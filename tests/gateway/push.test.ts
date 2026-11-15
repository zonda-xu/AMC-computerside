import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../apps/gateway/src/store.ts';
import { PushCoordinator, type PushNotice, type PushResult, type PushTransport } from '../../apps/gateway/src/push.ts';
import type { Session } from '../../packages/protocol/src/types.ts';
import { makeServer } from '../../apps/gateway/src/server.ts';
import { fixture as coreFixture } from '../helpers.ts';

function fixture(path = ':memory:', transport?: PushTransport) {
  const store = new Store(path); let now = 100_000;
  const push = new PushCoordinator(store, 'host', { transport, now: () => now, random: () => 0 });
  const paired = store.redeem(store.ticket().token, 'Phone');
  const session: Session = { id: 'session', ref: { hostId: 'host', workspaceId: 'workspace', engineId: 'codex', runtimeInstanceId: 'runtime', nativeSessionId: 'native' }, title: 'Secret title', cwd: 'private/path', state: 'idle', epoch: 0, messages: [], tools: [], agents: [], interactions: [], watermark: 0, historyStart: 1, updatedAt: now, externalSource: { namespace: 'namespace', nativeId: 'native', generation: 'generation', profile: 'verified', readOnly: true } };
  store.put('session', session.id, session); push.bind(paired.deviceId, 'secret-push-token');
  const emit = (text = 'private assistant text', role = 'assistant', id = 'message') => store.transaction(() => {
    const event = store.event(session.id, 'message.completed', { id, role, text }, false);
    return { event, queued: push.enqueue(session.id, event.seq) };
  });
  const baseline = () => store.transaction(() => push.completeBaseline(session.id, true));
  const jobs = () => store.db.prepare('SELECT * FROM push_jobs ORDER BY created,id').all();
  return { store, push, paired, session, emit, baseline, jobs, advance: (ms: number) => { now += ms; } };
}

test('baseline is mandatory, incomplete first sync stays silent, only subsequent assistant content notifies', () => {
  const f = fixture();
  try {
    assert.throws(() => f.push.completeBaseline(f.session.id, true), /transaction/);
    assert.throws(() => f.push.enqueue(f.session.id, 1), /transaction/);
    assert.equal(f.emit().queued, 0);
    assert.equal(f.store.transaction(() => f.push.completeBaseline(f.session.id, false)), false);
    assert.equal(f.emit('partial first history').queued, 0);
    assert.equal(f.baseline(), true);
    assert.equal(f.store.transaction(() => f.push.enqueue(f.session.id, 2)), 0);
    assert.equal(f.emit('user text', 'user').queued, 0);
    assert.equal(f.emit('thinking', 'reasoning').queued, 0);
    assert.equal(f.emit('   ').queued, 0);
    assert.equal(f.emit('new answer').queued, 1);
    assert.equal(f.baseline(), false);
    assert.equal(f.emit('new answer').queued, 0);
    assert.equal(f.emit('revised answer').queued, 1);
    assert.equal(f.jobs().length, 1);
  } finally { f.store.close(); }
});

test('projection, hash, baseline and outbox roll back together', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.transaction(() => { f.push.completeBaseline(f.session.id, true); throw Error('rollback'); }), /rollback/);
    assert.equal(f.emit().queued, 0); f.baseline();
    const before = f.store.get<Session>('session', f.session.id)!.watermark;
    assert.throws(() => f.store.transaction(() => {
      const event = f.store.event(f.session.id, 'message.completed', { id: 'new', role: 'assistant', text: 'answer' }, false);
      f.store.put('external-message-v1', 'new', { hash: 'version' });
      assert.equal(f.push.enqueue(f.session.id, event.seq), 1); throw Error('rollback');
    }), /rollback/);
    assert.equal(f.jobs().length, 0);
    assert.equal(f.store.get('external-message-v1', 'new'), undefined);
    assert.equal(f.store.get<Session>('session', f.session.id)!.watermark, before);
    assert.equal(f.emit('answer', 'assistant', 'new').queued, 1);
  } finally { f.store.close(); }
});

test('ten second fixed aggregation window, private payload and stable version deduplication', async () => {
  const sent: PushNotice[] = [];
  const f = fixture(':memory:', { send: async (token, notice) => { assert.equal(token, 'secret-push-token'); sent.push(notice); return 'accepted'; } });
  try {
    f.baseline(); f.emit(); f.advance(9000); f.emit('revision'); await f.push.tick(); assert.equal(sent.length, 0);
    f.advance(1000); await Promise.all([f.push.tick(), f.push.tick()]); assert.equal(sent.length, 1);
    assert.equal(f.jobs()[0].status, 'accepted');
    const payload = JSON.stringify(sent);
    for (const secret of ['secret-push-token', 'private assistant text', 'private/path', 'Secret title', 'revision']) assert.equal(payload.includes(secret), false);
    assert.equal(sent[0].hostId, 'host'); assert.equal(sent[0].sessionId, 'session');
    assert.match(sent[0].eventId, /^[a-f0-9]{64}$/);
    assert.equal(f.emit('revision').queued, 0);
    f.emit('another'); assert.equal(f.jobs().length, 2);
  } finally { await f.push.stop(); f.store.close(); }
});

test('self binding validates active pairing, token uniqueness, rotation and revoke cancel pending jobs', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.push.bind('not-paired', 'token'), /authorization/);
    for (const token of ['', 'x'.repeat(4097), 'line\nbreak', null]) assert.throws(() => f.push.bind(f.paired.deviceId, token), /Invalid push token/);
    const other = f.store.redeem(f.store.ticket().token, 'Other phone');
    assert.throws(() => f.push.bind(other.deviceId, 'secret-push-token'), /unavailable/);
    f.baseline(); f.emit(); f.push.bind(f.paired.deviceId, 'secret-push-token'); assert.equal(f.jobs()[0].status, 'pending');
    f.push.bind(f.paired.deviceId, 'rotated-secret'); assert.equal(f.jobs()[0].status, 'cancelled');
    assert.equal(JSON.stringify(f.push.binding(f.paired.deviceId)).includes('secret'), false);
    f.emit('new'); f.push.unbind(f.paired.deviceId); assert.equal(f.jobs().every(j => j.status === 'cancelled'), true);
    f.push.bind(f.paired.deviceId, 'rotated-again'); f.emit('newer'); f.store.revoke(f.paired.deviceId);
    assert.equal(f.store.db.prepare('SELECT * FROM push_bindings').all().length, 0);
    assert.equal(f.jobs().every(j => j.status === 'cancelled'), true);
    assert.throws(() => f.push.bind(f.paired.deviceId, 'token'), /authorization/);
  } finally { await f.push.stop(); f.store.close(); }
});

test('unconfigured fails closed and expires queued notices without sending', async () => {
  const f = fixture();
  try {
    assert.equal(f.push.status().state, 'unconfigured'); f.baseline(); f.emit(); f.advance(11_000); await f.push.tick();
    assert.equal(f.jobs()[0].attempts, 0); assert.equal(f.jobs()[0].status, 'pending');
    f.advance(3_600_000); await f.push.tick(); assert.equal(f.jobs()[0].status, 'expired');
  } finally { await f.push.stop(); f.store.close(); }
});

test('source identity changes require a new silent baseline', () => {
  const f = fixture();
  try {
    f.baseline(); f.emit();
    const session = f.store.get<Session>('session', f.session.id)!; session.externalSource!.generation = 'changed'; f.store.put('session', session.id, session);
    assert.equal(f.emit('history from new identity').queued, 0); assert.equal(f.baseline(), true);
    assert.equal(f.jobs()[0].status, 'cancelled'); assert.equal(f.emit('new live answer').queued, 1);
  } finally { f.store.close(); }
});

test('retry persists across restart, lease recovers and accepted provider response is not a delivery receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amc-push-')); const path = join(dir, 'store.sqlite');
  const f = fixture(path, { send: async () => { throw Error('secret token in provider error'); } });
  try {
    f.baseline(); f.emit(); f.advance(10_000); await f.push.tick();
    assert.equal(f.jobs()[0].status, 'pending'); assert.equal(f.jobs()[0].attempts, 1);
    assert.equal(JSON.stringify(f.jobs()).includes('secret token in provider error'), false);
    f.store.db.prepare("UPDATE push_jobs SET status='sending',lease='dead-worker',lease_until=120000").run();
    await f.push.stop(); f.store.close();
    const store = new Store(path); let calls = 0;
    const push = new PushCoordinator(store, 'host', { now: () => 130_000, transport: { send: async () => { calls++; return 'accepted'; } } });
    try {
      await push.tick(); assert.equal(calls, 1);
      assert.equal(store.db.prepare('SELECT status FROM push_jobs').get()!.status, 'accepted');
      assert.equal(store.transaction(() => push.enqueue(f.session.id, 1)), 0);
    } finally { await push.stop(); store.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid tokens unbind, permanent failures stop, auth and permission block until operator resume', async () => {
  for (const result of ['invalid_token', 'permanent', 'authentication', 'permission'] as PushResult[]) {
    let calls = 0;
    const f = fixture(':memory:', { send: async () => { calls++; return result; } });
    try {
      f.baseline(); f.emit(); f.advance(10_000); await f.push.tick();
      if (result === 'invalid_token') { assert.equal(f.push.binding(f.paired.deviceId).bound, false); assert.equal(f.jobs()[0].status, 'cancelled'); }
      if (result === 'permanent') assert.equal(f.jobs()[0].status, 'failed');
      if (result === 'authentication' || result === 'permission') {
        assert.equal(f.push.status().state, result); f.advance(300_000); await f.push.tick(); assert.equal(calls, 1);
        f.push.resume(); await f.push.tick(); assert.equal(calls, 2);
      }
    } finally { await f.push.stop(); f.store.close(); }
  }
});

test('retry exhaustion is bounded to ten attempts', async () => {
  const f = fixture(':memory:', { send: async () => 'retry' });
  try {
    f.baseline(); f.emit();
    for (let i = 0; i < 10; i++) { f.advance(301_000); await f.push.tick(); }
    assert.equal(f.jobs()[0].attempts, 10); assert.equal(f.jobs()[0].status, 'failed');
  } finally { await f.push.stop(); f.store.close(); }
});

test('send timeout aborts and schedules a bounded retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let signal: AbortSignal | undefined;
  const f = fixture(':memory:', { send: async (_token, _notice, current) => { signal = current; return new Promise<PushResult>(() => {}); } });
  try {
    f.baseline(); f.emit(); f.advance(10_000); const pending = f.push.tick();
    for(let i=0;i<10&&!signal;i++)await Promise.resolve();
    t.mock.timers.tick(10_000); await pending;
    assert.equal(signal?.aborted, true); assert.equal(f.jobs()[0].status, 'pending'); assert.equal(f.jobs()[0].attempts, 1);
  } finally { await f.push.stop(); f.store.close(); }
});

test('send-time source authorization cancels a queued notice and never submits it', async () => {
  const f=fixture();let calls=0;
  const push=new PushCoordinator(f.store,'host',{now:()=>200_000,authorize:async()=>false,transport:{send:async()=>{calls++;return 'accepted';}}});
  try{f.baseline();f.emit();await push.tick();assert.equal(calls,0);assert.equal(f.jobs()[0].status,'cancelled');}
  finally{await push.stop();await f.push.stop();f.store.close();}
});

test('device revoked during asynchronous source authorization is not submitted after validation returns', async () => {
  const f=fixture();let calls=0;let release:()=>void=()=>{};let entered:()=>void=()=>{};
  const waiting=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
  const push=new PushCoordinator(f.store,'host',{now:()=>200_000,authorize:async()=>{entered();await waiting;return true;},transport:{send:async()=>{calls++;return 'accepted';}}});
  try{f.baseline();f.emit();const pending=push.tick();await started;f.store.revoke(f.paired.deviceId);release();await pending;assert.equal(calls,0);assert.equal(f.jobs()[0].status,'cancelled');}
  finally{release();await push.stop();await f.push.stop();f.store.close();}
});

test('rotation aborts in-flight work and stale invalid-token result cannot remove the replacement', async () => {
  let resolve: (result: PushResult) => void = () => {}; let signal: AbortSignal | undefined;
  let entered: () => void = () => {}; const started = new Promise<void>(done => { entered = done; });
  const f = fixture(':memory:', { send: async (_token, _notice, current) => { signal = current; entered(); return new Promise<PushResult>(r => { resolve = r; }); } });
  try {
    f.baseline(); f.emit(); f.advance(10_000); const pending = f.push.tick(); await started;
    f.push.bind(f.paired.deviceId, 'secret-push-token'); assert.equal(signal?.aborted, false);
    f.push.bind(f.paired.deviceId, 'replacement'); assert.equal(signal?.aborted, true);
    resolve('invalid_token'); await pending;
    assert.equal(f.push.binding(f.paired.deviceId).bound, true);
    assert.equal(f.store.db.prepare('SELECT token FROM push_bindings').get()!.token, 'replacement');
    assert.equal(f.jobs()[0].status, 'cancelled');
  } finally { await f.push.stop(); f.store.close(); }
});

test('binding count is bounded and each device gets an independent aggregate', () => {
  const f = fixture();
  try {
    for (let i = 1; i < 100; i++) { const d = f.store.redeem(f.store.ticket().token, 'phone'); f.push.bind(d.deviceId, 'token-' + i); }
    const extra = f.store.redeem(f.store.ticket().token, 'extra');
    assert.throws(() => f.push.bind(extra.deviceId, 'extra-token'), /limit/);
    f.push.bind(f.paired.deviceId, 'replacement'); f.baseline(); assert.equal(f.emit().queued, 100);
    assert.equal(f.jobs().length, 100); assert.equal(f.emit('revision').queued, 100); assert.equal(f.jobs().length, 100);
  } finally { f.store.close(); }
});

test('a changed source cannot send previously queued notices', async () => {
  let calls = 0; const f = fixture(':memory:', { send: async () => { calls++; return 'accepted'; } });
  try {
    f.baseline(); f.emit(); const s = f.store.get<Session>('session', f.session.id)!;
    s.externalSource!.generation = 'replaced'; f.store.put('session', s.id, s);
    f.advance(10_000); await f.push.tick(); assert.equal(calls, 0); assert.equal(f.jobs()[0].status, 'cancelled');
  } finally { await f.push.stop(); f.store.close(); }
});

test('HTTPS self push uses the existing paired principal and never returns push tokens', async () => {
  const f = await coreFixture();
  const key = join(f.dir, 'key.pem'), cert = join(f.dir, 'cert.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost']);
  const tls = { key: await readFile(key), cert: await readFile(cert) };
  const server = makeServer(f.core, tls, { name: 'Host', os: 'test' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No address');
  const call = (method: string, token = '', body?: unknown, host = 'test-host') => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path: '/v1/devices/self/push', method, servername: 'localhost', ca: tls.cert, headers: { Authorization: 'Bearer ' + token, 'X-AMC-Host': host } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    assert.equal((await call('PUT', '', { token: 'push-secret' })).status, 401);
    const a = f.store.redeem(f.store.ticket().token, 'A'), b = f.store.redeem(f.store.ticket().token, 'B');
    assert.equal((await call('PUT', a.token, { token: 'push-secret' }, 'wrong-host')).status, 409);
    assert.equal((await call('PUT', a.token, { token: 'push-secret', deviceId: b.deviceId })).status, 400);
    const bound = await call('PUT', a.token, { token: 'push-secret' });
    assert.equal(bound.status, 200); assert.equal(bound.body.includes('push-secret'), false);
    assert.equal(JSON.parse(bound.body).data.bound, true); assert.equal(JSON.parse(bound.body).data.state, 'unconfigured');
    assert.equal(JSON.parse((await call('GET', b.token)).body).data.bound, false);
    assert.equal((await call('PUT', a.token, { token: 'x'.repeat(9000) })).status, 413);
    assert.equal((await call('DELETE', b.token)).status, 200);
    assert.equal(JSON.parse((await call('GET', a.token)).body).data.bound, true);
    assert.equal((await call('DELETE', a.token)).status, 200);
    assert.equal(JSON.parse((await call('GET', a.token)).body).data.bound, false);
    f.store.revoke(a.deviceId); assert.equal((await call('PUT', a.token, { token: 'another' })).status, 401);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

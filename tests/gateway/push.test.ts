import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, constants } from 'node:crypto';
import { Store } from '../../apps/gateway/src/store.ts';
import { PushCoordinator, type PushNotice, type PushResult, type PushTransport } from '../../apps/gateway/src/push.ts';
import { HuaweiPushTransport, makePushJwt, type PushServiceAccount } from '../../apps/gateway/src/huawei-push.ts';
import type { Session } from '../../packages/protocol/src/types.ts';

function fixture(transport?: PushTransport) {
  const store = new Store(':memory:'); let now = 100_000;
  const push = new PushCoordinator(store, 'host', { transport, now: () => now, random: () => 0 });
  const device = store.redeem(store.ticket().token, 'Phone');
  const session: Session = { id: 'session', ref: { hostId: 'host', workspaceId: 'workspace', engineId: 'codex', runtimeInstanceId: 'runtime', nativeSessionId: 'native' }, title: 'Secret title', cwd: 'private/path', state: 'running', runId: 'run-1', epoch: 1, binding: { runtimeInstanceId: 'runtime', generation: 1, nativeSessionId: 'native', state: 'attached', capabilities: { create: true, submit: true, observe: true, approve: true, answer: true, cancel: true, resume: true } }, messages: [], tools: [], agents: [], interactions: [], watermark: 0, historyStart: 1, updatedAt: now };
  store.put('session', session.id, session); push.bind(device.deviceId, 'private-token');
  const emit = (state = 'completed', runId = 'run-1') => store.transaction(() => {
    const event = store.event(session.id, 'run.updated', { state, runId }, false);
    return { event, queued: push.enqueue(session.id, event.seq) };
  });
  return { store, push, session, device, emit, advance: (ms: number) => { now += ms; }, jobs: () => store.db.prepare('SELECT * FROM push_jobs ORDER BY created,id').all() };
}

test('only explicit local run terminals and actionable interactions create stable notification intents', () => {
  const f = fixture();
  try {
    assert.throws(() => f.push.enqueue('session', 1), /transaction/);
    for (const state of ['accepted', 'running', 'cancel_requested', 'uncertain']) assert.equal(f.emit(state).queued, 0);
    assert.equal(f.emit().queued, 1);
    assert.equal(f.emit().queued, 0);
    assert.equal(f.emit('failed').queued, 0);
    const next = f.store.get<Session>('session', 'session')!; next.runId = 'run-2'; next.state = 'accepted'; f.store.put('session', 'session', next);
    assert.equal(f.emit('cancelled', 'run-2').queued, 1);
    f.store.transaction(() => {
      const event = f.store.event('session', 'message.completed', { id: 'assistant', role: 'assistant', text: 'secret output' }, false);
      assert.equal(f.push.enqueue('session', event.seq), 0);
    });
    assert.equal(f.jobs().length, 2);
  } finally { f.store.close(); }
});

test('event, projection and notification intent roll back together', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.transaction(() => { const event = f.store.event('session', 'run.updated', { state: 'completed', runId: 'run-1' }, false); f.push.enqueue('session', event.seq); throw Error('rollback'); }), /rollback/);
    assert.equal(f.jobs().length, 0); assert.equal(f.store.get<Session>('session', 'session')?.watermark, 0);
    assert.equal(f.emit().queued, 1);
  } finally { f.store.close(); }
});

test('history import remains silent even when it contains an old terminal', () => {
  const f = fixture();
  try {
    f.session.binding = undefined; f.session.externalSource = { namespace: 'ns', nativeId: 'native', generation: 'old', profile: 'history', readOnly: true };
    f.store.put('session', 'session', f.session);
    assert.equal(f.emit().queued, 0);
  } finally { f.store.close(); }
});

test('initial native snapshots and historical replay remain silent after control binding', () => {
  const f = fixture();
  try {
    for (const flag of ['silentBaseline', 'historical']) {
      f.store.transaction(() => {
        const event = f.store.event('session', 'interaction.created', { id: flag, sessionId: 'session', kind: 'permission', epoch: 1, title: 'Existing', detail: '', choices: [], questions: [], status: 'pending', nativeId: flag, nativeMethod: 'approval', [flag]: true }, false);
        assert.equal(f.push.enqueue('session', event.seq), 0);
      });
    }
    assert.equal(f.jobs().length, 0);
  } finally { f.store.close(); }
});

test('migrated unbound history and already-resolved interaction snapshots do not create notices', () => {
  const f = fixture();
  try {
    f.session.externalSource = { namespace: 'ns', nativeId: 'native', generation: 'old', profile: 'history', readOnly: true };
    f.session.binding!.state = 'unbound'; f.store.put('session', 'session', f.session);
    assert.equal(f.emit().queued, 0);
    const latest = f.store.get<Session>('session', 'session')!;
    latest.externalSource = undefined; latest.binding!.state = 'attached'; f.store.put('session', 'session', latest);
    f.store.transaction(() => {
      const event = f.store.event('session', 'interaction.created', { id: 'resolved', sessionId: 'session', kind: 'permission', epoch: 1, title: 'Existing', detail: '', choices: [], questions: [], status: 'resolved', nativeId: 1, nativeMethod: 'approval' }, false);
      assert.equal(f.push.enqueue('session', event.seq), 0);
    });
  } finally { f.store.close(); }
});

test('provider acceptance is not device delivery and payload contains no private content', async () => {
  const sent: PushNotice[] = [];
  const f = fixture({ send: async (_token, notice) => { sent.push(notice); return 'accepted'; } });
  try {
    f.emit(); await f.push.tick();
    assert.equal(f.jobs()[0].status, 'accepted'); assert.equal(sent[0].title, '任务已完成');
    for (const secret of ['private-token', 'private/path', 'Secret title']) assert.equal(JSON.stringify(sent).includes(secret), false);
  } finally { await f.push.stop(); f.store.close(); }
});

test('token rotation cannot be undone by an old invalid-token result', async () => {
  let release: (result: PushResult) => void = () => {};
  let entered: () => void = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ send: async () => { entered(); return new Promise<PushResult>(resolve => { release = resolve; }); } });
  try {
    f.emit(); const pending = f.push.tick(); await started;
    f.push.bind(f.device.deviceId, 'replacement'); release('invalid_token'); await pending;
    assert.equal(f.store.db.prepare('SELECT token FROM push_bindings').get()?.token, 'replacement');
    assert.equal(f.jobs()[0].status, 'cancelled');
  } finally { await f.push.stop(); f.store.close(); }
});

test('retry exhaustion is bounded and unconfigured queues expire without sending', async () => {
  const f = fixture({ send: async () => 'retry' }); const g = fixture();
  try {
    f.emit(); for (let i = 0; i < 10; i++) { f.advance(301_000); await f.push.tick(); }
    assert.equal(f.jobs()[0].attempts, 10); assert.equal(f.jobs()[0].status, 'failed');
    g.emit(); assert.equal(g.push.status().state, 'unconfigured'); g.advance(3_600_001); await g.push.tick();
    assert.equal(g.jobs()[0].status, 'expired'); assert.equal(g.jobs()[0].attempts, 0);
  } finally { await f.push.stop(); await g.push.stop(); f.store.close(); g.store.close(); }
});

test('source generation replacement and pairing revocation cancel queued notifications', async () => {
  let calls = 0; const f = fixture({ send: async () => { calls++; return 'accepted'; } });
  try {
    f.emit(); const latest = f.store.get<Session>('session', 'session')!;
    if (latest.binding) latest.binding.generation++;
    f.store.put('session', 'session', latest); await f.push.tick();
    assert.equal(calls, 0); assert.equal(f.jobs()[0].status, 'cancelled');
    f.emit('completed', 'run-2'); f.store.revoke(f.device.deviceId); await f.push.tick(); assert.equal(calls, 0);
  } finally { await f.push.stop(); f.store.close(); }
});

test('resolved approval notices are cancelled before provider submission', async () => {
  let calls = 0; const f = fixture({ send: async () => { calls++; return 'accepted'; } });
  try {
    f.store.transaction(() => {
      const event = f.store.event('session', 'interaction.created', { id: 'approval', sessionId: 'session', kind: 'permission', epoch: 1, title: 'Command approval', detail: 'private command', choices: [], questions: [], status: 'pending', nativeId: 42, nativeMethod: 'approval' }, false);
      assert.equal(f.push.enqueue('session', event.seq), 1);
    });
    f.store.event('session', 'interaction.closed', { id: 'approval', status: 'resolved' });
    await f.push.tick(); assert.equal(calls, 0); assert.equal(f.jobs()[0].status, 'cancelled');
  } finally { await f.push.stop(); f.store.close(); }
});

test('device revocation while asynchronous workspace authorization waits never sends', async () => {
  const f = fixture(); let calls = 0;
  let release: () => void = () => {}; let entered: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const push = new PushCoordinator(f.store, 'host', { now: () => 100_000, authorize: async () => { entered(); await pending; return true; }, transport: { send: async () => { calls++; return 'accepted'; } } });
  try {
    f.emit(); const ticking = push.tick(); await started; f.store.revoke(f.device.deviceId); release(); await ticking;
    assert.equal(calls, 0); assert.equal(f.jobs()[0].status, 'cancelled');
  } finally { release(); await push.stop(); await f.push.stop(); f.store.close(); }
});

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account: PushServiceAccount = { key_id: 'key', sub_account: 'service', project_id: 'project', private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
test('Harmony JWT uses PS256 RSA-PSS, exact audience and a one-hour lifetime', () => {
  const jwt = makePushJwt(account, 1000); const parts = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(parts[0], 'base64url').toString()), { alg: 'PS256', typ: 'JWT', kid: 'key' });
  assert.deepEqual(JSON.parse(Buffer.from(parts[1], 'base64url').toString()), { iss: 'service', aud: 'https://oauth-login.cloud.huawei.com/oauth2/v3/token', iat: 1000, exp: 4600 });
  assert.equal(verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: keys.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(parts[2], 'base64url')), true);
});

test('Harmony V3 transport keeps stable notification IDs, refreshes expired JWT and classifies errors conservatively', async () => {
  const bodies: string[] = []; let code = '80200005'; let calls = 0;
  const mock: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://push-api.cloud.huawei.com/v3/project/messages:send');
    bodies.push(String(init?.body)); calls++;
    const result = code; if (code === '80200005') code = '80000000';
    return new Response(JSON.stringify({ code: result, requestId: 'provider-request' }), { status: 200 });
  };
  const transport = new HuaweiPushTransport(account, { serviceAccountFile: 'unused', category: 'WORK', testMessage: true }, mock, () => 1_000_000);
  const notice: PushNotice = { hostId: 'host', sessionId: 'session', eventId: '1', interactionId: 'pending', notificationId: 'stable', title: 'Title', body: 'Body', ttlSeconds: 3600 };
  const signal = new AbortController().signal;
  assert.equal(await transport.send('token', notice, signal), 'accepted'); assert.equal(calls, 2); assert.equal(bodies[0], bodies[1]);
  assert.equal(transport.lastResult?.requestId, 'provider-request');
  for (const item of [{ code: '80300007', expected: 'permission' }, { code: '80200001', expected: 'authentication' }, { code: '80100003', expected: 'permanent' }, { code: '80300029', expected: 'retry' }]) {
    code = item.code; assert.equal(await transport.send('token', notice, signal), item.expected);
  }
});

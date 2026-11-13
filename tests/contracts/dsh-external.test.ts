import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { externalHandlers } from '../../plugins/dsh-bridge/external.mjs';
import { controllerEvidence } from '../../plugins/dsh-bridge/profile.mjs';
import { DshAdapter } from '../../packages/adapters/deepseek-harness/index.ts';
import { DshExternalProvider } from '../../packages/adapters/deepseek-harness/external.ts';
import { fixture } from '../helpers.ts';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';

test('DSH fixture passive history pins its waterline, keeps user text and never claims or invokes native control', async () => {
  const cwd = await realpath('.'); const calls: string[] = []; const observed = new Set<string>();
  const ctl = {
    async list() { calls.push('list'); return { items: [{ sessionId: 'fixture', cwd }] }; },
    async projections() { calls.push('projections'); return { kind: 'sequenced', asOfSeq: 3 }; },
    async page(p: { beforeSeq?: number; throughSeq?: number }) {
      calls.push('page'); assert.equal(p.throughSeq, 3);
      if (p.beforeSeq === undefined) return { hasMore: true, records: [{ type: 'event', event: { seq: 3, type: 'assistant/message', data: { turn: 1, step: 1, stream: [{ type: 'text-chunks', texts: ['Fixture answer'] }] } } }] };
      assert.equal(p.throughSeq, 3); assert.equal(p.beforeSeq, 3);
      return { hasMore: false, records: [{ type: 'event', event: { seq: 0, type: 'turn/start', data: {} } }, { type: 'event', event: { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Fixture prompt' }] } } }, { type: 'event', event: { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } } }] };
    }
  };
  const handlers = externalHandlers(ctl, observed, 'fixture-generation');
  const result = await handlers.externalHistory({ cwd, sessionId: 'fixture', instanceId: 'fixture-generation' });
  assert.deepEqual(result.items.map(m => m.role), ['user', 'assistant']);
  assert.equal(observed.size, 0); assert.deepEqual(calls, ['list', 'projections', 'page', 'page', 'list']);
  await handlers.externalObserve({ cwd, sessionId: 'fixture', instanceId: 'fixture-generation', enabled: true }); assert.ok(observed.has('fixture'));
  await assert.rejects(() => handlers.externalHistory({ cwd, sessionId: 'fixture', instanceId: 'old-generation' }), /generation changed/);
});
test('DSH rc.5 missing/migration waterlines never follow, activate, or guess a journal cut', async () => {
  const cwd = await realpath('.'); let pages = 0; let baseline: { kind: string; asOfSeq?: number } | null = null;
  const ctl = { async list() { return { items: [{ sessionId: 'fixture', cwd }] }; }, async projections() { return baseline; }, async page() { pages++; throw new Error('must not page'); } };
  const handlers = externalHandlers(ctl, new Set<string>(), 'fixture-generation');
  for (const value of [null, { kind: 'migration-required' }, { kind: 'sequenced', asOfSeq: 1.5 }]) {
    baseline = value; await assert.rejects(() => handlers.externalHistory({ cwd, sessionId: 'fixture', instanceId: 'fixture-generation' }), /waterline unavailable/);
  }
  assert.equal(pages, 0);
});
test('DSH configured CLI/revision cannot impersonate loaded API evidence and mutation methods fail before dispatch', async () => {
  const evidence = await controllerEvidence({ list() {}, page() {}, projections() {} }); assert.equal(evidence.apiProfile, '');
  const f = await fixture();
  try {
    const adapter = new DshAdapter('deepseek-harness', { command: 'fixture-only', expectedVersion: '0.2.1-rc.5' }, f.adapter.context);
    for (const method of ['create', 'state', 'prompt', 'cancel', 'selectModel', 'respond', 'constructor', 'toString']) await assert.rejects(() => adapter.call(method), /read-only/);
    for (const response of [
      { version: '0.2.1-rc.5', externalProtocol: 1, sourceRevision: 'fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159', instanceId: 'fixture' },
      { version: '0.2.1-rc.5', externalProtocol: 2, apiProfile: 'dsh-controller-0.2.1-rc.5-page-v2', controllerDigest: 'modified', control: false, instanceId: 'fixture' }
    ]) {
      adapter.call = async () => response;
      const profile = await new DshExternalProvider(adapter).profile(); assert.equal(profile.history.state, 'unverified'); assert.equal(profile.submit.state, 'unverified');
    }
  } finally { await f.close(); }
});
test('DSH rc.5 history rejects gaps, wrong record envelopes and incomplete pinned cuts', async () => {
  const cwd = await realpath('.'); let seq = 1; let type = 'event'; let waterline = 1;
  const ctl = {
    async list() { return { items: [{ sessionId: 'fixture', cwd }] }; },
    async projections() { return { kind: 'sequenced', asOfSeq: waterline }; },
    async page() { return { hasMore: false, records: [{ type, event: { seq, type: 'turn/start', data: {} } }] }; }
  };
  const handlers = externalHandlers(ctl, new Set<string>(), 'fixture');
  const request = { cwd, sessionId: 'fixture', instanceId: 'fixture' };
  await assert.rejects(() => handlers.externalHistory(request), /order or waterline/);
  seq = 0; type = 'unexpected'; await assert.rejects(() => handlers.externalHistory(request), /order or waterline/);
  type = 'event'; await assert.rejects(() => handlers.externalHistory(request), /did not reach/);
  waterline = 0; assert.deepEqual((await handlers.externalHistory(request)).items, []);
});
test('DSH read-only bridge ignores legacy managed events that could release an uncertain directory owner', async () => {
  const f = await fixture(); const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const adapter = new DshAdapter('deepseek-harness', { command: 'fixture-only', expectedVersion: '0.2.1-rc.5' }, f.adapter.context);
  try {
    await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
    const connected = once(server, 'connection'); const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); const [bridge] = await connected;
    await once(socket, 'open'); adapter.attach(socket); adapter.byNative.set(f.s.ref.nativeSessionId, f.s.id);
    f.adapter.context.emit(f.s.id, 'run.updated', { state: 'uncertain' });
    bridge.once('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString());
      bridge.send(JSON.stringify({ method: 'event', params: { sessionId: f.s.ref.nativeSessionId, type: 'run.updated', data: { state: 'completed' } } }));
      bridge.send(JSON.stringify({ id: message.id, result: { version: '0.2.1-rc.5', externalProtocol: 1 } }));
    });
    await adapter.call('probe', {}, 5000);
    assert.equal(f.core.session(f.s.id).state, 'uncertain');
  } finally {
    const disconnected = adapter.socket ? once(adapter.socket, 'close', { signal: AbortSignal.timeout(5000) }) : Promise.resolve();
    adapter.close(); for (const client of server.clients) client.terminate();
    await disconnected;
    await new Promise<void>(resolve => server.close(() => resolve())); await f.close();
  }
});
test('DSH fixture snapshot pagination is cwd bound and consumption cannot be replayed', async () => {
  const cwd = await realpath('.');
  const ctl = { async list() { return { items: Array.from({ length: 51 }, (_, i) => ({ sessionId: 'fixture-' + i, cwd })) }; } };
  const handlers = externalHandlers(ctl, new Set<string>(), 'fixture-generation');
  const a = await handlers.externalList({ cwd, instanceId: 'fixture-generation' }); assert.equal(a.items.length, 50); assert.ok(a.cursor);
  const b = await handlers.externalList({ cwd, instanceId: 'fixture-generation', cursor: a.cursor }); assert.equal(b.items.length, 1);
  await assert.rejects(() => handlers.externalList({ cwd, instanceId: 'fixture-generation', cursor: a.cursor }), /expired/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ajv } from 'ajv';
import { Store } from '../../apps/gateway/src/store.ts';
import { PushCoordinator } from '../../apps/gateway/src/push.ts';
import { validateConsoleEvent, validateEventData } from '../../packages/protocol/src/validation.ts';
import type { ConsoleEvent, EventType, RunRecord, RunState, Session } from '../../packages/protocol/src/types.ts';

function fixture() {
  const store = new Store(':memory:');
  const session: Session = { id: 'session', ref: { hostId: 'host', workspaceId: 'work', runtimeInstanceId: 'runtime', engineId: 'codex', nativeSessionId: 'thread' }, title: 'Test', cwd: '/work', state: 'running', epoch: 1, runId: 'run-1', nativeRunId: 'turn-1', runGeneration: 1, binding: { runtimeInstanceId: 'runtime', generation: 1, nativeSessionId: 'thread', state: 'attached', capabilities: { create: true, submit: true, observe: true, approve: true, answer: true, cancel: true, resume: true } }, messages: [], tools: [], agents: [], interactions: [], watermark: 0, updatedAt: 0, historyStart: 1 };
  store.put('session', session.id, session);
  store.put('run', 'run-1', { runId: 'run-1', sessionId: session.id, generation: 1, nativeRunId: 'turn-1', state: 'running' });
  return { store, session };
}

function interaction(kind: 'permission' | 'question', id: string): ConsoleEvent['data'] {
  return { id, sessionId: 'session', kind, epoch: 1, title: 'Native request', detail: '', choices: [], questions: [], status: 'pending', nativeId: id, nativeMethod: 'native/request' };
}

test('late first-time permission and question events cannot revive terminal runs or enqueue notices', async () => {
  const states: RunState[] = ['completed', 'failed', 'cancelled'];
  for (const state of states) {
    const f = fixture(); let sent = 0;
    const push = new PushCoordinator(f.store, 'host', { transport: { send: async () => { sent++; return 'accepted'; } } });
    try {
      const device = f.store.redeem(f.store.ticket().token, 'Phone'); push.bind(device.deviceId, 'token');
      f.store.event('session', 'run.updated', { state, runId: 'run-1', nativeRunId: 'turn-1' });
      for (const kind of ['permission', 'question']) {
        const data = interaction(kind === 'permission' ? 'permission' : 'question', 'late-' + kind);
        f.store.transaction(() => {
          const event = f.store.event('session', 'interaction.created', data, false);
          assert.equal(event.data.ignored, true);
          assert.equal(push.enqueue('session', event.seq), 0);
        });
      }
      assert.deepEqual(f.store.get<Session>('session', 'session')?.interactions, []);
      assert.throws(() => f.store.claimDecision('session', 'late-permission', 1, { choiceId: 'allow' }), /previous connection or run/);
      await push.tick(); assert.equal(sent, 0);
      f.store.event('session', 'run.updated', { state: 'running', nativeRunId: 'turn-2', nativeAccepted: true });
      const next = f.store.get<Session>('session', 'session')!;
      assert.notEqual(next.runId, 'run-1'); assert.equal(next.state, 'running');
      f.store.event('session', 'interaction.created', interaction('permission', 'new-permission'));
      assert.equal(f.store.get<Session>('session', 'session')?.interactions[0].status, 'pending');
    } finally { await push.stop(); f.store.close(); }
  }
});

test('queued approval notification is rejected after out-of-order terminal snapshot replacement', async () => {
  const f = fixture(); let sent = 0;
  const push = new PushCoordinator(f.store, 'host', { transport: { send: async () => { sent++; return 'accepted'; } } });
  try {
    const device = f.store.redeem(f.store.ticket().token, 'Phone'); push.bind(device.deviceId, 'token');
    f.store.transaction(() => {
      const event = f.store.event('session', 'interaction.created', interaction('permission', 'approval'), false);
      assert.equal(push.enqueue('session', event.seq), 1);
    });
    const replaced = f.store.get<Session>('session', 'session')!; replaced.state = 'completed';
    f.store.put('session', replaced.id, replaced);
    await push.tick(); assert.equal(sent, 0);
    assert.equal(f.store.db.prepare('SELECT status FROM push_jobs').get()?.status, 'cancelled');
  } finally { await push.stop(); f.store.close(); }
});

test('historical tool and message recovery never changes current run or overwrites terminal evidence', () => {
  const f = fixture();
  try {
    f.store.event('session', 'run.updated', { state: 'failed', nativeRunId: 'turn-1', error: { message: 'Original failure' } });
    const result = f.store.get<RunRecord>('run', 'run-1')?.result;
    f.store.event('session', 'tool.updated', { id: 'late-tool', status: 'failed', detail: 'Tool details', nativeRunId: 'turn-1' });
    assert.deepEqual(f.store.get<RunRecord>('run', 'run-1')?.result, result);
    f.store.event('session', 'run.updated', { state: 'running', nativeRunId: 'turn-2', nativeAccepted: true });
    const current = f.store.get<Session>('session', 'session')!;
    f.store.event('session', 'tool.updated', { id: 'recovered-tool', title: 'Command', status: 'failed', detail: 'Recovered output', nativeRunId: 'turn-1', historical: true });
    f.store.event('session', 'message.completed', { id: 'recovered-message', text: 'Old final', nativeRunId: 'turn-1', historical: true });
    const after = f.store.get<Session>('session', 'session')!;
    assert.equal(after.runId, current.runId); assert.equal(after.state, 'running'); assert.equal(after.nativeRunId, 'turn-2');
    assert.equal(after.tools.find(t => t.id === 'recovered-tool')?.detail, 'Recovered output');
    assert.equal(after.messages.find(m => m.id === 'recovered-message')?.text, 'Old final');
    assert.deepEqual(f.store.get<RunRecord>('run', 'run-1')?.result, result);
    assert.equal(f.store.get<RunRecord>('run', 'run-1')?.state, 'failed');
  } finally { f.store.close(); }
});

test('published v2 event schema and production payload validator share all event constraints', async () => {
  const schema = JSON.parse(await readFile(new URL('../../packages/protocol/schema/event.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv().compile(schema);
  const cases: Array<[EventType, ConsoleEvent['data'], ConsoleEvent['data']]> = [
    ['message.delta', { id: 'message', text: 'Delta' }, { id: 'message', text: 2 }],
    ['message.completed', { id: 'message', text: 'Final', role: 'assistant' }, { id: 'message', text: 'Final', role: 'invalid' }],
    ['tool.updated', { id: 'tool', status: 'completed' }, { status: 'completed' }],
    ['agent.updated', { id: 'agent', state: 'running' }, { id: 'agent', state: false }],
    ['run.updated', { state: 'failed' }, { state: 'success' }],
    ['interaction.created', interaction('permission', 'approval'), { ...interaction('permission', 'approval'), choices: [{ id: 'allow', label: 'Allow' }] }],
    ['interaction.closed', { id: 'approval', status: 'resolved' }, { id: 'approval', status: 'pending' }],
    ['model.confirmed', { model: { providerId: 'openai', modelId: 'gpt-5', label: 'GPT' } }, { model: { providerId: 'openai' } }],
    ['error', { message: 'Error' }, { detail: 'Missing message' }]
  ];
  const f = fixture();
  try {
    for (const [type, data, invalid] of cases) {
      const event: ConsoleEvent = { protocolVersion: 2, eventId: 'event', hostId: 'host', runtimeInstanceId: 'runtime', generation: 1, sessionId: 'session', ref: f.session.ref, seq: 1, time: 0, type, data };
      assert.equal(validate(event), true, JSON.stringify(validate.errors)); assert.equal(validateConsoleEvent(event), true);
      assert.doesNotThrow(() => validateEventData(type, data));
      assert.equal(validate({ ...event, data: invalid }), false, type); assert.throws(() => validateEventData(type, invalid), /Invalid/);
      for (const malformed of [{ ...data, generation: -1 }, { ...data, runId: '' }, { ...data, nativeRunId: 3 }]) {
        assert.equal(validate({ ...event, data: malformed }), false); assert.throws(() => validateEventData(type, malformed), /Invalid/);
      }
      assert.equal(validate({ ...event, generation: undefined }), false); assert.equal(validate({ ...event, eventId: undefined }), false);
    }
  } finally { f.store.close(); }
});

test('legacy stored events are normalized into mandatory v2 wire identities without deleting history', () => {
  const f = fixture();
  try {
    const legacy = { sessionId: 'session', ref: f.session.ref, seq: 1, time: 0, type: 'message.completed', data: { id: 'old-message', text: 'Preserved' } };
    f.store.db.prepare('INSERT INTO events VALUES(?,?,?)').run('session', 1, JSON.stringify(legacy));
    const [restored] = f.store.events('session', 0);
    assert.equal(validateConsoleEvent(restored), true, JSON.stringify(validateConsoleEvent.errors));
    assert.equal(restored.data.text, 'Preserved'); assert.equal(restored.protocolVersion, 2); assert.equal(restored.hostId, 'host');
    assert.equal(restored.eventId, f.store.events('session', 0)[0].eventId);
  } finally { f.store.close(); }
});

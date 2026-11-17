import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../../packages/adapters/opencode/index.ts';
import { ClaudeCodeAdapter, InputQueue } from '../../packages/adapters/claude-code/index.ts';
import { CodexAdapter } from '../../packages/adapters/codex/index.ts';
import { nativeContext } from './fixtures/native-context.ts';
import { fixture, command } from '../helpers.ts';
import { OpenCodeExternalProvider } from '../../packages/adapters/opencode/external.ts';
import { createHash } from 'node:crypto';

function openCodeHarness() {
  const f = nativeContext('opencode');
  const adapter = new OpenCodeAdapter('opencode', { command: 'synthetic', expectedVersion: '2.3.0' }, f.context);
  adapter.byNative.set('native', f.session.id);
  f.session.runId = 'gateway-run'; f.session.state = 'accepted'; f.session.runGeneration = 1;
  const run = { runId: 'gateway-run', sessionId: f.session.id, generation: 1, nativeRequestId: 'persisted-request', state: 'accepted' as const };
  f.context.getRun = () => run;
  let info: any = { id: 'native', location: { directory: f.session.cwd }, time: { busy: 1, idle: 2 }, outcome: 'succeeded' };
  let messages: any[] = [];
  let prompts = 0;
  adapter.connection = async () => {};
  adapter.http = async (path, method, body) => {
    if (path.endsWith('/prompt')) {
      prompts++;
      const message = { id: `msg_${prompts}`, type: 'user', sessionID: 'native', time: { created: 10 * prompts }, metadata: body?.metadata };
      messages.push(message); info = { ...info, time: { busy: 10 * prompts + 1, idle: 2 } };
      return { data: message };
    }
    if (path.includes('/message?')) return { data: messages, cursor: { next: null } };
    if (path.endsWith('/permission') || path.endsWith('/form')) return { data: [] };
    if (path.includes('/interrupt?resume=false')) return { interrupted: true };
    return { data: info };
  };
  const submit = async () => {
    await adapter.submit(f.session, { text: 'Synthetic protocol input', attachments: [], requestId: 'client', nativeRequestId: run.nativeRequestId, runId: run.runId, generation: 1 });
    await adapter.refreshing.get('native');
  };
  const terminal = async (outcome = 'succeeded') => {
    info = { ...info, outcome, time: { ...info.time, idle: info.time.busy + 1 } };
    adapter.event({ id: `end-${prompts}`, type: `session.execution.${outcome}`, data: { sessionID: 'native' } });
    await adapter.refreshing.get('native');
  };
  return { ...f, adapter, run, submit, terminal, get prompts() { return prompts; }, setInfo(value: any) { info = value; }, setMessages(value: any[]) { messages = value; } };
}

test('OpenCode owned input reaches native completion and a second turn keeps the same session', async () => {
  const f = openCodeHarness();
  await f.submit(); assert.equal(f.session.state, 'running');
  await f.terminal(); assert.equal(f.session.state, 'completed');
  assert.equal(f.events.filter(e => e.type === 'run.updated').at(-1)?.data.nativeInputId, 'msg_1');
  f.run.runId = 'gateway-run-2'; f.run.nativeRequestId = 'persisted-request-2'; f.session.runId = f.run.runId; f.session.state = 'accepted';
  await f.submit(); assert.equal(f.session.state, 'running');
  await f.terminal(); assert.equal(f.session.state, 'completed'); assert.equal(f.prompts, 2); assert.equal(f.session.ref.nativeSessionId, 'native');
});

test('OpenCode interrupt acknowledgement remains separate from an attributed native interrupted outcome', async () => {
  const f = openCodeHarness(); await f.submit(); f.session.state = 'cancel_requested';
  await f.adapter.requestCancel(f.session); assert.equal(f.session.state, 'cancel_requested');
  await f.terminal('interrupted'); assert.equal(f.session.state, 'cancelled');
});

test('OpenCode restart recovery proves input identity and native time boundaries without resubmitting', async () => {
  const f = openCodeHarness(); f.session.state = 'uncertain';
  f.setMessages([{ id: 'msg_recovered', type: 'user', sessionID: 'native', time: { created: 100 }, metadata: { aiMaidCafeRequestId: 'persisted-request' } }]);
  f.setInfo({ id: 'native', outcome: 'failed', time: { busy: 101, idle: 102 } });
  await f.adapter.reconcile('native', f.session.id); assert.equal(f.session.state, 'failed'); assert.equal(f.prompts, 0);
});

test('OpenCode does not apply prior execution or a later desktop input outcome to the gateway run', async () => {
  for (const competing of [false, true]) {
    const f = openCodeHarness(); f.session.state = 'uncertain';
    const messages: any[] = [{ id: 'msg_ours', type: 'user', sessionID: 'native', time: { created: 100 }, metadata: { aiMaidCafeRequestId: 'persisted-request' } }];
    if (competing) messages.push({ id: 'msg_desktop', type: 'user', sessionID: 'native', time: { created: 102 } });
    f.setMessages(messages); f.setInfo({ id: 'native', outcome: 'succeeded', time: { busy: competing ? 103 : 99, idle: 104 } });
    await f.adapter.reconcile('native', f.session.id); assert.equal(f.session.state, 'uncertain');
  }
});

test('OpenCode rejects a changed authorized native workspace and service incarnation', async () => {
  const f = openCodeHarness(); f.setInfo({ id: 'native', location: { directory: 'another-workspace' } });
  await assert.rejects(f.adapter.reconcile('native', f.session.id), /workspace changed/);
  f.session.binding = { runtimeInstanceId: 'runtime', nativeSessionId: 'native', generation: 1, state: 'disconnected', nativeIdentity: 'original', capabilities: f.adapter.control };
  f.adapter.endpoint = { url: 'http://127.0.0.1:1', identity: 'replacement', headers: {} };
  await assert.rejects(f.adapter.resumeSession(f.session), /identity changed/);
});

test('Claude recreating a Query advances only its handle generation and refuses stale input', async () => {
  const f = nativeContext('claude-code'); let generation = 0; const opened: string[][] = [];
  f.context.openConnection = (ids, identity) => { assert.match(identity!, /^claude-query:/); opened.push(ids!); return ++generation; };
  const adapter = new ClaudeCodeAdapter('claude-code', { command: process.execPath, expectedVersion: '' }, f.context);
  const outputs: InputQueue<any>[] = []; const inputs: InputQueue<any>[] = [];
  adapter.checkVersion = async () => {};
  adapter.loadSdk = async () => ({ query: ({ prompt }: any) => {
    inputs.push(prompt); const output = new InputQueue<any>(); outputs.push(output);
    output.push({ type: 'system', subtype: 'init', session_id: 'native' });
    return { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), interrupt: async () => ({}), return: async () => output.close() };
  } });
  try {
    const created = await adapter.createSession(f.session.id, f.workspace); f.session.binding = created.binding;
    assert.equal(created.binding.generation, 1); const first = created.binding.nativeIdentity;
    const live = adapter.live.get(f.session.id)!; outputs[0].close(); await live.consumer;
    await adapter.resumeSession(f.session); assert.equal(f.session.binding.generation, 2); assert.notEqual(f.session.binding.nativeIdentity, first);
    await assert.rejects(adapter.submit(f.session, { text: 'stale', requestId: 'stale', attachments: [], generation: 1 }), /generation changed/);
    assert.equal(inputs[1].items.length, 0);
    await adapter.submit(f.session, { text: 'new', requestId: 'new', attachments: [], generation: 2 }); assert.equal(inputs[1].items.length, 1);
    assert.deepEqual(opened, [[f.session.id], [f.session.id]]);
  } finally { adapter.close(); outputs.forEach(output => output.close()); }
});

test('Codex active shared-thread attachment supplies native acceptance to create an observed run', async () => {
  const f = nativeContext(); const adapter = new CodexAdapter('codex', { command: 'synthetic', expectedVersion: '', runtimeIdentity: 'server', endpoint: 'ws://127.0.0.1:1' }, f.context);
  const rpc = { request: async () => ({ thread: { id: 'native', cwd: f.session.cwd, status: { type: 'active' }, turns: [{ id: 'turn', status: 'inProgress', items: [] }] } }) };
  adapter.rpc = rpc as any; adapter.connectionIdentity = 'server'; adapter.connectionEndpoint = adapter.config.endpoint; adapter.connection = async () => rpc as any;
  await adapter.attachExistingSession(f.session, 'server');
  assert.equal(f.events.at(-1)?.data.nativeAccepted, true); assert.equal(f.events.at(-1)?.data.nativeRunId, 'turn');
});

test('Codex permission replies omit null capabilities and native resolution can identify a request without threadId', async () => {
  const f = nativeContext(); const adapter = new CodexAdapter('codex', { command: 'synthetic', expectedVersion: '' }, f.context);
  const responses: any[] = []; const rejections: any[] = [];
  adapter.rpc = { respond: (id: unknown, result: unknown) => responses.push({ id, result }), reject: (id: unknown) => rejections.push(id) } as any;
  adapter.byNative.set('native', f.session.id);
  adapter.request({ id: 7, method: 'item/permissions/requestApproval', params: { threadId: 'native', permissions: { network: null, fileSystem: { read: ['/tmp'], write: null } } } });
  const interaction = f.session.interactions.at(-1)!;
  await adapter.respond(f.session, interaction, { interactionId: interaction.id, epoch: 1, choiceId: 'turn' });
  assert.deepEqual(responses[0], { id: 7, result: { scope: 'turn', permissions: { fileSystem: { read: ['/tmp'], write: null } } } });
  adapter.request({ id: '8', method: 'item/commandExecution/requestApproval', params: { threadId: 'native', command: 'test' } });
  adapter.notification({ method: 'serverRequest/resolved', params: { requestId: '8' } });
  assert.equal(adapter.approvals.size, 0); assert.equal(f.session.interactions.at(-1)?.status, 'resolved');
  f.session.nativeRunId = 'new-turn'; f.session.state = 'running';
  adapter.request({ id: 'old', method: 'item/commandExecution/requestApproval', params: { threadId: 'native', turnId: 'old-turn' } });
  assert.deepEqual(rejections, ['old']); assert.equal(adapter.approvals.size, 0);
});

test('Core rejects an old Claude generation before dispatch and accepts refreshed continuation after Query exit', async () => {
  const f = await fixture(); const outputs: InputQueue<any>[] = []; const inputs: InputQueue<any>[] = [];
  const adapter = new ClaudeCodeAdapter('claude-code', { command: process.execPath, expectedVersion: '' }, f.core.context('claude-code'));
  adapter.checkVersion = async () => {};
  adapter.probe = async () => ({ ...(await f.adapter.probe()), id: 'claude-code', runtimeInstanceId: adapter.context.runtimeInstanceId });
  adapter.loadSdk = async () => ({ query: ({ prompt }: any) => {
    inputs.push(prompt); const output = new InputQueue<any>(); outputs.push(output); output.push({ type: 'system', subtype: 'init', session_id: 'claude-native' });
    return { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), interrupt: async () => ({}), return: async () => output.close() };
  } });
  f.core.adapters.set('claude-code', adapter);
  try {
    const s = await f.core.createSession('device', 'create-claude', f.w.id, 'claude-code');
    const initial = command(s); f.core.accept('device', initial); await f.core.drain();
    const input = inputs[0].items[0]; assert.ok(input);
    adapter.frame(s.id, { type: 'result', session_id: 'claude-native', user_message_uuid: input.uuid, uuid: 'result-1', subtype: 'success', is_error: false, terminal_reason: 'completed' });
    assert.equal(f.core.session(s.id).state, 'completed');
    const consumer = adapter.live.get(s.id)!.consumer; outputs[0].close(); await consumer;
    const stale = command(f.core.session(s.id)); f.core.accept('device', stale); await f.core.drain();
    assert.equal(f.store.getReceipt('device', stale.clientRequestId)?.status, 'rejected');
    assert.equal(inputs[1].items.length, 0); assert.equal(f.core.session(s.id).binding!.generation, s.binding!.generation + 1);
    const fresh = command(f.core.session(s.id)); f.core.accept('device', fresh); await f.core.drain();
    assert.equal(inputs[1].items.length, 1); assert.equal(outputs.length, 2);
    assert.notEqual(f.core.session(s.id).runId, f.store.getReceipt('device', initial.clientRequestId)?.runId);
  } finally { adapter.close(); outputs.forEach(output => output.close()); await f.close(); }
});

test('OpenCode provider stays within the registered service directory and preserves opaque message pagination', async () => {
  const f = openCodeHarness(); const adapter = f.adapter; const paths: string[] = [];
  adapter.probe = async () => ({ id: 'opencode', runtimeInstanceId: 'runtime', version: '2.3.0', installed: true, verified: false, authentication: 'unknown', detail: 'synthetic', models: [], capabilities: { text: true, image: false, files: false, history: true, permission: true, questions: true, cancelScope: 'session', models: false }, connectionState: 'attached', nativeIdentity: 'incarnation' });
  adapter.http = async path => {
    paths.push(path);
    if (path.startsWith('/api/session?')) return { data: [{ id: 'native', title: 'Owned', location: { directory: f.session.cwd } }, { id: 'other', location: { directory: 'elsewhere' } }], cursor: { next: 'next' } };
    if (path.includes('/message?')) return { data: [{ id: 'msg', sessionID: 'native', type: 'assistant', payload: { text: 'answer' } }], cursor: { next: null } };
    return { data: { id: 'native', location: { directory: f.session.cwd }, time: { created: 1 } } };
  };
  const provider = new OpenCodeExternalProvider(adapter);
  assert.deepEqual((await provider.discover(f.session.cwd)).items.map(i => i.nativeId), ['native']);
  assert.deepEqual((await provider.history(f.session.cwd, 'native', 'opaque/+')).items, [{ nativeEventId: 'msg', role: 'assistant', text: 'answer' }]);
  const historyPath = paths.find(path => path.includes('/message?'))!; assert.ok(historyPath.includes('cursor=opaque%2F%2B')); assert.ok(!historyPath.includes('order='));
});

test('OpenCode attachment validates same service, native session and workspace before granting a binding', async () => {
  const f = openCodeHarness(); f.session.runId = undefined; f.session.state = 'uncertain';
  f.adapter.endpoint = { url: 'http://127.0.0.1:1', headers: {}, identity: 'registered' };
  f.setInfo({ id: 'native', location: { directory: f.session.cwd }, time: { created: 1, busy: 2, idle: 3 }, outcome: 'succeeded' });
  await assert.rejects(f.adapter.attachExistingSession(f.session, 'wrong'), /identity mismatch/);
  const binding = await f.adapter.attachExistingSession(f.session, 'registered'); assert.equal(binding.nativeIdentity, 'registered'); assert.equal(f.session.state, 'completed');
  f.adapter.byNative.clear(); f.session.binding = undefined;
  f.setInfo({ id: 'native', location: { directory: 'outside' }, time: { created: 1 } });
  await assert.rejects(f.adapter.attachExistingSession(f.session, 'registered'), /workspace or state/); assert.equal(f.session.binding, undefined);
});

test('Codex attachment and native replay reuse the imported historical message identity', () => {
  const f = nativeContext(); const adapter = new CodexAdapter('codex', { command: 'synthetic', expectedVersion: '' }, f.context);
  f.session.externalSource = { namespace: 'history', nativeId: 'native', generation: 'history', profile: 'test', readOnly: true };
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const candidate = digest(['host', 'codex', 'history', 'native']); const imported = digest([candidate, 'turn:item']);
  f.session.messages.push({ id: imported, role: 'assistant', text: 'historical', complete: true });
  assert.equal(adapter.messageId(f.session.id, 'item', 'turn'), imported);
  assert.equal(adapter.messageId(f.session.id, 'new', 'turn'), 'new');
});

test('OpenCode observed execution persists its native busy boundary and reconciles after adapter replacement', async () => {
  const f = await fixture();
  const adapter = new OpenCodeAdapter('opencode', { command: 'synthetic', expectedVersion: '' }, f.core.context('opencode'));
  adapter.connection = async () => {}; adapter.endpoint = { url: 'http://127.0.0.1:1', headers: {}, identity: 'native-service' };
  adapter.probe = async () => ({ ...(await f.adapter.probe()), id: 'opencode', runtimeInstanceId: adapter.context.runtimeInstanceId });
  let info: any = { id: 'native', location: { directory: f.w.path }, time: { created: 1, busy: 10, idle: 2 } };
  adapter.http = async path => path.includes('/message') || path.endsWith('/permission') || path.endsWith('/form') ? { data: [] } : { data: info };
  f.core.adapters.set('opencode', adapter);
  try {
    const s = await f.core.createSession('device', 'create-opencode', f.w.id, 'opencode');
    await adapter.reconcile('native', s.id);
    const observing = f.core.session(s.id); assert.equal(observing.state, 'running'); assert.ok(observing.runId);
    assert.equal(f.store.get<any>('run', observing.runId!)?.nativeStartedAt, 10);
    const replacement = new OpenCodeAdapter('opencode', { command: 'synthetic', expectedVersion: '' }, f.core.context('opencode')); replacement.http = adapter.http;
    info = { ...info, outcome: 'interrupted', time: { created: 1, busy: 20, idle: 21 } };
    await replacement.reconcile('native', s.id); assert.equal(f.core.session(s.id).state, 'uncertain');
    info = { ...info, time: { created: 1, busy: 10, idle: 12 } };
    await replacement.reconcile('native', s.id); assert.equal(f.core.session(s.id).state, 'cancelled');
    assert.equal(f.core.session(s.id).nativeRunId, undefined);
  } finally { adapter.close(); await f.close(); }
});

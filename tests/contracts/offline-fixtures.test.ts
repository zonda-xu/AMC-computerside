import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Ajv } from 'ajv';
import { nativeSchemas, extraSchemas, schemaProvenance } from '../fixtures/four-platform/native.schemas.ts';

const root = new URL('../fixtures/four-platform/', import.meta.url);
const ajv = new Ajv({ strict: true });
const object = { type: 'object', minProperties: 1 };
const pair = {
  type: 'object', required: ['request', 'response'],
  properties: { request: object, response: object }
};
const validateFixture = ajv.compile({
  type: 'object',
  required: ['fixtureVersion', 'engine', 'version', 'provenance', 'nativeVerified', 'sessionId', 'runId', 'create', 'submit', 'events', 'approvals', 'question', 'cancelRace', 'continuation'],
  properties: {
    fixtureVersion: { const: 1 }, engine: { enum: ['codex', 'claude-code', 'opencode', 'deepseek-harness'] },
    version: { type: 'string', minLength: 1 }, provenance: { type: 'string', pattern: '^synthetic-plan-appendix-' },
    nativeVerified: { const: false }, sessionId: { type: 'string', minLength: 1 }, runId: { type: 'string', minLength: 1 },
    create: pair, submit: pair, question: pair, continuation: object,
    events: { type: 'array', minItems: 4, items: object },
    approvals: { type: 'array', minItems: 2, items: { type: 'object', required: ['request', 'response'], properties: { request: object, response: { anyOf: [object, { enum: ['allowed-once', 'rejected'] }] } } } },
    cancelRace: { ...pair, required: ['request', 'response', 'terminalBeforeResponse'], properties: { ...pair.properties, terminalBeforeResponse: object } }
  }
});

async function load(name: string) {
  return JSON.parse(await readFile(new URL(name, root), 'utf8'));
}

test('manual appendix request/event schemas validate every engine sample and reject malformed native fields', async () => {
  assert.match(schemaProvenance.extraction, /manual excerpt; not generated/);
  assert.equal(schemaProvenance.nativeVerified, false);
  for (const [engine, schemas] of Object.entries(nativeSchemas)) {
    const f = await load(`${engine}.json`);
    const request = ajv.compile(schemas.request);
    const event = ajv.compile(schemas.event);
    const pairs = [f.create, f.submit, ...f.approvals, f.question, f.cancelRace];
    if (engine === 'claude-code') {
      pairs.push({ request: f.continuation.sameQuery.input }, { request: f.continuation.afterQueryEnds });
      for (const response of [f.create.response, f.submit.response]) assert.equal(event(response), true, JSON.stringify(event.errors));
    } else pairs.push(f.continuation);
    for (const pair of pairs) assert.equal(request(pair.request), true, `${engine}: ${JSON.stringify(request.errors)}`);
    for (const sample of [...f.events, f.cancelRace.terminalBeforeResponse, ...f.approvals.flatMap((p: any) => p.event ? [p.event] : [])]) {
      assert.equal(event(sample), true, `${engine}: ${JSON.stringify(event.errors)}`);
      const bad = structuredClone(sample);
      delete bad[engine === 'codex' ? 'params' : engine === 'deepseek-harness' ? (bad.type === 'event' ? 'event' : 'frame') : engine === 'opencode' ? 'data' : 'session_id'];
      assert.equal(event(bad), false, engine);
    }
  }
  const codex = await load('codex.json');
  const codexRequest = ajv.compile(nativeSchemas.codex.request);
  const permission = ajv.compile(extraSchemas.permissionResponse);
  for (const id of [true, null, {}, [], 1.5]) {
    assert.equal(codexRequest({ ...codex.submit.request, id }), false);
    assert.equal(permission({ ...codex.approvals[2].response, id }), false);
  }
  for (const id of [101, '101']) assert.equal(codexRequest({ ...codex.submit.request, id }), true);
  assert.equal(permission(codex.approvals[2].response), true);
  for (const scope of ['always', true, null]) assert.equal(permission({ ...codex.approvals[2].response, result: { ...codex.approvals[2].response.result, scope } }), false);
  const claude = await load('claude-code.json');
  const claudeRequest = ajv.compile(nativeSchemas['claude-code'].request);
  assert.equal(claudeRequest({ ...claude.approvals[0].request, options: { ...claude.approvals[0].request.options, requestId: 101 } }), false);
  const result = ajv.compile(extraSchemas.claudeResult);
  const final = claude.events.at(-1);
  for (const is_error of ['false', 0, null]) assert.equal(result({ ...final, is_error }), false);
  const missingError = structuredClone(final); delete missingError.is_error;
  assert.equal(result(missingError), false);
  assert.equal(result({ ...final, is_error: true }), true);
  assert.equal(terminal('claude-code', { ...final, is_error: true }), 'failed');
  const open = await load('opencode.json');
  const envelope = ajv.compile(nativeSchemas.opencode.event);
  for (const patch of [{ id: 12 }, { created: 'now' }, { data: [] }, { data: { ...open.events[1].data, ordinal: -1 } }]) assert.equal(envelope({ ...open.events[1], ...patch }), false);
  const validateForm = ajv.compile(extraSchemas.form);
  assert.equal(validateForm(open.question.form), true);
  for (const patch of [{ type: 'select' }, { required: 'true' }, { options: [{ label: 'All' }] }, { minimum: '0' }]) {
    const bad = structuredClone(open.question.form); Object.assign(bad.fields[0], patch);
    assert.equal(validateForm(bad), false);
  }
  const answer = ajv.compile(extraSchemas.formAnswer);
  assert.equal(answer(open.question.request.body.answer), true);
  for (const value of [null, {}, [true]]) assert.equal(answer({ test_scope: value }), false);
  const dsh = await load('deepseek-harness.json');
  const stream = ajv.compile(extraSchemas.streamFrame);
  const end = dsh.events.find((e: any) => e.frame?.type === 'end').frame;
  for (const index of [-1, 0.5, '1', null]) assert.equal(stream({ ...end, index }), false);
  assert.equal(stream({ ...end, outcome: { kind: 'committed', eventType: 'turn/end', seq: 4 } }), false);
  const validateReason = ajv.compile(extraSchemas.reason);
  for (const reason of [{ kind: 'success' }, { kind: 'aborted' }, { kind: 'aborted', reason: { kind: 'network' } }, { kind: 'error', error: 'failed' }]) assert.equal(validateReason(reason), false);
  for (const kind of ['completed', 'blocked', 'max-tokens', 'interrupted', 'forked']) assert.equal(validateReason({ kind }), true);
  const dshRequest = ajv.compile(nativeSchemas['deepseek-harness'].request);
  assert.equal(dshRequest({ ...dsh.submit.request, params: { ...dsh.submit.request.params, requestId: 1 } }), false);
  assert.equal(dshRequest({ ...dsh.create.request, params: { ...dsh.create.request.params, requestId: 'invented' } }), false);
  for (const [name, value] of [['follow', dsh.recovery.follow], ['page', dsh.recovery.page]] as const) {
    const validate = ajv.compile(extraSchemas[name]);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...value, afterSeq: 5 }), false);
  }
});

function terminal(engine: string, native: any): string {
  if (engine === 'codex') return ({ completed: 'completed', interrupted: 'cancelled', failed: 'failed' } as Record<string, string>)[native.params.turn.status] ?? 'uncertain';
  if (engine === 'claude-code') {
    if (native.is_error || native.terminal_reason === 'api_error') return 'failed';
    if (['aborted_streaming', 'aborted_tools'].includes(native.terminal_reason)) return 'cancelled';
    return native.subtype === 'success' && native.terminal_reason === 'completed' ? 'completed' : 'failed';
  }
  if (engine === 'opencode') return ({ 'session.execution.succeeded': 'completed', 'session.execution.failed': 'failed', 'session.execution.interrupted': 'cancelled' } as Record<string, string>)[native.type] ?? 'uncertain';
  return ({ completed: 'completed', aborted: 'cancelled', 'max-tokens': 'failed', error: 'failed' } as Record<string, string>)[native.event.data.reason.kind] ?? 'uncertain';
}

test('all four native-shaped fixtures pass AJV; missing and false provenance fields fail', async () => {
  assert.deepEqual((await readdir(root)).filter(n => n.endsWith('.json')).sort(), ['claude-code.json', 'codex.json', 'deepseek-harness.json', 'lifecycle.json', 'opencode.json']);
  for (const name of ['codex', 'claude-code', 'opencode', 'deepseek-harness']) {
    const f = await load(`${name}.json`);
    assert.equal(validateFixture(f), true, JSON.stringify(validateFixture.errors));
    assert.equal(f.engine, name);
    for (const field of ['sessionId', 'events', 'submit', 'cancelRace']) {
      const bad = structuredClone(f);
      delete bad[field];
      assert.equal(validateFixture(bad), false, field);
    }
    assert.equal(validateFixture({ ...f, nativeVerified: true }), false);
    assert.equal(terminal(name, f.events.at(-1)), 'completed');
    assert.equal(terminal(name, f.cancelRace.terminalBeforeResponse), 'completed');
  }
});

test('Codex preserves typed RPC IDs, distinct approval shapes, tool correlation and same-thread continuation', async () => {
  const f = await load('codex.json');
  for (const p of [f.create, f.submit, ...f.approvals, f.question, f.cancelRace, f.continuation]) assert.equal(p.request.id, p.response.id);
  assert.notEqual(f.approvals[0].response.id, f.approvals[1].response.id);
  assert.equal(f.create.response.result.thread.id, f.sessionId);
  assert.equal(f.submit.request.params.threadId, f.sessionId);
  assert.equal(f.submit.response.result.turn.id, f.runId);
  assert.equal(f.cancelRace.request.params.turnId, f.runId);
  assert.equal(f.cancelRace.request.method, 'turn/interrupt');
  assert.equal(f.cancelRace.request.params.threadId, f.sessionId);
  assert.equal(f.continuation.request.params.threadId, f.sessionId);
  assert.notEqual(f.continuation.response.result.turn.id, f.runId);
  assert.deepEqual(f.approvals.slice(0, 2).map((p: any) => p.response.result.decision), ['accept', 'decline']);
  const extra = f.approvals[2];
  assert.equal(extra.request.method, 'item/permissions/requestApproval');
  assert.deepEqual(extra.response.result.permissions.fileSystem, extra.request.params.permissions.fileSystem);
  assert.equal(extra.response.result.scope, 'turn');
  assert.equal(extra.response.result.decision, undefined);
  assert.deepEqual(Object.keys(f.question.response.result.answers), f.question.request.params.questions.map((q: any) => q.id));
  assert.deepEqual(f.question.response.result.answers.test_scope.answers, ['All']);
  const [start, delta, tool, result, final] = f.events;
  assert.equal(start.params.turn.id, f.runId);
  for (const e of f.events) assert.equal(e.params.threadId, f.sessionId);
  assert.equal(tool.params.item.id, result.params.item.id);
  assert.equal(result.params.item.exitCode, 0);
  assert.equal(delta.params.itemId, final.params.item.id);
  assert.equal(final.params.item.text, 'Tests passed.');
});

test('Claude uses SDK message correlation, exact question text keys and persistent Query/resume', async () => {
  const f = await load('claude-code.json');
  assert.equal(f.create.request.options.permissionMode, 'default');
  assert.equal(f.create.request.options.includePartialMessages, true);
  assert.match(f.create.request.options.pathToClaudeCodeExecutable, /^\//);
  assert.equal(f.create.response.session_id, f.sessionId);
  assert.equal(f.submit.request.uuid, f.runId);
  assert.equal(f.submit.response.user_message_uuid, f.runId);
  assert.equal(f.submit.response.session_id, f.sessionId);
  assert.equal(f.submit.response.type, 'stream_event');
  assert.equal(f.events.at(-1).user_message_uuid, f.runId);
  for (const e of f.events) assert.equal(e.session_id, f.sessionId);
  assert.equal(f.events[0].message.content[0].id, f.events[1].message.content[0].tool_use_id);
  assert.equal(f.events[2].message.content[0].text, f.events.at(-1).result);
  for (const p of [...f.approvals, f.question]) assert.equal(p.response.toolUseID, p.request.options.toolUseID);
  assert.deepEqual(f.approvals.map((p: any) => p.response.behavior), ['allow', 'deny']);
  assert.deepEqual(f.approvals[0].response.updatedInput, f.approvals[0].request.input);
  assert.equal(typeof f.approvals[1].response.message, 'string');
  assert.deepEqual(f.question.response.updatedInput.questions, f.question.request.input.questions);
  assert.deepEqual(Object.keys(f.question.response.updatedInput.answers), f.question.request.input.questions.map((q: any) => q.question));
  assert.equal(f.question.response.updatedInput.answers['Which tests?'], 'All');
  assert.deepEqual(f.cancelRace.response.still_queued, []);
  assert.equal(f.continuation.sameQuery.queryHandle, f.cancelRace.request.queryHandle);
  assert.notEqual(f.continuation.sameQuery.input.uuid, f.runId);
  assert.equal(f.continuation.afterQueryEnds.options.resume, f.sessionId);
  assert.notEqual(f.continuation.afterQueryEnds.options.forkSession, true);
});

test('OpenCode v2 preserves HTTP envelopes, permission request ID, typed form values and snapshot recovery', async () => {
  const f = await load('opencode.json');
  assert.match(f.sessionId, /^ses/);
  assert.match(f.runId, /^msg_/);
  assert.equal(f.create.request.path, '/api/session');
  assert.equal(f.create.response.body.data.id, f.sessionId);
  assert.equal(f.submit.request.path, `/api/session/${f.sessionId}/prompt`);
  assert.equal(f.submit.response.body.data.id, f.runId);
  assert.equal(f.submit.response.body.data.sessionID, f.sessionId);
  assert.equal(f.submit.response.body.data.type, 'user');
  assert.equal(f.submit.request.body.delivery, 'queue');
  for (const e of f.events) {
    assert.equal(e.data.sessionID, f.sessionId);
    assert.equal(typeof e.id, 'string');
    assert.equal(typeof e.created, 'number');
  }
  assert.equal(f.events[2].data.id, f.events[3].data.id);
  assert.equal(f.events[1].data.assistantMessageID, f.events[4].data.assistantMessageID);
  assert.equal(f.events[4].data.text, 'Tests passed.');
  for (const p of f.approvals) {
    assert.equal(p.request.path, `/api/session/${f.sessionId}/permission/${p.event.data.id}/reply`);
    assert.notEqual(p.event.id, p.event.data.id);
    assert.equal(p.response.status, 204);
  }
  assert.deepEqual(f.approvals.map((p: any) => p.request.body.decision), ['once', 'reject']);
  const answer = f.question.request.body.answer;
  assert.deepEqual(Object.keys(answer), f.question.form.fields.map((v: any) => v.key));
  assert.equal(answer.test_scope, f.question.form.fields[0].options[0].value);
  assert.notEqual(answer.test_scope, f.question.form.fields[0].options[0].label);
  const validAnswer = ajv.compile({ type: 'object', required: ['test_scope', 'include_integration', 'retries'], additionalProperties: false, properties: { test_scope: { enum: ['all', 'unit'] }, include_integration: { type: 'boolean' }, retries: { type: 'integer', minimum: 0, maximum: 3 } } });
  assert.equal(validAnswer(answer), true);
  assert.equal(validAnswer({ ...answer, include_integration: 'true' }), false);
  assert.equal(validAnswer({ ...answer, retries: 1.5 }), false);
  assert.equal(f.cancelRace.request.path, `/api/session/${f.sessionId}/interrupt?resume=false`);
  assert.equal(f.cancelRace.response.body.interrupted, false);
  assert.equal(f.continuation.response.body.data.sessionID, f.sessionId);
  assert.notEqual(f.continuation.response.body.data.id, f.runId);
  assert.equal(f.recovery.supportsReplay, false);
  assert.equal(f.recovery.secondStateRead, true);
  assert.deepEqual(f.recovery.requests, ['', '/message', '/permission', '/form'].map(s => `/api/session/${f.sessionId}${s}`));
  assert.equal(f.recovery.sessionResponse.data.outcome, 'succeeded');
  assert.deepEqual(f.recovery.pendingResponse.data, []);
});

test('DSH uses actual create ID, native resolver outcomes, stream commit and bounded page instead of replay cursor', async () => {
  const f = await load('deepseek-harness.json');
  assert.equal(f.create.request.params.requestId, undefined);
  assert.notEqual(f.create.request.params.sessionId, f.sessionId);
  assert.equal(f.create.response.sessionId, f.sessionId);
  assert.equal(f.submit.request.params.sessionId, f.sessionId);
  assert.equal(f.submit.request.params.requestId, f.runId);
  assert.equal(f.submit.response.accepted, true);
  assert.equal(f.submit.request.params.mode, 'queue');
  assert.deepEqual(f.approvals.map((p: any) => p.response), ['allowed-once', 'rejected']);
  assert.deepEqual(f.question.response.answers.map((a: any) => a.id), f.question.request.questions.map((q: any) => q.id));
  assert.deepEqual(f.question.response.answers[0].selected, ['All']);
  const durable = f.events.filter((e: any) => e.type === 'event').map((e: any) => e.event);
  assert.deepEqual(durable.map((e: any) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(durable[1].data.callId, durable[2].data.message.toolCallId);
  assert.deepEqual(JSON.parse(durable[1].data.arguments), { command: 'node --test' });
  const frames = f.events.filter((e: any) => e.type === 'assistant-stream').map((e: any) => e.frame);
  for (const frame of frames) {
    assert.equal(frame.attemptId, frames[0].attemptId);
    assert.equal(frame.revision, 1);
  }
  assert.equal(frames[1].index, 0);
  assert.equal(frames[2].index, 1);
  assert.equal(frames[2].outcome.seq, durable[3].seq);
  assert.equal(durable[3].data.stream[0].texts.join(''), 'Tests passed.');
  assert.equal(f.cancelRace.request.params.sessionId, f.sessionId);
  assert.equal(f.continuation.request.params.sessionId, f.sessionId);
  assert.notEqual(f.continuation.request.params.requestId, f.runId);
  assert.equal(f.recovery.follow.afterSeq, undefined);
  assert.equal(f.recovery.follow.cursor, undefined);
  assert.equal(f.recovery.page.throughSeq, f.recovery.snapshot.cursor);
  assert.equal(f.recovery.page.beforeSeq <= f.recovery.page.throughSeq, true);
  assert.equal(f.recovery.snapshot.header.id, f.sessionId);
  assert.equal(f.recovery.pendingInboxAfterCancel.length, 1);
  assert.equal(f.recovery.bridgeReconnectGeneration, 3);
  assert.equal(f.recovery.hostReplacementGeneration, 4);
});

test('native error/limit samples cannot produce success', async () => {
  const f = await load('lifecycle.json');
  assert.equal(f.errors.length, 4);
  for (const e of f.errors) {
    const validate = ajv.compile(nativeSchemas[e.engine].event);
    assert.equal(validate(e.native), true, JSON.stringify(validate.errors));
    assert.equal(terminal(e.engine, e.native), e.expectedState);
  }
  assert.equal(f.errors.find((e: any) => e.engine === 'claude-code').native.is_error, true);
  assert.equal(f.errors.find((e: any) => e.engine === 'deepseek-harness').native.event.data.reason.kind, 'max-tokens');
});

test('appendix F reference replay checks state, side effects, atomic publication and generations', async t => {
  const f = await load('lifecycle.json');
  const validate = ajv.compile({ type: 'object', required: ['fixtureVersion', 'provenance', 'nativeVerified', 'binding', 'scenarios', 'errors'], properties: {
    fixtureVersion: { const: 1 }, provenance: { const: 'synthetic-plan-appendix-F' }, nativeVerified: { const: false },
    binding: { type: 'object', required: ['generation'], properties: { generation: { type: 'integer', minimum: 1 } } },
    scenarios: { type: 'array', minItems: 7, maxItems: 7, items: { type: 'object', required: ['id', 'steps', 'expected'], properties: {
      id: { type: 'string' }, expected: object, steps: { type: 'array', minItems: 1, items: { type: 'object', required: ['op'], properties: { op: { enum: ['submit', 'accepted', 'started', 'delta', 'toolStart', 'toolResult', 'final', 'terminal', 'cancelIntent', 'cancelAck', 'approval', 'decision', 'phoneDisconnect', 'nativeAcceptedAckLost', 'gatewayRestart', 'recover', 'streamLost', 'bridgeReconnect', 'replaceRuntime'] } } } }
    } } }, errors: { type: 'array', minItems: 4, items: object }
  } });
  assert.equal(validate(f), true, JSON.stringify(validate.errors));
  assert.deepEqual(f.scenarios.map((s: any) => s.id), ['01-success', '02-stop-race', '03-approval-once', '04-restart-after-write', '05-native-stream-gap', '06-generation-change', '07-limits-and-errors']);
  for (const scenario of f.scenarios) await t.test(scenario.id, () => {
    let state = 'idle', generation = f.binding.generation, cancelPending = false;
    let nativeSubmits = 0, conflicts = 0, blockedSubmits = 0, settlements = 0, nativeResponses = 0, rejectedDecisions = 0, notifications = 0;
    const commands = new Map<string, string>();
    const pending = new Map<string, number>();
    const messages = new Map<string, string>();
    const tools = new Map<string, string>();
    const persisted: { seq: number; state: string; op: string }[] = [];
    const published: number[] = [];
    const isTerminal = () => ['completed', 'failed', 'cancelled'].includes(state);
    for (const s of scenario.steps) {
      switch (s.op) {
        case 'submit': {
          const key = JSON.stringify([s.deviceId, s.clientRequestId]);
          if (commands.has(key)) { if (commands.get(key) !== s.body) conflicts++; break; }
          if (cancelPending || !['idle', 'completed', 'failed', 'cancelled'].includes(state)) { blockedSubmits++; break; }
          commands.set(key, s.body);
          nativeSubmits++;
          state = 'received';
          break;
        }
        case 'accepted': if (!isTerminal()) state = 'accepted'; break;
        case 'started': if (!isTerminal()) state = 'running'; break;
        case 'delta': messages.set(s.messageId, (messages.get(s.messageId) ?? '') + s.text); break;
        case 'final': messages.set(s.messageId, s.text); break;
        case 'toolStart': tools.set(s.toolId, 'running'); break;
        case 'toolResult': assert.equal(tools.get(s.toolId), 'running'); tools.set(s.toolId, s.text); break;
        case 'cancelIntent': cancelPending = true; if (!isTerminal()) state = 'cancel_requested'; break;
        case 'cancelAck': cancelPending = false; break;
        case 'approval': pending.set(s.interactionId, s.generation); state = 'waiting_permission'; break;
        case 'decision':
          if (s.generation !== generation || pending.get(s.interactionId) !== generation) { rejectedDecisions++; break; }
          pending.delete(s.interactionId); settlements++; nativeResponses++; state = 'running'; break;
        case 'replaceRuntime': assert.equal(s.generation > generation, true); generation = s.generation; pending.clear(); state = 'uncertain'; break;
        case 'gatewayRestart': case 'streamLost': case 'nativeAcceptedAckLost': state = 'uncertain'; break;
        case 'recover':
          assert.notEqual(s.nativeReplay, true);
          if (s.messageId) messages.set(s.messageId, s.text);
          if (!isTerminal()) { state = s.state; if (state === 'completed') notifications++; }
          break;
        case 'terminal': if (!isTerminal()) { state = s.state; if (state === 'completed') notifications++; } break;
        case 'phoneDisconnect': case 'bridgeReconnect': break;
        default: assert.fail(`Unhandled operation: ${s.op}`);
      }
      const row = { seq: persisted.length + 1, state, op: s.op };
      persisted.push(row);
      published.push(row.seq);
      assert.equal(persisted.at(-1)?.state, state);
    }
    const actual = { state, generation, nativeSubmits, conflicts, blockedSubmits, settlements, nativeResponses, rejectedDecisions, pending: pending.size, notifications, finalText: [...messages.values()].join('') };
    for (const [key, value] of Object.entries(scenario.expected)) assert.deepEqual(actual[key as keyof typeof actual], value, key);
    assert.deepEqual(published, persisted.map(e => e.seq));
    assert.deepEqual(published, Array.from({ length: published.length }, (_, i) => i + 1));
    if (scenario.expected.finalText) assert.equal(messages.size, 1);
    if (scenario.id === '01-success') assert.equal(tools.get('tool-1'), '1 test passed');
  });
});

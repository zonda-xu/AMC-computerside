import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshAdapter } from '../../packages/adapters/deepseek-harness/index.ts';
import { nativeContext } from './fixtures/native-context.ts';
import { fixture } from '../helpers.ts';

test('DSH abandoned output closes as its own message and cannot merge with a retry at the same turn/step', async () => {
  const f = nativeContext('deepseek-harness');
  const adapter = new DshAdapter('deepseek-harness', { command: 'unused', expectedVersion: '' }, f.context);
  adapter.byNative.set('native', f.session.id);
  const frame = (frame: object) => adapter.follow('native', { type: 'assistant-stream', frame });
  await frame({ type: 'start', attemptId: 'first', revision: 1, turn: 1, step: 1 });
  await frame({ type: 'chunk', attemptId: 'first', revision: 1, index: 0, chunk: { type: 'text-delta', text: 'discarded' } });
  await frame({ type: 'end', attemptId: 'first', revision: 1, index: 1, outcome: { kind: 'abandoned' } });
  const abandoned = f.events.at(-1)!;
  assert.equal(abandoned.type, 'message.completed');
  assert.deepEqual(abandoned.data, { id: 'dsh:first:1', role: 'assistant', text: 'discarded', nativeKey: 'dsh:first:1', temporary: true, abandoned: true, attemptId: 'first', revision: 1 });
  const count = f.events.length;
  await frame({ type: 'end', attemptId: 'first', revision: 1, index: 1, outcome: { kind: 'abandoned' } });
  assert.equal(f.events.length, count);
  await frame({ type: 'start', attemptId: 'retry', revision: 2, turn: 1, step: 1 });
  await frame({ type: 'chunk', attemptId: 'retry', revision: 2, index: 0, chunk: { type: 'text-delta', text: 'partial' } });
  await frame({ type: 'end', attemptId: 'retry', revision: 2, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } });
  adapter.durable('native', { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, stream: [{ type: 'text-chunks', texts: ['authoritative'] }] } });
  const final = f.events.at(-1)!;
  assert.equal(final.data.id, 'dsh:retry:2');
  assert.equal(final.data.nativeKey, '1:1');
  assert.equal(final.data.temporary, false);
  assert.equal(final.data.abandoned, false);
  assert.equal(final.data.text, 'authoritative');
  assert.equal(final.data.attemptId, 'retry');
  assert.equal(final.data.revision, 2);
  assert.notEqual(final.data.id, abandoned.data.id);
  const messages = new Map(f.events.filter(e => e.type === 'message.completed').map(e => [e.data.id, e.data]));
  assert.equal(messages.size, 2);
  assert.equal(messages.get('dsh:first:1')?.abandoned, true);
  assert.equal(messages.get('dsh:retry:2')?.text, 'authoritative');
  assert.equal(f.events.some(e => e.type === 'tool.updated' || e.type === 'run.updated'), false);
});

test('DSH snapshot prefix and live chunks share attempt identity; final-before-end replaces once including empty text', async () => {
  for (const text of ['final text', '']) {
    const f = nativeContext('deepseek-harness');
    const adapter = new DshAdapter('deepseek-harness', { command: 'unused', expectedVersion: '' }, f.context);
    adapter.byNative.set('native', f.session.id);
    await adapter.follow('native', { type: 'snapshot', records: [], hasMore: false, assistantStream: { revision: 3, activeAttempt: { attemptId: 'restored', turn: 2, step: 1, nextIndex: 2, stream: [{ type: 'text-delta', text: 'prefix' }] } } });
    await adapter.follow('native', { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'restored', revision: 3, index: 2, chunk: { type: 'text-delta', text: ' suffix' } } });
    assert.equal(f.events.at(-1)?.data.text, 'prefix suffix');
    adapter.durable('native', { type: 'assistant/message', seq: 7, data: { turn: 2, step: 1, stream: [{ type: 'text-delta', text }] } });
    await adapter.follow('native', { type: 'assistant-stream', frame: { type: 'end', attemptId: 'restored', revision: 3, index: 3, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 7 } } });
    assert.equal(f.events.at(-1)?.data.text, text);
    assert.equal(f.events.at(-1)?.data.temporary, false);
    assert.equal(new Set(f.events.map(e => e.data.id)).size, 1);
  }
});

test('DSH committed assistant/attempt stays independent from the later formal answer', async () => {
  const f = nativeContext('deepseek-harness');
  const adapter = new DshAdapter('deepseek-harness', { command: 'unused', expectedVersion: '' }, f.context);
  adapter.byNative.set('native', f.session.id);
  await adapter.follow('native', { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt', revision: 1, turn: 1, step: 1 } });
  adapter.durable('native', { type: 'assistant/attempt', seq: 1, data: { turn: 1, step: 1, stream: [{ type: 'text-delta', text: 'attempt' }] } });
  adapter.durable('native', { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, stream: [{ type: 'text-delta', text: 'answer' }] } });
  assert.notEqual(f.events[0].data.id, f.events[1].data.id);
  assert.notEqual(f.events[0].data.nativeKey, f.events[1].data.nativeKey);
  assert.equal(f.events[0].data.temporary, true);
  assert.equal(f.events[1].data.temporary, false);
});

test('DSH persisted abandoned fact and committed replacement remain two independent projected messages', async () => {
  const f = await fixture();
  try {
    const adapter = new DshAdapter('deepseek-harness', { command: 'unused', expectedVersion: '' }, f.adapter.context);
    const native = f.s.ref.nativeSessionId;
    adapter.byNative.set(native, f.s.id);
    const frame = (frame: object) => adapter.follow(native, { type: 'assistant-stream', frame });
    await frame({ type: 'start', attemptId: 'abandoned', revision: 1, turn: 1, step: 1 });
    await frame({ type: 'chunk', attemptId: 'abandoned', revision: 1, index: 0, chunk: { type: 'text-delta', text: 'abandoned text' } });
    await frame({ type: 'end', attemptId: 'abandoned', revision: 1, index: 1, outcome: { kind: 'abandoned' } });
    await frame({ type: 'start', attemptId: 'committed', revision: 2, turn: 1, step: 1 });
    await frame({ type: 'chunk', attemptId: 'committed', revision: 2, index: 0, chunk: { type: 'text-delta', text: 'partial' } });
    await frame({ type: 'end', attemptId: 'committed', revision: 2, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 10 } });
    adapter.durable(native, { type: 'assistant/message', seq: 10, data: { turn: 1, step: 1, stream: [{ type: 'text-delta', text: 'final' }] } });
    const messages = f.core.session(f.s.id).messages;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].text, 'abandoned text');
    assert.equal(messages[0].complete, true);
    assert.equal(messages[1].id, 'dsh:committed:2');
    assert.equal(messages[1].text, 'final');
    assert.equal(messages[1].complete, true);
    assert.notEqual(messages[0].nativeKey, messages[1].nativeKey);
  } finally {
    await f.close();
  }
});

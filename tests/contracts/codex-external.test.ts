import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { fixture } from '../helpers.ts';
import { CodexAdapter } from '../../packages/adapters/codex/index.ts';
import { CodexExternalProvider } from '../../packages/adapters/codex/external.ts';
import { StdioRpc } from '../../packages/adapters/common/rpc.ts';

test('Codex alpha.4.1 schema fixtures retain their exact release provenance and bytes', async () => {
  const source: { package: string; version: string; gitCommit: string; schemas: Record<string, string> } = JSON.parse(await readFile(new URL('./codex-generated/alpha4.1/source.json', import.meta.url), 'utf8'));
  assert.equal(source.package, '@openai/codex'); assert.equal(source.version, '0.167.0-alpha.4.1');
  assert.equal(source.gitCommit, 'd2c035639366e0bf2c316aa2065c24aabc12bcdc'); assert.equal(Object.keys(source.schemas).length, 6);
  for (const [name, digest] of Object.entries(source.schemas)) {
    const bytes = await readFile(new URL('./codex-generated/alpha4.1/' + name, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
  }
});

test('Codex alpha.4.1 external reads match exact upstream request and turn response schemas without resume or mutation', async t => {
  const f = await fixture();
  const adapter = new CodexAdapter('codex', { command: 'fixture-only', expectedVersion: 'codex-cli 0.167.0-alpha.4.1' }, f.adapter.context);
  const rpc = new StdioRpc(process.execPath, [fileURLToPath(new URL('./fixtures/rpc-agent.mjs', import.meta.url))], f.w.path, process.env);
  const exited = new Promise<void>(resolve => rpc.process.once('close', () => resolve()));
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const validators = new Map<string, ValidateFunction>();
  for (const [method, name] of [['thread/list', 'ThreadList'], ['thread/read', 'ThreadRead'], ['thread/turns/list', 'ThreadTurnsList']]) {
    validators.set(method, ajv.compile(JSON.parse(await readFile(new URL(`./codex-generated/alpha4.1/${name}Params.json`, import.meta.url), 'utf8'))));
  }
  const validTurns = ajv.compile(JSON.parse(await readFile(new URL('./codex-generated/alpha4.1/ThreadTurnsListResponse.json', import.meta.url), 'utf8')));
  const calls: string[] = []; let view = 'full'; let changed = false; let runtimeVersion = adapter.config.expectedVersion;
  t.mock.method(adapter, 'probe', async () => ({ ...await f.adapter.probe(), version: runtimeVersion }));
  t.mock.method(adapter, 'connection', async () => rpc);
  t.mock.method(rpc, 'request', async (method: string, params: object) => {
    calls.push(method); const validate = validators.get(method);
    assert.ok(validate, 'Only verified read methods may be called'); assert.ok(validate(params), JSON.stringify(validate.errors));
    if (method === 'thread/list') return { data: [{ id: 'native', cwd: f.w.path, preview: 'Fixture' }], nextCursor: 'opaque-next' };
    if (method === 'thread/read') return { thread: { id: 'native', cwd: changed ? f.wb.path : f.w.path } };
    const result = { data: [{ id: 'turn', status: 'completed', itemsView: view, items: [
      { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'Fixture prompt' }] },
      { type: 'agentMessage', id: 'assistant', text: 'Fixture answer' },
      { type: 'reasoning', id: 'reasoning', summary: ['Fixture summary'], content: [] },
      { type: 'plan', id: 'plan', text: 'Not imported as an instruction' }
    ] }], nextCursor: null };
    assert.ok(validTurns(result), JSON.stringify(validTurns.errors)); return result;
  });
  try {
    const provider = new CodexExternalProvider(adapter); const profile = await provider.profile();
    assert.equal(profile.profile, 'codex-app-server-0.167.0-alpha.4.1'); assert.equal(profile.submit.state, 'unverified');
    assert.equal((await provider.discover(f.w.path)).cursor, 'opaque-next');
    const history = await provider.history(f.w.path, 'native', 'opaque-turn-cursor');
    assert.deepEqual(history.items.map(item => item.role), ['user', 'assistant', 'reasoning']);
    assert.deepEqual(history.items.map(item => item.nativeEventId), ['turn:user', 'turn:assistant', 'turn:reasoning']);
    assert.deepEqual(calls, ['thread/list', 'thread/read', 'thread/turns/list']);
    view = 'summary'; await assert.rejects(() => provider.history(f.w.path, 'native'), /incomplete/);
    changed = true; const before = calls.length; await assert.rejects(() => provider.history(f.w.path, 'native'), /identity changed/); assert.equal(calls.length, before + 1);
    adapter.config.expectedVersion = 'codex-cli 0.167.0-alpha.4';
    assert.equal((await provider.profile()).history.state, 'unverified');
    await assert.rejects(() => provider.discover(f.w.path), /verified profile/);
    runtimeVersion = adapter.config.expectedVersion;
    assert.equal((await provider.profile()).history.state, 'unverified');
  } finally { rpc.close(); await exited; await f.close(); }
});

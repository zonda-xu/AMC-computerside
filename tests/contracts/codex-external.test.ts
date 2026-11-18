import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
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

test('Codex 0.169 external reads use thread/read turns without legacy pagination or mutation', async t => {
  const f = await fixture();
  const adapter = new CodexAdapter('codex', { command: 'fixture-only', expectedVersion: 'codex-cli 0.169.0' }, f.adapter.context);
  const rpc = new StdioRpc(process.execPath, [fileURLToPath(new URL('./fixtures/rpc-agent.mjs', import.meta.url))], f.w.path, process.env);
  const exited = new Promise<void>(resolve => rpc.process.once('close', () => resolve()));
  const calls: string[] = []; let view = 'full'; let changed = false; let runtimeVersion = adapter.config.expectedVersion;
  t.mock.method(adapter, 'probe', async () => ({ ...await f.adapter.probe(), version: runtimeVersion }));
  t.mock.method(adapter, 'connection', async () => rpc);
  t.mock.method(rpc, 'request', async (method: string, params: object) => {
    calls.push(method);
    if (method === 'thread/list') { assert.deepEqual(params,{cwd:f.w.path,cursor:undefined,limit:50,currentAccountOnly:true});return { data: [{ id: 'native', cwd: f.w.path, preview: 'Fixture' }], nextCursor: 'opaque-next' }; }
    assert.equal(method,'thread/read');assert.deepEqual(params,{threadId:'native',includeTurns:true});
    return { thread: { id: 'native', cwd: changed ? f.wb.path : f.w.path, turns: [{ id: 'turn', status: 'completed', items: view==='full'?[
      { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'Fixture prompt' }] },
      { type: 'agentMessage', id: 'assistant', text: 'Fixture answer' },
      { type: 'reasoning', id: 'reasoning', summary: ['Fixture summary'], content: [] },
      { type: 'plan', id: 'plan', text: 'Not imported as an instruction' }
    ]:undefined }] } };
  });
  try {
    const provider = new CodexExternalProvider(adapter); const profile = await provider.profile();
    assert.equal(profile.profile, 'codex-app-server-0.169.0'); assert.equal(profile.submit.state, 'unverified');
    assert.equal((await provider.discover(f.w.path)).cursor, 'opaque-next');
    await assert.rejects(provider.history(f.w.path,'native','legacy-cursor'),/legacy turn-page cursor/);
    const history = await provider.history(f.w.path, 'native');
    assert.deepEqual(history.items.map(item => item.role), ['user', 'assistant', 'reasoning']);
    assert.deepEqual(history.items.map(item => item.nativeEventId), ['turn:user', 'turn:assistant', 'turn:reasoning']);
    assert.deepEqual(calls, ['thread/list', 'thread/read']);
    view = 'summary'; await assert.rejects(() => provider.history(f.w.path, 'native'), /incomplete/);
    changed = true; const before = calls.length; await assert.rejects(() => provider.history(f.w.path, 'native'), /identity changed/); assert.equal(calls.length, before + 1);
    for(const version of ['codex-cli 0.167.0-alpha.4.1','codex-cli 0.167.1']){
      adapter.config.expectedVersion=version;
      assert.equal((await provider.profile()).history.state,'unverified');
      runtimeVersion=version;
      const legacy=await provider.profile();assert.equal(legacy.profile,'');assert.equal(legacy.discover.state,'unverified');assert.equal(legacy.history.state,'unverified');assert.equal(legacy.submit.state,'unverified');
      const count=calls.length;await assert.rejects(()=>provider.discover(f.w.path),/verified profile/);await assert.rejects(()=>provider.history(f.w.path,'native'),/profile unavailable/);assert.equal(calls.length,count);
    }
  } finally { rpc.close(); await exited; await f.close(); }
});

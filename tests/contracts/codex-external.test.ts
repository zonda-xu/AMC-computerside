import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { toNamespacedPath } from 'node:path';
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

test('Codex keeps the same persisted source across versions and negotiates legacy and paginated history', async t => {
  const f = await fixture();
  const adapter = new CodexAdapter('codex', { command: 'fixture-only', expectedVersion: 'codex-cli 0.169.0' }, f.adapter.context);
  const rpc = new StdioRpc(process.execPath, [fileURLToPath(new URL('./fixtures/rpc-agent.mjs', import.meta.url))], f.w.path, process.env);
  const exited = new Promise<void>(resolve => rpc.process.once('close', () => resolve()));
  const calls: string[] = []; let view = 'full'; let changed = false; let paginated = false;
  adapter.observedVersion = 'codex-cli 0.167.1';
  t.mock.method(adapter, 'connection', async () => rpc);
  t.mock.method(rpc, 'request', async (method: string, params: Record<string,unknown>) => {
    calls.push(method);
    if (method === 'thread/list') {
      if(params.limit===50)assert.deepEqual(params,{cwd:process.platform==='win32'?[f.w.path,toNamespacedPath(f.w.path)]:f.w.path,limit:50,currentAccountOnly:true});
      else assert.equal(params.limit,1);
      return { data: [{ id: 'native', cwd: f.w.path, preview: 'Fixture' }], nextCursor: 'opaque-next' };
    }
    if(method==='thread/turns/list'){
      assert.equal(params.threadId,'native');assert.equal(params.sortDirection,'asc');assert.equal(params.itemsView,'full');
      return { data:[{id:params.cursor?'older-2':'older-1',itemsView:view,items:[]}], nextCursor:params.cursor?null:'native-next' };
    }
    assert.equal(method,'thread/read');assert.equal(params.threadId,'native');
    if(params.includeTurns===false)return {thread:{id:'native',cwd:changed?f.wb.path:f.w.path,historyMode:paginated?'paginated':'legacy'}};
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
    await assert.rejects(provider.history(f.w.path,'native','legacy-cursor'),/turn-page cursor/);
    const history = await provider.history(f.w.path, 'native');
    assert.deepEqual(history.items.map(item => item.role), ['user', 'assistant', 'reasoning']);
    assert.deepEqual(history.items.map(item => item.nativeEventId), ['turn:user', 'turn:assistant', 'turn:reasoning']);
    assert.ok(calls.every(method=>['thread/list','thread/read'].includes(method)));
    view = 'summary'; await assert.rejects(() => provider.history(f.w.path, 'native'), /incomplete/);
    changed = true; const before = calls.length; await assert.rejects(() => provider.history(f.w.path, 'native'), /identity changed/); assert.equal(calls.length, before + 1);
    changed=false;paginated=true;view='full';
    for(const version of ['codex-cli 0.145.0','codex-cli 0.167.0-alpha.4.1','codex-cli 9.2.0']){
      adapter.observedVersion=version;
      const other=await provider.profile();assert.equal(other.profile,profile.profile);assert.equal(other.namespace,profile.namespace);
      assert.equal(other.version,version);assert.equal(other.discover.state,'supported');assert.equal(other.submit.state,'unverified');
      assert.equal((await provider.history(f.w.path,'native')).cursor,'native-next');
      assert.equal((await provider.history(f.w.path,'native','native-next')).cursor,undefined);
    }
    view='summary';await assert.rejects(()=>provider.history(f.w.path,'native'),/incomplete/);
    assert.ok(calls.every(method=>['thread/list','thread/read','thread/turns/list'].includes(method)));
  } finally { rpc.close(); await exited; await f.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexExternalProvider } from '../../packages/adapters/codex/external.ts';
import type { CodexAdapter } from '../../packages/adapters/codex/index.ts';
import { ClaudeExternalProvider } from '../../packages/adapters/claude-code/external.ts';
import type { ClaudeCodeAdapter } from '../../packages/adapters/claude-code/index.ts';
import { OpenCodeExternalProvider } from '../../packages/adapters/opencode/external.ts';
import type { OpenCodeAdapter } from '../../packages/adapters/opencode/index.ts';
import { externalHandlers } from '../../plugins/dsh-bridge/external.mjs';
import { nativeWorkspacePath } from '../../packages/adapters/common/workspace-path.ts';
import { listCodexThreads, readCodexHistoryPage } from '../../packages/adapters/codex/protocol.ts';
import type { WebSocketRpc } from '../../packages/adapters/common/ws-rpc.ts';

test('ordinary Windows extended paths match a project while device and special names stay distinct', () => {
  assert.equal(nativeWorkspacePath('\\\\?\\D:\\cafe','win32'),'D:\\cafe');
  assert.equal(nativeWorkspacePath('\\\\?\\UNC\\host\\share\\cafe','win32'),'\\\\host\\share\\cafe');
  for (const path of ['\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1','\\\\?\\D:\\project.','\\\\?\\D:\\aux']) {
    assert.equal(nativeWorkspacePath(path,'win32'),path);
  }
});

test('Codex can list and read the original Windows thread using both path spellings and a string-only runtime', {skip:process.platform !== 'win32'}, async () => {
  const cwd = 'D:\\cafe', extended = '\\\\?\\D:\\cafe';
  for (const legacy of [true,false]) {
    const rpc = {request: async (method:string,p:{cwd?:unknown;currentAccountOnly?:boolean}) => {
      if (method === 'thread/read') return {thread:{id:'old',cwd:extended,turns:[]}};
      assert.equal(p.currentAccountOnly,true);
      if (p.cwd) {
        assert.deepEqual(p.cwd,[cwd, extended]);
        if (legacy) throw Object.assign(new Error('invalid params'),{code:-32602});
      }
      return {data:[{id:'old',cwd:extended},{id:'other',cwd:cwd+'-other'}]};
    }} as unknown as WebSocketRpc;
    assert.deepEqual((await listCodexThreads(rpc,50,cwd)).data.map(t=>t.id),['old']);
    assert.equal((await readCodexHistoryPage(rpc,'old',cwd)).snapshot.thread.id,'old');
    await assert.rejects(readCodexHistoryPage(rpc,'old',cwd+'-other'),/cwd or identity/);
  }
});

test('Codex directory discovery pages the current account and Claude SDK omits the project filter',async()=>{
  const codex=new CodexExternalProvider({connection:async()=>({request:async(method:string,params:unknown)=>{
    assert.equal(method,'thread/list');assert.deepEqual(params,{limit:100,currentAccountOnly:true,cursor:'more'});
    return {data:[{id:'n1',cwd:'/project-a'}],nextCursor:null};
  }})} as unknown as CodexAdapter);
  assert.deepEqual((await codex.projectDirectories('more')).paths,['/project-a']);
  const claude=new ClaudeExternalProvider({checkVersion:async()=>{},loadSdk:async()=>({
    listSessions:async(...args:unknown[])=>{assert.equal(args.length,0);return [{cwd:'/a'},{cwd:'/a'},{cwd:'/b'},{sessionId:'no-path'}];}
  })} as unknown as ClaudeCodeAdapter);
  assert.deepEqual((await claude.projectDirectories()).paths,['/a','/b']);
});

test('DSH exposes empty registered projects and independent ordinary session directories',async()=>{
  const handlers=externalHandlers({list:async()=>({items:[{sessionId:'1',cwd:'/active'},{sessionId:'2',cwd:'/child',origin:'subagent'}]})},
    new Set(),'peer',{get:()=>({list:()=>[{path:'/empty'},{path:'/active'}]})});
  assert.deepEqual((await handlers.projectDirectories({instanceId:'peer'})).paths.sort(),['/active','/empty']);
  await assert.rejects(handlers.projectDirectories({instanceId:'old'}),/generation/);
});

test('OpenCode combines saved checkouts with session pages and handles a service with only session discovery',async()=>{
  const routes:string[]=[];
  let missing=false;
  const provider=new OpenCodeExternalProvider({connection:async()=>{},projectListRoute:'/api/project',http:async(path:string)=>{
    routes.push(path);
    if(path==='/api/project'){
      if(missing)throw Error('OpenCode GET /api/project: HTTP 404');
      return [{canonical:'/empty',worktree:'/a',sandboxes:['/checkout']}];
    }
    return {data:[{location:{directory:'/session'}}],cursor:path.includes('cursor=')?{}:{next:'next'}};
  }} as unknown as OpenCodeAdapter);
  assert.deepEqual((await provider.projectDirectories()).paths,['/empty','/a','/checkout','/session']);
  assert.deepEqual((await provider.projectDirectories('next')).paths,['/session']);
  assert.equal(routes.filter(route=>route==='/api/project').length,1);
  missing=true;
  assert.deepEqual((await provider.projectDirectories()).paths,['/session']);
});

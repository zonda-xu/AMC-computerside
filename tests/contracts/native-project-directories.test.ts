import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexExternalProvider } from '../../packages/adapters/codex/external.ts';
import type { CodexAdapter } from '../../packages/adapters/codex/index.ts';
import { ClaudeExternalProvider } from '../../packages/adapters/claude-code/external.ts';
import type { ClaudeCodeAdapter } from '../../packages/adapters/claude-code/index.ts';
import { OpenCodeExternalProvider } from '../../packages/adapters/opencode/external.ts';
import type { OpenCodeAdapter } from '../../packages/adapters/opencode/index.ts';
import { externalHandlers } from '../../plugins/dsh-bridge/external.mjs';

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

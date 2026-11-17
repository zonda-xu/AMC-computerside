import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../../packages/adapters/codex/index.ts';
import { OpenCodeAdapter } from '../../packages/adapters/opencode/index.ts';
import { ClaudeCodeAdapter } from '../../packages/adapters/claude-code/index.ts';
import { nativeContext } from './fixtures/native-context.ts';
import { catalogModel } from '../../packages/adapters/common/models.ts';

test('Codex catalog reads the native provider and follows model/list pagination without guessing identities',async t=>{
  const f=nativeContext();const a=new CodexAdapter('codex',{command:'unused',expectedVersion:''},f.context);const calls:Array<{method:string;params:any}>=[];
  t.mock.method(a,'connection',async()=>({request:async(method:string,params:any)=>{calls.push({method,params});if(method==='config/read')return{config:{model_provider:'custom'}};return{data:[{id:'display-id',model:params.cursor?'second-model':'native-model',displayName:'Label'}],nextCursor:params.cursor?null:'page2'};}}));
  const models=await a.listModels(f.workspace);assert.deepEqual(models.map(m=>m.modelId),['native-model','second-model']);assert.ok(models.every(m=>m.providerId==='custom'));
  assert.equal(calls[0].params.cwd,f.workspace.path);assert.equal(calls[1].params.modelProvider,'custom');assert.equal(models[0].parameterCount,undefined);
});
test('OpenCode model catalog and switching use the v2 workspace-aware native API',async t=>{
  const f=nativeContext('opencode');const a=new OpenCodeAdapter('opencode',{command:'unused',expectedVersion:''},f.context);const calls:any[]=[];
  t.mock.method(a,'connection',async()=>{});t.mock.method(a,'http',async(path:string,method?:string,body?:unknown)=>{calls.push([path,method,body]);return{data:[{id:'m',providerID:'p',name:'Actual',type:'chat'},{id:'i',providerID:'p',type:'image'}]};});
  assert.equal((await a.listModels(f.workspace)).length,1);assert.match(calls[0][0],/^\/api\/model\?location\[directory\]=/);
  await a.configure(f.session,{providerId:'p',modelId:'m',label:'Actual'});assert.deepEqual(calls[1],['/api/session/native/model','POST',{model:{id:'m',providerID:'p'}}]);assert.equal(f.events.some(e=>e.type==='model.confirmed'),false);
});
test('Claude model discovery sends no prompt and closes its metadata-only query',async t=>{
  const f=nativeContext('claude-code');const a=new ClaudeCodeAdapter('claude-code',{command:'unused',expectedVersion:''},f.context);let closed=0;let options:any;
  t.mock.method(a,'checkVersion',async()=>{});t.mock.method(a,'executable',async()=>'/local/claude');t.mock.method(a,'loadSdk',async()=>({query:(args:any)=>{options=args;return{supportedModels:async()=>[{value:'native-id',displayName:'Claude'}],close:()=>closed++};}}));
  const models=await a.listModels(f.workspace);assert.equal(models[0].modelId,'native-id');assert.equal(closed,1);assert.equal(options.prompt.items.length,0);assert.equal(options.options.cwd,f.workspace.path);assert.equal(a.live.size,0);
});
test('parameter counts require numeric native metadata; model names do not imply size',()=>{
  assert.equal(catalogModel('p','model-700b-pro','Huge','native')?.parameterCount,undefined);
  assert.equal(catalogModel('p','m','M','native',{parameterCount:32000000000})?.parameterSource,'native');
  assert.equal(catalogModel('p','m','M','native',{parameterCount:Infinity})?.parameterCount,undefined);
});

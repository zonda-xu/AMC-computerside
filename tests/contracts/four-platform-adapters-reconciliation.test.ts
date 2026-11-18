import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Command, EngineId, Receipt, RunRecord } from '../../packages/protocol/src/types.ts';
import { CodexAdapter } from '../../packages/adapters/codex/index.ts';
import { ClaudeCodeAdapter, InputQueue } from '../../packages/adapters/claude-code/index.ts';
import { OpenCodeAdapter } from '../../packages/adapters/opencode/index.ts';
import { DshAdapter } from '../../packages/adapters/deepseek-harness/index.ts';
import { controllerBridge } from '../../plugins/dsh-bridge/controller.mjs';
import { nativeContext } from './fixtures/native-context.ts';
import { fixture, command } from '../helpers.ts';

function pendingHarness(engine:EngineId,action:'submit'|'cancel'='submit'){
  const f=nativeContext(engine);f.session.state='uncertain';f.session.runId='run';f.session.runGeneration=1;
  const request:Command={protocolVersion:2,hostId:f.session.ref.hostId,sessionId:f.session.id,ref:{...f.session.ref},clientRequestId:'command',action,payload:{expectedGeneration:1,...(action==='cancel'?{runId:'run'}:{text:'same text'})}};
  const receipt:Receipt={clientRequestId:'command',status:'uncertain',runId:'run',generation:1,nativeRequestId:'native-input'};
  const run:RunRecord={runId:'run',sessionId:f.session.id,generation:1,deviceId:'device',clientRequestId:'command',nativeRequestId:'native-input',nativeRunId:'turn',state:'uncertain'};
  const settlements:any[]=[];
  f.context.pendingCommands=()=>['received','uncertain'].includes(receipt.status)?[{deviceId:'device',clientRequestId:'command',command:request,receipt}]:[];
  f.context.getRun=id=>id==='run'?run:undefined;
  f.context.reconcileReceipt=(device,id,evidence)=>{assert.equal(device,'device');assert.equal(id,'command');settlements.push(evidence);Object.assign(receipt,evidence);};
  return{...f,request,receipt,run,settlements};
}

test('Codex history confirms only the persisted native input ID, without retrying turn/start',async t=>{
  const f=pendingHarness('codex');const a=new CodexAdapter('codex',{command:'unused',expectedVersion:''},f.context);const methods:string[]=[];let itemId='unrelated-input';
  const rpc={request:async(method:string)=>{methods.push(method);return{thread:{id:'native',status:{type:'idle'},turns:[{id:'turn',status:'completed',items:[{type:'userMessage',id:itemId,content:[{type:'text',text:'same text'}]}]}]}};}};
  a.rpc=rpc as any;t.mock.method(a,'connection',async()=>rpc as any);
  await a.resumeSession(f.session);assert.equal(f.receipt.status,'uncertain');assert.equal(f.session.state,'uncertain');
  itemId='native-input';await a.resumeSession(f.session);assert.equal(f.receipt.status,'native_accepted');assert.equal(f.receipt.nativeRunId,'turn');assert.equal(f.session.state,'completed');assert.deepEqual(methods,['thread/resume','thread/resume']);
});

test('DSH durable user-message provenance reconciles repeated snapshots but never matches text or another scope',()=>{
  const f=pendingHarness('deepseek-harness');const a=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);a.byNative.set('native',f.session.id);
  const event={seq:1,type:'user/message',data:{source:{kind:'user',rpcId:'other'},content:[{type:'text',text:'same text'}]}};
  a.durable('native',event);assert.equal(f.receipt.status,'uncertain');f.request.ref.workspaceId='other';a.durable('native',{...event,data:{source:{kind:'user',rpcId:'native-input'}}});assert.equal(f.receipt.status,'uncertain');
  f.request.ref.workspaceId=f.session.ref.workspaceId;a.durable('native',{...event,data:{source:{kind:'user',rpcId:'native-input'}}});assert.equal(f.receipt.status,'native_accepted');assert.equal(f.settlements.length,1);a.durable('native',event);assert.equal(f.settlements.length,1);
});

test('OpenCode message metadata resolves lost prompt acceptance while unrelated outcome and text do not',async t=>{
  const f=pendingHarness('opencode');const a=new OpenCodeAdapter('opencode',{command:'unused',expectedVersion:''},f.context);let confirmed=false;const methods:string[]=[];
  t.mock.method(a,'http',async(path:string,method='GET')=>{methods.push(method);if(path.includes('/message'))return{data:[{type:'user',id:'msg_native',sessionID:'native',payload:{text:'same text'},...(confirmed?{metadata:{aiMaidCafeRequestId:'native-input'}}:{})}]};if(path.endsWith('/permission')||path.endsWith('/form'))return{data:[]};return{data:{id:'native',time:{},outcome:'succeeded'}};});
  await a.reconcile('native',f.session.id);assert.equal(f.receipt.status,'uncertain');assert.equal(f.session.state,'uncertain');confirmed=true;await a.reconcile('native',f.session.id);assert.equal(f.receipt.status,'native_accepted');assert.equal(f.session.state,'uncertain');assert.ok(methods.every(method=>method==='GET'));
});

test('OpenCode session terminal alone never invents acceptance of an uncertain cancellation',async t=>{
  const f=pendingHarness('opencode','cancel');const a=new OpenCodeAdapter('opencode',{command:'unused',expectedVersion:''},f.context);
  t.mock.method(a,'http',async(path:string)=>path.includes('/message')||path.endsWith('/permission')||path.endsWith('/form')?{data:[]}:{data:{id:'native',time:{},outcome:'interrupted'}});
  await a.reconcile('native',f.session.id);assert.equal(f.session.state,'uncertain');assert.equal(f.receipt.status,'uncertain');assert.equal(f.settlements.length,0);
});

test('Claude queue insertion is not acceptance; matching native UUID reconciles and interrupt acknowledgement settles cancel',async t=>{
  const f=pendingHarness('claude-code');const a=new ClaudeCodeAdapter('claude-code',{command:process.execPath,expectedVersion:''},f.context);const output=new InputQueue<any>();let interrupts=0;
  t.mock.method(a,'checkVersion',async()=>{});t.mock.method(a,'loadSdk',async()=>({query:()=>({[Symbol.asyncIterator]:()=>output[Symbol.asyncIterator](),interrupt:async()=>{interrupts++;return{still_queued:[]};},return:async()=>output.close()})}));output.push({type:'system',subtype:'init',session_id:'native'});
  try{await a.createSession(f.session.id,f.workspace);f.receipt.status='received';await a.submit(f.session,{text:'same text',attachments:[],requestId:'command',nativeRequestId:'native-input'});f.receipt.status='uncertain';assert.equal(f.receipt.status,'uncertain');a.frame(f.session.id,{type:'user',uuid:'wrong',session_id:'native'});assert.equal(f.receipt.status,'uncertain');a.frame(f.session.id,{type:'user',uuid:'native-input',session_id:'native'});assert.equal(f.receipt.status,'native_accepted');
    f.request.action='cancel';f.request.payload={expectedGeneration:1,runId:'run'};f.receipt.status='received';await a.requestCancel(f.session);assert.equal(interrupts,1);assert.equal(f.receipt.status,'native_accepted');assert.notEqual(f.session.state,'cancelled');
  }finally{a.close();output.close();}
});

test('DSH retained cancel acknowledgement resolves a lost bridge response without another native cancel',async t=>{
  const f=pendingHarness('deepseek-harness','cancel');const a=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);a.pluginInstanceId='plugin';a.turns.set('native',7);let cancelled=0;
  const bridge=controllerBridge({on:()=>()=>{}},{cancel:()=>{cancelled++;return{accepted:true};},projections:async()=>null},'plugin',()=>{});bridge.states.set('native',{active:true,turn:7});
  t.mock.method(a,'call',async(method:string,params:any)=>{if(method==='cancel'){bridge.handlers.cancel(params);throw new Error('Bridge response lost');}assert.equal(method,'snapshot');return bridge.handlers.snapshot(params);});
  try{await assert.rejects(a.requestCancel(f.session),/response lost/);assert.equal(f.receipt.status,'uncertain');f.session.state='cancelled';await a.restorePending('native',f.session.id);assert.equal(f.receipt.status,'native_accepted');assert.equal(cancelled,1);await a.restorePending('native',f.session.id);assert.equal(cancelled,1);assert.equal(f.settlements.length,1);}finally{bridge.close();}
});

test('DSH plugin replacement without the original cancel acknowledgement leaves receipt uncertain',async t=>{
  const f=pendingHarness('deepseek-harness','cancel');const a=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);a.pluginInstanceId='replacement';f.session.state='completed';t.mock.method(a,'call',async()=>({pluginInstanceId:'replacement',pending:[],cancelReceipts:[]}));await a.restorePending('native',f.session.id);assert.equal(f.receipt.status,'uncertain');
});

test('Claude checks the explicit CLI executable version and never advertises model choices without a catalog',async t=>{
  const f=nativeContext('claude-code');const a=new ClaudeCodeAdapter('claude-code',{command:'must-not-run',executablePath:process.execPath,expectedVersion:'2.1.325 (Claude Code)'},f.context);
  await a.checkVersion();assert.equal(a.observedVersion,process.version);
  a.config.compatibilityMode='pinned';await assert.rejects(a.checkVersion(),/已固定版本/);
  a.config.expectedVersion=process.version;await a.checkVersion();
  t.mock.method(a,'loadSdk',async()=>({query:()=>{}}));t.mock.method(a,'checkVersion',async()=>{});const result=await a.probe();assert.deepEqual(result.models,[]);assert.equal(result.capabilities.models,false);
});

test('native input evidence clears the real persisted submission blocker without dispatching a second task',async()=>{
  const f=await fixture();try{
    const c=command(f.s);const run:RunRecord={runId:'recovered-run',sessionId:f.s.id,generation:f.s.epoch,deviceId:'device',clientRequestId:c.clientRequestId,nativeRequestId:'persisted-input',state:'uncertain'};f.store.receive('device',c.clientRequestId,c);f.store.dispatching('device',c.clientRequestId,run);f.store.receipt('device',{clientRequestId:c.clientRequestId,status:'uncertain',runId:run.runId,nativeRequestId:run.nativeRequestId,generation:run.generation});assert.equal(f.store.unresolvedSubmission(f.s.id),true);
    const a=new CodexAdapter('codex',{command:'unused',expectedVersion:''},f.core.context('codex'));a.acceptSubmission(f.s.id,'unrelated-input','turn');assert.equal(f.store.unresolvedSubmission(f.s.id),true);a.acceptSubmission(f.s.id,'persisted-input','turn');assert.equal(f.store.unresolvedSubmission(f.s.id),false);assert.equal(f.adapter.submitted,0);
  }finally{await f.close();}
});

test('same-plugin cancellation evidence clears the real persisted cancel blocker after gateway recovery',async t=>{
  const f=await fixture();let cancelled=0;const bridge=controllerBridge({on:()=>()=>{}},{cancel:()=>{cancelled++;return{accepted:true};},projections:async()=>null},'surviving-plugin',()=>{});
  try{
    const context=f.core.context('deepseek-harness');const s={...f.s,ref:{...f.s.ref,engineId:'deepseek-harness' as const,runtimeInstanceId:context.runtimeInstanceId,nativeSessionId:'native'},state:'cancel_requested' as const,runId:'cancel-run',runGeneration:context.epoch,epoch:context.epoch,binding:{...f.s.binding!,runtimeInstanceId:context.runtimeInstanceId,nativeSessionId:'native',generation:context.epoch,nativeIdentity:'surviving-plugin'}};f.store.put('session',s.id,s);
    const c=command(s,'cancel');f.store.receive('device',c.clientRequestId,c);f.store.dispatching('device',c.clientRequestId);f.store.receipt('device',{clientRequestId:c.clientRequestId,status:'uncertain'});
    const a=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},context);a.pluginInstanceId='surviving-plugin';a.turns.set('native',7);bridge.states.set('native',{active:true,turn:7});t.mock.method(a,'call',async(method:string,params:any)=>{assert.equal(method,'cancel');bridge.handlers.cancel(params);throw new Error('Response lost');});await assert.rejects(a.requestCancel(s),/Response lost/);assert.equal(f.store.unresolvedCancel(s.id),true);
    f.store.recover();const reconnected=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.core.context('deepseek-harness'));reconnected.pluginInstanceId='surviving-plugin';t.mock.method(reconnected,'call',async(method:string,params:any)=>{assert.equal(method,'snapshot');return bridge.handlers.snapshot(params);});await reconnected.restorePending('native',s.id);assert.equal(f.store.unresolvedCancel(s.id),false);assert.equal(f.store.getReceipt('device',c.clientRequestId)!.status,'native_accepted');assert.equal(cancelled,1);assert.equal(f.core.session(s.id).state,'uncertain');
  }finally{bridge.close();await f.close();}
});

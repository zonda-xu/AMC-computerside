import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { ClaudeCodeAdapter, InputQueue } from '../../packages/adapters/claude-code/index.ts';
import { OpenCodeAdapter } from '../../packages/adapters/opencode/index.ts';
import { CodexAdapter } from '../../packages/adapters/codex/index.ts';
import { DshAdapter } from '../../packages/adapters/deepseek-harness/index.ts';
import { loadNativeModule } from '../../packages/adapters/common/native-module.ts';
import { nativeContext, until } from './fixtures/native-context.ts';
import { controllerBridge } from '../../plugins/dsh-bridge/controller.mjs';
import { project } from '../../apps/gateway/src/store.ts';
import type { ConsoleEvent } from '../../packages/protocol/src/types.ts';
import { mapDurable } from '../../plugins/dsh-bridge/mapping.mjs';

test('native dependency gates verify package identity and exact version before executing imports',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'four-platform-adapters-module-'));
  try{
    const entry=join(directory,'service.mjs');
    await writeFile(entry,'throw new Error("must not execute mismatched dependency");');
    await writeFile(join(directory,'package.json'),JSON.stringify({name:'@opencode/client',version:'2.2.0',type:'module'}));
    await assert.rejects(loadNativeModule(pathToFileURL(entry).href,'@opencode/client','2.3.0'),/2.3.0 required; found 2.2.0/);
    const wrongClientContext=nativeContext('opencode');const wrongClient=new OpenCodeAdapter('opencode',{command:'unused',expectedVersion:'2.3.0',serviceModule:pathToFileURL(entry).href},wrongClientContext.context);await assert.rejects(wrongClient.discover(),/OpenCode v2 discovery unavailable.*2.3.0 required; found 2.2.0/);
    await assert.rejects(loadNativeModule(pathToFileURL(entry).href,'@anthropic-ai/claude-agent-sdk','0.3.325'),/not provided by/);
    await writeFile(join(directory,'package.json'),JSON.stringify({name:'@opencode/client',version:'2.3.0',type:'module'}));
    await writeFile(entry,'export const Service={discover:async()=>undefined,headers:()=>({})};');
    const f=nativeContext('opencode');const a=new OpenCodeAdapter('opencode',{command:'unused',expectedVersion:'2.3.0',serviceModule:pathToFileURL(entry).href},f.context);
    await assert.rejects(a.discover(),/Service.ensure will not be called/);
    const c=new ClaudeCodeAdapter('claude-code',{command:process.execPath,expectedVersion:'',sdkModule:pathToFileURL(entry).href},f.context);
    await assert.rejects(c.loadSdk(),/Claude official SDK unavailable.*not provided by/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('Claude linked output preserves permission and cancellation states and child result cannot finish parent',async t=>{
  const f=nativeContext('claude-code');const a=new ClaudeCodeAdapter('claude-code',{command:process.execPath,expectedVersion:''},f.context);const output=new InputQueue<any>();
  let finishInterrupt!:(value:any)=>void;
  t.mock.method(a,'loadSdk',async()=>({query:()=>({[Symbol.asyncIterator]:()=>output[Symbol.asyncIterator](),interrupt:()=>new Promise(resolve=>{finishInterrupt=resolve;}),return:async()=>output.close()})}));
  t.mock.method(a,'checkVersion',async()=>{});
  output.push({type:'system',subtype:'init',session_id:'native'});
  try{
    await a.createSession(f.session.id,f.workspace);f.session.state='accepted';await a.submit(f.session,{text:'test',attachments:[],requestId:'input'});
    assert.equal(f.events.some(e=>e.data.nativeAccepted),false);
    f.session.state='waiting_permission';a.frame(f.session.id,{type:'stream_event',session_id:'native',user_message_uuid:'input',event:{type:'message_start',message:{id:'a'}}});assert.equal(f.session.state,'waiting_permission');
    f.session.state='cancel_requested';const cancellation=a.requestCancel(f.session);
    a.frame(f.session.id,{type:'result',parent_tool_use_id:'child',session_id:'native',user_message_uuid:'input',subtype:'success',terminal_reason:'completed'});assert.equal(a.live.get(f.session.id)!.active,true);
    a.frame(f.session.id,{type:'stream_event',session_id:'native',user_message_uuid:'input',event:{type:'content_block_delta',delta:{type:'text_delta',text:'final'}}});assert.equal(f.session.state,'cancel_requested');
    a.frame(f.session.id,{type:'result',session_id:'native',user_message_uuid:'input',subtype:'success',is_error:false,terminal_reason:'completed'});assert.equal(f.session.state,'completed');
    finishInterrupt({still_queued:['old']});await assert.rejects(cancellation,/queued inputs/);assert.equal(f.session.state,'completed');
  }finally{a.close();output.close();}
});

test('OpenCode missing terminal evidence keeps detached execution uncertain and rejects unconfirmed cancel',async t=>{
  const f=nativeContext('opencode');const a=new OpenCodeAdapter('opencode',{command:'unused',expectedVersion:''},f.context);f.session.state='uncertain';
  t.mock.method(a,'connection',async()=>{});
  t.mock.method(a,'http',async(path:string)=>path.includes('/interrupt')?{interrupted:false}:path.includes('/message')||path.endsWith('/permission')||path.endsWith('/form')?{data:[]}:{data:{id:'native',time:{created:1,updated:2}}});
  await a.reconcile('native',f.session.id);assert.equal(f.session.state,'uncertain');
  await assert.rejects(a.requestCancel(f.session),/not confirmed/);assert.equal(f.session.state,'uncertain');
});

test('OpenCode reuses persisted live interactions and closes cards absent from native snapshot',async t=>{
  const f=nativeContext('opencode');const a=new OpenCodeAdapter('opencode',{command:'unused',expectedVersion:''},f.context);
  const request={id:'permission',sessionID:'native',action:'write'};
  a.openInteraction(f.session.id,request,'permission');const original=f.session.interactions[0];a.pending.clear();
  a.openInteraction(f.session.id,request,'permission');assert.equal(f.session.interactions.length,1);assert.equal(a.pending.get('native:permission')!.interactionId,original.id);
  a.pending.clear();t.mock.method(a,'http',async(path:string)=>path.includes('/message')||path.endsWith('/permission')||path.endsWith('/form')?{data:[]}:{data:{id:'native',time:{},outcome:'succeeded'}});
  await a.reconcile('native',f.session.id);assert.equal(original.status,'resolved');
});

test('DSH snapshot stream index survives duplicate start and snapshot without active stream clears it',async()=>{
  const f=nativeContext('deepseek-harness');const a=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);a.byNative.set('native',f.session.id);
  await a.follow('native',{type:'snapshot',records:[],cursor:0,hasMore:false,assistantStream:{revision:4,activeAttempt:{attemptId:'a',turn:1,step:1,nextIndex:2,stream:[{type:'text-chunks',texts:['first','second']}]}}});
  await a.follow('native',{type:'assistant-stream',frame:{type:'start',attemptId:'a',revision:4,turn:1,step:1}});
  await a.follow('native',{type:'assistant-stream',frame:{type:'chunk',attemptId:'a',revision:4,index:1,chunk:{type:'text-delta',text:'second'}}});
  await a.follow('native',{type:'assistant-stream',frame:{type:'chunk',attemptId:'a',revision:4,index:2,chunk:{type:'text-delta',text:'third'}}});
  assert.deepEqual(f.events.filter(e=>e.type==='message.completed').map(e=>e.data.text),['firstsecond','firstsecondthird']);
  for(const e of f.events)project(f.session,{...e,sessionId:f.session.id,ref:f.session.ref,seq:1,time:0} as ConsoleEvent);
  assert.equal(f.session.messages.length,1);assert.equal(f.session.messages[0].text,'firstsecondthird');
  await a.follow('native',{type:'snapshot',records:[],cursor:0,hasMore:false});assert.equal(a.streams.has('native'),false);
});

test('DSH durable retry attempts do not overwrite the final answer or reuse abandoned stream identity',()=>{
  const attempt={id:'live',turn:1,step:2,abandoned:true};const event={type:'assistant/attempt',seq:3,data:{turn:1,step:2,stream:[{type:'text-delta',text:'retry'}]}};
  const retry=mapDurable(event,attempt)[0].data;const final=mapDurable({...event,type:'assistant/message',seq:4},attempt)[0].data;assert.notEqual(retry.id,'live');assert.notEqual(retry.nativeKey,final.nativeKey);
  assert.equal(mapDurable({...event,type:'assistant/message',seq:4},{...attempt,abandoned:false,committedSeq:4})[0].data.id,'live');assert.notEqual(mapDurable({...event,type:'assistant/message',seq:5},{...attempt,abandoned:false,committedSeq:4})[0].data.id,'live');
});

test('DSH rejects forged resolver ownership and requires explicit native cancellation and decision acceptance',async t=>{
  const f=nativeContext('deepseek-harness');const a=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);a.pluginInstanceId='plugin';
  a.openInteraction(f.session.id,{interactionId:'wait',pluginInstanceId:'plugin',sessionId:'native',turn:1,kind:'permission',request:{toolName:'Write'}});const i=f.session.interactions[0];let calls=0;
  t.mock.method(a,'call',async()=>{calls++;return{};});
  await assert.rejects(a.respond({...f.session,ref:{...f.session.ref,nativeSessionId:'other'}},i,{interactionId:i.id,epoch:1,choiceId:'allowed-once'}),/stale/);assert.equal(calls,0);
  await assert.rejects(a.respond(f.session,i,{interactionId:i.id,epoch:1,choiceId:'allowed-once'}),/acceptance not confirmed/);assert.equal(i.status,'pending');
  await assert.rejects(a.requestCancel(f.session),/acceptance not confirmed/);assert.notEqual(f.session.state,'cancelled');
});

test('DSH authoritative pending snapshot closes persisted cards even after adapter registry loss',async t=>{
  const f=nativeContext('deepseek-harness');const a=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);a.pluginInstanceId='plugin';
  a.openInteraction(f.session.id,{interactionId:'wait',pluginInstanceId:'plugin',sessionId:'native',turn:1,kind:'permission',request:{toolName:'Write'}});a.nativeInteractions.clear();
  t.mock.method(a,'call',async()=>({pluginInstanceId:'plugin',pending:[]}));await a.restorePending('native',f.session.id);assert.equal(f.session.interactions[0].status,'resolved');
});

test('DSH free-text answers use the native custom field rather than invalid option labels',async t=>{
  const f=nativeContext('deepseek-harness');const a=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);a.pluginInstanceId='plugin';let answer:any;
  a.openInteraction(f.session.id,{interactionId:'question',pluginInstanceId:'plugin',sessionId:'native',turn:1,kind:'question',request:{questions:[{id:'scope',question:'Which scope?',options:[{label:'All'}]}]}});
  t.mock.method(a,'call',async(method:string,params:any)=>{answer=params.answers;return{accepted:true};});const i=f.session.interactions[0];await a.respond(f.session,i,{interactionId:i.id,epoch:1,answers:{scope:['Only adapter contracts']}});assert.deepEqual(answer,[{id:'scope',selected:[],custom:'Only adapter contracts'}]);
});

test('DSH plugin rejects a stale cancellation generation without calling native controller',()=>{
  let calls=0;const bridge=controllerBridge({on:()=>()=>{}},{cancel:()=>{calls++;return{accepted:true};}},'plugin',()=>{});
  try{bridge.states.set('native',{active:true,turn:1});assert.throws(()=>bridge.handlers.cancel({sessionId:'native',turn:1,pluginInstanceId:'old'}),/generation changed/);assert.equal(calls,0);}finally{bridge.close();}
});

test('DSH truncated opening snapshot pages the pinned cut before claiming active-turn resolvers',async()=>{
  const frames=new InputQueue<any>();const listeners=new Map<string,Function>();const pages:any[]=[];
  const ctl={follow:()=>frames,page:async(request:any)=>{pages.push(request);return{records:[{type:'event',event:{type:'turn/start',seq:1,data:{turn:7}}}],hasMore:false};},cancel:()=>({accepted:true})};
  const bridge=controllerBridge({on:(name:string,listener:Function)=>{listeners.set(name,listener);return()=>{};}},ctl,'plugin',()=>{});
  try{await bridge.handlers.subscribe({sessionId:'native',subscriptionId:'s'});frames.push({type:'snapshot',cursor:8,hasMore:true,records:[{type:'event',event:{type:'tool/call',seq:8,data:{}}}]});await until(()=>bridge.states.get('native')?.active===true);assert.deepEqual(pages,[{address:{kind:'session',sessionId:'native'},throughSeq:8,beforeSeq:8,maxMessages:100}]);
    const waiting=listeners.get('approval/request')!({agent:{session:{id:'native'}},toolName:'Write'},async()=> 'unavailable');const entry=[...bridge.pending.values()][0];assert.equal(entry.turn,7);bridge.handlers.decide({sessionId:'native',pluginInstanceId:'plugin',turn:7,interactionId:entry.interactionId,outcome:'rejected'});assert.equal(await waiting,'rejected');
  }finally{bridge.close();frames.close();}
});

test('Codex automatically reconnects to the same server and restores terminal state without resubmitting',async t=>{
  const f=nativeContext();const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No listener');let connections=0;const calls:string[]=[];
  server.on('connection',socket=>{connections++;socket.on('message',raw=>{const m=JSON.parse(raw.toString());calls.push(m.method);if(m.id===undefined)return;const result=m.method==='thread/start'?{thread:{id:'native'}}:m.method==='thread/resume'?{thread:{id:'native',status:{type:'idle'},turns:[{id:'turn',status:'completed',items:[]}]}}:{};socket.send(JSON.stringify({id:m.id,result}));});});
  const a=new CodexAdapter('codex',{command:'unused',expectedVersion:'',endpoint:`ws://127.0.0.1:${address.port}`,runtimeIdentity:'incarnation'},f.context);t.mock.method(a,'checkVersion',async()=>{});
  try{await a.createSession(f.session.id,f.workspace);f.session.state='running';a.rpc!.socket.terminate();await until(()=>connections===2&&f.session.state==='completed');assert.equal(calls.includes('turn/start'),false);assert.equal(f.session.binding?.nativeIdentity,'incarnation');}
  finally{a.close();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('Codex cancel never substitutes a gateway run ID for an unknown native turn',async()=>{
  const f=nativeContext();const a=new CodexAdapter('codex',{command:'unused',expectedVersion:''},f.context);f.session.runId='gateway-run';await assert.rejects(a.requestCancel(f.session),/Native turn ID is not known/);
});

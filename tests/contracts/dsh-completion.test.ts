import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { DshAdapter } from '../../packages/adapters/deepseek-harness/index.ts';
import { controllerBridge } from '../../plugins/dsh-bridge/controller.mjs';
import { controllerEvidence, controllerDigest } from '../../plugins/dsh-bridge/profile.mjs';
import { nativeContext, until } from './fixtures/native-context.ts';
import { fixture } from '../helpers.ts';
import type { Command, Receipt, RunRecord } from '../../packages/protocol/src/types.ts';

interface JournalEvent { seq:number; type:string; data:{turn:number; reason?:{kind:string}; stream?:Array<{type:string;text:string}>} }
interface Frame { type:string; cursor:number; hasMore:boolean; records:Array<{event:JournalEvent}> }
interface ResolverRequest { agent:{sessionId:string}; toolName?:string; signal?:AbortSignal; questions?:Array<{id:string;question:string;options:Array<{label:string}>;multiSelect?:boolean}> }
type ResolverResult=string|{answers:Array<{id:string;selected:string[];custom?:string}>};
type ResolverListener=(request:ResolverRequest,next:()=>Promise<ResolverResult>)=>Promise<ResolverResult>;

function waitingReceipt(){
  const f=nativeContext('deepseek-harness');f.session.state='uncertain';f.session.runId='run';f.session.runGeneration=1;
  const command:Command={protocolVersion:2,hostId:'host',sessionId:f.session.id,ref:{...f.session.ref},clientRequestId:'input',action:'submit',payload:{expectedGeneration:1}};
  const receipt:Receipt={clientRequestId:'input',status:'uncertain',runId:'run',nativeRequestId:'native-input',generation:1};
  const run:RunRecord={runId:'run',sessionId:f.session.id,generation:1,deviceId:'device',clientRequestId:'input',nativeRequestId:'native-input',state:'uncertain'};
  let settled=0;
  f.context.pendingCommands=()=>receipt.status==='uncertain'?[{deviceId:'device',clientRequestId:'input',command,receipt}]:[];
  f.context.getRun=id=>id==='run'?run:undefined;
  f.context.reconcileReceipt=(device,id,evidence)=>{assert.equal(device,'device');assert.equal(id,'input');settled++;Object.assign(receipt,evidence);};
  return{...f,command,receipt,run,settled:()=>settled};
}

test('DSH live plugin reopens failed follow with a fresh pinned snapshot, reconnects in the same generation, and continues without resubmit',async()=>{
  const f=nativeContext('deepseek-harness');let generations=0;f.context.openConnection=()=>{generations++;return 1;};
  const adapter=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);adapter.byNative.set('native',f.session.id);
  const methods:string[]=[];const requests:Array<{address:{kind:string;sessionId:string};maxMessages:number;assistantStream:boolean;afterSeq?:number}>=[];
  const pages:Array<{throughSeq:number;beforeSeq:number}>=[];const failures:Array<()=>void>=[];let prompts=0;let client:WebSocket|undefined;
  const bridge=controllerBridge({on:()=>()=>{}},{
    async *follow(request:typeof requests[number],signal:AbortSignal){
      requests.push(request);const reopened=requests.length>1;
      const frame:Frame={type:'snapshot',cursor:reopened?5:1,hasMore:reopened,records:[{event:reopened?{seq:5,type:'assistant/message',data:{turn:2,stream:[{type:'text-delta',text:'recovered'}]}}:{seq:1,type:'turn/start',data:{turn:1}}}]};
      yield frame;
      await new Promise<void>((resolve,reject)=>{failures.push(()=>reject(new Error('injected native stream failure')));signal.addEventListener('abort',()=>resolve(),{once:true});if(signal.aborted)resolve();});
    },
    async page(request:typeof pages[number]){pages.push(request);return{hasMore:false,records:[{event:{seq:1,type:'turn/start',data:{turn:1}}},{event:{seq:2,type:'turn/end',data:{turn:1,reason:{kind:'aborted'}}}},{event:{seq:3,type:'turn/start',data:{turn:2}}}]};},
    projections:async()=>null,
    prompt:async(request:{sessionId:string;requestId:string})=>{assert.equal(request.sessionId,'native');assert.ok(request.requestId);prompts++;return{accepted:true};},
  },'surviving-plugin',(message:object)=>{if(client?.readyState===WebSocket.OPEN)client.send(JSON.stringify(message));});
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('Expected TCP listener');
  server.on('connection',socket=>adapter.attach(socket));
  async function connect(){
    const socket=new WebSocket(`ws://127.0.0.1:${typeof address==='object'&&address?address.port:0}`);client=socket;
    socket.on('message',async raw=>{const message=JSON.parse(raw.toString());methods.push(message.method);let result;
      if(message.method==='probe')result={pluginInstanceId:'surviving-plugin',control:true};
      else if(message.method==='subscribe')result=await bridge.handlers.subscribe(message.params);
      else if(message.method==='page')result=await bridge.handlers.page(message.params);
      else if(message.method==='snapshot')result=await bridge.handlers.snapshot(message.params);
      else if(message.method==='prompt')result=await bridge.handlers.prompt(message.params);
      else throw new Error('Unexpected method '+message.method);
      if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({id:message.id,result}));
    });socket.on('close',()=>bridge.disconnect());await once(socket,'open');
  }
  try{
    await connect();await until(()=>f.session.binding?.state==='attached'&&failures.length===1);
    await adapter.submit(f.session,{text:'first',requestId:'first',attachments:[]});assert.equal(prompts,1);
    const firstSubscription=adapter.subscriptions.get('native');failures[0]();
    await until(()=>requests.length===2&&f.events.some(e=>e.data.text==='recovered')&&f.session.binding?.state==='attached');
    assert.notEqual(adapter.subscriptions.get('native'),firstSubscription);assert.equal(prompts,1);assert.equal(generations,1);
    assert.ok(pages.length>=2);assert.ok(pages.every(p=>p.throughSeq===5&&p.beforeSeq===5));
    assert.ok(requests.every(r=>r.address.sessionId==='native'&&!Object.hasOwn(r,'afterSeq')&&!Object.hasOwn(r,'cursor')));
    assert.equal(f.events.filter(e=>e.type==='message.completed'&&e.data.text==='recovered').length,1);
    client?.terminate();await until(()=>adapter.socket===undefined);await connect();
    await until(()=>requests.length===3&&f.session.binding?.state==='attached');assert.equal(generations,1);assert.equal(adapter.epoch,1);assert.equal(prompts,1);
    await adapter.submit(f.session,{text:'next',requestId:'next',attachments:[]});assert.equal(prompts,2);assert.equal(methods.filter(m=>m==='prompt').length,2);assert.equal(methods.includes('create'),false);
  }finally{adapter.close();bridge.close();client?.terminate();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('DSH pending permission and question resolvers survive disconnect and settle exactly once whichever surface wins',async()=>{
  const listeners=new Map<string,ResolverListener>();const closed:string[]=[];
  const bridge=controllerBridge({on:(name:string,listener:ResolverListener)=>{listeners.set(name,listener);return()=>{};}},{projections:async()=>null},'plugin',(message:{params:{type:string;interactionId?:string}})=>{if(message.params.type==='interaction.closed'&&message.params.interactionId)closed.push(message.params.interactionId);});
  bridge.states.set('native',{turn:7,active:true});
  const approval=listeners.get('approval/request');const question=listeners.get('user-questions/request');assert.ok(approval);assert.ok(question);
  let desktopPermission:(result:ResolverResult)=>void=()=>{throw new Error('Desktop not ready');};
  let desktopQuestion:(result:ResolverResult)=>void=()=>{throw new Error('Desktop not ready');};
  const permissionRequest:ResolverRequest={agent:{sessionId:'native'},toolName:'Write'};
  const questionRequest:ResolverRequest={agent:{sessionId:'native'},questions:[{id:'q',question:'Which?',options:[{label:'A'}]}]};
  try{
    const permission=approval(permissionRequest,()=>new Promise(resolve=>{desktopPermission=resolve;}));
    const answer=question(questionRequest,()=>new Promise(resolve=>{desktopQuestion=resolve;}));
    await Promise.resolve();bridge.disconnect();const snapshot=await bridge.handlers.snapshot({sessionId:'native'});assert.equal(snapshot.pending.length,2);
    const p=snapshot.pending.find(p=>p.kind==='permission');const q=snapshot.pending.find(p=>p.kind==='question');assert.ok(p);assert.ok(q);
    desktopPermission('allowed-once');assert.equal(await permission,'allowed-once');
    assert.throws(()=>bridge.handlers.decide({sessionId:'native',pluginInstanceId:'plugin',turn:7,interactionId:p.interactionId,outcome:'rejected'}),/settled|stale/);
    assert.equal(bridge.handlers.decide({sessionId:'native',pluginInstanceId:'plugin',turn:7,interactionId:q.interactionId,answers:[{id:'q',selected:[],custom:'custom answer'}]}).accepted,true);
    assert.deepEqual(await answer,{answers:[{id:'q',selected:[],custom:'custom answer'}]});desktopQuestion({answers:[{id:'q',selected:['A']}]});await Promise.resolve();
    assert.equal(permissionRequest.signal?.aborted,true);assert.equal(questionRequest.signal?.aborted,true);assert.equal(bridge.pending.size,0);assert.equal(closed.length,2);assert.equal(new Set(closed).size,2);
    assert.equal((await bridge.handlers.snapshot({sessionId:'native'})).pending.length,0);
  }finally{bridge.close();}
});

test('DSH malformed opening cut and assistant chunk gaps both trigger automatic fresh-snapshot recovery',async()=>{
  const f=nativeContext('deepseek-harness');const adapter=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);adapter.byNative.set('native',f.session.id);let openings=0;let pages=0;
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('Expected TCP listener');server.on('connection',socket=>adapter.attach(socket));
  const client=new WebSocket(`ws://127.0.0.1:${address.port}`);
  client.on('message',raw=>{const message=JSON.parse(raw.toString());let result;
    if(message.method==='probe')result={pluginInstanceId:'plugin',control:true};
    else if(message.method==='snapshot')result={pluginInstanceId:'plugin',pending:[]};
    else if(message.method==='page'){pages++;throw new Error('Must not invent a missing cut');}
    else if(message.method==='subscribe'){
      openings++;result={subscriptionId:message.params.subscriptionId};
      const event=(frame:object)=>client.send(JSON.stringify({method:'event',params:{pluginInstanceId:'plugin',sessionId:'native',subscriptionId:message.params.subscriptionId,type:'follow',frame}}));
      if(openings===1)event({type:'snapshot',hasMore:true,records:[{event:{seq:9,type:'turn/start',data:{turn:1}}}]});
      else if(openings===2){event({type:'snapshot',cursor:9,hasMore:false,records:[]});event({type:'assistant-stream',frame:{type:'start',attemptId:'attempt',revision:1,turn:1,step:1}});event({type:'assistant-stream',frame:{type:'chunk',attemptId:'attempt',revision:1,index:2,chunk:{type:'text-delta',text:'lost prefix'}}});}
      else event({type:'snapshot',cursor:9,hasMore:false,records:[],assistantStream:{revision:1,activeAttempt:{attemptId:'attempt',turn:1,step:1,nextIndex:3,stream:[{type:'text-delta',text:'whole prefix'}]}}});
    }else throw new Error('Unexpected '+message.method);
    client.send(JSON.stringify({id:message.id,result}));
  });
  try{await until(()=>openings===3&&f.events.some(e=>e.data.text==='whole prefix')&&f.session.binding?.state==='attached');assert.equal(pages,0);assert.equal(adapter.epoch,1);assert.equal(adapter.streams.get('native')?.index,2);assert.ok(f.events.some(e=>e.data.message==='DSH snapshot missing pinned page cut'));assert.ok(f.events.some(e=>e.data.message==='DSH assistant stream index gap'));}
  finally{adapter.close();client.terminate();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('DSH unexpected native follow completion is reported as recoverable failure, not silent success',async()=>{
  const errors:string[]=[];
  const bridge=controllerBridge({on:()=>()=>{}},{async *follow(){yield{type:'snapshot',cursor:0,hasMore:false,records:[]};}},'plugin',(message:{params:{type:string;message?:string}})=>{if(message.params.type==='error'&&message.params.message)errors.push(message.params.message);});
  try{await bridge.handlers.subscribe({sessionId:'native',subscriptionId:'opening'});await until(()=>errors.length===1);assert.match(errors[0],/follow ended/);}finally{bridge.close();}
});

test('DSH lost prompt response reconciles native requestId from the surviving plugin registry without prompting again',async t=>{
  const f=waitingReceipt();const adapter=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);adapter.pluginInstanceId='plugin';let prompts=0;
  const bridge=controllerBridge({on:()=>()=>{}},{prompt:async()=>{prompts++;return{accepted:true};},projections:async()=>null},'plugin',()=>{});
  t.mock.method(adapter,'call',async(method:string,params:Parameters<DshAdapter['call']>[1])=>{if(method==='prompt'){await bridge.handlers.prompt(params);throw new Error('response lost');}assert.equal(method,'snapshot');return bridge.handlers.snapshot(params);});
  try{
    await assert.rejects(adapter.call('prompt',{sessionId:'native',requestId:'native-input',text:'same input'}),/response lost/);assert.equal(f.receipt.status,'uncertain');bridge.disconnect();
    await adapter.restorePending('native',f.session.id);assert.equal(f.receipt.status,'native_accepted');assert.equal(f.settled(),1);await adapter.restorePending('native',f.session.id);assert.equal(prompts,1);assert.equal(f.settled(),1);
    const repeated=await bridge.handlers.prompt({sessionId:'native',requestId:'native-input',text:'same input'});assert.equal(repeated.accepted,true);assert.equal(prompts,1);
    await assert.rejects(bridge.handlers.prompt({sessionId:'native',requestId:'native-input',text:'different input'}),/different input/);assert.equal(prompts,1);
  }finally{bridge.close();}
});

test('DSH registry prompt evidence cannot cross plugin, session, native input, or generation ownership',async t=>{
  const f=waitingReceipt();const adapter=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);adapter.pluginInstanceId='plugin';
  const evidence={pluginInstanceId:'other',sessionId:'native',requestId:'native-input',accepted:true};
  t.mock.method(adapter,'call',async()=>({pluginInstanceId:'plugin',pending:[],promptReceipts:[evidence]}));
  await adapter.restorePending('native',f.session.id);assert.equal(f.receipt.status,'uncertain');
  evidence.pluginInstanceId='plugin';evidence.sessionId='other';await adapter.restorePending('native',f.session.id);assert.equal(f.receipt.status,'uncertain');
  evidence.sessionId='native';evidence.requestId='other';await adapter.restorePending('native',f.session.id);assert.equal(f.receipt.status,'uncertain');
  evidence.requestId='native-input';f.run.generation=2;await adapter.restorePending('native',f.session.id);assert.equal(f.receipt.status,'uncertain');assert.equal(f.settled(),0);
});

test('DSH queued next turn receives its own persisted run and a late previous end cannot terminate it',async t=>{
  const f=await fixture();
  try{
    const context=f.core.context('deepseek-harness');const session=f.s;session.ref.engineId='deepseek-harness';session.ref.runtimeInstanceId=context.runtimeInstanceId;session.ref.nativeSessionId='native';session.epoch=context.epoch;session.state='idle';session.runId=undefined;session.binding={runtimeInstanceId:context.runtimeInstanceId,generation:context.epoch,nativeSessionId:'native',state:'attached',capabilities:{create:true,submit:true,observe:true,approve:true,answer:true,cancel:true,resume:true},nativeIdentity:'plugin'};f.store.put('session',session.id,session);
    const adapter=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},context);adapter.byNative.set('native',session.id);adapter.pluginInstanceId='plugin';
    t.mock.method(adapter,'call',async()=>({pluginInstanceId:'plugin',pending:[],state:{turn:7,active:true}}));
    adapter.durable('native',{seq:1,type:'turn/start',data:{turn:7}});const first=f.core.session(session.id).runId;assert.ok(first);
    adapter.fault(session.id,new Error('follow transport failed'));assert.equal(f.core.session(session.id).state,'uncertain');await adapter.follow('native',{type:'snapshot',cursor:1,hasMore:false,records:[{event:{seq:1,type:'turn/start',data:{turn:7}}}]});await adapter.restorePending('native',session.id);assert.equal(f.core.session(session.id).state,'running');assert.equal(f.core.session(session.id).runId,first);
    adapter.durable('native',{seq:2,type:'turn/end',data:{turn:7,reason:{kind:'aborted'}}});assert.equal(f.core.session(session.id).state,'cancelled');
    adapter.durable('native',{seq:3,type:'turn/start',data:{turn:8}});const second=f.core.session(session.id).runId;assert.ok(second);assert.notEqual(first,second);assert.equal(f.core.session(session.id).nativeRunId,'8');assert.equal(f.core.session(session.id).state,'running');
    adapter.durable('native',{seq:4,type:'turn/end',data:{turn:7,reason:{kind:'aborted'}}});assert.equal(f.core.session(session.id).runId,second);assert.equal(f.core.session(session.id).state,'running');
    adapter.durable('native',{seq:5,type:'turn/end',data:{turn:8,reason:{kind:'completed'}}});assert.equal(f.core.session(session.id).state,'completed');assert.equal(f.store.get<RunRecord>('run',first)?.state,'cancelled');assert.equal(f.store.get<RunRecord>('run',second)?.state,'completed');
  }finally{await f.close();}
});

test('DSH retained cancellation receipt reconciles the original run after inbox starts the next turn without recancelling',async t=>{
  const f=waitingReceipt();f.command.action='cancel';f.command.payload.runId='run';f.session.state='cancel_requested';const adapter=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);adapter.pluginInstanceId='plugin';adapter.turns.set('native',7);let cancels=0;
  const bridge=controllerBridge({on:()=>()=>{}},{cancel:()=>{cancels++;return{accepted:true};},projections:async()=>null},'plugin',()=>{});bridge.states.set('native',{turn:7,active:true});
  t.mock.method(adapter,'call',async(method:string,params:Parameters<DshAdapter['call']>[1])=>{if(method==='cancel'){bridge.handlers.cancel(params);throw new Error('response lost');}return bridge.handlers.snapshot(params);});
  try{await assert.rejects(adapter.requestCancel(f.session),/response lost/);f.session.runId='next-run';f.session.state='running';bridge.states.set('native',{turn:8,active:true});await adapter.restorePending('native',f.session.id);assert.equal(f.receipt.status,'native_accepted');assert.equal(f.session.state,'running');assert.equal(f.session.runId,'next-run');assert.equal(cancels,1);assert.equal(f.settled(),1);const receipt=(await bridge.handlers.snapshot({sessionId:'native'})).cancelReceipts[0];assert.equal(bridge.handlers.cancel({...receipt,pluginInstanceId:'plugin'}).accepted,true);assert.equal(cancels,1);assert.throws(()=>bridge.handlers.cancel({...receipt,pluginInstanceId:'plugin',runId:'next-run'}),/ownership mismatch/);}finally{bridge.close();}
});

test('DSH controller methods without host identity cannot enable native control',async()=>{
  const evidence=await controllerEvidence({create:()=>{},prompt:()=>{},cancel:()=>{},list:()=>{},page:()=>{},follow:()=>{},projections:()=>{}});
  assert.equal(controllerDigest,'a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386');assert.equal(evidence.apiProfile,'');assert.equal(evidence.controllerDigest,'');assert.match(evidence.detail,/loaded host service identity/);
});

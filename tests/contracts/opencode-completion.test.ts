import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AdapterContext, RunRecord } from '../../packages/protocol/src/types.ts';
import { OpenCodeAdapter } from '../../packages/adapters/opencode/index.ts';
import { nativeContext } from './fixtures/native-context.ts';
import { Store } from '../../apps/gateway/src/store.ts';
import type { Session } from '../../packages/protocol/src/types.ts';

function setup(){
  const f=nativeContext('opencode');
  const adapter=new OpenCodeAdapter('opencode',{command:'must-not-spawn',expectedVersion:'2.3.0'},f.context);
  adapter.byNative.set('native',f.session.id);
  return {...f,adapter};
}

test('OpenCode merges interleaved ordinals, replaces ended blocks and ignores duplicate and late deltas',()=>{
  const f=setup();let event=0;
  function text(type:string,ordinal:number,value:string){f.adapter.event({id:String(++event),type:`session.text.${type}`,data:{sessionID:'native',assistantMessageID:'msg_a',ordinal,delta:value,text:value}});}
  text('delta',1,'B');text('delta',0,'wrong');text('ended',0,'A');text('ended',1,'B');text('delta',0,'late');
  assert.equal(f.events.at(-1)?.data.text,'AB');
  const count=f.events.length;
  f.adapter.event({id:String(event),type:'session.text.delta',data:{sessionID:'native',assistantMessageID:'msg_a',ordinal:1,delta:'duplicate'}});
  assert.equal(f.events.length,count);
  text('started',0,'');text('delta',0,'late again');assert.equal(f.events.length,count);
});

test('OpenCode paginates opaque cursors without order and history replaces streaming text',async t=>{
  const f=setup();const paths:string[]=[];
  t.mock.method(f.adapter,'http',async(path:string)=>{
    paths.push(path);
    if(path.includes('/message?')&&!path.includes('&cursor='))return {data:[{id:'msg_a',type:'assistant',sessionID:'native',payload:{text:'first'}}],cursor:{next:'opaque/+='}};
    if(path.includes('&cursor='))return {data:[{id:'msg_a',type:'assistant',sessionID:'native',payload:{text:'authoritative'}}],cursor:{next:null}};
    if(path.endsWith('/permission')||path.endsWith('/form'))return {data:[]};
    return {data:{id:'native',time:{}}};
  });
  await f.adapter.reconcile('native',f.session.id);
  assert.ok(paths.includes('/api/session/native/message?limit=100&cursor=opaque%2F%2B%3D'));
  const count=f.events.length;
  f.adapter.event({id:'late',type:'session.text.delta',data:{sessionID:'native',assistantMessageID:'msg_a',ordinal:0,delta:'duplicate'}});
  assert.equal(f.events.length,count);
  assert.equal(f.events.filter(e=>e.type==='message.completed').at(-1)?.data.text,'authoritative');
});

test('OpenCode rejects repeated history cursors and cross-session native messages',async t=>{
  const f=setup();let wrong=false;
  t.mock.method(f.adapter,'http',async(path:string)=>path.includes('/message?')?{data:wrong?[{id:'msg',type:'user',sessionID:'other'}]:[],cursor:{next:'same'}}:{data:{id:'native'}});
  await assert.rejects(f.adapter.reconcile('native',f.session.id),/cursor repeated/);
  wrong=true;await assert.rejects(f.adapter.reconcile('native',f.session.id),/identity mismatch/);
});

test('OpenCode session-only desktop events cannot terminate or restart the prior gateway run',async t=>{
  const f=setup();f.session.runId='gateway-run';f.session.state='completed';
  t.mock.method(f.adapter,'http',async(path:string)=>path.endsWith('/permission')||path.endsWith('/form')||path.includes('/message?')?{data:[]}:{data:{id:'native',outcome:'succeeded',time:{idle:4}}});
  f.adapter.event({id:'desktop-start',type:'session.execution.started',data:{sessionID:'native'}});
  f.adapter.event({id:'desktop-end',type:'session.execution.interrupted',data:{sessionID:'native'}});
  assert.equal(f.session.state,'completed');assert.equal(f.events.length,0);
  f.session.state='running';
  f.adapter.event({id:'unattributed-end',type:'session.execution.succeeded',data:{sessionID:'native'}});
  assert.equal(f.session.state,'uncertain');
  t.mock.method(f.adapter,'http',async(path:string)=>path.endsWith('/permission')||path.endsWith('/form')?{data:[]}:{data:{id:'native',outcome:'succeeded',time:{idle:4}}});
  await f.adapter.reconcile('native',f.session.id,false);
  assert.equal(f.session.state,'uncertain');
});

test('OpenCode production tool mapping uses the local fixture contract and reports the tool-history gap',async t=>{
  const f=setup();
  f.adapter.event({id:'call',type:'session.tool.called',data:{sessionID:'native',assistantMessageID:'assistant',id:'tool',input:{command:'node --test'},executed:true}});
  f.adapter.event({id:'failed',type:'session.tool.failed',data:{sessionID:'native',assistantMessageID:'assistant',id:'tool',content:'stderr',error:{message:'exit failure'},executed:true}});
  assert.equal(f.events.at(-1)?.data.output,'stderr');assert.deepEqual(f.events.at(-1)?.data.error,{message:'exit failure'});assert.equal(f.session.state,'idle');
  t.mock.method(f.adapter,'http',async(path:string)=>path.endsWith('/permission')||path.endsWith('/form')||path.includes('/message?')?{data:[]}:{data:{id:'native',time:{}}});
  await f.adapter.reconcile('native',f.session.id);await f.adapter.reconcile('native',f.session.id);
  assert.equal(f.events.filter(e=>e.type==='error'&&e.data.code==='opencode_tool_history_unavailable').length,1);
  assert.equal(f.events.filter(e=>e.type==='tool.updated').length,2);
});

test('OpenCode desktop started verifies a fresh busy boundary and late old events cannot end the observed run',async t=>{
  const f=setup();const store=new Store(':memory:');t.after(()=>store.db.close());
  f.session.runId='old-run';f.session.nativeRunId='old-input';f.session.state='completed';
  f.session.binding=f.adapter.binding('native',f.adapter.control,'service');
  store.put('session',f.session.id,f.session);store.put('run','old-run',{runId:'old-run',sessionId:f.session.id,generation:1,state:'completed',nativeStartedAt:10});
  f.context.getSession=()=>store.get<Session>('session',f.session.id)!;
  f.context.getRun=runId=>store.get<RunRecord>('run',runId);
  f.context.emit=(_,type,data)=>{store.event(f.session.id,type,data);};
  let info={id:'native',time:{busy:20,idle:10},outcome:'succeeded'};
  t.mock.method(f.adapter,'http',async(path:string)=>path.includes('/message?')||path.endsWith('/permission')||path.endsWith('/form')?{data:[]}:{data:info});
  f.adapter.event({id:'new-start',type:'session.execution.started',data:{sessionID:'native'}});
  await f.adapter.refreshing.get('native');
  const observed=f.context.getSession(f.session.id);assert.equal(observed.state,'running');assert.notEqual(observed.runId,'old-run');assert.equal(observed.nativeRunId,'opencode:busy:20');
  for(const event of ['session.execution.started','session.execution.succeeded','session.execution.interrupted']){
    f.adapter.event({id:event,type:event,data:{sessionID:'native'}});await f.adapter.refreshing.get('native');
    assert.equal(f.context.getSession(f.session.id).state,'running');assert.equal(f.context.getSession(f.session.id).runId,observed.runId);
  }
  info={id:'native',time:{busy:10,idle:15},outcome:'succeeded'};
  await f.adapter.reconcile('native',f.session.id);assert.equal(f.context.getSession(f.session.id).state,'running');
  info={id:'native',time:{busy:20,idle:30},outcome:'failed'};
  await f.adapter.reconcile('native',f.session.id);assert.equal(f.context.getSession(f.session.id).state,'failed');
  f.adapter.event({id:'duplicate-start',type:'session.execution.started',data:{sessionID:'native'}});await f.adapter.refreshing.get('native');
  assert.equal(f.context.getSession(f.session.id).runId,observed.runId);assert.equal(store.get<RunRecord>('run','old-run')?.state,'completed');
});

function pending(f:ReturnType<typeof setup>,action:'submit'|'cancel'){
  f.session.runId='gateway-run';f.session.state='uncertain';
  const run:RunRecord={runId:'gateway-run',sessionId:f.session.id,generation:1,clientRequestId:'request',deviceId:'device',nativeRequestId:'native-request',state:'uncertain'};
  f.context.getRun=()=>run;
  const controls:ReturnType<NonNullable<AdapterContext['pendingCommands']>>=[{deviceId:'device',clientRequestId:'request',command:{protocolVersion:2,hostId:'host',sessionId:f.session.id,clientRequestId:'request',ref:f.session.ref,action,payload:{runId:'gateway-run',expectedGeneration:1}},receipt:{clientRequestId:'request',status:'uncertain',runId:'gateway-run',nativeRequestId:'native-request',generation:1}}];
  f.context.pendingCommands=()=>controls;
  const receipts:Array<{status:string;detail?:string}>=[];
  f.context.reconcileReceipt=(_,__,evidence)=>{receipts.push(evidence);};
  return {run,receipts};
}

test('OpenCode uncertain submit requires matching native user-message evidence, not idle or assistant output',async t=>{
  const f=setup();const p=pending(f,'submit');let matching=false;
  t.mock.method(f.adapter,'http',async(path:string)=>{
    if(path.includes('/message?'))return {data:[{id:'msg_input',type:'user',sessionID:'native',metadata:{aiMaidCafeRequestId:matching?'native-request':'desktop-request'}},{id:'msg_output',type:'assistant',payload:{text:'done'}}],cursor:{next:null}};
    if(path.endsWith('/permission')||path.endsWith('/form'))return {data:[]};
    return {data:{id:'native',outcome:'succeeded',time:{idle:4}}};
  });
  await f.adapter.reconcile('native',f.session.id);assert.equal(p.receipts.length,0);
  matching=true;await f.adapter.reconcile('native',f.session.id);assert.equal(p.receipts.length,1);assert.equal(p.receipts[0].status,'native_accepted');assert.equal(f.session.state,'uncertain');
  p.run.deviceId='other';await f.adapter.reconcile('native',f.session.id);assert.equal(p.receipts.length,1);
});

test('OpenCode direct native message ID settles submit without manufacturing an execution ID',()=>{
  const f=setup();const p=pending(f,'submit');
  f.adapter.confirmInput(f.session.id,{id:'native-request',sessionID:'native',type:'user'});
  assert.equal(p.receipts.length,1);assert.equal(f.session.nativeRunId,undefined);
});

test('OpenCode idle snapshots and false interrupts cannot settle uncertain cancel; true acknowledges only acceptance',async t=>{
  const f=setup();const p=pending(f,'cancel');let interrupted=false;
  t.mock.method(f.adapter,'connection',async()=>{});
  t.mock.method(f.adapter,'http',async(path:string)=>path.includes('/interrupt?')?{interrupted}:path.includes('/message')||path.endsWith('/permission')||path.endsWith('/form')?{data:[]}:{data:{id:'native',outcome:'succeeded',time:{idle:4}}});
  await f.adapter.reconcile('native',f.session.id);assert.equal(p.receipts.length,0);assert.equal(f.session.state,'uncertain');
  await assert.rejects(f.adapter.requestCancel(f.session),/not confirmed/);assert.equal(p.receipts.length,0);
  interrupted=true;await f.adapter.requestCancel(f.session);assert.equal(p.receipts.length,1);assert.equal(f.session.state,'uncertain');
});

test('OpenCode SSE recovery buffers events and second snapshot repairs messages and withdrawn pending requests',async t=>{
  const f=setup();let snapshots=0;let history=0;let permission=0;
  const server=createServer((_,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(': ready\n\n');});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('Missing listener');
  f.adapter.endpoint={url:`http://127.0.0.1:${address.port}`,headers:{authorization:'Bearer synthetic'}};
  t.mock.method(f.adapter,'http',async(path:string)=>{
    if(path.includes('/message?')){history++;return {data:history===1?[]:[{id:'msg_gap',type:'assistant',sessionID:'native',payload:{text:'Recovered after first history read'}}],cursor:{next:null}};}
    if(path.endsWith('/permission')){permission++;return {data:permission===1?[{id:'request',sessionID:'native',action:'execute'}]:[]};}
    if(path.endsWith('/form'))return {data:[]};
    snapshots++;
    if(snapshots===1)f.adapter.buffered.push({id:'buffered',type:'session.text.delta',data:{sessionID:'native',assistantMessageID:'msg_gap',ordinal:0,delta:'stale partial'}});
    return {data:{id:'native',time:{},outcome:snapshots===1?undefined:'succeeded'}};
  });
  try{
    await f.adapter.openStream();
    assert.equal(history,2);assert.equal(snapshots,2);assert.equal(f.session.state,'completed');
    assert.equal(f.events.filter(e=>e.type==='message.completed').at(-1)?.data.text,'Recovered after first history read');
    assert.equal(f.session.interactions[0].status,'resolved');assert.equal(f.adapter.recovering,false);
  }finally{f.adapter.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('OpenCode active history uses fresh authoritative snapshots rather than appending overlapping deltas',async t=>{
  const f=setup();let text='partial';let idle=false;
  t.mock.method(f.adapter,'http',async(path:string)=>{
    if(path.includes('/message?'))return {data:[{id:'msg_active',type:'assistant',sessionID:'native',payload:{text}}],cursor:{next:null}};
    if(path.endsWith('/permission')||path.endsWith('/form'))return {data:[]};
    return {data:{id:'native',time:{busy:1,idle:idle?2:undefined}}};
  });
  await f.adapter.reconcile('native',f.session.id);
  text='partial plus final';idle=true;
  f.adapter.event({id:'fresh',type:'session.text.ended',data:{sessionID:'native',assistantMessageID:'msg_active',ordinal:0,text:'partial plus final'}});
  await f.adapter.refreshing.get('native');
  assert.equal(f.events.filter(e=>e.type==='message.completed').at(-1)?.data.text,'partial plus final');
  assert.equal(f.adapter.activeSnapshots.size,0);
});

test('OpenCode cancel captures its target before reconnect and refuses a changed run',async t=>{
  const f=setup();pending(f,'cancel');let calls=0;
  t.mock.method(f.adapter,'connection',async()=>{f.session.runId='next-run';});
  t.mock.method(f.adapter,'http',async()=>{calls++;return {interrupted:true};});
  await assert.rejects(f.adapter.requestCancel(f.session),/target changed/);assert.equal(calls,0);
});

test('OpenCode explicit SSE overflow disconnects and requests reconciliation',async t=>{
  const f=setup();f.session.state='running';let reconnects=0;
  t.mock.method(f.adapter,'reconnect',async()=>{reconnects++;});
  const controller=new AbortController();f.adapter.controller=controller;
  await f.adapter.consume(new Response('data: {"type":"effect/http-api/stream/failure"}\n\n'),controller);
  assert.equal(reconnects,1);assert.equal(f.session.state,'uncertain');
  assert.ok(f.events.some(e=>e.type==='error'&&String(e.data.message).includes('overflow')));
});

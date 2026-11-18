import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { CodexAdapter } from '../../packages/adapters/codex/index.ts';
import { OpenCodeAdapter } from '../../packages/adapters/opencode/index.ts';
import { ClaudeCodeAdapter, InputQueue } from '../../packages/adapters/claude-code/index.ts';
import { controllerBridge } from '../../plugins/dsh-bridge/controller.mjs';
import { nativeContext, until } from './fixtures/native-context.ts';
import { AdapterBase } from '../../packages/adapters/common/base.ts';
import type { RuntimeDescriptor, Session } from '../../packages/protocol/src/types.ts';
import type { WebSocketRpc } from '../../packages/adapters/common/ws-rpc.ts';
import { DshAdapter } from '../../packages/adapters/deepseek-harness/index.ts';
import { fixture } from '../helpers.ts';
import { Core } from '../../apps/gateway/src/core.ts';

test('Codex uses one shared WS, preserves typed approval IDs, resumes without spawning and handles early completion',async t=>{
  const f=nativeContext();const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();if(typeof address==='string'||!address)throw new Error('No listener');
  let connections=0;const calls:any[]=[];const answers:any[]=[];
  server.on('connection',socket=>{connections++;socket.on('message',raw=>{const m=JSON.parse(raw.toString());if(!m.method){answers.push(m);return;}calls.push(m);if(m.id===undefined)return;
    let result:any={};if(m.method==='thread/start')result={thread:{id:'native'}};
    if(m.method==='thread/resume')result={thread:{id:'native',status:{type:'idle'},turns:[]}};
    if(m.method==='thread/read')result={thread:{id:'native',cwd:f.session.cwd,status:{type:'idle'},turns:[]}};
    if(m.method==='turn/start'){socket.send(JSON.stringify({method:'turn/completed',params:{threadId:'native',turn:{id:'turn-1',status:'completed'}}}));result={turn:{id:'turn-1'}};}
    socket.send(JSON.stringify({id:m.id,result}));
  });});
  const adapter=new CodexAdapter('codex',{command:'must-not-spawn',expectedVersion:'',runtimeIdentity:'shared-process-1',endpoint:`ws://127.0.0.1:${address.port}`},f.context);
  t.mock.method(adapter,'checkVersion',async()=>{});
  try{await Promise.all([adapter.connection(''),adapter.connection('')]);assert.equal(connections,1);await adapter.createSession(f.session.id,f.workspace);
    const socket=[...server.clients][0];for(const id of [71,'71'])socket.send(JSON.stringify({id,method:'item/commandExecution/requestApproval',params:{threadId:'native',turnId:'turn-1',itemId:'tool',command:'test'}}));
    await until(()=>f.session.interactions.length===2);for(const i of f.session.interactions)await adapter.respond(f.session,i,{interactionId:i.id,epoch:1,choiceId:'accept'});await until(()=>answers.length===2);assert.deepEqual(answers.map(a=>a.id),[71,'71']);await assert.rejects(adapter.respond(f.session,f.session.interactions[0],{interactionId:'old',epoch:1,choiceId:'decline'}),/no longer pending/);
    f.session.state='accepted';await adapter.submit(f.session,{text:'test',attachments:[],requestId:'request'});assert.equal(f.session.state,'completed');assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
    assert.deepEqual(calls.find(c=>c.method==='thread/read').params,{threadId:'native',includeTurns:false});adapter.rpc!.socket.terminate();await until(()=>!adapter.rpc);await adapter.resumeSession(f.session);assert.deepEqual(calls.find(c=>c.method==='thread/resume').params,{threadId:'native'});assert.equal(connections,2);assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
  }finally{adapter.close();for(const s of server.clients)s.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('Codex additional permissions and user input return distinct native shapes',async()=>{const f=nativeContext();const a=new CodexAdapter('codex',{command:'',expectedVersion:''},f.context);a.byNative.set('native',f.session.id);const responses:any[]=[];a.rpc={respond:(id:any,result:any)=>responses.push({id,result})} as any;
  const permissions={network:{enabled:true},fileSystem:{read:['/approved'],write:null}};
  a.request({id:'permissions',method:'item/permissions/requestApproval',params:{threadId:'native',permissions}});await a.respond(f.session,f.session.interactions[0],{interactionId:'x',epoch:1,choiceId:'turn'});assert.deepEqual(responses[0],{id:'permissions',result:{permissions,scope:'turn'}});
  a.request({id:42,method:'item/tool/requestUserInput',params:{threadId:'native',questions:[{id:'q',question:'Choose',options:null,isSecret:true}],isBlocking:true}});assert.equal((f.session.interactions[1].questions[0] as unknown as Record<string,unknown>).isSecret,true);await a.respond(f.session,f.session.interactions[1],{interactionId:'y',epoch:1,answers:{q:['secret-contract-value']}});assert.deepEqual(responses[1],{id:42,result:{answers:{q:{answers:['secret-contract-value']}}}});assert.equal(f.events.some(e=>JSON.stringify(e.data).includes('secret-contract-value')),false);
});

test('Codex probe never opens control on a version-only mismatch or failed installation',async t=>{
  const f=nativeContext();const a=new CodexAdapter('codex',{command:'must-not-spawn',expectedVersion:'codex-cli 0.169.0'},f.context);let version='codex-cli 0.167.1';let installed=true;let connections=0;
  t.mock.method(AdapterBase.prototype,'probe',async():Promise<RuntimeDescriptor>=>({id:'codex',runtimeInstanceId:'runtime',version,installed,authentication:'unknown',verified:false,detail:'Synthetic version evidence',capabilities:{text:false,image:false,files:false,history:false,permission:false,questions:false,cancelScope:'unavailable',models:false},models:[]}));
  t.mock.method(a,'connection',async()=>{connections++;return {} as WebSocketRpc;});t.mock.method(a,'listModels',async()=>[]);
  assert.equal((await a.probe()).capabilities.text,false);assert.equal(connections,0);version='codex-cli 0.169.0';installed=false;assert.equal((await a.probe()).capabilities.text,false);assert.equal(connections,0);installed=true;const connected=await a.probe();assert.equal(connected.controlCapabilities?.create,true);assert.equal(connected.verified,false);assert.equal(connections,1);a.config.expectedVersion='codex-cli 0.167.1';assert.equal((await a.probe()).capabilities.text,false);assert.equal(connections,1);await assert.rejects(a.checkVersion(),/rust-v0.169.0/);
});

test('Claude persistent official SDK boundary consumes queue, settles permission once, confirms result and resumes same session',async t=>{
  const f=nativeContext('claude-code');const a=new ClaudeCodeAdapter('claude-code',{command:process.execPath,expectedVersion:''},f.context);a.readScope=async()=>'fixture-account-and-route';const outputs:InputQueue<any>[]=[];const inputs:any[]=[];const options:any[]=[];let interrupts=0;
  t.mock.method(a,'checkVersion',async()=>{});
  t.mock.method(a,'loadSdk',async()=>({query:({prompt,options:opts}:any)=>{options.push(opts);const output=new InputQueue<any>();outputs.push(output);output.push({type:'system',subtype:'init',session_id:'native',model:'actual'});void(async()=>{for await(const input of prompt)inputs.push(input);})();return{[Symbol.asyncIterator]:()=>output[Symbol.asyncIterator](),interrupt:async()=>{interrupts++;return{still_queued:[]};},return:async()=>{output.close();},setModel:async()=>{}};}}));
  try{const created=await a.createSession(f.session.id,f.workspace);assert.equal(created.nativeSessionId,'native');await a.submit(f.session,{text:'one',attachments:[],requestId:'input-1'});await until(()=>inputs.length===1);assert.equal(f.events.some(e=>e.data.nativeAccepted===true),false);
    outputs[0].push({type:'stream_event',session_id:'native',user_message_uuid:'input-1',event:{type:'message_start',message:{id:'assistant'}}});await until(()=>f.session.state==='running');
    const abort=new AbortController();const waiting=options[0].canUseTool('AskUserQuestion',{questions:[{question:'Which tests?',header:'Tests',multiSelect:false,options:[{label:'All'},{label:'Unit'}]}]},{requestId:'permission',toolUseID:'tool',signal:abort.signal});const i=f.session.interactions.at(-1)!;
    await a.respond(f.session,i,{interactionId:i.id,epoch:1,answers:{'Which tests?':['All']}});const permission=await waiting;assert.deepEqual(permission.updatedInput.answers,{'Which tests?':'All'});await assert.rejects(a.respond(f.session,i,{interactionId:i.id,epoch:1,answers:{'Which tests?':['Unit']}}),/already settled/);
    await a.requestCancel(f.session);assert.equal(interrupts,1);assert.notEqual(f.session.state,'cancelled');outputs[0].push({type:'result',session_id:'native',user_message_uuid:'input-1',subtype:'success',is_error:false,terminal_reason:'completed',result:'done'});await until(()=>f.session.state==='completed');
    await a.submit(f.session,{text:'two',attachments:[],requestId:'input-2'});assert.equal(options.length,1);outputs[0].push({type:'result',session_id:'native',user_message_uuid:'input-2',subtype:'error_during_execution',is_error:true,terminal_reason:'api_error',errors:['offline']});await until(()=>f.session.state==='failed');outputs[0].close();await until(()=>!a.live.size);await a.resumeSession(f.session);await until(()=>options.length===2);assert.equal(options[1].resume,'native');
  }finally{a.close();for(const output of outputs)output.close();}
});

test('Claude native abort closes a pending callback and stale decision cannot revive it',async t=>{const f=nativeContext('claude-code');const a=new ClaudeCodeAdapter('claude-code',{command:process.execPath,expectedVersion:''},f.context);const output=new InputQueue<any>();output.push({type:'system',subtype:'init',session_id:'native'});t.mock.method(a,'checkVersion',async()=>{});t.mock.method(a,'loadSdk',async()=>({query:()=>({[Symbol.asyncIterator]:()=>output[Symbol.asyncIterator](),interrupt:async()=>{},return:async()=>output.close()})}));try{await a.createSession(f.session.id,f.workspace);const signal=new AbortController();const permission=a.permission(f.session.id,'Bash',{command:'long'},{requestId:'p',toolUseID:'tool',signal:signal.signal});const i=f.session.interactions.at(-1)!;signal.abort();assert.equal((await permission).behavior,'deny');await assert.rejects(a.respond(f.session,i,{interactionId:i.id,epoch:1,choiceId:'allow'}),/no longer live/);}finally{a.close();output.close();}});

test('OpenCode v2 discovers without ensure, parses SSE frames and reconciles missed terminal and pending forms',async t=>{
  const f=nativeContext('opencode');let stream:ServerResponse|undefined;let outcome:string|undefined;let opens=0;let formPending=true;const calls:Array<{url:string;method:string;body:any}>=[];
  const server=createServer(async(req,res)=>{const url=req.url!;let body='';for await(const c of req)body+=c;calls.push({url,method:req.method!,body:body?JSON.parse(body):undefined});if(url==='/api/event'){opens++;stream=res;res.writeHead(200,{'content-type':'text/event-stream'});res.write(': ready\n\n');return;}res.setHeader('content-type','application/json');
    if(url==='/api/session'&&req.method==='POST'){res.end(JSON.stringify({data:{id:'native',model:{id:'actual',providerID:'provider'}}}));return;}
    if(url.includes('/form/')&&req.method==='POST'){formPending=false;res.writeHead(204).end();return;}
    if(url.includes('/interrupt')){res.end('{"interrupted":true}');return;}
    if(url.includes('/prompt')){res.end('{"data":{"id":"msg_inbox"}}');return;}
    if(url.includes('/message')){res.end(JSON.stringify({data:[{id:'msg_final',type:'assistant',payload:{text:'Recovered final'}}],cursor:{next:null}}));return;}
    if(url.endsWith('/permission')){res.end('{"data":[]}');return;}
    if(url.endsWith('/form')){res.end(JSON.stringify({data:formPending?[{id:'form',sessionID:'native',title:'Test',fields:[{key:'enabled',type:'boolean',required:true},{key:'count',type:'integer',minimum:1,maximum:3,required:true}]}]:[]}));return;}
    res.end(JSON.stringify({data:{id:'native',time:{created:1,updated:2},outcome}}));
  });server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No listener');
  const a=new OpenCodeAdapter('opencode',{command:'must-not-spawn',expectedVersion:''},f.context);t.mock.method(a,'discover',async()=>({url:`http://127.0.0.1:${address.port}`,headers:{authorization:'Bearer contract'}}));
  t.mock.method(a,'checkVersion',async()=>{});
  try{await a.createSession(f.session.id,f.workspace);await a.resumeSession(f.session);const i=f.session.interactions.at(-1)!;assert.deepEqual(i.form,[{key:'enabled',type:'boolean',required:true},{key:'count',type:'integer',minimum:1,maximum:3,required:true}]);await assert.rejects(a.respond(f.session,i,{interactionId:i.id,epoch:1,answer:{enabled:'true',count:2}}),/Invalid form field/);await assert.rejects(a.respond(f.session,i,{interactionId:i.id,epoch:1,answer:{enabled:true,count:9}}),/Invalid form field/);await a.respond(f.session,i,{interactionId:i.id,epoch:1,answer:{enabled:true,count:2}});assert.deepEqual(calls.find(c=>c.url.includes('/form/form/reply'))!.body,{answer:{enabled:true,count:2}});
    await a.submit(f.session,{text:'test',attachments:[],requestId:'request'});await a.requestCancel(f.session);assert.ok(calls.some(c=>c.url.endsWith('/interrupt?resume=false')));assert.notEqual(f.session.state,'cancelled');
    const event={id:'delta',created:1,type:'session.text.delta',data:{sessionID:'native',assistantMessageID:'msg_a',ordinal:0,delta:'part'}};const encoded=JSON.stringify(event);const split=encoded.indexOf(',"data"');stream!.write(`data: ${encoded.slice(0,split)},\r\ndata: ${encoded.slice(split+1)}\r\n\r\n`);await until(()=>f.events.some(e=>e.type==='message.delta'));
    outcome='succeeded';stream!.destroy();await until(()=>opens===2&&f.session.state==='completed');assert.ok(f.events.some(e=>e.type==='message.completed'&&e.data.text==='Recovered final'));assert.equal(calls.filter(c=>c.url.endsWith('/prompt')).length,1);
  }finally{a.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('DSH controller registry arbitrates desktop/phone once, preserves resolver across disconnect and validates active turn cancel',async()=>{
  const listeners=new Map<string,Function>();const events:any[]=[];let followInput:any;let cancelled=0;const frames=new InputQueue<any>();
  const ctl={follow:(request:any)=>{followInput=request;return frames;},create:async(request:any)=>({sessionId:'actual'}),prompt:async(request:any,signal:AbortSignal)=>({accepted:true}),cancel:()=>{cancelled++;return{accepted:true};},projections:async()=>({kind:'sequenced',asOfSeq:1,values:{}}),page:async()=>({records:[],hasMore:false})};
  const bridge=controllerBridge({on:(name:string,listener:Function)=>{listeners.set(name,listener);return()=>listeners.delete(name);}},ctl,'plugin',(event:any)=>events.push(event));
  try{assert.equal((await bridge.handlers.create({cwd:process.cwd()})).sessionId,'actual');await bridge.handlers.subscribe({sessionId:'native',subscriptionId:'sub'});frames.push({type:'snapshot',records:[{type:'event',event:{seq:1,type:'turn/start',data:{turn:4}}}],cursor:1,hasMore:false});await until(()=>bridge.states.has('native'));assert.deepEqual(followInput,{address:{kind:'session',sessionId:'native'},maxMessages:100,assistantStream:true});
    let desktop!:(v:string)=>void;const nativeSignal=new AbortController();const waiting=listeners.get('approval/request')!({agent:{sessionId:'native'},toolName:'Bash',callId:'call',signal:nativeSignal.signal},()=>new Promise(resolve=>{desktop=resolve;}));await until(()=>bridge.pending.size===1);const entry=[...bridge.pending.values()][0];bridge.disconnect();assert.equal(bridge.pending.size,1);
    const decision={pluginInstanceId:'plugin',sessionId:'native',turn:4,interactionId:entry.interactionId,outcome:'allowed-once'};assert.deepEqual(bridge.handlers.decide(decision),{accepted:true});assert.equal(await waiting,'allowed-once');desktop('rejected');nativeSignal.abort();assert.equal(events.filter(e=>e.params.type==='interaction.closed').length,1);assert.throws(()=>bridge.handlers.decide(decision),/settled/);
    assert.throws(()=>bridge.handlers.cancel({sessionId:'native',turn:3}),/changed/);assert.equal(cancelled,0);bridge.handlers.cancel({sessionId:'native',turn:4});assert.equal(cancelled,1);
    const withoutSignal=listeners.get('approval/request')!({agent:{sessionId:'native'},toolName:'Write'},async()=> 'unavailable');
    const questionsWithoutSignal=listeners.get('user-questions/request')!({agent:{sessionId:'native'},questions:[{id:'q',question:'Continue?'}]},()=>new Promise(()=>{}));
    const endedEntries=[...bridge.pending.values()];assert.equal(endedEntries.length,2);frames.push({type:'event',event:{seq:2,type:'turn/end',data:{turn:4,reason:{kind:'completed'}}}});await until(()=>bridge.pending.size===0);assert.equal(await withoutSignal,'cancelled');assert.deepEqual(await questionsWithoutSignal,{answers:[]});for(const old of endedEntries)assert.throws(()=>bridge.handlers.decide({...decision,interactionId:old.interactionId}),/settled or stale/);assert.equal(cancelled,1);
  }finally{bridge.close();frames.close();}
});

test('DSH gateway restart with the same live plugin preserves generation and restores its pending resolver',async()=>{
  const f=await fixture();const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No listener');
  const pluginInstanceId='surviving-plugin';let pending=true;let decisions=0;const registry={pluginInstanceId,sessionId:'native-dsh',turn:3,interactionId:'native-wait',kind:'permission',request:{toolName:'Bash'}};
  server.on('connection',socket=>socket.on('message',raw=>{const m=JSON.parse(raw.toString());let result:any={};if(m.method==='probe')result={pluginInstanceId,control:true};if(m.method==='subscribe'){socket.send(JSON.stringify({method:'event',params:{pluginInstanceId,sessionId:'native-dsh',subscriptionId:m.params.subscriptionId,type:'follow',frame:{type:'snapshot',cursor:1,hasMore:false,records:[{type:'event',event:{seq:1,type:'turn/start',data:{turn:3}}}]}}}));result={subscriptionId:m.params.subscriptionId};}if(m.method==='snapshot')result={pluginInstanceId,pending:pending?[registry]:[]};if(m.method==='decide'){decisions++;pending=false;result={accepted:true};}socket.send(JSON.stringify({id:m.id,result}));}));
  const initialContext=f.core.context('deepseek-harness');const stored:Session={...f.s,id:'dsh-managed',ref:{...f.s.ref,engineId:'deepseek-harness',runtimeInstanceId:initialContext.runtimeInstanceId,nativeSessionId:'native-dsh'},binding:{runtimeInstanceId:initialContext.runtimeInstanceId,nativeSessionId:'native-dsh',generation:0,state:'disconnected',capabilities:{create:true,submit:true,observe:true,approve:true,answer:true,cancel:true,resume:true}},epoch:0,interactions:[]};f.store.put('session',stored.id,stored);
  const adapters:DshAdapter[]=[];const sockets:WebSocket[]=[];
  const port=address.port;
  async function attach(core:Core){const a=new DshAdapter('deepseek-harness',{command:'must-not-spawn',expectedVersion:'0.2.1-rc.5'},core.context('deepseek-harness'));adapters.push(a);a.byNative.set('native-dsh',stored.id);const socket=new WebSocket(`ws://127.0.0.1:${port}`);sockets.push(socket);await once(socket,'open');a.attach(socket);await a.handshake;await until(()=>core.session(stored.id).binding?.state==='attached');return a;}
  try{const first=await attach(f.core);const original=f.core.session(stored.id);const generation=original.binding!.generation;const localId=original.interactions[0].id;first.socket!.terminate();await until(()=>f.core.session(stored.id).binding?.state==='disconnected');f.store.recover();const restarted=new Core(f.store,f.core.hostId,[f.root]);const second=await attach(restarted);const restored=restarted.session(stored.id);assert.equal(restored.binding!.generation,generation);assert.equal(restored.binding!.nativeIdentity,pluginInstanceId);assert.equal(restored.interactions.filter(i=>i.status==='pending').length,1);assert.equal(restored.interactions[0].id,localId);await second.respond(restored,restored.interactions[0],{interactionId:localId,epoch:generation,choiceId:'allowed-once'});assert.equal(decisions,1);assert.equal(pending,false);}
  finally{const disconnected=sockets.filter(s=>s.readyState!==WebSocket.CLOSED).map(s=>once(s,'close'));for(const a of adapters)a.close();for(const socket of sockets)socket.terminate();for(const socket of server.clients)socket.terminate();await Promise.all(disconnected);await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});

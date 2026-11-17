import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DshAdapter } from '../../packages/adapters/deepseek-harness/index.ts';
import { controllerBridge } from '../../plugins/dsh-bridge/controller.mjs';
import { nativeContext } from './fixtures/native-context.ts';

test('DSH bridge adoption proves live ordinary Agent ownership and canonical cwd without activation', async () => {
  const cwd=await realpath('.');
  const row={sessionId:'native',cwd,agentAvailable:true,formatStatus:'current',origin:undefined as string|undefined};
  const bridge=controllerBridge({on:()=>()=>{}},{list:async()=>({items:[row]})},'plugin',()=>{});
  const request={pluginInstanceId:'plugin',sessionId:'native',cwd};
  try {
    assert.deepEqual(await bridge.handlers.attach(request),{pluginInstanceId:'plugin',sessionId:'native',cwd,agentAvailable:true});
    await assert.rejects(bridge.handlers.attach({...request,pluginInstanceId:'other'}),/generation/);
    await assert.rejects(bridge.handlers.attach({...request,sessionId:'other'}),/not owned/);
    await assert.rejects(bridge.handlers.attach({...request,cwd:await realpath('..')}),/workspace/);
    row.agentAvailable=false;await assert.rejects(bridge.handlers.attach(request),/not owned/);
    row.agentAvailable=true;row.formatStatus='migration-required';await assert.rejects(bridge.handlers.attach(request),/not owned/);
    row.formatStatus='current';row.origin='subagent';await assert.rejects(bridge.handlers.attach(request),/not owned/);
  } finally { bridge.close(); }
});

test('DSH adoption checks both native evidence and opening header before binding; history remains silent', async t => {
  const f=nativeContext('deepseek-harness');const cwd=await realpath(f.session.cwd);
  const a=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);a.pluginInstanceId='plugin';
  const methods:string[]=[];
  t.mock.method(a,'call',async(method:string)=>{
    methods.push(method);
    if(method==='attach')return{pluginInstanceId:'plugin',sessionId:'native',cwd,agentAvailable:true};
    assert.equal(method,'snapshot');return{pluginInstanceId:'plugin',pending:[]};
  });
  t.mock.method(a,'subscribe',async()=>{
    await a.follow('native',{type:'snapshot',header:{id:'native',cwd},cursor:1,hasMore:false,records:[{event:{seq:0,type:'turn/start',data:{turn:1}}},{event:{seq:1,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}}]});
  });
  const binding=await a.attachExistingSession(f.session,'plugin');
  assert.equal(binding.state,'attached');assert.equal(binding.nativeIdentity,'plugin');assert.equal(binding.nativeSessionId,'native');
  assert.equal(f.session.binding?.state,'attached');assert.deepEqual(methods,['attach','snapshot','attach']);
  assert.ok(f.events.filter(e=>e.type==='run.updated').every(e=>e.data.historical===true));
  assert.equal(a.adopting.size,0);
});

test('DSH changed follow identity rejects adoption and never leaves a writable binding', async t => {
  const f=nativeContext('deepseek-harness');const cwd=await realpath(f.session.cwd);
  const a=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);a.pluginInstanceId='plugin';
  let disconnected=0;f.context.disconnect=()=>{disconnected++;};
  t.mock.method(a,'call',async()=>({pluginInstanceId:'plugin',sessionId:'native',cwd,agentAvailable:true}));
  t.mock.method(a,'subscribe',async()=>a.follow('native',{type:'snapshot',header:{id:'wrong',cwd},cursor:0,hasMore:false,records:[]}));
  await assert.rejects(a.attachExistingSession(f.session,'plugin'),/snapshot/);
  assert.equal(f.session.binding,undefined);assert.equal(a.byNative.size,0);assert.equal(a.adopting.size,0);assert.equal(disconnected,1);
  await assert.rejects(a.attachExistingSession(f.session,'other'),/ownership/);
});

test('DSH captures live Agent approval before any phone subscription and uses the current native turn', async () => {
  const listeners=new Map<string,Function>();
  const bridge=controllerBridge({on:(name:string,fn:Function)=>{listeners.set(name,fn);return()=>{};}},{},'plugin',()=>{});
  const events=[{type:'turn/start',data:{turn:4}},{type:'turn/end',data:{turn:4}},{type:'turn/start',data:{turn:5}},{type:'approval/asked',data:{}}];
  const request={agent:{session:{id:'native',seq:events.length,eventAt:(seq:number)=>events[seq]}},toolName:'Write'};
  try {
    bridge.states.set('native',{turn:4,active:true,seq:0});
    const result=listeners.get('approval/request')!(request,async()=> 'unavailable');
    const entry=[...bridge.pending.values()][0];assert.ok(entry);assert.equal(entry.turn,5);
    bridge.disconnect();assert.equal(bridge.pending.size,1);
    assert.equal(bridge.handlers.decide({pluginInstanceId:'plugin',sessionId:'native',turn:5,interactionId:entry.interactionId,outcome:'allowed-once'}).accepted,true);
    assert.equal(await result,'allowed-once');assert.equal(bridge.pending.size,0);
    const after= listeners.get('approval/request')!({...request,signal:undefined},async()=> 'unavailable');
    assert.equal(bridge.pending.size,1);
    listeners.get('session/event')!(request.agent.session,{seq:4,type:'turn/end',data:{turn:5,reason:{kind:'completed'}}});
    assert.equal(await after,'cancelled');assert.equal(bridge.pending.size,0);
  } finally { bridge.close(); }
});

test('DSH attachment reuses imported durable message identity instead of duplicating historical output', () => {
  const f=nativeContext('deepseek-harness');const a=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);
  f.session.externalSource={namespace:'plugin',nativeId:'native',generation:'plugin',profile:'rc5',readOnly:true};
  const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const importedId=hash([hash(['host','deepseek-harness','plugin','native']),'9:assistant']);
  f.session.messages.push({id:importedId,role:'assistant',text:'imported',complete:true});a.byNative.set('native',f.session.id);
  a.durable('native',{seq:9,type:'assistant/message',data:{turn:1,step:2,stream:[{type:'text-delta',text:'authoritative'}]}},true);
  assert.equal(f.events[0].data.id,importedId);assert.equal(f.events[0].data.nativeKey,'1:2');
});

test('DSH automatic recovery of adopted history repeats ownership verification before enabling control', async t => {
  const f=nativeContext('deepseek-harness');const a=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);a.pluginInstanceId='plugin';
  f.session.externalSource={namespace:'plugin',nativeId:'native',generation:'plugin',profile:'rc5',readOnly:true};
  f.session.binding={...a.binding('native',a.control,'plugin'),state:'disconnected'};
  t.mock.method(a,'call',async(method:string)=>{assert.equal(method,'attach');throw new Error('DSH session workspace changed');});
  t.mock.method(a,'subscribe',async()=>{assert.fail('Cannot subscribe to a rejected native owner');});
  await assert.rejects(a.resumeSession(f.session),/workspace changed/);
  assert.equal(f.session.binding.state,'disconnected');
});

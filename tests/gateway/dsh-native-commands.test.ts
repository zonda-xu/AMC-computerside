import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, command } from '../helpers.ts';
import { DshAdapter } from '../../packages/adapters/deepseek-harness/index.ts';
import { Core } from '../../apps/gateway/src/core.ts';
import { Store } from '../../apps/gateway/src/store.ts';
import { join } from 'node:path';
import { upload } from '../../apps/gateway/src/files.ts';
import { controllerBridge } from '../../plugins/dsh-bridge/controller.mjs';

async function setup(){
  const f=await fixture();const adapter=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.core.context('deepseek-harness'));
  adapter.control={...adapter.control,configure:true,slash:true,steer:true};
  adapter.probe=async()=>({id:'deepseek-harness',runtimeInstanceId:adapter.context.runtimeInstanceId,version:'synthetic',installed:true,authentication:'unknown',verified:false,detail:'test double',capabilities:{text:true,image:true,files:true,history:true,permission:true,questions:true,models:true,cancelScope:'turn'},controlCapabilities:adapter.control,models:[]});
  adapter.createSession=async()=>({nativeSessionId:'native',binding:adapter.binding('native',adapter.control,'plugin'),model:undefined});
  f.core.adapters.set('deepseek-harness',adapter);const session=await f.core.createSession('device','dsh-create',f.w.id,'deepseek-harness');
  return{...f,adapter,session};
}

test('DSH slash receipts and results persist across gateway reopen; duplicate IDs never execute twice',async()=>{
  const f=await setup();let calls=0;
  try{
    f.adapter.executeNativeCommand=async()=>{calls++;return{status:'completed',text:'native result'};};
    const request=command(f.session,'slash',{line:'/compact'});f.core.accept('device',request);await f.core.drain();
    assert.equal(f.store.getReceipt('device',request.clientRequestId)?.status,'native_accepted');assert.deepEqual(f.store.getReceipt('device',request.clientRequestId)?.result,{status:'completed',text:'native result'});
    assert.equal(f.core.session(f.session.id).messages.length,0);assert.equal(f.core.session(f.session.id).state,'idle');
    const reopened=new Store(join(f.dir,'console.sqlite'));
    try{const core=new Core(reopened,f.core.hostId,[f.root]);core.adapters.set('deepseek-harness',f.adapter);assert.equal(core.accept('device',request).status,'native_accepted');await core.drain();assert.equal(calls,1);assert.deepEqual(reopened.getReceipt('device',request.clientRequestId)?.result,{status:'completed',text:'native result'});}finally{reopened.close();}
  }finally{await f.close();}
});

test('uncertain native commands retain a persistent directory lock and are not retried after restart',async()=>{
  const f=await setup();let calls=0;
  try{
    f.adapter.executeNativeCommand=async()=>{calls++;throw new Error('native response lost after side effect');};
    const request=command(f.session,'slash',{line:'/compact'});f.core.accept('device',request);await f.core.drain();
    assert.equal(f.store.getReceipt('device',request.clientRequestId)?.status,'uncertain');assert.equal(f.store.unresolvedSubmission(f.session.id),true);
    const core=new Core(f.store,f.core.hostId,[f.root]);core.adapters.set('deepseek-harness',f.adapter);core.adapters.set('codex',f.core.adapters.get('codex')!);
    core.accept('device',request);await core.drain();assert.equal(calls,1);
    const next=command(f.session,'slash',{line:'/compact'});core.accept('device',next);await core.drain();assert.equal(f.store.getReceipt('device',next.clientRequestId)?.status,'rejected');
    const other=command(f.s);core.accept('device',other);await core.drain();assert.equal(f.store.getReceipt('device',other.clientRequestId)?.status,'rejected');assert.match(f.store.getReceipt('device',other.clientRequestId)?.detail||'',/directory/);
  }finally{await f.close();}
});

test('native commands validate workspace attachment ownership before dispatch',async()=>{
  const f=await setup();let calls=0;
  try{
    f.adapter.executeNativeCommand=async(_s,_line,input)=>{calls++;assert.equal(input.attachments[0].dataBase64,Buffer.from('notes').toString('base64'));return{done:true};};
    const own=await upload(f.w,'notes.txt','text/plain',Buffer.from('notes'));f.store.put('attachment',own.id,own);
    const foreign=await upload(f.wb,'other.txt','text/plain',Buffer.from('other'));f.store.put('attachment',foreign.id,foreign);
    const denied=command(f.session,'slash',{line:'/compact',attachmentIds:[foreign.id]});f.core.accept('device',denied);await f.core.drain();assert.equal(f.store.getReceipt('device',denied.clientRequestId)?.status,'rejected');assert.equal(calls,0);
    const valid=command(f.session,'slash',{line:'/compact',attachmentIds:[own.id]});f.core.accept('device',valid);await f.core.drain();assert.equal(f.store.getReceipt('device',valid.clientRequestId)?.status,'native_accepted');assert.equal(calls,1);
  }finally{await f.close();}
});

test('steer targets the same persisted run, rejects stale run IDs, and is idempotent',async()=>{
  const f=await setup();let calls=0;
  try{
    const run=command(f.session);f.adapter.submit=async()=>{};f.core.accept('device',run);await f.core.drain();
    f.adapter.context.emit(f.session.id,'run.updated',{state:'running',nativeAccepted:true,nativeRunId:'turn-1'});
    const active=f.core.session(f.session.id);assert.ok(active.runId);
    f.adapter.submit=async(s,input)=>{calls++;assert.equal(input.mode,'steer');assert.equal(s.runId,active.runId);};
    const stale=command(active,'steer',{text:'change',runId:'old'});f.core.accept('device',stale);await f.core.drain();assert.equal(f.store.getReceipt('device',stale.clientRequestId)?.status,'rejected');assert.equal(calls,0);
    const steer=command(active,'steer',{text:'change direction',runId:active.runId});f.core.accept('device',steer);await f.core.drain();f.core.accept('device',steer);await f.core.drain();
    assert.equal(calls,1);assert.equal(f.core.session(active.id).runId,active.runId);assert.equal(f.store.getReceipt('device',steer.clientRequestId)?.status,'native_accepted');
  }finally{await f.close();}
});

test('lost slash ACK reconciles from the surviving plugin and releases its lock without execution',async()=>{
  const f=await setup();let executions=0;
  const agent={id:'native',session:{id:'native',header:{},snapshotEvents:()=>[]}};
  const services:any={agents:{get:()=>agent},commands:{execute:async()=>{executions++;return{status:'completed'};}}};
  const bridge=controllerBridge({get:(name:string)=>services[name],on:()=>()=>{}},{projections:async()=>null},'plugin',()=>{});
  try{
    f.adapter.pluginInstanceId='plugin';
    f.adapter.executeNativeCommand=async(_s,line,input)=>{await bridge.handlers.slash({sessionId:'native',requestId:input.nativeRequestId,line});throw new Error('ACK lost');};
    const request=command(f.session,'slash',{line:'/compact'});f.core.accept('device',request);await f.core.drain();assert.equal(f.store.unresolvedSubmission(f.session.id),true);
    f.adapter.call=async()=>bridge.handlers.snapshot({sessionId:'native'});
    await f.adapter.restorePending('native',f.session.id);
    assert.equal(f.store.getReceipt('device',request.clientRequestId)?.status,'native_accepted');assert.deepEqual(f.store.getReceipt('device',request.clientRequestId)?.result,{status:'completed'});assert.equal(f.store.unresolvedSubmission(f.session.id),false);assert.equal(executions,1);
  }finally{bridge.close();await f.close();}
});

test('DSH native commands cannot reuse a grant outside current host-authorized roots',async()=>{
  const f=await setup();let calls=0;
  try{const s=f.core.session(f.session.id);s.grantedRoots=[f.dir];f.store.put('session',s.id,s);f.adapter.executeNativeCommand=async()=>{calls++;};const request=command(s,'slash',{line:'/compact'});f.core.accept('device',request);await f.core.drain();assert.equal(f.store.getReceipt('device',request.clientRequestId)?.status,'rejected');assert.match(f.store.getReceipt('device',request.clientRequestId)?.detail||'',/outside current host/);assert.equal(calls,0);}finally{await f.close();}
});

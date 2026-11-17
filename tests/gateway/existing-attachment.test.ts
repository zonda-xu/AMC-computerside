import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, command } from '../helpers.ts';
import { NO_CONTROL, type AgentAdapter, type Session } from '../../packages/protocol/src/types.ts';
import { RuntimeRecovery } from '../../apps/gateway/src/runtime-recovery.ts';

function history(f:Awaited<ReturnType<typeof fixture>>):Session {
  const s=f.core.session(f.s.id);
  s.externalSource={namespace:'history-only',nativeId:s.ref.nativeSessionId,generation:'history',profile:'fixture',readOnly:true};
  s.ref={...s.ref,runtimeInstanceId:'history-only'};
  s.binding={runtimeInstanceId:'history-only',nativeSessionId:s.ref.nativeSessionId,generation:0,state:'unbound',capabilities:{...NO_CONTROL,observe:true}};
  s.state='uncertain';s.epoch=0;f.store.put('session',s.id,s);return s;
}
function attachment(f:Awaited<ReturnType<typeof fixture>>,s:Session,clientRequestId='attach-once') {
  return {protocolVersion:2,hostId:f.core.hostId,clientRequestId,runtimeInstanceId:f.adapter.context.runtimeInstanceId,ref:s.ref};
}

test('history remains unbound across startup, disconnect and native handshake; it never owns a managed write lock',async t=>{
  const f=await fixture();const recovery=new RuntimeRecovery(f.core);
  try {
    const s=history(f);const before=f.core.session(s.id);let resumed=0;
    t.mock.method(f.adapter,'resumeSession',async()=>{resumed++;});
    f.store.recover();f.adapter.context.disconnect?.(undefined,'test disconnect');f.adapter.context.openConnection(undefined,'native-process');
    await recovery.tick();assert.equal(resumed,0);assert.deepEqual(f.core.session(s.id),before);
    const managed=await f.core.createSession('device','other-managed',f.w.id,'codex');
    f.core.accept('device',command(managed));await f.core.drain();assert.equal(f.adapter.submitted,1);
  }finally{await recovery.close();await f.close();}
});

test('explicit native attachment is idempotent, preserves history, and submits no task',async t=>{
  const f=await fixture();try {
    const s=history(f);const request=attachment(f,s);let attached=0;
    f.store.event(s.id,'message.completed',{id:'historical',text:'Existing history',role:'assistant'});
    const originalProbe=f.adapter.probe.bind(f.adapter);
    t.mock.method(f.adapter,'probe',async()=>({...await originalProbe(),controlCapabilities:{...NO_CONTROL,attach:true},connectionState:'attached',nativeIdentity:'same-native-process'}));
    (f.adapter as AgentAdapter).attachExistingSession=async(candidate,identity)=>{
      attached++;assert.equal(identity,'same-native-process');assert.equal(candidate.ref.runtimeInstanceId,f.adapter.context.runtimeInstanceId);
      assert.equal(f.store.pendingCommands(s.id).length,0,'attachment is not a model command');
      const generation=f.adapter.context.openConnection(undefined,identity);
      assert.equal(f.core.session(s.id).binding?.state,'unbound');
      return {runtimeInstanceId:candidate.ref.runtimeInstanceId,nativeSessionId:candidate.ref.nativeSessionId,generation,state:'attached',capabilities:{...NO_CONTROL,submit:true},nativeIdentity:identity};
    };
    const result=await f.core.attachExisting('device',s.id,request);
    assert.equal(result.binding?.state,'attached');assert.equal(result.messages[0].text,'Existing history');assert.deepEqual(result.externalSource,s.externalSource);
    assert.equal((await f.core.attachExisting('device',s.id,request)).id,s.id);assert.equal(attached,1);assert.equal(f.adapter.submitted,0);
    assert.equal(f.store.getReceipt('device','attach-once')?.status,'native_accepted');
    f.adapter.context.emit(s.id,'run.updated',{state:'running',nativeRunId:'native-active-turn',nativeAccepted:true});
    const active=f.core.session(s.id);assert.ok(active.runId);assert.notEqual(active.runId,'native-active-turn');assert.equal(active.runGeneration,result.binding?.generation);
    await assert.rejects(f.core.attachExisting('device',s.id,{...request,runtimeInstanceId:'other'}),/different target or contents/);
  }finally{await f.close();}
});

test('rebuilding a native control handle before submission rejects the old generation without creating a run',async()=>{
  const f=await fixture();try {
    (f.adapter as AgentAdapter).prepareSubmission=async s=>{
      const generation=f.adapter.context.openConnection([s.id],'replacement-query');
      f.core.bindSession(s.id,{...s.binding!,generation,state:'attached',nativeIdentity:'replacement-query'});
    };
    const old=command(f.s);f.core.accept('device',old);await f.core.drain();
    assert.equal(f.store.getReceipt('device',old.clientRequestId)?.status,'rejected');assert.equal(f.adapter.submitted,0);assert.equal(f.core.session(f.s.id).runId,undefined);
    f.core.accept('device',command(f.core.session(f.s.id)));await f.core.drain();assert.equal(f.adapter.submitted,1);
  }finally{await f.close();}
});

test('native attachment rejects wrong host, changed source, absent capability and unregistered target',async t=>{
  const f=await fixture();try {
    const s=history(f);const req=attachment(f,s);
    await assert.rejects(f.core.attachExisting('device',s.id,{...req,hostId:'wrong'}),/another host/);
    await assert.rejects(f.core.attachExisting('device',s.id,{...req,ref:{...s.ref,nativeSessionId:'wrong'}}),/identity changed/);
    await assert.rejects(f.core.attachExisting('device',s.id,{...req,clientRequestId:'missing-method'}),/cannot verify ownership/);
    (f.adapter as AgentAdapter).attachExistingSession=async()=>{throw new Error('Must not attach');};
    await assert.rejects(f.core.attachExisting('device',s.id,{...req,clientRequestId:'wrong-runtime',runtimeInstanceId:'other'}),/unregistered/);
    await assert.rejects(f.core.attachExisting('device',s.id,{...req,clientRequestId:'no-capability'}),/TEST DOUBLE/);
    assert.equal(f.core.session(s.id).binding?.state,'unbound');assert.equal(f.adapter.submitted,0);
  }finally{await f.close();}
});

test('partial attachment failure closes control, rejects the receipt, and recovery repeats ownership proof',async t=>{
  const f=await fixture();try{
    const s=history(f);const req=attachment(f,s);let proofs=0;let resumed=0;
    const originalProbe=f.adapter.probe.bind(f.adapter);
    t.mock.method(f.adapter,'probe',async()=>({...await originalProbe(),controlCapabilities:{...NO_CONTROL,attach:true},connectionState:'attached',nativeIdentity:'same-process'}));
    t.mock.method(f.adapter,'resumeSession',async()=>{resumed++;});
    (f.adapter as AgentAdapter).attachExistingSession=async(candidate,identity)=>{
      proofs++;const generation=f.adapter.context.openConnection([s.id],identity);
      const binding={runtimeInstanceId:f.adapter.context.runtimeInstanceId,nativeSessionId:candidate.ref.nativeSessionId,generation,state:'attached' as const,capabilities:{...NO_CONTROL,submit:true},nativeIdentity:identity};
      f.core.bindSession(s.id,binding);
      if(proofs===1)throw new Error('Native cwd changed during final proof');
      return binding;
    };
    await assert.rejects(f.core.attachExisting('device',s.id,req),/cwd changed/);
    assert.equal(f.store.getReceipt('device',req.clientRequestId)?.status,'rejected');assert.equal(f.core.session(s.id).binding?.state,'disconnected');
    await f.core.reconcile(s.id);assert.equal(proofs,2);assert.equal(resumed,0);assert.equal(f.core.session(s.id).binding?.state,'attached');
    assert.equal(f.adapter.submitted,0);
  }finally{await f.close();}
});

test('restart rejects incomplete read-only attachment without treating it as a possibly executed task',async()=>{
  const f=await fixture();try{
    const s=history(f);const req=attachment(f,s);
    f.store.receive('device',req.clientRequestId,{kind:'session.attach',sessionId:s.id,...req});f.store.dispatching('device',req.clientRequestId);
    f.store.recover();assert.equal(f.store.getReceipt('device',req.clientRequestId)?.status,'rejected');assert.equal(f.core.session(s.id).binding?.state,'unbound');
  }finally{await f.close();}
});

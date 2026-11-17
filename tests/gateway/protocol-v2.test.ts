import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ajv } from 'ajv';
import { fixture, command, tick } from '../helpers.ts';
import { Store } from '../../apps/gateway/src/store.ts';
import { Core } from '../../apps/gateway/src/core.ts';
import { validateCommand, validateFormAnswer } from '../../packages/protocol/src/validation.ts';
import type { Interaction, RunRecord, Session, Submission } from '../../packages/protocol/src/types.ts';
import { NO_CONTROL } from '../../packages/protocol/src/types.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function submitted(f:Awaited<ReturnType<typeof fixture>>){const c=command(f.core.session(f.s.id));f.core.accept('device',c);await f.core.drain();return c;}
function permission(s:Session):Interaction{return{id:'permission',sessionId:s.id,epoch:s.epoch,generation:s.binding!.generation,runId:s.runId,kind:'permission',title:'Write file',detail:'file.txt',choices:[{id:'allow',label:'Allow once',scope:'native:once',allows:true},{id:'deny',label:'Deny',scope:'native:once'}],questions:[],status:'pending',nativeId:17,nativeMethod:'approval'};}

test('v2 schemas reject v1 and missing mutation targets, and validate persisted events',async()=>{
  const f=await fixture();try{
    const c=command(f.s);assert.equal(validateCommand(c),true);assert.equal(validateCommand({...c,protocolVersion:1}),false);assert.equal(validateCommand({...c,payload:{text:'missing generation'}}),false);
    assert.equal(validateCommand(command(f.s,'cancel',{})),false);
    const schema=JSON.parse(await readFile(new URL('../../packages/protocol/schema/command.schema.json',import.meta.url),'utf8'));const validate=new Ajv({strict:false}).compile(schema);assert.equal(validate(c),true);assert.equal(validate({...c,payload:{}}),false);
    await submitted(f);const eventSchema=JSON.parse(await readFile(new URL('../../packages/protocol/schema/event.schema.json',import.meta.url),'utf8'));const events=new Ajv().compile(eventSchema);for(const e of f.store.events(f.s.id,0))assert.equal(events(e),true,JSON.stringify(events.errors));
  }finally{await f.close();}
});

test('gateway run identity is stable, native IDs are separate, and duplicate requests never rerun',async()=>{
  const f=await fixture();try{
    const c=await submitted(f);const first=f.core.session(f.s.id);assert.ok(first.runId);assert.notEqual(first.runId,c.clientRequestId);
    f.adapter.context.emit(first.id,'run.updated',{state:'running',nativeRunId:'native-turn-1',runId:first.runId,nativeAccepted:true});
    const s=f.core.session(first.id);assert.equal(s.runId,first.runId);assert.equal(s.nativeRunId,'native-turn-1');const run=f.store.get<RunRecord>('run',s.runId!)!;assert.equal(run.nativeRunId,'native-turn-1');assert.equal(run.clientRequestId,c.clientRequestId);assert.ok(run.nativeRequestId);
    for(let n=0;n<100;n++)f.core.accept('device',c);await f.core.drain();assert.equal(f.adapter.submitted,1);
    assert.throws(()=>f.core.accept('device',{...c,payload:{...c.payload,text:'changed'}}),/different target or contents/);
    f.adapter.context.emit(s.id,'run.updated',{state:'completed',runId:s.runId,nativeRunId:'native-turn-1',reasonCode:'completed'});
    await submitted(f);const next=f.core.session(s.id);assert.notEqual(next.runId,s.runId);assert.equal(next.ref.nativeSessionId,s.ref.nativeSessionId);assert.equal(next.nativeRunId,undefined);
  }finally{await f.close();}
});

test('native run IDs in the existing adapter event field are normalized without replacing gateway ID',async()=>{
  const f=await fixture();try{await submitted(f);const id=f.core.session(f.s.id).runId;f.adapter.context.emit(f.s.id,'run.updated',{state:'running',runId:'native-turn',nativeAccepted:true});const s=f.core.session(f.s.id);assert.equal(s.runId,id);assert.equal(s.nativeRunId,'native-turn');}finally{await f.close();}
});

test('commands serialize per session, while separate directories remain concurrent',async t=>{
  const f=await fixture();const entered=deferred(),release=deferred(),otherEntered=deferred();let cancelled=0;
  t.mock.method(f.adapter,'submit',async(s:Session,input:Submission)=>{f.adapter.submitted++;if(s.id===f.s.id){entered.resolve();await release.promise;}else otherEntered.resolve();f.adapter.context.emit(s.id,'run.updated',{state:'running',runId:input.runId,nativeAccepted:true});});
  t.mock.method(f.adapter,'requestCancel',async()=>{cancelled++;});
  try{
    const second=await f.core.createSession('device','second',f.wb.id,'codex');const c=command(f.s);f.core.accept('device',c);await entered.promise;
    const target=f.core.session(f.s.id);f.core.accept('device',command(target,'cancel',{}));f.core.accept('device',command(second));await otherEntered.promise;assert.equal(cancelled,0);assert.equal(f.adapter.submitted,2);
    release.resolve();await f.core.drain();assert.equal(cancelled,1);assert.equal(f.core.session(f.s.id).state,'cancel_requested');
  }finally{release.resolve();await f.close();}
});

test('stale cancel and generation targets cannot affect a later run',async t=>{
  const f=await fixture();let cancelled=0;t.mock.method(f.adapter,'requestCancel',async()=>{cancelled++;});try{
    await submitted(f);const previous=f.core.session(f.s.id);f.adapter.context.emit(previous.id,'run.updated',{state:'completed'});await submitted(f);
    const stale=command(previous,'cancel',{});f.core.accept('device',stale);const wrong=command(f.core.session(previous.id),'cancel',{expectedGeneration:999});f.core.accept('device',wrong);await f.core.drain();assert.equal(cancelled,0);assert.equal(f.store.getReceipt('device',stale.clientRequestId)?.status,'rejected');assert.equal(f.store.getReceipt('device',wrong.clientRequestId)?.status,'rejected');assert.equal(f.core.session(previous.id).state,'running');
  }finally{await f.close();}
});

test('completion wins cancel race and no late progress or conflicting terminal rolls it back',async t=>{
  const f=await fixture();const entered=deferred(),release=deferred();t.mock.method(f.adapter,'requestCancel',async()=>{entered.resolve();await release.promise;});try{
    await submitted(f);const before=f.core.session(f.s.id);const c=command(before,'cancel',{});f.core.accept('device',c);await entered.promise;
    f.adapter.context.emit(before.id,'run.updated',{state:'completed',result:'actual final',reasonCode:'natural'});release.resolve();await f.core.drain();
    for(const state of ['running','cancelled','failed'])f.adapter.context.emit(before.id,'run.updated',{state,runId:before.runId});
    const s=f.core.session(before.id);assert.equal(s.state,'completed');assert.equal(s.result?.result,'actual final');assert.equal(f.store.getReceipt('device',c.clientRequestId)?.status,'native_accepted');
  }finally{release.resolve();await f.close();}
});

test('uncertain cancellation blocks continuation even after natural completion, until evidence settles its receipt',async t=>{
  const f=await fixture();t.mock.method(f.adapter,'requestCancel',async()=>{f.adapter.context.emit(f.s.id,'run.updated',{state:'completed'});throw new Error('ack lost');});try{
    await submitted(f);const c=command(f.core.session(f.s.id),'cancel',{});f.core.accept('device',c);await f.core.drain();assert.equal(f.store.getReceipt('device',c.clientRequestId)?.status,'uncertain');assert.equal(f.core.session(f.s.id).state,'completed');
    const next=command(f.core.session(f.s.id));f.core.accept('device',next);await f.core.drain();assert.equal(f.adapter.submitted,1);assert.equal(f.store.getReceipt('device',next.clientRequestId)?.status,'rejected');
    f.adapter.context.reconcileReceipt!('device',c.clientRequestId,{status:'native_accepted',detail:'Native cancellation record verified'});await submitted(f);assert.equal(f.adapter.submitted,2);
  }finally{await f.close();}
});

test('native history does not grant control, but a verified binding permits historical-source sessions',async()=>{
  const f=await fixture();try{
    const s=f.core.session(f.s.id);s.externalSource={namespace:'history',nativeId:s.ref.nativeSessionId,generation:'history',profile:'fixture',readOnly:true};s.binding={...s.binding!,state:'unbound',capabilities:{...NO_CONTROL}};f.store.put('session',s.id,s);
    const denied=command(s);f.core.accept('device',denied);await f.core.drain();assert.equal(f.adapter.submitted,0);assert.equal(f.store.getReceipt('device',denied.clientRequestId)?.status,'rejected');
    f.core.bindSession(s.id,{...f.s.binding!,state:'attached'});await submitted(f);assert.equal(f.adapter.submitted,1);assert.ok(f.core.session(s.id).externalSource);
  }finally{await f.close();}
});

test('bridge reconnection preserves generation and pending approvals, replacement invalidates them',async()=>{
  const f=await fixture();try{
    const ctx=f.adapter.context;const generation=ctx.openConnection([f.s.id],'plugin-instance-A');const s=f.core.session(f.s.id);ctx.bindSession!(s.id,{...s.binding!,generation,state:'attached'});await submitted(f);
    ctx.emit(s.id,'interaction.created',permission(f.core.session(s.id)) as unknown as Record<string,unknown>);ctx.disconnect!([s.id],'bridge offline');assert.equal(ctx.openConnection([s.id],'plugin-instance-A'),generation);assert.equal(f.core.session(s.id).interactions[0].status,'pending');
    ctx.bindSession!(s.id,{...f.core.session(s.id).binding!,state:'attached'});const replacement=ctx.openConnection([s.id],'plugin-instance-B');assert.equal(replacement,generation+1);assert.equal(f.core.session(s.id).interactions[0].status,'stale');
    ctx.bindSession!(s.id,{...f.core.session(s.id).binding!,state:'attached'});const c=command(f.core.session(s.id),'decide',{interactionId:'permission',expectedGeneration:generation,answer:{choiceId:'allow'}});f.core.accept('device',c);await f.core.drain();assert.equal(f.adapter.decisions,0);
  }finally{await f.close();}
});

test('approval races settle once and stopped-run answers cannot revive the native wait',async()=>{
  const f=await fixture();try{
    await submitted(f);let s=f.core.session(f.s.id);f.adapter.context.emit(s.id,'interaction.created',permission(s) as unknown as Record<string,unknown>);
    const a=command(s,'decide',{interactionId:'permission',answer:{choiceId:'allow'}}),b=command(s,'decide',{interactionId:'permission',answer:{choiceId:'deny'}});f.core.accept('device',a);f.core.accept('other-device',b);await f.core.drain();assert.equal(f.adapter.decisions,1);assert.equal(f.store.getReceipt('other-device',b.clientRequestId)?.status,'rejected');
    f.adapter.context.emit(s.id,'run.updated',{state:'cancelled'});s=f.core.session(s.id);const stale=command(s,'decide',{interactionId:'permission',answer:{choiceId:'allow'}});f.core.accept('device',stale);await f.core.drain();assert.equal(f.adapter.decisions,1);
  }finally{await f.close();}
});

test('restart keeps identity, pairing, history and delivery intent without resubmitting',async()=>{
  const f=await fixture();let reopened:Store|undefined;try{
    const ticket=f.store.ticket();const paired=f.store.redeem(ticket.token,'Phone');const c=await submitted(f);f.adapter.context.emit(f.s.id,'message.completed',{id:'final-text',text:'durable',role:'assistant'});
    const orphan=command(f.core.session(f.s.id),'cancel',{});f.store.receive(paired.deviceId,orphan.clientRequestId,orphan);f.store.dispatching(paired.deviceId,orphan.clientRequestId);const count=f.adapter.submitted;const watermark=f.core.session(f.s.id).watermark;
    reopened=new Store(f.dir+'/console.sqlite');reopened.recover();assert.equal(reopened.authenticate(paired.token),paired.deviceId);assert.equal(reopened.getReceipt(paired.deviceId,orphan.clientRequestId)?.status,'uncertain');const s=reopened.get<Session>('session',f.s.id)!;assert.equal(s.ref.runtimeInstanceId,f.s.ref.runtimeInstanceId);assert.equal(s.binding?.state,'disconnected');assert.equal(s.state,'uncertain');assert.equal(s.messages.at(-1)?.text,'durable');assert.ok(s.watermark>watermark);assert.ok(reopened.intent('device',c.clientRequestId));assert.equal(f.adapter.submitted,count);
    const core=new Core(reopened,f.core.hostId,f.core.allowedRoots);core.adapters.set('codex',f.adapter);assert.equal(core.accept('device',c).runId,s.runId);await core.drain();assert.equal(f.adapter.submitted,count);
  }finally{reopened?.close();await f.close();}
});

test('native approval cannot grant paths outside host-authorized roots',async()=>{
  const f=await fixture();try{
    await submitted(f);const s=f.core.session(f.s.id);const i=permission(s);i.writeRoots=[f.dir];
    f.adapter.context.emit(s.id,'interaction.created',{...i});
    const c=command(s,'decide',{interactionId:i.id,answer:{choiceId:'allow'}});
    f.core.accept('device',c);await f.core.drain();
    assert.equal(f.store.getReceipt('device',c.clientRequestId)?.status,'rejected');
    assert.match(f.store.getReceipt('device',c.clientRequestId)?.detail??'',/outside host-configured/);
    assert.equal(f.adapter.decisions,0);assert.equal(f.core.session(s.id).interactions[0].status,'pending');
    assert.deepEqual(f.core.session(s.id).writeRoots??[],[]);assert.deepEqual(f.core.workspace(s.ref.workspaceId).writeRoots,[f.w.path]);
  }finally{await f.close();}
});

test('a pending approval cannot revive a stopping or uncertain run before terminal confirmation',async()=>{
  const f=await fixture();try{
    await submitted(f);let s=f.core.session(f.s.id);const i=permission(s);f.adapter.context.emit(s.id,'interaction.created',{...i});
    f.core.accept('device',command(s,'cancel',{}));await f.core.drain();assert.equal(f.core.session(s.id).state,'cancel_requested');
    for(const state of ['cancel_requested','uncertain']){
      if(state==='uncertain')f.adapter.context.emit(s.id,'run.updated',{state});s=f.core.session(s.id);
      const c=command(s,'decide',{interactionId:i.id,answer:{choiceId:'allow'}});f.core.accept('device',c);await f.core.drain();
      assert.equal(f.store.getReceipt('device',c.clientRequestId)?.status,'rejected');assert.equal(f.adapter.decisions,0);
    }
  }finally{await f.close();}
});

test('changed native interaction scope is rejected after asynchronous path validation',async()=>{
  const f=await fixture();try{
    await submitted(f);const s=f.core.session(f.s.id);const i=permission(s);i.writeRoots=[f.w.path];
    f.adapter.context.emit(s.id,'interaction.created',{...i});const c=command(s,'decide',{interactionId:i.id,answer:{choiceId:'allow'}});
    f.store.receive('device',c.clientRequestId,c);const pending=f.core.execute('device',c);const rejected=assert.rejects(pending,/Native interaction changed/);
    f.adapter.context.emit(s.id,'interaction.created',{...i,detail:'Replacement scope',writeRoots:[f.dir]});
    await rejected;assert.equal(f.adapter.decisions,0);assert.deepEqual(f.core.session(s.id).writeRoots??[],[]);
    assert.equal(f.core.session(s.id).interactions[0].status,'pending');
  }finally{await f.close();}
});

test('a failed reconciliation does not poison the next serialized recovery attempt',async t=>{
  const f=await fixture();const entered=deferred(),release=deferred();let attempts=0;
  t.mock.method(f.adapter,'resumeSession',async()=>{attempts++;if(attempts===1){entered.resolve();await release.promise;throw new Error('temporary connection failure');}});
  try{
    const first=f.core.reconcile(f.s.id);const rejected=assert.rejects(first,/temporary connection failure/);await entered.promise;
    const second=f.core.reconcile(f.s.id);release.resolve();await rejected;await second;assert.equal(attempts,2);
  }finally{release.resolve();await f.close();}
});

test('native-event dedup and stale-generation events preserve monotonic authoritative projection',async()=>{
  const f=await fixture();try{
    await submitted(f);const s=f.core.session(f.s.id);const d={id:'m',text:'first',nativeEventId:'native-1',generation:s.binding!.generation,runId:s.runId};f.adapter.context.emit(s.id,'message.delta',d);f.adapter.context.emit(s.id,'message.delta',d);assert.equal(f.core.session(s.id).messages.at(-1)?.text,'first');
    f.adapter.context.emit(s.id,'message.completed',{id:'m',text:'authoritative'});f.adapter.context.emit(s.id,'message.delta',{id:'m',text:'late'});assert.equal(f.core.session(s.id).messages.at(-1)?.text,'authoritative');
    f.adapter.context.emit(s.id,'run.updated',{state:'failed',generation:s.binding!.generation+1});assert.equal(f.core.session(s.id).state,'running');const events=f.store.events(s.id,0);assert.deepEqual(events.map(e=>e.seq),events.map((_,i)=>i+1));assert.equal(new Set(events.map(e=>e.eventId)).size,events.length);
  }finally{await f.close();}
});

test('typed native forms retain booleans, numbers and option values and reject invalid fields',()=>{
  const fields=[{key:'scope',type:'string' as const,required:true,options:[{value:'all',label:'Everything'}]},{key:'count',type:'integer' as const,minimum:1,maximum:3},{key:'enabled',type:'boolean' as const},{key:'tags',type:'multiselect' as const,options:[{value:'unit',label:'Unit tests'}],minItems:1}];
  assert.doesNotThrow(()=>validateFormAnswer(fields,{scope:'all',count:2,enabled:true,tags:['unit']}));for(const answer of [{scope:'Everything'},{scope:'all',count:'2'},{scope:'all',enabled:'true'},{scope:'all',extra:'hidden'},{scope:'all',tags:['unit','unit']}])assert.throws(()=>validateFormAnswer(fields,answer));
});

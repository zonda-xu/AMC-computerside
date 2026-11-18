import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeAdapter, InputQueue } from '../../packages/adapters/claude-code/index.ts';
import type { Command, Receipt, RunRecord } from '../../packages/protocol/src/types.ts';
import { nativeContext, until } from './fixtures/native-context.ts';

type Frame = Parameters<ClaudeCodeAdapter['frame']>[1];

function harness(){
  const f=nativeContext('claude-code');
  const adapter=new ClaudeCodeAdapter('claude-code',{command:process.execPath,expectedVersion:''},f.context);
  const outputs:InputQueue<Frame>[]=[];
  const inputs:InputQueue<Frame>[]=[];
  const options:Frame[]=[];
  let interrupt:()=>Promise<Frame|undefined>=async()=>({still_queued:[]});
  adapter.checkVersion=async()=>{};
  adapter.readScope = async () => 'fixture-account-and-route';
  adapter.loadSdk=async()=>({query:(args:{prompt:InputQueue<Frame>;options:Frame})=>{
    const output=new InputQueue<Frame>();outputs.push(output);inputs.push(args.prompt);options.push(args.options);
    output.push({type:'system',subtype:'init',session_id:'native'});
    return{[Symbol.asyncIterator]:()=>output[Symbol.asyncIterator](),interrupt:()=>interrupt(),return:async()=>{output.close();return{done:true,value:undefined};}};
  }});
  const frame=(data:Frame)=>adapter.frame(f.session.id,{session_id:'native',parent_tool_use_id:null,...data});
  const submit=(requestId='input-1')=>adapter.submit(f.session,{text:'Controlled synthetic SDK input',attachments:[],requestId,nativeRequestId:requestId});
  const result=(requestId='input-1',data:Frame={})=>frame({type:'result',uuid:`result-${requestId}`,subtype:'success',is_error:false,terminal_reason:'completed',user_message_uuid:requestId,...data});
  return{...f,adapter,outputs,inputs,options,frame,submit,result,setInterrupt:(value:()=>Promise<Frame|undefined>)=>{interrupt=value;},close:()=>{adapter.close();for(const output of outputs)output.close();}};
}

function pending(f:ReturnType<typeof harness>,action:'submit'|'cancel'='submit'){
  f.session.runId='run';f.session.runGeneration=1;
  const command:Command={protocolVersion:2,hostId:'host',sessionId:f.session.id,ref:{...f.session.ref},clientRequestId:'command',action,payload:{expectedGeneration:1,runId:'run'}};
  const receipt:Receipt={clientRequestId:'command',status:'uncertain',generation:1,runId:'run',nativeRequestId:'input-1'};
  const run:RunRecord={runId:'run',sessionId:f.session.id,generation:1,deviceId:'device',clientRequestId:'command',nativeRequestId:'input-1',state:'uncertain'};
  const settlements:Partial<Receipt>[]=[];
  f.context.pendingCommands=()=>['received','uncertain'].includes(receipt.status)?[{deviceId:'device',clientRequestId:'command',command,receipt}]:[];
  f.context.getRun=()=>run;
  f.context.reconcileReceipt=(device,id,evidence)=>{assert.equal(device,'device');assert.equal(id,'command');settlements.push(evidence);Object.assign(receipt,evidence);};
  return{command,receipt,run,settlements};
}

test('continuing a Claude session rechecks the account and route before delivering input', async () => {
  const f=harness();
  try{
    const created=await f.adapter.createSession(f.session.id,f.workspace);f.session.binding=created.binding;
    await f.submit('first');f.result('first');
    f.adapter.readScope=async()=>'different-route';
    await assert.rejects(f.submit('second'),/账户、项目或服务地址已变化/);
    assert.equal(f.inputs[0].items.length,1);
  }finally{f.close();}
});

test('synthetic SDK keeps one Query across two rounds, then resumes the same session after normal completion',async()=>{
  const f=harness();try{
    await f.adapter.createSession(f.session.id,f.workspace);
    await f.submit();assert.equal(f.inputs[0].items[0].uuid,'input-1');f.result();
    await f.submit('input-2');f.result('input-2');
    assert.equal(f.outputs.length,1);assert.equal(f.inputs[0].items.length,2);assert.equal(f.inputs[0].ended,false);
    const live=f.adapter.live.get(f.session.id);assert.ok(live);f.outputs[0].close();await live.consumer;
    await f.adapter.resumeSession(f.session);assert.equal(f.outputs.length,2);assert.equal(f.options[1].resume,'native');assert.equal(f.options[1].forkSession,undefined);assert.equal(f.inputs[1].items.length,0);
    await f.submit('input-3');f.result('input-3');assert.equal(f.session.state,'completed');
  }finally{f.close();}
});

test('synthetic root and child streams preserve native message and tool identities without duplicate finals',async()=>{
  const f=harness();try{
    await f.adapter.createSession(f.session.id,f.workspace);await f.submit();
    const stream=(event:Frame,parent_tool_use_id:string|null=null)=>f.frame({type:'stream_event',event,parent_tool_use_id,user_message_uuid:'input-1'});
    stream({type:'message_start',message:{id:'root'}});stream({type:'message_start',message:{id:'child'}},'agent-tool');
    stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Root'}});
    stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Child'}},'agent-tool');
    stream({type:'content_block_start',index:1,content_block:{type:'tool_use',id:'tool-root',name:'Bash',input:{}}});
    stream({type:'content_block_start',index:1,content_block:{type:'tool_use',id:'tool-child',name:'Read',input:{}}},'agent-tool');
    stream({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"command":'}});
    stream({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"path":'}},'agent-tool');
    const assistant={type:'assistant',message:{id:'root',content:[{type:'text',text:'Root final'},{type:'tool_use',id:'tool-root',name:'Bash',input:{command:'test'}}]}};
    f.frame(assistant);f.frame(assistant);stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'late'}});
    f.frame({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-root',content:'done'}]}});
    f.frame({type:'assistant',message:{id:'late-tool',content:[{type:'tool_use',id:'tool-root',name:'Bash',input:{}}]}});
    f.result();f.result();
    assert.deepEqual(f.events.filter(e=>e.type==='message.delta').map(e=>[e.data.id,e.data.text]),[['root','Root'],['child','Child']]);
    assert.deepEqual(f.events.filter(e=>e.type==='message.completed').map(e=>[e.data.id,e.data.text]),[['root','Root final']]);
    assert.deepEqual(f.events.filter(e=>e.data.inputDelta).map(e=>e.data.id),['tool-root','tool-child']);
    assert.equal(f.events.filter(e=>e.type==='run.updated'&&e.data.state==='completed').length,1);
    assert.equal(f.events.filter(e=>e.type==='tool.updated'&&e.data.id==='tool-root').at(-1)?.data.status,'completed');
  }finally{f.close();}
});

test('results require current root acceptance; child, stale, and foreign-session evidence cannot settle input',async()=>{
  const f=harness();try{
    await f.adapter.createSession(f.session.id,f.workspace);await f.submit();const p=pending(f);
    f.result('input-1',{parent_tool_use_id:'child'});f.result('old');f.result('input-1',{user_message_uuid:undefined});
    f.result('input-1',{session_id:'foreign'});assert.equal(f.adapter.live.get(f.session.id)?.active,true);assert.equal(p.receipt.status,'uncertain');
    f.frame({type:'user',uuid:'input-1',parent_tool_use_id:'child'});assert.equal(p.receipt.status,'uncertain');
    p.command.ref.workspaceId='other';f.frame({type:'user',uuid:'input-1'});assert.equal(p.receipt.status,'uncertain');
    p.command.ref.workspaceId='workspace';f.frame({type:'user',uuid:'input-1'});assert.equal(p.receipt.status,'native_accepted');assert.equal(p.settlements.length,1);
    f.result('input-1',{user_message_uuid:undefined});assert.equal(f.session.state,'completed');assert.equal(f.adapter.live.get(f.session.id)?.active,false);
    await f.submit('input-2');f.frame({type:'user',uuid:'input-2'});f.result('input-1',{user_message_uuid:undefined});assert.equal(f.adapter.live.get(f.session.id)?.active,true);f.result('input-2');
  }finally{f.close();}
});

test('pending submission UUID evidence is reconciled without enqueue, including while no turn is active',async()=>{
  const f=harness();try{
    await f.adapter.createSession(f.session.id,f.workspace);const p=pending(f);
    f.frame({type:'result',subtype:'success',user_message_uuid:'input-1',parent_tool_use_id:'child'});assert.equal(p.receipt.status,'uncertain');
    await assert.rejects(f.submit(),/unresolved/);assert.equal(f.inputs[0].items.length,0);
    f.frame({type:'user',uuid:'input-1'});assert.equal(p.receipt.status,'native_accepted');assert.equal(f.inputs[0].items.length,0);assert.equal(f.session.state,'idle');
  }finally{f.close();}
});

test('Query failure is not process-exit evidence and an unresolved turn cannot be resumed or resent',async()=>{
  const f=harness();try{
    await f.adapter.createSession(f.session.id,f.workspace);await f.submit();
    f.outputs[0].close();await until(()=>!f.adapter.live.has(f.session.id));
    await assert.rejects(f.adapter.resumeSession(f.session),/termination (verification|is unverified)/);
    f.session.state='completed';await assert.rejects(f.adapter.resumeSession(f.session),/termination is unverified/);await assert.rejects(f.submit('input-2'),/termination is unverified/);
    assert.equal(f.outputs.length,1);
  }finally{f.close();}
});

test('consumer exceptions retain ownership uncertainty even after a completed turn',async()=>{
  const f=harness();try{
    await f.adapter.createSession(f.session.id,f.workspace);await f.submit();f.result();
    const original=f.adapter.frame.bind(f.adapter);f.adapter.frame=(id,frame)=>{if(frame.type==='synthetic_failure')throw new Error('consumer lost');original(id,frame);};
    f.outputs[0].push({type:'synthetic_failure'});await until(()=>!f.adapter.live.has(f.session.id));
    await assert.rejects(f.adapter.resumeSession(f.session),/termination is unverified/);assert.equal(f.outputs.length,1);
  }finally{f.close();}
});

test('cancel response race preserves completion and blocks a new turn until acknowledgement',async()=>{
  const f=harness();try{
    await f.adapter.createSession(f.session.id,f.workspace);await f.submit();const p=pending(f,'cancel');p.receipt.status='received';
    let acknowledge:(value:Frame)=>void=()=>{throw new Error('not started');};f.setInterrupt(()=>new Promise(resolve=>{acknowledge=resolve;}));
    const cancelling=f.adapter.requestCancel(f.session);f.result();await assert.rejects(f.submit('input-2'),/unresolved/);assert.equal(f.session.state,'completed');
    acknowledge({still_queued:[]});await cancelling;assert.equal(p.receipt.status,'native_accepted');assert.equal(f.session.state,'completed');await f.submit('input-2');f.result('input-2');
  }finally{f.close();}
});

test('lost interrupt acknowledgement and queued inputs never invent cancel acceptance or trigger retry',async()=>{
  for(const queued of [false,true]){
    const f=harness();try{
      await f.adapter.createSession(f.session.id,f.workspace);await f.submit();const p=pending(f,'cancel');p.receipt.status='received';let calls=0;
      f.setInterrupt(async()=>{calls++;if(!queued)throw new Error('ack lost');return{still_queued:['input-1']};});
      await assert.rejects(f.adapter.requestCancel(f.session),queued?/left queued inputs/:/ack lost/);p.receipt.status='uncertain';
      await assert.rejects(f.adapter.requestCancel(f.session),/already dispatched/);assert.equal(calls,1);assert.equal(p.receipt.status,'uncertain');
      f.result('input-1',{terminal_reason:'aborted_tools'});assert.equal(f.session.state,'cancelled');assert.equal(p.receipt.status,'uncertain');assert.equal(p.settlements.length,0);await assert.rejects(f.submit('input-2'),/unresolved/);
    }finally{f.close();}
  }
});

test('questions preserve original text keys and tool input, reject unsupported multiselect encoding, and settle once',async()=>{
  const f=harness();try{
    await f.adapter.createSession(f.session.id,f.workspace);await f.submit();
    const input={questions:[{question:'Original question?',header:'Not the key',multiSelect:true,options:[{label:'All'},{label:'Unit'}]}],extra:'preserved'};
    const answer=f.adapter.permission(f.session.id,'AskUserQuestion',input,{toolUseID:'ask',requestId:'permission'});const i=f.session.interactions.at(-1);assert.ok(i);
    await assert.rejects(f.adapter.respond(f.session,i,{interactionId:i.id,epoch:i.epoch,answers:{'Not the key':['All']}}),/original question/);
    await assert.rejects(f.adapter.respond(f.session,i,{interactionId:i.id,epoch:i.epoch,answers:{'Original question?':['All','Unit']}}),/target SDK tool schema/);
    i.status='responding';await f.adapter.respond(f.session,i,{interactionId:i.id,epoch:i.epoch,answers:{'Original question?':['All']}});
    assert.deepEqual(await answer,{behavior:'allow',updatedInput:{...input,answers:{'Original question?':'All'}},toolUseID:'ask'});
    await assert.rejects(f.adapter.respond(f.session,i,{interactionId:i.id,epoch:i.epoch,answers:{'Original question?':['Unit']}}),/settled/);
    const controller=new AbortController();const aborted=f.adapter.permission(f.session.id,'Bash',{command:'test'},{toolUseID:'tool',signal:controller.signal});controller.abort();assert.equal((await aborted).behavior,'deny');
  }finally{f.close();}
});

test('stale-generation decisions cannot resolve a live callback',async()=>{
  const f=harness();try{
    await f.adapter.createSession(f.session.id,f.workspace);await f.submit();
    const answer=f.adapter.permission(f.session.id,'Bash',{command:'test'},{toolUseID:'tool'});const i=f.session.interactions.at(-1);assert.ok(i);i.generation=(i.generation??1)+1;
    await assert.rejects(f.adapter.respond(f.session,i,{interactionId:i.id,epoch:i.epoch,choiceId:'allow'}),/Stale/);assert.equal(f.adapter.live.get(f.session.id)?.pending.size,1);
    f.close();assert.equal((await answer).behavior,'deny');
  }finally{f.close();}
});

test('an uncertain persisted cancel is not dispatched again on a surviving Query',async()=>{
  const f=harness();try{
    await f.adapter.createSession(f.session.id,f.workspace);await f.submit();const p=pending(f,'cancel');let calls=0;f.setInterrupt(async()=>{calls++;return{still_queued:[]};});
    await assert.rejects(f.adapter.requestCancel(f.session),/cannot be retried safely/);assert.equal(calls,0);assert.equal(p.receipt.status,'uncertain');f.result();assert.equal(p.receipt.status,'uncertain');
  }finally{f.close();}
});

test('native API and limit failures retain assistant output without reporting success',async()=>{
  for(const terminal_reason of ['api_error','max_turns','budget_exhausted']){
    const f=harness();try{
      await f.adapter.createSession(f.session.id,f.workspace);await f.submit();
      f.frame({type:'assistant',message:{id:'partial',content:[{type:'text',text:'Retained output'}]}});
      f.result('input-1',{terminal_reason,is_error:true,errors:['controlled failure']});assert.equal(f.session.state,'failed');
      assert.equal(f.events.filter(e=>e.type==='message.completed')[0]?.data.text,'Retained output');assert.equal(f.events.some(e=>e.type==='run.updated'&&e.data.state==='completed'),false);
    }finally{f.close();}
  }
});

test('stream gaps do not invent message identities, and final text still arrives once',async()=>{
  const f=harness();try{
    await f.adapter.createSession(f.session.id,f.workspace);await f.submit();
    f.frame({type:'stream_event',uuid:'event-not-message',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'fragment'}}});
    const complete={type:'assistant',message:{id:'authoritative',content:[{type:'text',text:'Authoritative final'}]}};f.frame(complete);f.frame(complete);f.result();
    assert.equal(f.events.filter(e=>e.type==='message.delta').length,0);assert.deepEqual(f.events.filter(e=>e.type==='message.completed').map(e=>e.data.id),['authoritative']);
  }finally{f.close();}
});

test('cancelled decisions cannot accidentally grant permission through a stale allow choice',async()=>{
  const f=harness();try{
    await f.adapter.createSession(f.session.id,f.workspace);await f.submit();
    const answer=f.adapter.permission(f.session.id,'Bash',{command:'test'},{toolUseID:'tool'});const i=f.session.interactions.at(-1);assert.ok(i);
    await f.adapter.respond(f.session,i,{interactionId:i.id,epoch:i.epoch,cancelled:true,choiceId:'allow'});assert.equal((await answer).behavior,'deny');
  }finally{f.close();}
});

test('cancellation prevents late native callbacks from reviving actionable permission cards',async()=>{
  const f=harness();try{
    await f.adapter.createSession(f.session.id,f.workspace);await f.submit();await f.adapter.requestCancel(f.session);
    const before=f.session.interactions.length;
    assert.equal((await f.adapter.permission(f.session.id,'Bash',{command:'test'},{toolUseID:'late'})).behavior,'deny');assert.equal(f.session.interactions.length,before);
    f.result('input-1',{terminal_reason:'aborted_streaming'});assert.equal(f.session.state,'cancelled');
  }finally{f.close();}
});

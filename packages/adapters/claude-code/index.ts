import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AgentAdapter, Decision, Interaction, ModelIdentity, Session, Submission, Workspace } from '../../protocol/src/types.ts';
import { ACTIVE } from '../../protocol/src/types.ts';
import { AdapterBase } from '../common/base.ts';
import { loadNativeModule } from '../common/native-module.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeCommand } from '../common/command.ts';
import { catalogModel, uniqueModels } from '../common/models.ts';

type Native=Record<string,any>;
export class InputQueue<T> implements AsyncIterable<T> {
  items:T[]=[]; waiters:Array<(value:IteratorResult<T>)=>void>=[]; ended=false;
  push(value:T){if(this.ended)throw new Error('Input queue closed');const waiter=this.waiters.shift();if(waiter)waiter({done:false,value});else this.items.push(value);}
  close(){this.ended=true;for(const waiter of this.waiters.splice(0))waiter({done:true,value:undefined});}
  [Symbol.asyncIterator]():AsyncIterator<T>{return{next:()=>{if(this.items.length)return Promise.resolve({done:false as const,value:this.items.shift()!});if(this.ended)return Promise.resolve({done:true as const,value:undefined});return new Promise(resolve=>this.waiters.push(resolve));}};}
}
interface Live { model?:ModelIdentity; identity:string; generation?:number; query:Native; input:InputQueue<Native>; pending:Map<string,{input:Native;toolUseID:string;finish:(result:Native,stale?:boolean)=>boolean}>; active:boolean; stopping:boolean; attached:boolean; accepted?:boolean; cancelPending?:boolean; cancelUncertain?:boolean; nativeId?:string; requestId?:string; streams:Map<string,{messageId:string;blocks:Map<number,string>}>; completed:Set<string>; results:Set<string>; finishedTools:Set<string>; ready:Promise<string>; initialized:(id:string)=>void; rejectInit:(error:Error)=>void; consumer?:Promise<void> }
export class ClaudeCodeAdapter extends AdapterBase implements AgentAdapter {
  async listModels(workspace?:Workspace):Promise<ModelIdentity[]>{return this.cachedModels(workspace?.path||'',()=>this.readModelCatalog(workspace));}
  async readModelCatalog(workspace?:Workspace):Promise<ModelIdentity[]>{
    const owner=[...this.live.entries()].find(([id,l])=>l.attached&&(!workspace||this.context.getSession(id).cwd===workspace.path));
    let query=owner?.[1].query;let input:InputQueue<Native>|undefined;let timer:ReturnType<typeof setTimeout>|undefined;
    const abortController=new AbortController();
    try{
      if(!query){
        const sdk=await this.loadSdk();await this.checkVersion();input=new InputQueue<Native>();
        query=sdk.query({prompt:input,options:{cwd:workspace?.path||process.cwd(),pathToClaudeCodeExecutable:await this.executable(),env:this.env,settingSources:['user','project','local'],abortController}});
      }
      if(!query||typeof query.supportedModels!=='function')throw new Error('Claude Query.supportedModels unavailable');
      const items=await Promise.race([query.supportedModels(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Claude model catalog timed out')),15000);})]);
      if(!Array.isArray(items))throw new Error('Claude supportedModels did not return an array');
      return uniqueModels(items.map(m=>catalogModel('anthropic',m.value,m.displayName,'claude-sdk:supportedModels',m)));
    }finally{if(timer)clearTimeout(timer);if(!owner){input?.close();abortController.abort();if(typeof query?.close==='function')query.close();}}
  }
  control={create:true,submit:true,observe:true,approve:true,answer:true,cancel:true,resume:true,configure:true};
  live=new Map<string,Live>(); starting=new Map<string,Promise<Live>>(); lost=new Set<string>();
  async loadSdk(){const module=this.config.sdkModule||'@anthropic-ai/claude-agent-sdk';try{const sdk=await loadNativeModule(module,'@anthropic-ai/claude-agent-sdk','0.3.325');if(typeof sdk.query!=='function')throw new Error('query export unavailable');return sdk;}catch(e){throw new Error(`Claude official SDK unavailable (${module}): ${e instanceof Error?e.message:String(e)}`);}}
  async executable(){const path=this.config.executablePath||this.config.command;if(!isAbsolute(path))throw new Error('Claude requires an explicit absolute local pathToClaudeCodeExecutable');await access(path);return path;}
  async checkVersion(){if(this.config.enabled===false)throw new Error('Claude runtime disabled');if(this.config.expectedVersion!=='2.1.325 (Claude Code)')throw new Error('Claude requires exact CLI 2.1.325 (Claude Code) and official SDK 0.3.325');const native=nativeCommand(await this.executable());const {stdout}=await promisify(execFile)(native.command,[...native.args,'--version'],{env:this.env,timeout:10000,windowsHide:true});if(stdout.trim()!==this.config.expectedVersion)throw new Error('Claude executable does not match exact CLI 2.1.325 (Claude Code)');}
  async createSession(id:string,w:Workspace,model?:ModelIdentity){const live=await this.start(id,w.path,undefined,model);try{const nativeSessionId=await live.ready;live.attached=true;return{nativeSessionId,model:live.model,binding:{...this.binding(nativeSessionId,this.control,live.identity),generation:live.generation!}};}catch(e){this.lost.add(id);live.input.close();if(this.live.get(id)===live)this.live.delete(id);throw e;}}
  async resumeSession(s:Session){if(!this.live.has(s.id)&&(ACTIVE.includes(s.state)||this.pendingControls(s.id).some(p=>['submit','cancel'].includes(p.command.action)&&(p.receipt.status==='uncertain'||!!p.receipt.runId||!!p.receipt.nativeRequestId))))throw new Error('Previous Claude Query is not owned; native termination verification is required before resume');const live=await this.start(s.id,s.cwd,s.ref.nativeSessionId,s.nextModel||s.model);try{await live.ready;}catch(e){this.lost.add(s.id);live.input.close();throw e;}this.context.bindSession?.(s.id,{...this.binding(s.ref.nativeSessionId,this.control,live.identity),generation:live.generation!});}
  async prepareSubmission(s:Session){await this.resumeSession(s);}
  async start(id:string,cwd:string,nativeId?:string,model?:ModelIdentity):Promise<Live>{if(this.lost.has(id))throw new Error('Previous Claude Query termination is unverified');const existing=this.live.get(id);if(existing){if(nativeId&&existing.nativeId!==nativeId)throw new Error('Claude Query native identity mismatch');return existing;}const pending=this.starting.get(id);if(pending)return pending;const promise=this.open(id,cwd,nativeId,model);this.starting.set(id,promise);try{return await promise;}finally{this.starting.delete(id);}}
  async open(id:string,cwd:string,nativeId?:string,model?:ModelIdentity):Promise<Live>{
    if(this.lost.has(id))throw new Error('Previous Claude Query termination is unverified');if(this.config.enabled===false)throw new Error('Claude runtime disabled');const sdk=await this.loadSdk();await this.checkVersion();const path=await this.executable();const input=new InputQueue<Native>();
    let initialized!:(id:string)=>void;let rejectInit!:(error:Error)=>void;
    const ready=new Promise<string>((resolve,reject)=>{initialized=resolve;rejectInit=reject;});ready.catch(()=>{});
    const query=sdk.query({prompt:input,options:{cwd,pathToClaudeCodeExecutable:path,includePartialMessages:true,permissionMode:'default',settingSources:['user','project','local'],env:this.env,...(nativeId?{resume:nativeId}:{}),...(model?{model:model.modelId}:{}),canUseTool:(name:string,toolInput:Native,native:Native)=>this.permission(id,name,toolInput,native)}});
    if(!query||typeof query[Symbol.asyncIterator]!=='function'||typeof query.interrupt!=='function')throw new Error('Configured SDK did not return an official persistent Query');
    const live:Live={identity:`claude-query:${randomUUID()}`,query,input,pending:new Map(),active:false,stopping:false,attached:!!nativeId,nativeId,streams:new Map(),completed:new Set(),results:new Set(),finishedTools:new Set(),ready,initialized,rejectInit};this.live.set(id,live);
    live.consumer=(async()=>{let ended=false;try{for await(const message of query){if(this.live.get(id)!==live)break;this.frame(id,message);}ended=true;}catch(e){const error=e instanceof Error?e:new Error(String(e));rejectInit(error);if(live.attached)this.fault(id,error);}finally{if(!ended||live.active||live.cancelPending||live.cancelUncertain)this.lost.add(id);input.close();for(const p of live.pending.values())p.finish({behavior:'deny',message:'Native Query ended'},true);if(live.active&&live.attached)this.fault(id,new Error('Claude Query ended without a result'));if(this.live.get(id)===live)this.live.delete(id);rejectInit(new Error('Claude Query ended before system/init'));}})();
    const timer=setTimeout(()=>rejectInit(new Error('Claude SDK system/init not received; native session creation unconfirmed')),30000);timer.unref();void ready.finally(()=>clearTimeout(timer)).catch(()=>{});return live;
  }
  permission(id:string,name:string,input:Native,native:Native):Promise<Native>{
    const live=this.live.get(id);if(!live||!live.attached||live.stopping||this.lost.has(id)||native.signal?.aborted)return Promise.resolve({behavior:'deny',message:'Session not attached or native request is stopping',toolUseID:native.toolUseID});
    const question=name==='AskUserQuestion';
    const i=this.interaction(id,native.requestId||randomUUID(),'claude/canUseTool',{kind:question?'question':'permission',title:name,detail:JSON.stringify({input,title:native.title,blockedPath:native.blockedPath,description:native.description}),questions:question?(input.questions||[]).map((q:Native)=>({id:q.question,title:q.question,options:(q.options||[]).map((o:Native)=>o.label),multiple:q.multiSelect===true,freeText:true})):[],choices:question?[]:[{id:'allow',label:'Allow once',scope:'tool_call',allows:true},{id:'deny',label:'Deny',scope:'tool_call',allows:false}]});
    return new Promise(resolve=>{let settled=false;const abort=()=>finish({behavior:'deny',message:'Native permission request aborted',toolUseID:native.toolUseID},true);const finish=(result:Native,stale=false)=>{if(settled)return false;settled=true;live.pending.delete(i.id);native.signal?.removeEventListener('abort',abort);this.context.emit(id,'interaction.closed',{id:i.id,status:stale?'stale':'resolved'});resolve(result);return true;};live.pending.set(i.id,{input,toolUseID:native.toolUseID,finish});native.signal?.addEventListener('abort',abort,{once:true});if(native.signal?.aborted)abort();});
  }
  async submit(s:Session,input:Submission){
    if(input.attachments.length)throw new Error('Claude SDK attachment contract not enabled');
    if(this.lost.has(s.id))throw new Error('Previous Claude Query termination is unverified');
    if(this.pendingControls(s.id).some(p=>p.command.action==='cancel'||p.command.action==='submit'&&(p.receipt.status==='uncertain'||(p.receipt.nativeRequestId&&p.receipt.nativeRequestId!==(input.nativeRequestId||input.requestId)))))throw new Error('Claude has an unresolved native control operation');
    let live=this.live.get(s.id);if(!live){if(ACTIVE.includes(s.state)&&s.state!=='accepted')throw new Error('Detached Claude run requires native termination verification');live=await this.start(s.id,s.cwd,s.ref.nativeSessionId,s.nextModel||s.model);await live.ready;}
    await live.ready;if(input.generation!==undefined&&input.generation!==live.generation)throw new Error('Claude Query generation changed; refresh session before submitting');if(live.nativeId!==s.ref.nativeSessionId||!live.attached)throw new Error('Claude Query native identity mismatch');if(live.active)throw new Error('Claude Query already has an active input');if(live.cancelPending||live.cancelUncertain)throw new Error('Claude cancellation is unresolved');if(live.input.ended)throw new Error('Claude Query input is closed');live.active=true;live.stopping=false;live.accepted=false;live.requestId=input.nativeRequestId||input.requestId;live.streams.clear();
    live.input.push({type:'user',message:{role:'user',content:input.text},parent_tool_use_id:null,uuid:live.requestId,session_id:s.ref.nativeSessionId});
  }
  frame(id:string,f:Native){
    const live=this.live.get(id);if(!live)return;
    if(f.type==='system'&&f.subtype==='init'){
      if(typeof f.session_id!=='string'||!f.session_id){live.rejectInit(new Error('SDK init missing native session_id'));return;}
      if(f.claude_code_version!==undefined&&f.claude_code_version!=='2.1.325'){live.rejectInit(new Error('SDK initialized an unexpected Claude Code version'));if(live.attached)this.fault(id,new Error('Claude Code native version mismatch'));return;}
      if(live.nativeId&&live.nativeId!==f.session_id){this.lost.add(id);live.input.close();live.rejectInit(new Error('SDK resumed a different session'));if(live.attached)this.fault(id,new Error('SDK native identity mismatch'));return;}
      if(typeof f.model==='string'&&f.model)live.model={providerId:'anthropic',modelId:f.model,label:f.model};live.nativeId=f.session_id;if(live.generation===undefined){live.generation=this.context.openConnection([id],live.identity);this.epoch=live.generation;}live.initialized(f.session_id);if(!live.attached)return;
    }
    if(!live.attached)return;
    if(f.session_id&&f.session_id!==live.nativeId){this.fault(id,new Error('Claude returned a different native session'));return;}
    if(f.type==='result'&&typeof f.uuid==='string'&&live.results.has(f.uuid))return;
    const emit=(type:Parameters<typeof this.context.emit>[1],data:Native)=>this.context.emit(id,type,data);
    if(f.type==='system'&&f.subtype==='init'&&f.model)emit('model.confirmed',{model:{providerId:'anthropic',modelId:f.model,label:f.model}});
    const linked=!!live.requestId&&(f.user_message_uuid===live.requestId||f.user_message_uuids?.includes(live.requestId)||(f.type==='user'&&f.uuid===live.requestId));
    if(!f.parent_tool_use_id){for(const requestId of [f.user_message_uuid,...(f.user_message_uuids||[]),...(f.type==='user'?[f.uuid]:[])])this.acceptSubmission(id,requestId);}
    if(live.active&&linked&&!f.parent_tool_use_id){live.accepted=true;const state=this.context.getSession(id).state;emit('run.updated',{state:['waiting_permission','waiting_input','cancel_requested'].includes(state)?state:'running',nativeAccepted:true,nativeInputId:live.requestId});}
    if((f.user_message_uuid||f.user_message_uuids?.length)&&!linked&&live.active)return;
    if(f.type==='stream_event'){
      const scope=f.parent_tool_use_id||'';
      if(f.event?.type==='message_start'&&typeof f.event.message?.id==='string')live.streams.set(scope,{messageId:f.event.message.id,blocks:new Map()});
      const stream=live.streams.get(scope);
      if(stream&&!live.completed.has(stream.messageId)){
        if(f.event?.type==='content_block_delta'&&f.event.delta?.type==='text_delta')emit('message.delta',{id:stream.messageId,text:f.event.delta.text,role:'assistant'});
        if(f.event?.type==='content_block_start'&&f.event.content_block?.type==='tool_use'){const block=f.event.content_block;stream.blocks.set(f.event.index,block.id);if(!live.finishedTools.has(block.id))emit('tool.updated',{id:block.id,title:block.name,status:'running',detail:JSON.stringify(block.input)});}
        const toolId=stream.blocks.get(f.event?.index);
        if(toolId&&!live.finishedTools.has(toolId)&&f.event?.delta?.type==='input_json_delta')emit('tool.updated',{id:toolId,status:'running',inputDelta:f.event.delta.partial_json});
      }
      if(f.event?.type==='message_stop')live.streams.delete(scope);
    }
    if(f.type==='assistant'){
      if(typeof f.message?.model==='string'&&f.message.model)emit('model.confirmed',{model:{providerId:'anthropic',modelId:f.message.model,label:f.message.model}});
      const messageId=f.message?.id;if(typeof messageId!=='string'||live.completed.has(messageId))return;live.completed.add(messageId);
      const text=(f.message?.content||[]).filter((c:Native)=>c.type==='text').map((c:Native)=>c.text).join('\n');if(text)emit('message.completed',{id:messageId,text,role:'assistant'});
      for(const c of f.message?.content||[])if(c.type==='tool_use'&&!live.finishedTools.has(c.id))emit('tool.updated',{id:c.id,title:c.name,status:'running',detail:JSON.stringify(c.input)});
    }
    if(f.type==='user'&&Array.isArray(f.message?.content))for(const c of f.message.content)if(c.type==='tool_result'&&!live.finishedTools.has(c.tool_use_id)){live.finishedTools.add(c.tool_use_id);emit('tool.updated',{id:c.tool_use_id,status:c.is_error?'failed':'completed',detail:typeof c.content==='string'?c.content:JSON.stringify(c.content)});}
    if(f.type==='result'&&live.active&&!f.parent_tool_use_id){
      if(!linked&&(!live.accepted||typeof f.uuid!=='string'||!f.uuid))return;
      if(typeof f.uuid==='string')live.results.add(f.uuid);
      live.active=false;const aborted=['aborted_streaming','aborted_tools'].includes(f.terminal_reason);const state=live.stopping&&aborted?'cancelled':f.subtype==='success'&&!f.is_error&&(!f.terminal_reason||f.terminal_reason==='completed')?'completed':'failed';
      for(const p of live.pending.values())p.finish({behavior:'deny',message:'Native turn ended'},true);
      emit('run.updated',{state,nativeAccepted:live.accepted,terminalReason:f.terminal_reason,stopReason:f.stop_reason,result:f.result,errors:f.errors,nativeInputId:live.requestId});
      if(state==='failed')emit('error',{message:JSON.stringify(f.errors||f.result||f.terminal_reason||f.subtype)});
    }
    if(f.type==='system'&&f.subtype==='task_notification')emit('agent.updated',{id:f.task_id,title:f.summary||f.task_id,state:f.status,detail:f.output_file||''});
  }
  async requestCancel(s:Session){const live=this.live.get(s.id);if(!live?.active||live.nativeId!==s.ref.nativeSessionId||this.lost.has(s.id))throw new Error('No owned active Claude Query');if(live.stopping)throw new Error('Claude cancellation already dispatched; acceptance must be reconciled');const operation=this.cancelOperation(s);if(operation?.receipt.status==='uncertain'||!operation&&this.pendingControls(s.id).some(p=>p.command.action==='cancel'))throw new Error('Claude cancellation acceptance is uncertain; native interrupt cannot be retried safely');live.stopping=true;live.cancelPending=true;try{const receipt=await live.query.interrupt();if(receipt?.still_queued?.length){live.cancelUncertain=true;if(live.active)this.context.emit(s.id,'run.updated',{state:'uncertain',detail:'SDK interrupt left queued inputs',stillQueued:receipt.still_queued});else this.context.emit(s.id,'error',{message:'SDK interrupt left queued inputs after turn completion',stillQueued:receipt.still_queued});throw new Error('SDK interrupt left queued inputs; cancellation acceptance is uncertain');}if(operation)this.context.reconcileReceipt?.(operation.deviceId,operation.clientRequestId,{status:'native_accepted',detail:'Owned Query interrupt acknowledgement received; termination is separate'});}catch(e){live.cancelUncertain=true;throw e;}finally{live.cancelPending=false;}}
  async respond(s:Session,i:Interaction,d:Decision){const live=this.live.get(s.id);const p=live?.pending.get(i.id);if(!live||!p||live.nativeId!==s.ref.nativeSessionId||live.stopping||this.lost.has(s.id))throw new Error('Claude request already settled or no longer live');let result:Native;
    if(d.interactionId!==i.id||d.epoch!==(i.generation??i.epoch)||d.expectedGeneration!==undefined&&d.expectedGeneration!==i.generation||i.generation!==(s.binding?.generation??s.epoch)||i.runtimeInstanceId!==this.context.runtimeInstanceId||i.sessionId!==s.id||i.runId!==s.runId||!['pending','responding'].includes(i.status))throw new Error('Stale Claude interaction');
    if(i.kind==='question'&&!d.cancelled){const answers:Record<string,string>={};for(const q of p.input.questions||[]){const selected=d.answers?.[q.question];if(!selected?.length||selected.some(value=>typeof value!=='string'||!value.trim()))throw new Error('Missing original question text answer');if(selected.length>1)throw new Error(q.multiSelect?'Claude multiselect encoding requires the target SDK tool schema or native fixture':'Claude single-select question requires one answer');Object.defineProperty(answers,q.question,{value:selected[0],enumerable:true,configurable:true,writable:true});}result={behavior:'allow',updatedInput:{...p.input,answers},toolUseID:p.toolUseID};}
    else{if(!d.cancelled&&!['allow','deny'].includes(d.choiceId||''))throw new Error('Invalid Claude permission decision');result=!d.cancelled&&d.choiceId==='allow'?{behavior:'allow',updatedInput:p.input,toolUseID:p.toolUseID}:{behavior:'deny',message:'Denied by user',toolUseID:p.toolUseID};}
    if(!p.finish(result))throw new Error('Claude request already settled');
  }
  async configure(s:Session,model:ModelIdentity){const live=this.live.get(s.id);if(live?.active)throw new Error('Change model between turns');if(live){if(typeof live.query.setModel!=='function')throw new Error('SDK Query.setModel unavailable');await live.query.setModel(model.modelId);}}
  async probe(){const result=await super.probe();try{await this.loadSdk();await this.checkVersion();const attached=[...this.live.values()].some(l=>l.attached&&l.nativeId);result.installed=true;result.version=this.config.expectedVersion;result.controlCapabilities=attached?this.control:{create:true,submit:false,observe:false,approve:false,answer:false,cancel:false,resume:false};result.detail=attached?'Official SDK Query connected':'Official SDK and explicit executable available for Query creation; authentication unverified until native initialization';result.capabilities={text:true,image:false,files:false,history:true,permission:true,questions:true,cancelScope:'owned Query current execution',models:true};try{result.models=await this.listModels();}catch(error){result.capabilities.models=false;result.detail+='; model catalog unavailable: '+String(error);}}catch(e){result.detail=e instanceof Error?e.message:String(e);}return result;}
  close(){for(const [id,live] of this.live){this.lost.add(id);live.input.close();for(const p of live.pending.values())p.finish({behavior:'deny',message:'Host adapter closed'},true);if(typeof live.query.return==='function')void live.query.return().catch(()=>{});}this.live.clear();}
}

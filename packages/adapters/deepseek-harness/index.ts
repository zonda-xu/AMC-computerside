import type WebSocket from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { AgentAdapter, Decision, Interaction, ModelIdentity, Session, Submission, Workspace, RuntimeDescriptor, RuntimeBinding } from '../../protocol/src/types.ts';
import { AdapterBase, unavailableCapabilities } from '../common/base.ts';
import { decodeRequestIdentity } from '../../../plugins/dsh-bridge/features.mjs';
import { mapDurable, streamText } from '../../../plugins/dsh-bridge/mapping.mjs';
type Native=Record<string,any>;
export class DshAdapter extends AdapterBase implements AgentAdapter {
  control={create:true,submit:true,observe:true,approve:true,answer:true,cancel:true,resume:true,configure:false,attach:true,slash:false,steer:false};
  nativeFeatures:Record<string,boolean>={};
  historyNamespace?:string;
  updateCapabilities(r:Native){this.historyNamespace=typeof r.historyNamespace==='string' && /^dsh-store:[a-f0-9]{64}$/.test(r.historyNamespace)?r.historyNamespace:undefined;if(!r.capabilities)return;this.nativeFeatures=r.capabilities;for(const key of Object.keys(this.control) as Array<keyof typeof this.control>)this.control[key]=r.capabilities[key]===true;}
  adopting=new Map<string,{cwd:string;pluginInstanceId:string;session:Session}>();
  socket?:WebSocket; byNative=new Map<string,string>(); pending=new Map<string,{resolve:(v:Native)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>(); pluginInstanceId?:string; handshake?:Promise<void>; subscriptions=new Map<string,string>(); turns=new Map<string,number>(); sequences=new Map<string,number>(); streams=new Map<string,Native>(); snapshots=new Map<string,{resolve:()=>void;reject:(e:Error)=>void}>(); nativeInteractions=new Map<string,Native>(); following=new Map<string,Promise<void>>();
  reopenings=new Map<string,ReturnType<typeof setTimeout>>(); reopenDelays=new Map<string,number>();
  attach(socket:WebSocket){
    if(this.config.enabled===false||this.socket){socket.close(1008,'Runtime disabled or already connected');return;}this.socket=socket;
    socket.on('message',raw=>{try{const m=JSON.parse(raw.toString());if(m.id!==undefined){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);if(m.error)p.reject(new Error(typeof m.error==='string'?m.error:m.error.message));else p.resolve(m.result);}}else if(m.method==='event'&&this.pluginInstanceId&&m.params?.pluginInstanceId===this.pluginInstanceId)this.event(m.params);}catch(e){for(const id of this.byNative.values())this.fault(id,e);}});
    socket.on('error',()=>socket.close());socket.on('close',()=>{if(this.socket!==socket)return;this.socket=undefined;for(const timer of this.reopenings.values())clearTimeout(timer);this.reopenings.clear();this.subscriptions.clear();this.context.disconnect?.([...this.byNative.values()],'DSH bridge disconnected; native plugin may still be running');for(const p of this.snapshots.values())p.reject(new Error('DSH follow disconnected'));this.snapshots.clear();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('DSH bridge disconnected'));}this.pending.clear();for(const id of this.byNative.values())this.fault(id,new Error('DSH host disconnected'));});
    this.handshake=(async()=>{const r=await this.call('probe',{},10000);if(typeof r.pluginInstanceId!=='string'||!r.control)throw new Error(r.detail||'DSH native control unavailable');if(this.config.compatibilityMode==='pinned'&&(!r.version||r.version!==this.config.expectedVersion))throw new Error('DSH pinned controller version mismatch');this.updateCapabilities(r);if(this.pluginInstanceId!==r.pluginInstanceId){if(this.pluginInstanceId){this.sequences.clear();this.turns.clear();this.streams.clear();this.nativeInteractions.clear();for(const id of this.byNative.values())for(const i of this.context.getSession(id).interactions)if(i.status==='pending'||i.status==='responding')this.context.emit(id,'interaction.closed',{id:i.id,status:'stale'});}this.pluginInstanceId=r.pluginInstanceId;this.epoch=this.context.openConnection([...this.byNative.values()],r.pluginInstanceId);}})();
    void this.handshake.then(async()=>{for(const [native,id]of this.byNative){try{await this.resumeSession(this.context.getSession(id));}catch(e){this.fault(id,e);this.reopen(native,id);}}}).catch(e=>{for(const id of this.byNative.values())this.fault(id,e);});
  }
  call(method:string,params:Native={},timeout=120000):Promise<Native>{if(!this.socket)return Promise.reject(new Error('DSH bridge is not connected'));const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`DSH ${method} did not confirm`));},timeout);this.pending.set(id,{resolve,reject,timer});this.socket!.send(JSON.stringify({id,method,params}),error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});});}
  async probe():Promise<RuntimeDescriptor>{
    const result:RuntimeDescriptor={id:this.engineId,runtimeInstanceId:this.context.runtimeInstanceId,version:'',installed:false,authentication:'unknown',verified:false,detail:'DSH plugin not connected',capabilities:{...unavailableCapabilities},models:[]};
    try{
      if(this.config.enabled===false)throw new Error('DSH runtime disabled');
      const r=await this.call('probe',{},10000);result.version=r.version||'';result.installed=!!r.apiProfile;result.detail=r.detail||'Controller unavailable';
      if(this.config.compatibilityMode==='pinned'&&(!r.version||r.version!==this.config.expectedVersion))throw new Error('DSH pinned controller version mismatch');
      if(r.control===true&&r.pluginInstanceId&&r.capabilities){
        this.updateCapabilities(r);result.controlCapabilities={...this.control};result.generation=this.epoch;result.nativeIdentity=r.pluginInstanceId;result.connectionState='attached';
        result.capabilities={text:this.control.submit,image:r.capabilities.image===true,files:r.capabilities.files===true,history:this.control.observe,permission:this.control.approve,questions:this.control.answer,cancelScope:this.control.cancel?'current native turn; inbox retained':'unavailable',models:r.capabilities.models===true&&this.control.configure,slash:this.control.slash,steer:this.control.steer};
        if(result.capabilities.models)try{const catalog=await this.call('models',{},15000);if(!Array.isArray(catalog.models))throw new Error('Invalid DSH model catalog');result.models=catalog.models;}catch(error){result.capabilities.models=false;result.detail+='; model catalog unavailable: '+String(error);}
      }
    }catch(e){result.detail=e instanceof Error?e.message:String(e);}
    return result;
  }
  async createSession(id:string,w:Workspace,model?:ModelIdentity){
    await this.handshake;const r=await this.call('create',{cwd:w.path});
    if(typeof r.sessionId!=='string'||!r.sessionId)throw new Error('DSH create missing native sessionId');
    this.byNative.set(r.sessionId,id);
    const selected=model?(await this.call('configure',{sessionId:r.sessionId,model})).selected:undefined;
    if(model&&(typeof selected?.providerId!=='string'||typeof selected?.modelId!=='string'))throw new Error('DSH model selection was not confirmed');
    const binding:RuntimeBinding={...this.binding(r.sessionId,this.control,this.pluginInstanceId),historyNamespace:this.historyNamespace};
    return{nativeSessionId:r.sessionId,binding,model:selected};
  }
  async resumeSession(s:Session){await this.handshake;
    if(s.binding?.historyNamespace && s.binding.historyNamespace!==this.historyNamespace)throw new Error('DeepSeek Harness 历史存储位置已变化');
    if(s.externalSource || this.historyNamespace && s.binding?.historyNamespace===this.historyNamespace && s.binding.nativeIdentity!==this.pluginInstanceId){const binding=await this.attachExistingSession(s,this.pluginInstanceId||'');this.context.bindSession?.(s.id,binding);return;}this.byNative.set(s.ref.nativeSessionId,s.id);await this.subscribe(s.ref.nativeSessionId,s.id);await this.restorePending(s.ref.nativeSessionId,s.id);this.context.bindSession?.(s.id,{...this.binding(s.ref.nativeSessionId,this.control,this.pluginInstanceId),historyNamespace:this.historyNamespace});}
  async attachExistingSession(s:Session,nativeIdentity:string){
    await this.handshake;
    if(s.binding?.historyNamespace && s.binding.historyNamespace!==this.historyNamespace)throw new Error('DeepSeek Harness 原历史目录已改变');
    if(this.historyNamespace && s.externalSource && s.externalSource.namespace!==this.historyNamespace && s.externalSource.namespace!==this.pluginInstanceId)throw new Error('无法核实该历史来自当前 DeepSeek Harness 存储');
    if(this.historyNamespace && s.binding?.historyNamespace===this.historyNamespace && nativeIdentity===s.binding.nativeIdentity && this.pluginInstanceId) nativeIdentity=this.pluginInstanceId;
    if(!nativeIdentity||nativeIdentity!==this.pluginInstanceId||s.ref.engineId!==this.engineId||s.ref.runtimeInstanceId!==this.context.runtimeInstanceId)throw new Error('DSH runtime ownership changed');
    const native=s.ref.nativeSessionId;const cwd=await realpath(s.cwd);
    const owner=this.byNative.get(native);
    if(owner&&owner!==s.id)throw new Error('DSH native session is already attached to another local session');
    const request={sessionId:native,cwd,pluginInstanceId:nativeIdentity,restoreIdle:true};
    const verify=async()=>{const evidence=await this.call('attach',request);if(evidence.pluginInstanceId!==nativeIdentity||this.pluginInstanceId!==nativeIdentity||evidence.sessionId!==native||evidence.cwd!==cwd||evidence.agentAvailable!==true)throw new Error('DSH live session ownership was not confirmed');};
    await verify();
    const oldSubscription=this.subscriptions.get(native);
    if(oldSubscription){this.subscriptions.delete(native);await this.call('unsubscribe',{subscriptionId:oldSubscription});}
    this.adopting.set(native,{cwd,pluginInstanceId:nativeIdentity,session:s});this.byNative.set(native,s.id);
    try{
      await this.subscribe(native,s.id);await this.restorePending(native,s.id);await verify();
      return {...this.binding(native,this.control,nativeIdentity),historyNamespace:this.historyNamespace};
    }catch(error){
      this.context.disconnect?.([s.id],'DSH attachment could not confirm the same live session');
      const subscriptionId=this.subscriptions.get(native);this.subscriptions.delete(native);
      if(subscriptionId)void this.call('unsubscribe',{subscriptionId},5000).catch(()=>{});
      const timer=this.reopenings.get(native);if(timer)clearTimeout(timer);this.reopenings.delete(native);
      if(!owner)this.byNative.delete(native);
      throw error;
    }finally{this.adopting.delete(native);}
  }
  async subscribe(native:string,id:string){if(this.subscriptions.has(native))return;const subscriptionId=randomUUID();this.subscriptions.set(native,subscriptionId);let timer:ReturnType<typeof setTimeout>;const ready=new Promise<void>((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('DSH opening snapshot unavailable')),30000);this.snapshots.set(subscriptionId,{resolve,reject});});void ready.catch(()=>{});try{await this.call('subscribe',{sessionId:native,subscriptionId});await ready;}catch(e){if(this.subscriptions.get(native)===subscriptionId)this.subscriptions.delete(native);this.reopen(native,id);throw e;}finally{clearTimeout(timer!);this.snapshots.delete(subscriptionId);}}
  reopen(native:string,id:string){if(this.socket?.readyState!==1||this.reopenings.has(native))return;const plugin=this.pluginInstanceId;const socket=this.socket;const delay=this.reopenDelays.get(native)||100;this.reopenDelays.set(native,Math.min(delay*2,10000));const timer=setTimeout(()=>{this.reopenings.delete(native);if(this.socket!==socket||socket.readyState!==1||this.pluginInstanceId!==plugin)return;void(async()=>{try{await this.resumeSession(this.context.getSession(id));if(this.socket!==socket||this.pluginInstanceId!==plugin)return;this.reopenDelays.delete(native);}catch(e){if(this.socket!==socket||this.pluginInstanceId!==plugin)return;this.fault(id,e);this.reopen(native,id);}})();},delay);timer.unref();this.reopenings.set(native,timer);}
  async restorePending(native:string,id:string){const snapshot=await this.call('snapshot',{sessionId:native});if(snapshot.pluginInstanceId!==this.pluginInstanceId)throw new Error('DSH plugin identity changed');const active=new Set<string>();for(const p of snapshot.pending||[]){if(p.sessionId!==native||p.pluginInstanceId!==this.pluginInstanceId)throw new Error('DSH pending resolver ownership mismatch');active.add(p.interactionId);this.openInteraction(id,p);this.nativeInteractions.get(p.interactionId)!.responding=false;}for(const [key,p]of this.nativeInteractions)if(p.sessionId===native&&!active.has(key))this.nativeInteractions.delete(key);for(const i of this.context.getSession(id).interactions)if(['permission','question'].includes(i.nativeMethod)&&['pending','responding'].includes(i.status)&&!active.has(String(i.nativeId)))this.context.emit(id,'interaction.closed',{id:i.id});for(const r of snapshot.promptReceipts||[])if(r.accepted===true&&r.pluginInstanceId===this.pluginInstanceId&&r.sessionId===native)this.acceptSubmission(id,r.requestId);for(const operation of this.pendingControls(id)){if(operation.command.action==='slash'&&operation.command.payload.expectedGeneration===this.epoch){const requestId=createHash('sha256').update(JSON.stringify([operation.deviceId,operation.clientRequestId])).digest('hex');const receipt=(snapshot.slashReceipts||[]).find((r:Native)=>r.accepted===true&&r.pluginInstanceId===this.pluginInstanceId&&r.sessionId===native&&r.requestId===requestId);if(receipt)this.context.reconcileReceipt?.(operation.deviceId,operation.clientRequestId,{status:'native_accepted',result:receipt.result,detail:'Retained native command receipt; no command was resent'});}if(operation.command.action!=='cancel'||operation.command.payload.expectedGeneration!==this.epoch)continue;const operationId=createHash('sha256').update(JSON.stringify([operation.deviceId,operation.clientRequestId])).digest('hex');if((snapshot.cancelReceipts||[]).some((r:Native)=>r.accepted===true&&r.pluginInstanceId===this.pluginInstanceId&&r.operationId===operationId&&r.sessionId===native&&r.runId===operation.command.payload.runId))this.context.reconcileReceipt?.(operation.deviceId,operation.clientRequestId,{status:'native_accepted',detail:'Same DSH plugin retained the original native cancel acknowledgement; no cancellation was resent'});}const current=this.context.getSession(id);if(snapshot.state?.active===true&&typeof snapshot.state.turn==='number'&&current.nativeRunId===String(snapshot.state.turn)&&current.state==='uncertain'&&!active.size&&!this.pendingControls(id).length&&!(snapshot.cancelReceipts||[]).some((r:Native)=>r.accepted===true&&r.runId===current.runId))this.context.emit(id,'run.updated',{state:'running',nativeRunId:current.nativeRunId,nativeAccepted:true});}
  async submit(s:Session,input:Submission){
    await this.resumeSession(s);if(s.nextModel&&input.mode!=='steer')await this.configure(s,s.nextModel);
    const r=await this.call('prompt',{sessionId:s.ref.nativeSessionId,requestId:input.nativeRequestId||input.requestId,text:input.text,attachments:input.attachments,mode:input.mode||'queue'});
    if(r.accepted!==true)throw new Error('DSH native acceptance not confirmed');
    this.acceptSubmission(s.id,input.nativeRequestId||input.requestId);
    this.context.emit(s.id,'run.updated',{state:this.context.getSession(s.id).state,nativeAccepted:true,nativeRequestId:input.nativeRequestId||input.requestId});
  }
  async listNativeCommands(s:Session){await this.handshake;const result=await this.call('slashCommands',{sessionId:s.ref.nativeSessionId});if(!Array.isArray(result.commands))throw new Error('Invalid native command catalog');return {commands:result.commands as unknown[]};}
  async executeNativeCommand(s:Session,line:string,input:Submission){await this.handshake;const r=await this.call('slash',{sessionId:s.ref.nativeSessionId,line,requestId:input.nativeRequestId||input.requestId,attachments:input.attachments});if(r.accepted!==true)throw new Error('DSH command acceptance not confirmed');return r.result;}
  async requestCancel(s:Session){const operation=this.cancelOperation(s);const r=await this.call('cancel',{sessionId:s.ref.nativeSessionId,turn:this.turns.get(s.ref.nativeSessionId),pluginInstanceId:this.pluginInstanceId,...(operation?{operationId:operation.operationId,runId:s.runId}:{})});if(r.accepted!==true)throw new Error('DSH native cancellation acceptance not confirmed');if(operation)this.context.reconcileReceipt?.(operation.deviceId,operation.clientRequestId,{status:'native_accepted',detail:'Native DSH cancel acknowledgement received; termination is separate'});}
  async configure(s:Session,model:ModelIdentity){const r=await this.call('configure',{sessionId:s.ref.nativeSessionId,model});if(typeof r.selected?.providerId!=='string'||typeof r.selected?.modelId!=='string')throw new Error('DSH model selection was not confirmed');this.context.emit(s.id,'model.confirmed',{model:r.selected});}
  async respond(s:Session,i:Interaction,d:Decision){
    const p=this.nativeInteractions.get(String(i.nativeId));if(!p||p.responding||p.sessionId!==s.ref.nativeSessionId||p.localId!==i.id||p.pluginInstanceId!==this.pluginInstanceId)throw new Error('DSH interaction already settled or stale');
    if(i.kind==='permission'&&!['allowed-once','rejected'].includes(d.choiceId||''))throw new Error('Invalid DSH permission outcome');
    const answers=(p.request.questions||[]).map((q:Native)=>{const values=d.answers?.[q.id]||[];const selected=values.filter((value:string)=>q.options?.some((option:Native)=>option.label===value));const custom=values.filter((value:string)=>!selected.includes(value));if(!values.length||custom.length>1||!q.multiSelect&&values.length>1)throw new Error('Invalid DSH question answer');return{id:q.id,selected,...(custom.length?{custom:custom[0]}:{})};});
    p.responding=true;try{const r=await this.call('decide',{sessionId:s.ref.nativeSessionId,pluginInstanceId:this.pluginInstanceId,interactionId:i.nativeId,turn:p.turn,outcome:d.choiceId,answers});if(r.accepted!==true)throw new Error('DSH native decision acceptance not confirmed');this.nativeInteractions.delete(String(i.nativeId));this.context.emit(s.id,'interaction.closed',{id:i.id});}catch(e){p.responding=false;throw e;}
  }
  openInteraction(id:string,p:Native){if(this.nativeInteractions.has(p.interactionId))return;const session=this.context.getSession(id);const prior=session.interactions.find(i=>i.nativeId===p.interactionId&&(i.generation??i.epoch)===this.epoch&&['pending','responding'].includes(i.status));if(prior){this.nativeInteractions.set(p.interactionId,{...p,localId:prior.id});return;}const question=p.kind==='question';const i=this.interaction(id,p.interactionId,p.kind,{kind:question?'question':'permission',title:question?'DSH questions':p.request.toolName,detail:JSON.stringify(p.request),choices:question?[]:[{id:'allowed-once',label:'Allow once',scope:'tool_call',allows:true},{id:'rejected',label:'Reject',scope:'tool_call',allows:false}],questions:question?(p.request.questions||[]).map((q:Native)=>({id:q.id,title:q.question,options:(q.options||[]).map((o:Native)=>o.label),multiple:!!q.multiSelect,freeText:true})):[]});this.nativeInteractions.set(p.interactionId,{...p,localId:i.id});}
  async follow(native:string,frame:Native){const id=this.byNative.get(native);if(!id)return;
    if(frame.type==='snapshot'){
      const adoption=this.adopting.get(native);
      if(adoption&&(this.pluginInstanceId!==adoption.pluginInstanceId||frame.header?.id!==native||typeof frame.header.cwd!=='string'||await realpath(frame.header.cwd)!==adoption.cwd||frame.header.origin==='subagent'))throw new Error('DSH follow snapshot does not match the authorized live session');
      if(adoption)this.attachSession(adoption.session,this.control,adoption.pluginInstanceId);
      const subscription=this.subscriptions.get(native);const plugin=this.pluginInstanceId;
      let records=[...(frame.records||[])];let more=frame.hasMore;let before=records[0]?.event?.seq;if(more&&(frame.cursor===undefined||before===undefined))throw new Error('DSH snapshot missing pinned page cut');
      while(more){const page=await this.call('page',{sessionId:native,throughSeq:frame.cursor,beforeSeq:before});if(this.subscriptions.get(native)!==subscription||this.pluginInstanceId!==plugin)return;if(!page.records?.length)throw new Error('DSH page did not advance');const first=page.records[0].event.seq;if(before!==undefined&&first>=before)throw new Error('DSH page cursor did not advance');records=[...page.records,...records];before=first;more=page.hasMore;}
      if(this.subscriptions.get(native)!==subscription||this.pluginInstanceId!==plugin)return;for(const record of records)this.durable(native,record.event,!!adoption);
      const attempt=frame.assistantStream?.activeAttempt;
      if(attempt){const text=streamText(attempt.stream);const stream={...attempt,id:`dsh:${attempt.attemptId}:${frame.assistantStream.revision}`,revision:frame.assistantStream.revision,index:attempt.nextIndex-1,text,restored:true};this.streams.set(native,stream);if(text)this.context.emit(id,'message.completed',{id:stream.id,role:'assistant',text,nativeKey:stream.id,temporary:true,abandoned:false,attemptId:stream.attemptId,revision:stream.revision});}
      else this.streams.delete(native);
    }
    else if(frame.type==='event')this.durable(native,frame.event);
    else if(frame.type==='assistant-stream'){
      const f=frame.frame;
      if(f.type==='start'){const prior=this.streams.get(native);if(prior&&(prior.revision>f.revision||prior.revision===f.revision&&prior.attemptId===f.attemptId))return;this.streams.set(native,{...f,id:`dsh:${f.attemptId}:${f.revision}`,index:-1,text:''});return;}
      const stream=this.streams.get(native);if(!stream||stream.attemptId!==f.attemptId||stream.revision!==f.revision)return;
      if(f.index<=stream.index)return;if(f.index!==stream.index+1)throw new Error('DSH assistant stream index gap');stream.index=f.index;
      if(f.type==='chunk'&&!stream.finalized&&!stream.abandoned){const text=streamText([f.chunk]);if(text){stream.text+=text;this.context.emit(id,stream.restored?'message.completed':'message.delta',{id:stream.id,role:'assistant',text:stream.restored?stream.text:text,nativeKey:stream.id,temporary:true,abandoned:false,attemptId:stream.attemptId,revision:stream.revision});}}
      if(f.type==='end'){stream.abandoned=f.outcome.kind==='abandoned';if(stream.abandoned&&!stream.finalized)this.context.emit(id,'message.completed',{id:stream.id,role:'assistant',text:stream.text,nativeKey:stream.id,temporary:true,abandoned:true,attemptId:stream.attemptId,revision:stream.revision});else if(!stream.abandoned)stream.committedSeq=f.outcome.seq;}
    }
  }
  durable(native:string,event:Native,historical=false){const id=this.byNative.get(native);if(id&&event.type==='user/message'&&event.data?.source?.kind==='user')this.acceptSubmission(id,decodeRequestIdentity(event.data.source.rpcId)?.requestId);if(event.seq<=(this.sequences.get(native)??-1))return;this.sequences.set(native,event.seq);if(event.type==='turn/start')this.turns.set(native,event.data.turn);if(event.type==='turn/end'&&event.data.turn!==this.turns.get(native))return;for(const mapped of mapDurable(event,this.streams.get(native))){if(mapped.type==='run.updated'&&id&&this.pendingControls(id).some(p=>p.command.action==='submit'))continue;this.event({sessionId:native,...mapped,data:{...mapped.data,...(historical?{historical:true}:{})}});}}
  event(p:Native){const id=this.byNative.get(p.sessionId);if(!id)return;if(p.pluginInstanceId&&p.pluginInstanceId!==this.pluginInstanceId)return;
    if(p.type==='follow'){if(this.subscriptions.get(p.sessionId)!==p.subscriptionId)return;const prior=this.following.get(p.sessionId)||Promise.resolve();const next=prior.then(()=>{if(this.subscriptions.get(p.sessionId)===p.subscriptionId)return this.follow(p.sessionId,p.frame);}).then(()=>{if(p.frame.type==='snapshot'&&this.subscriptions.get(p.sessionId)===p.subscriptionId)this.snapshots.get(p.subscriptionId)?.resolve();}).catch(e=>{this.event({sessionId:p.sessionId,subscriptionId:p.subscriptionId,type:'error',message:e instanceof Error?e.message:String(e)});});this.following.set(p.sessionId,next);}
    else if(p.type==='error'&&p.subscriptionId){if(this.subscriptions.get(p.sessionId)!==p.subscriptionId)return;this.subscriptions.delete(p.sessionId);this.snapshots.get(p.subscriptionId)?.reject(new Error(p.message||'DSH follow failed'));this.context.disconnect?.([id],'DSH native follow failed; reconciliation required');this.fault(id,new Error(p.message||'DSH follow failed'));this.reopen(p.sessionId,id);}
    else if(p.type==='interaction')this.openInteraction(id,p.interaction);
    else if(p.type==='interaction.closed'){const i=this.nativeInteractions.get(p.interactionId);if(i){this.context.emit(id,'interaction.closed',{id:i.localId});this.nativeInteractions.delete(p.interactionId);}}
    else if(['message.delta','message.completed','run.updated','tool.updated','agent.updated','model.confirmed','error'].includes(p.type)){if(p.type==='message.completed'&&p.data.nativeKey){const session=this.context.getSession(id);const source=session.externalSource;const externalId=source&&Number.isSafeInteger(p.data.nativeSeq)?createHash('sha256').update(JSON.stringify([createHash('sha256').update(JSON.stringify([session.ref.hostId,session.ref.engineId,source.namespace,source.nativeId])).digest('hex'),String(p.data.nativeSeq)+':'+p.data.role])).digest('hex'):undefined;const prior=session.messages.findLast(m=>(m.nativeKey===p.data.nativeKey||m.id===externalId)&&m.role===p.data.role);if(prior)p.data.id=prior.id;}this.context.emit(id,p.type,p.data);}
  }
  async releaseSession(s: Session) {
    const native = s.ref.nativeSessionId;
    if (this.byNative.get(native) !== s.id) return;
    await this.handshake;
    const peer = this.pluginInstanceId;
    const snapshot = await this.call('snapshot', {sessionId:native});
    if (!peer || this.pluginInstanceId !== peer || snapshot.pluginInstanceId !== peer ||
      snapshot.state?.active || snapshot.pending?.length) throw new Error('DeepSeek Harness 仍在执行、等待审批或已换实例');
    const subscription = this.subscriptions.get(native);
    if (subscription) await this.call('unsubscribe', {subscriptionId:subscription});
    if (this.pluginInstanceId !== peer) throw new Error('DeepSeek Harness 连接已变化，请刷新状态');
    const timer = this.reopenings.get(native);
    if (timer) clearTimeout(timer);
    this.reopenings.delete(native); this.reopenDelays.delete(native);
    this.subscriptions.delete(native); this.byNative.delete(native);
    this.context.disconnect?.([s.id], '已归档，恢复后可连接原会话');
  }
  async prepareDelete(_s: Session): Promise<() => Promise<void>> {
    throw new Error('此版 DeepSeek Harness 提供归档，但未提供可确认清理原始对话与子代理的删除接口');
  }
  close(){for(const timer of this.reopenings.values())clearTimeout(timer);this.reopenings.clear();this.socket?.close();}
}

import type { AgentAdapter, Decision, Interaction, ModelIdentity, Session, Submission, Workspace } from '../../protocol/src/types.ts';
import { AdapterBase, checkRuntimePolicy } from '../common/base.ts';
import { createHash } from 'node:crypto';
import { validateFormAnswer } from '../../protocol/src/validation.ts';
import { loadNativeModule } from '../common/native-module.ts';
import { ACTIVE } from '../../protocol/src/types.ts';
import { openCodeModels } from '../common/models.ts';
type Native=Record<string,any>;
export class OpenCodeAdapter extends AdapterBase implements AgentAdapter {
  async listModels(workspace?:Workspace):Promise<ModelIdentity[]>{return this.cachedModels(workspace?.path||'',()=>this.readModelCatalog(workspace));}
  async readModelCatalog(workspace?:Workspace):Promise<ModelIdentity[]>{
    await this.connection();
    return openCodeModels(await this.http('/api/model'+(workspace?'?location[directory]='+encodeURIComponent(workspace.path):'')));
  }
  control={create:true,submit:true,observe:true,approve:true,answer:true,cancel:true,resume:true,configure:true,attach:true};
  endpoint?:{url:string;headers:HeadersInit;identity?:string}; connecting?:Promise<void>; byNative=new Map<string,string>(); loaded=new Set<string>(); pending=new Map<string,Native>(); seen=new Set<string>(); controller?:AbortController; closed=false; streamTask?:Promise<void>; recovering=false; buffered:Native[]=[]; reconnecting=false; blocks=new Map<string,Map<number,string>>();
  finalMessages=new Set<string>(); endedBlocks=new Set<string>(); inputIds=new Map<string,string>();
  // The native execution events carry only sessionID. Correlate their outcome with
  // the persisted input identity and native busy/idle boundaries, never with text.
  submittedInputs=new Map<string,{runId?:string;requestId:string;id:string}>();
  activeSnapshots=new Set<string>(); refreshing=new Map<string,Promise<void>>(); refreshAgain=new Set<string>();
  observedBoundaries=new Map<string,number>(); recoveryWarnings=new Set<string>();
  async discover(){const module=this.config.serviceModule||'@opencode/client/service';try{const {Service}=await loadNativeModule(module,'@opencode/client');if(typeof Service?.discover!=='function'||typeof Service?.headers!=='function')throw new Error('Service.discover/headers unavailable');const endpoint=await Service.discover();if(!endpoint)throw new Error('No matching registered v2 service; inspect registry/PID. Service.ensure will not be called');const url=new URL(endpoint.url);if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Registered OpenCode service must be loopback');return{url:url.href,headers:Service.headers(endpoint) as HeadersInit,identity:createHash('sha256').update(JSON.stringify(endpoint)).digest('hex')};}catch(e){throw new Error(`OpenCode v2 discovery unavailable (${module}): ${e instanceof Error?e.message:String(e)}`);}}
  async connection(){if(this.endpoint&&this.controller)return;if(this.connecting)return this.connecting;const promise=this.connect();this.connecting=promise;try{await promise;}finally{this.connecting=undefined;}}
  async checkVersion() {
    if (this.config.compatibilityMode === 'pinned') await super.checkVersion();
    else checkRuntimePolicy(this.config, '');
  }
   async connect(){if(this.config.enabled===false)throw new Error('OpenCode runtime disabled');await this.checkVersion();const endpoint=await this.discover();const identity=endpoint.identity||endpoint.url;const changed=this.endpoint&&(this.endpoint.identity||this.endpoint.url)!==identity;
    if(changed&&this.byNative.size)throw new Error('OpenCode registered service identity changed; explicit runtime reconciliation required');
    for(const id of this.byNative.values()){const binding=this.context.getSession(id).binding;if(binding?.nativeIdentity&&binding.nativeIdentity!==identity)throw new Error('OpenCode registered service differs from persisted session binding');}
    if(changed){this.pending.clear();this.blocks.clear();this.seen.clear();this.finalMessages.clear();this.endedBlocks.clear();this.inputIds.clear();this.submittedInputs.clear();this.activeSnapshots.clear();}this.endpoint=endpoint;this.closed=false;this.epoch=this.context.openConnection(undefined,identity);await this.openStream();}
  projectListRoute = '/api/project';
  async http(path:string,method='GET',body?:Native):Promise<Native>{if(!this.endpoint)throw new Error('OpenCode service not discovered');const headers=new Headers(this.endpoint.headers);if(body)headers.set('content-type','application/json');const response=await fetch(new URL(path,this.endpoint.url),{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error(`OpenCode ${method} ${path}: HTTP ${response.status}`);return response.status===204?{}:await response.json() as Native;}
  path(nativeId:string,suffix=''){return `/api/session/${encodeURIComponent(nativeId)}${suffix}`;}
  async openStream(){
    const controller=new AbortController();this.controller=controller;this.recovering=true;this.buffered=[];const timer=setTimeout(()=>controller.abort(),10000);
    try{const response=await fetch(new URL('/api/event',this.endpoint!.url),{headers:{...Object.fromEntries(new Headers(this.endpoint!.headers)),accept:'text/event-stream'},signal:controller.signal});clearTimeout(timer);if(!response.ok||!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))throw new Error(`OpenCode SSE unavailable: HTTP ${response.status}`);
      this.streamTask=this.consume(response,controller);
      for(const [native,id]of this.byNative)await this.reconcile(native,id);
      for(const event of this.buffered.splice(0))this.event(event);
       for(const [native,id]of this.byNative)await this.reconcile(native,id);
      if(this.controller!==controller||controller.signal.aborted)throw new Error('OpenCode SSE lost during reconciliation');
      this.recovering=false;for(const event of this.buffered.splice(0))this.event(event);
      for(const [native,id]of this.byNative)this.attachSession(this.context.getSession(id),this.control,this.endpoint?.identity||this.endpoint?.url);
    }catch(e){controller.abort();if(this.controller===controller)this.controller=undefined;throw e;}finally{clearTimeout(timer);}
  }
  async consume(response:Response,controller:AbortController){
    const reader=response.body!.getReader();const decoder=new TextDecoder();let buffer='';let data:string[]=[];
     try{while(true){const {value,done}=await reader.read();if(done)throw new Error('OpenCode SSE ended; snapshot reconciliation required');buffer+=decoder.decode(value,{stream:true});let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);if(!line){if(data.length){const event=JSON.parse(data.join('\n'));data=[];if(event.type==='effect/http-api/stream/failure')throw new Error('OpenCode SSE overflow; snapshot reconciliation required');if(this.recovering)this.buffered.push(event);else this.event(event);}}else if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));}if(buffer.length+data.reduce((size,line)=>size+line.length,0)>8*1024*1024)throw new Error('OpenCode SSE frame too large');}}
    catch(e){if(!controller.signal.aborted){this.context.disconnect?.([...this.byNative.values()],'OpenCode SSE disconnected; reconciling native state');for(const id of this.byNative.values())this.fault(id,e);}}
    finally{reader.releaseLock();if(this.controller===controller)this.controller=undefined;if(!this.closed&&!controller.signal.aborted)void this.reconnect();}
  }
  async reconnect(){if(this.reconnecting)return;this.reconnecting=true;try{let delay=250;while(!this.closed){await new Promise(resolve=>setTimeout(resolve,delay));if(this.closed)return;try{await this.connection();return;}catch(e){for(const id of this.byNative.values())this.fault(id,e);delay=Math.min(delay*2,10000);}}}finally{this.reconnecting=false;}}
  async createSession(id:string,w:Workspace,model?:ModelIdentity){await this.connection();const r=await this.http('/api/session','POST',{location:{directory:w.path},...(model?{model:{id:model.modelId,providerID:model.providerId}}:{})});const info=r.data;if(typeof info?.id!=='string')throw new Error('OpenCode create did not return native session ID');if(info.location?.directory!==undefined&&info.location.directory!==w.path)throw new Error('OpenCode created session outside the authorized workspace');this.byNative.set(info.id,id);return{nativeSessionId:info.id,binding:this.binding(info.id,this.control,this.endpoint?.identity||this.endpoint?.url),model:this.model(info)};}
  messageId(id:string,nativeId:string){
    const session=this.context.getSession(id);const source=session.externalSource;
    if(source){const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const candidate=digest([session.ref.hostId,'opencode',source.namespace,source.nativeId]);const imported=digest([candidate,nativeId]);
      if(session.messages.some(message=>message.id===imported))return imported;
    }
    return nativeId;
  }
  model(info:Native):ModelIdentity|undefined{return info?.model?.id&&info.model.providerID?{providerId:info.model.providerID,modelId:info.model.id,label:info.model.id}:undefined;}
  async resumeSession(s:Session){await this.connection();const identity=this.endpoint?.identity||this.endpoint?.url;if(s.binding?.nativeIdentity&&s.binding.nativeIdentity!==identity)throw new Error('OpenCode registered service identity changed; old session binding cannot be reused');this.byNative.set(s.ref.nativeSessionId,s.id);await this.reconcile(s.ref.nativeSessionId,s.id);this.loaded.add(s.id);this.attachSession(s,this.control,identity);}
  async attachExistingSession(s:Session,nativeIdentity:string){
    if(s.ref.engineId!=='opencode'||s.ref.runtimeInstanceId!==this.context.runtimeInstanceId||!nativeIdentity)throw new Error('OpenCode attachment runtime identity mismatch');
    await this.connection();const endpoint=this.endpoint;
    if((endpoint?.identity||endpoint?.url)!==nativeIdentity)throw new Error('OpenCode attachment service identity mismatch');
    const owner=this.byNative.get(s.ref.nativeSessionId);if(owner&&owner!==s.id)throw new Error('OpenCode session already owned by another gateway session');
    const snapshot=(await this.http(this.path(s.ref.nativeSessionId))).data;
    if(snapshot?.id!==s.ref.nativeSessionId||snapshot.location?.directory!==s.cwd||!snapshot.time||!Number.isFinite(snapshot.time.created))throw new Error('OpenCode attachment native session identity, workspace or state is unverified');
    if(this.endpoint!==endpoint)throw new Error('OpenCode service changed during attachment');
    this.byNative.set(s.ref.nativeSessionId,s.id);this.attachSession(s,this.control,nativeIdentity);
    await this.reconcile(s.ref.nativeSessionId,s.id);
    if(this.endpoint!==endpoint)throw new Error('OpenCode service changed during attachment');
    return this.binding(s.ref.nativeSessionId,this.control,nativeIdentity);
  }
  async reconcile(native:string,id:string,messages=true){
    const path=this.path(native);const session=await this.http(path);const info=session.data;if(info?.id!==native)throw new Error('OpenCode snapshot identity mismatch');
    if(info.location?.directory!==undefined&&info.location.directory!==this.context.getSession(id).cwd)throw new Error('OpenCode native workspace changed');
    const existing=this.context.getSession(id);
    const busyBoundary=info.time?.busy;const priorRun=existing.runId?this.context.getRun?.(existing.runId):undefined;
    const priorBoundary=this.observedBoundaries.get(id)??priorRun?.nativeStartedAt;
    if(existing.binding?.state==='attached'&&(!existing.runId||['completed','failed','cancelled'].includes(existing.state))&&!this.pendingControls(id).some(p=>p.command.action==='submit')&&Number.isFinite(busyBoundary)&&(!Number.isFinite(info.time?.idle)||busyBoundary>info.time.idle)&&(priorBoundary===undefined||busyBoundary>priorBoundary)){
      this.observedBoundaries.set(id,busyBoundary);
      this.context.emit(id,'run.updated',{state:'running',nativeAccepted:true,...(existing.runId?{nativeRunId:`opencode:busy:${busyBoundary}`} : {}),nativeStartedAt:busyBoundary,nativeStatus:info,evidence:'Adapter correlation key derived from authoritative session busy boundary, not a native execution ID'});
    }
    const nativeMessages:Native[]=[];
     if(messages){let cursor:string|undefined;const cursors=new Set<string>();do{const r=await this.http(path+'/message?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):'&order=asc'));for(const m of r.data||[]){nativeMessages.push(m);if(m.sessionID!==undefined&&m.sessionID!==native)throw new Error('OpenCode message snapshot identity mismatch');if(m.type==='user'&&typeof m.id==='string')this.confirmInput(id,m);if(m.type==='assistant'){const text=m.payload?.text;if(typeof m.id==='string'&&typeof text==='string'){const key=`${native}:${m.id}`;this.finalMessages.add(key);if(typeof info.time?.busy==='number'&&(!info.time.idle||info.time.busy>info.time.idle))this.activeSnapshots.add(key);else this.activeSnapshots.delete(key);this.context.emit(id,'message.completed',{id:this.messageId(id,m.id),text,role:'assistant',nativeMessage:m});}}}cursor=r.cursor?.next||undefined;if(cursor&&cursors.has(cursor))throw new Error('OpenCode message pagination cursor repeated');if(cursor)cursors.add(cursor);}while(cursor);}
    if(messages&&!this.recoveryWarnings.has(id)){this.recoveryWarnings.add(id);this.context.emit(id,'error',{code:'opencode_tool_history_unavailable',message:'OpenCode 2.3.0 local contract defines tool SSE events but no persisted tool-message schema. Missed tool records, output and errors cannot be reconstructed; recovery is partial.'});}
    const permissions=await this.http(path+'/permission');const forms=await this.http(path+'/form');const nativePending=new Set<string>();
     for(const p of permissions.data||[]){if(p.sessionID!==native)throw new Error('OpenCode permission snapshot identity mismatch');nativePending.add(p.id);this.openInteraction(id,p,'permission');}
     for(const f of forms.data||[]){if(f.sessionID!==native)throw new Error('OpenCode form snapshot identity mismatch');nativePending.add(f.id);this.openInteraction(id,f,'form');}
    for(const [key,p]of this.pending)if(p.sessionID===native&&!nativePending.has(p.id)){this.pending.delete(key);const i=this.context.getSession(id).interactions.find(i=>i.nativeId===p.id);if(i)this.context.emit(id,'interaction.closed',{id:i.id});}
    for(const i of this.context.getSession(id).interactions)if(['permission','form'].includes(i.nativeMethod)&&['pending','responding'].includes(i.status)&&!nativePending.has(String(i.nativeId)))this.context.emit(id,'interaction.closed',{id:i.id});
    const model=this.model(info);if(model)this.context.emit(id,'model.confirmed',{model});
    if(this.reconcileOwnedExecution(id,info,nativeMessages))return;
    const busy=typeof info.time?.busy==='number'&&(!info.time.idle||info.time.busy>info.time.idle);
     if(busy){if(!this.managedRun(id)||ACTIVE.includes(this.context.getSession(id).state))this.context.emit(id,'run.updated',{state:this.managedRun(id)?'uncertain':nativePending.size?this.context.getSession(id).state:'running',nativeStatus:info,...(!this.managedRun(id)?{nativeAccepted:true,nativeStartedAt:info.time?.busy}:{})});}
     else if(info.outcome&&!this.pendingControls(id).some(p=>p.command.action==='submit')){const current=this.context.getSession(id);if(this.managedRun(id)){if(ACTIVE.includes(current.state))this.context.emit(id,'run.updated',{state:'uncertain',nativeStatus:info,detail:'Session outcome has no native execution/input correlation; input acceptance does not prove this run ended'});}else this.context.emit(id,'run.updated',{state:info.outcome==='succeeded'?'completed':info.outcome==='interrupted'?'cancelled':'failed',nativeStatus:info});}
     else if(this.context.getSession(id).state!=='accepted'&&(!this.managedRun(id)||ACTIVE.includes(this.context.getSession(id).state)))this.context.emit(id,'run.updated',{state:ACTIVE.includes(this.context.getSession(id).state)?'uncertain':'idle',nativeStatus:info});
  }
  reconcileOwnedExecution(id:string,info:Native,messages:Native[]):boolean{
    const session=this.context.getSession(id);
    if(!session.runId||!ACTIVE.includes(session.state))return false;
    const observed=this.observedBoundaries.get(id);
    if(observed!==undefined&&session.nativeRunId===`opencode:busy:${observed}`){
      if(info.time?.busy!==observed)return true;
      const running=!Number.isFinite(info.time?.idle)||info.time.idle<observed;
      const state=running?(['waiting_permission','waiting_input','cancel_requested'].includes(session.state)?session.state:'running'):info.outcome==='succeeded'?'completed':info.outcome==='failed'?'failed':info.outcome==='interrupted'?'cancelled':'uncertain';
      this.context.emit(id,'run.updated',{state,runId:session.runId,nativeRunId:session.nativeRunId,nativeStartedAt:observed,nativeStatus:info});return true;
    }
    const run=this.context.getRun?.(session.runId);
    if(run&&(run.sessionId!==id||run.generation!==(session.runGeneration??session.binding?.generation??session.epoch)))return false;
    if(run&&!run.clientRequestId&&!run.nativeRequestId){
      const busy=info.time?.busy;const idle=info.time?.idle;
      if(!Number.isFinite(run.nativeStartedAt)||busy!==run.nativeStartedAt)return false;
      const running=!Number.isFinite(idle)||idle<busy;
      const state=running?(['waiting_permission','waiting_input','cancel_requested'].includes(session.state)?session.state:'running'):
        info.outcome==='succeeded'?'completed':info.outcome==='failed'?'failed':info.outcome==='interrupted'?'cancelled':undefined;
      if(!state)return false;
      this.context.emit(id,'run.updated',{state,runId:session.runId,nativeStatus:info,nativeStartedAt:busy,evidence:'Observed native execution busy boundary is unchanged'});
      return true;
    }
    const submitted=this.submittedInputs.get(id);
    const owned=submitted?.runId===session.runId?submitted:undefined;
    const request=run?.nativeRequestId||owned?.requestId;
    if(!request)return false;
    // The most recent native user input must be ours. A later desktop/inbox
    // input can start another execution and must not finish this gateway run.
    const input=messages.filter(message=>message.type==='user').at(-1);
    if(!input||input.sessionID!==session.ref.nativeSessionId||
      !(input.id===owned?.id||input.id===request||input.metadata?.aiMaidCafeRequestId===request))return false;
    const created=input.time?.created;const busy=info.time?.busy;const idle=info.time?.idle;
    if(!Number.isFinite(created)||!Number.isFinite(busy)||busy<created)return false;
    const running=!Number.isFinite(idle)||idle<busy;
    const state=running?(['waiting_permission','waiting_input','cancel_requested'].includes(session.state)?session.state:'running'):
      info.outcome==='succeeded'?'completed':info.outcome==='failed'?'failed':info.outcome==='interrupted'?'cancelled':undefined;
    if(!state)return false;
    this.context.emit(id,'run.updated',{state,runId:session.runId,nativeAccepted:true,nativeInputId:input.id,nativeStatus:info,
      evidence:'Native input identity, latest user message and execution busy/idle boundaries agree'});
    return true;
  }
  managedRun(id:string){const s=this.context.getSession(id);return !!s.runId;}
  refreshSnapshot(native:string,id:string){
    if(this.refreshing.has(native)){this.refreshAgain.add(native);return;}
    const task=(async()=>{do{this.refreshAgain.delete(native);await this.reconcile(native,id);}while(this.refreshAgain.has(native)&&!this.closed);})();
    this.refreshing.set(native,task);
    void task.catch(e=>this.fault(id,e)).finally(()=>{this.refreshing.delete(native);});
  }
  confirmInput(id:string,message:Native){
    const session=this.context.getSession(id);
    if(message.type!=='user'||typeof message.id!=='string'||message.sessionID!==session.ref.nativeSessionId)return;
    for(const p of this.pendingControls(id)){
      if(p.command.action!=='submit'||p.command.payload.expectedGeneration!==(session.runGeneration??session.binding?.generation??session.epoch))continue;
      const run=p.receipt.runId?this.context.getRun?.(p.receipt.runId):undefined;
      if(run&&(run.sessionId!==id||run.clientRequestId!==p.clientRequestId||run.deviceId!==p.deviceId||run.generation!==p.command.payload.expectedGeneration))continue;
      const request=p.receipt.nativeRequestId||run?.nativeRequestId;
      if(!request||message.id!==request&&message.metadata?.aiMaidCafeRequestId!==request)continue;
      this.inputIds.set(id,message.id);
      this.context.reconcileReceipt?.(p.deviceId,p.clientRequestId,{status:'native_accepted',detail:`Native user message ${message.id} confirms input acceptance; execution remains separately uncorrelated`});
    }
  }
   async submit(s:Session,input:Submission){if(input.attachments.length)throw new Error('OpenCode v2 attachment contract not enabled');this.byNative.set(s.ref.nativeSessionId,s.id);await this.connection();const info=(await this.http(this.path(s.ref.nativeSessionId))).data;if(info?.time?.busy&&(!info.time.idle||info.time.busy>info.time.idle))throw new Error('OpenCode already has an active execution');const requestId=input.nativeRequestId||input.requestId;const r=await this.http(this.path(s.ref.nativeSessionId,'/prompt'),'POST',{text:input.text,delivery:'queue',metadata:{aiMaidCafeRequestId:requestId}});if(typeof r.data?.id!=='string'||r.data.sessionID!==undefined&&r.data.sessionID!==s.ref.nativeSessionId)throw new Error('OpenCode inbox acceptance missing native ID or session mismatch');this.inputIds.set(s.id,r.data.id);this.submittedInputs.set(s.id,{runId:input.runId||s.runId,requestId,id:r.data.id});this.acceptSubmission(s.id,requestId);this.context.emit(s.id,'run.updated',{state:this.context.getSession(s.id).state,runId:input.runId||s.runId,nativeAccepted:true,nativeInputId:r.data.id});this.refreshSnapshot(s.ref.nativeSessionId,s.id);}
   async requestCancel(s:Session){const operation=this.cancelOperation(s);const target=s.runId;const generation=s.runGeneration??s.binding?.generation??s.epoch;await this.connection();const current=this.context.getSession(s.id);if(target!==current.runId||generation!==(current.runGeneration??current.binding?.generation??current.epoch)||target&&!ACTIVE.includes(current.state))throw new Error('OpenCode cancel target changed or ended');const r=await this.http(this.path(s.ref.nativeSessionId,'/interrupt?resume=false'),'POST');if(r.interrupted===true){if(operation)this.context.reconcileReceipt?.(operation.deviceId,operation.clientRequestId,{status:'native_accepted',detail:'Native OpenCode interrupt acknowledgement received; termination is separate'});}else if(r.interrupted===false){await this.reconcile(s.ref.nativeSessionId,s.id);if(ACTIVE.includes(this.context.getSession(s.id).state))throw new Error('OpenCode interruption not confirmed by native state');}else throw new Error('OpenCode interrupt acknowledgement missing');}
  async configure(s:Session,model:ModelIdentity){
    if(ACTIVE.includes(s.state))throw new Error('Change model between turns');
    await this.connection();
    await this.http(this.path(s.ref.nativeSessionId,'/model'),'POST',{model:{id:model.modelId,providerID:model.providerId}});
    // A successful switch request is not evidence of the model used to execute.
    // The session projection/assistant events confirm that independently.
  }
  openInteraction(id:string,p:Native,kind:'permission'|'form'){
    const key=`${p.sessionID}:${p.id}`;if(this.pending.has(key))return;const prior=this.context.getSession(id).interactions.find(i=>i.nativeId===p.id&&(i.generation??i.epoch)===this.epoch&&['pending','responding'].includes(i.status));if(prior){this.pending.set(key,{...p,kind,interactionId:prior.id});return;}this.pending.set(key,{...p,kind});
    const i=this.interaction(id,p.id,kind,{kind:kind==='form'?'question':'permission',title:p.title||p.message||p.action||'OpenCode permission',detail:JSON.stringify(p),nativeRequest:p,...(kind==='form'?{form:p.fields}:{}),choices:kind==='permission'?[{id:'once',label:'Allow once',scope:'once',allows:true},...(p.save?[{id:'always',label:'Remember displayed scope',scope:'always',allows:true}]:[]),{id:'reject',label:'Reject',scope:'once',allows:false}]:[],questions:kind==='form'?(p.fields||[]).filter((f:Native)=>!f.hidden).map((f:Native)=>({id:f.key,title:f.title||f.key,options:(f.options||[]).map((o:Native)=>o.value),multiple:f.type==='multiselect',freeText:f.type==='string'&&!!f.custom||!f.options?.length})):[]});
    this.pending.get(key)!.interactionId=i.id;
  }
  event(event:Native){
    if(typeof event.id==='string'){if(this.seen.has(event.id))return;this.seen.add(event.id);if(this.seen.size>10000)this.seen.delete(this.seen.values().next().value!);}
    const d=event.data||{};const form=d.form;const native=d.sessionID||form?.sessionID;const id=this.byNative.get(native);if(!id)return;
    const emit=(type:Parameters<typeof this.context.emit>[1],data:Native)=>this.context.emit(id,type,{...data,nativeEventId:event.id});
    const type=event.type;
    const unconfirmed=this.pendingControls(id).some(p=>p.command.action==='submit');
      if(type==='session.execution.started'&&!unconfirmed)this.refreshSnapshot(native,id);
      if(['session.execution.succeeded','session.execution.failed','session.execution.interrupted'].includes(type)&&!unconfirmed){if(this.managedRun(id)){if(ACTIVE.includes(this.context.getSession(id).state)&&!this.observedBoundaries.has(id))emit('run.updated',{state:'uncertain',reason:d.reason,error:d.error,detail:'Native execution event identifies only the session, not the gateway input/run'});}else emit('run.updated',{state:type.endsWith('succeeded')?'completed':type.endsWith('interrupted')?'cancelled':'failed',reason:d.reason,error:d.error});this.refreshSnapshot(native,id);}
     if(['session.text.started','session.text.delta','session.text.ended'].includes(type)&&typeof d.assistantMessageID==='string'&&Number.isInteger(d.ordinal)&&d.ordinal>=0){const key=`${native}:${d.assistantMessageID}`;const blockKey=`${key}:${d.ordinal}`;if(this.finalMessages.has(key)){if(this.activeSnapshots.has(key)&&!this.recovering)this.refreshSnapshot(native,id);return;}if(this.endedBlocks.has(blockKey))return;const blocks=this.blocks.get(key)||new Map<number,string>();this.blocks.set(key,blocks);if(type.endsWith('started')){if(!blocks.has(d.ordinal))blocks.set(d.ordinal,'');return;}const text=type.endsWith('delta')?d.delta:d.text;if(typeof text!=='string')return;blocks.set(d.ordinal,type.endsWith('delta')?(blocks.get(d.ordinal)||'')+text:text);if(type.endsWith('ended'))this.endedBlocks.add(blockKey);if(type.endsWith('delta')&&blocks.size===1)emit('message.delta',{id:this.messageId(id,d.assistantMessageID),role:'assistant',text});else emit('message.completed',{id:this.messageId(id,d.assistantMessageID),role:'assistant',text:[...blocks].sort(([a],[b])=>a-b).map(([,part])=>part).join('')});}
    if(['session.tool.called','session.tool.progress','session.tool.success','session.tool.failed'].includes(type))emit('tool.updated',{id:d.id,title:d.id,status:type.endsWith('success')?'completed':type.endsWith('failed')?'failed':'running',output:d.content,error:d.error,input:d.input,executed:d.executed,assistantMessageID:d.assistantMessageID,detail:JSON.stringify(d)});
    if(type==='permission.asked')this.openInteraction(id,d,'permission');
    if(type==='form.created')this.openInteraction(id,form,'form');
    if(['permission.replied','form.replied','form.cancelled'].includes(type)){const requestId=d.requestID||d.id;const p=this.pending.get(`${native}:${requestId}`);if(p){this.pending.delete(`${native}:${requestId}`);emit('interaction.closed',{id:p.interactionId});}}
  }
  async respond(s:Session,i:Interaction,d:Decision){const key=`${s.ref.nativeSessionId}:${i.nativeId}`;const p=this.pending.get(key);if(!p||p.responding)throw new Error('OpenCode interaction already settled or responding');let body:Native;
    if(p.kind==='permission'){if(!['once','always','reject'].includes(d.choiceId||'')||d.choiceId==='always'&&!p.save)throw new Error('Invalid native permission decision');body={decision:d.choiceId};}
    else{if(d.cancelled)throw new Error('OpenCode form cancellation reply is not specified');if(!d.answer||typeof d.answer!=='object'||Array.isArray(d.answer))throw new Error('OpenCode form requires a typed answer keyed by native field key');validateFormAnswer(p.fields,d.answer);body={answer:d.answer};}
    p.responding=true;try{await this.http(this.path(s.ref.nativeSessionId,`/${p.kind==='permission'?'permission':'form'}/${encodeURIComponent(String(i.nativeId))}/reply`),'POST',body);this.pending.delete(key);this.context.emit(s.id,'interaction.closed',{id:i.id});}catch(e){p.responding=false;throw e;}
  }
  async probe() {
    const result = await super.probe();
    try {
      checkRuntimePolicy(this.config, result.version);
      await this.connection();
      const page = await this.http('/api/session?limit=1');
      if (!Array.isArray(page?.data)) throw new Error('OpenCode /api/session 未返回会话列表');
      result.installed = true;
      result.version ||= 'unknown';
      result.controlCapabilities = this.control;
      result.generation = this.epoch;
      result.connectionState = 'attached';
      result.nativeIdentity = this.endpoint?.identity || this.endpoint?.url;
      result.detail = '已连接本机 OpenCode 会话接口和 SSE 事件流。';
      result.capabilities = { text:true, image:false, files:false, history:true, permission:true, questions:true, cancelScope:'session current execution; no atomic turn comparison', models:true };
      try { result.models = await this.listModels(); }
      catch (error) { result.capabilities.models = false; result.detail += ' 模型目录不可用：' + String(error); }
    } catch (error) { result.detail = (error as Error).message; }
    return result;
  }
  async releaseSession(s: Session) {
    await this.connection();
    const native=s.ref.nativeSessionId;
    if(this.byNative.get(native)!==s.id)return;
    const info=(await this.http(this.path(native))).data;
    if(info?.id!==native || info.location?.directory!==s.cwd || info.time?.busy && (!info.time?.idle||info.time.busy>info.time.idle)) throw new Error('OpenCode 会话状态已改变');
    this.loaded.delete(s.id); this.byNative.delete(native);
    this.context.disconnect?.([s.id],'会话已归档');
  }
  async prepareDelete(s: Session) {
    await this.connection();
    const endpoint=this.endpoint, identity=endpoint?.identity||endpoint?.url;
    if(!identity || s.binding?.nativeIdentity && s.binding.nativeIdentity!==identity || s.externalSource && s.externalSource.namespace!==this.context.runtimeInstanceId+':'+identity) throw new Error('OpenCode 服务身份与历史不符');
    const native=s.ref.nativeSessionId, path=this.path(native);
    let info: Native;
    try { info=(await this.http(path)).data; }
    catch(e){if(s.deletionPending && String(e).endsWith('HTTP 404'))return async()=>{};throw e;}
    if(info?.id!==native||info.location?.directory!==s.cwd||!Number.isFinite(info.time?.created) || info.time.busy && (!info.time.idle || info.time.busy>info.time.idle))throw new Error('OpenCode 未确认会话身份或空闲状态');
    return async()=>{
      if(this.endpoint!==endpoint)throw new Error('OpenCode 服务连接已改变');
      await this.http(path,'DELETE');
      try {await this.http(path);}
      catch(e){if(String(e).endsWith('HTTP 404')){this.byNative.delete(native);this.loaded.delete(s.id);return;}throw e;}
      throw new Error('OpenCode 仍能找到原会话，请核对后重试');
    };
  }
  close(){this.closed=true;this.controller?.abort();this.controller=undefined;this.endpoint=undefined;}
}

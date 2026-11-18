import { createHash, randomUUID } from 'node:crypto';
import type { AgentAdapter, Decision, ExternalCapability, Interaction, ModelIdentity, Session, Submission, Workspace } from '../../protocol/src/types.ts';
import { AdapterBase, checkRuntimePolicy } from '../common/base.ts';
import type { RpcMessage } from '../common/rpc.ts';
import { WebSocketRpc } from '../common/ws-rpc.ts';
import { ACTIVE } from '../../protocol/src/types.ts';
import { catalogModel, uniqueModels } from '../common/models.ts';
import { codexControls, initializeCodex, listCodexThreads, readCodexMethods, readCodexHistoryPage, type CodexMethods } from './protocol.ts';
import { matchesPinnedVersion } from '../../protocol/src/compatibility.ts';
type Native = Record<string, any>;
export interface CodexThreadSnapshot {
  thread: { id: string; cwd: string; historyMode?: string; model?: string | null; modelProvider?: string; status: { type: string }; turns: Array<{ id: string; status: string; error?: unknown; itemsView?: string; items: Array<{ type: string; id: string; text?: string; [key: string]: unknown }> }> };
  model?: string;
  modelProvider?: string;
}
type Completion={state:'completed'|'failed'|'cancelled'|'uncertain';reason:string;error?:unknown};
interface PendingApproval { method: string; params: Native; sessionId: string; rpc?: WebSocketRpc; interactionId?: string }
export class CodexAdapter extends AdapterBase implements AgentAdapter {
   connectionIdentity?:string; connectionEndpoint?:string;
  private methods?: CodexMethods;
  get control(){return codexControls(this.methods, this.rpc?.unavailableMethods);}
  private historyCheck?: { rpc: WebSocketRpc; until: number; result: Promise<{ discover: ExternalCapability; history: ExternalCapability }> };
  historyAccess(rpc: WebSocketRpc) {
    if (this.historyCheck?.rpc === rpc && this.historyCheck.until > Date.now()) return this.historyCheck.result;
    const result = this.inspectHistory(rpc);
    this.historyCheck = { rpc, until: Date.now() + 5000, result };
    return result;
  }
  private async inspectHistory(rpc: WebSocketRpc) {
    const supported = (reason: string): ExternalCapability => ({ state:'supported', reason });
    const unavailable = (reason: string): ExternalCapability => ({ state:'unverified', reason });
    let discover = unavailable('Codex 缺少 thread/list'), history = unavailable('Codex 缺少 thread/read');
    let example: { id:string; cwd:string } | undefined;
    try {
      example = (await listCodexThreads(rpc, 1)).data[0];
      discover = supported('thread/list 已返回有效会话列表');
    } catch (error) { discover = unavailable(String(error)); }
    if (rpc.unavailableMethods?.has('thread/read')) return { discover, history };
    if (this.methods) {
      if (this.methods.requests.has('thread/read')) history = supported('本机 app-server 协议包含 thread/read');
    } else {
      const id = example?.id ?? randomUUID();
      try {
        const result = await rpc.request<CodexThreadSnapshot>('thread/read', { threadId: id, includeTurns:false }, 5000);
        if (example && result?.thread?.id === id && result.thread.cwd === example.cwd) history = supported('thread/read 已返回匹配的会话标识');
      } catch (error) {
        history = !example && /thread .*not found|thread not found|no rollout found|no recorded rollout/i.test(String(error))
          ? supported('thread/read 已处理空目录中的只读查询') : unavailable(String(error));
      }
    }
    return { discover, history };
  }
  async listModels(workspace?:Workspace):Promise<ModelIdentity[]>{return this.cachedModels(workspace?.path||'',()=>this.readModelCatalog(workspace));}
  async readModelCatalog(workspace?:Workspace):Promise<ModelIdentity[]>{
    const rpc=await this.connection(workspace?.path||'');
    const effective=await rpc.request<Native>('config/read',{includeLayers:false,...(workspace?{cwd:workspace.path}:{})});
    if(!effective.config||typeof effective.config!=='object')throw new Error('Codex effective model provider unavailable');
    const provider=effective.config.model_provider??'openai';
    if(typeof provider!=='string'||!provider)throw new Error('Codex provider identity unavailable');
    const models:Array<ModelIdentity|undefined>=[];let cursor:string|undefined;const seen=new Set<string>();
    for(let page=0;page<20;page++){
      const response=await rpc.request<Native>('model/list',{limit:100,includeHidden:false,modelProvider:provider,...(cursor?{cursor}:{})});
      if(!Array.isArray(response.data))throw new Error('Codex model/list did not return data[]');
      for(const item of response.data)if(!item.hidden)models.push(catalogModel(provider,item.model,item.displayName,'codex:model/list',item));
      if(!response.nextCursor)return uniqueModels(models);
      if(typeof response.nextCursor!=='string'||seen.has(response.nextCursor))throw new Error('Codex model cursor did not advance');
      cursor=response.nextCursor;seen.add(cursor);
    }
    throw new Error('Codex model catalog exceeds pagination limit');
  }
   rpc?: WebSocketRpc; connecting?:Promise<WebSocketRpc>; byNative = new Map<string,string>(); loaded=new Set<string>(); submitting=new Set<string>(); starting=new Map<string,Map<string,Completion>>(); approvals=new Map<string|number,PendingApproval>(); closed=false; reconnecting=false;
  async connection(cwd:string){
    if(this.connecting)return this.connecting;
    this.connecting=this.connect(cwd);
    try{return await this.connecting;}finally{this.connecting=undefined;}
  }
  createRpc(cwd:string){if(!this.config.endpoint)throw new Error('Shared Codex app-server endpoint is not configured; no private process will be started');if(!this.config.runtimeIdentity)throw new Error('Codex shared app-server incarnation identity is not registered; endpoint alone cannot identify a restarted runtime');return new WebSocketRpc(this.config.endpoint);}
  async checkVersion() {
    if (this.config.registeredVersion && this.config.runtimeIdentity) {
      checkRuntimePolicy(this.config, this.config.registeredVersion);
      if (!this.observedVersion) await super.probe();
    }
    else await super.checkVersion();
  }
   async connect(cwd:string){
     if(this.rpc){checkRuntimePolicy(this.config,this.config.registeredVersion || this.observedVersion);if(this.connectionIdentity!==this.config.runtimeIdentity||this.connectionEndpoint!==this.config.endpoint)throw new Error('Codex shared app-server registration changed; reconnect explicitly');return this.rpc;}
    if(this.config.enabled===false)throw new Error('Codex runtime disabled');
    await this.checkVersion();
     const nativeIdentity=this.config.runtimeIdentity;const endpoint=this.config.endpoint;const rpc=this.createRpc(cwd);this.rpc=rpc;
    rpc.on('notification',(m:RpcMessage)=>{if(this.rpc===rpc)this.notification(m);});
    rpc.on('request',(m:RpcMessage)=>{if(this.rpc===rpc)this.request(m);});
     const invalidate=(e:Error)=>{if(this.rpc!==rpc)return;this.rpc=undefined;this.loaded.clear();this.clearApprovals();this.context.disconnect?.([...this.byNative.values()],e.message);rpc.close();for(const id of this.byNative.values())this.fault(id,e);if(!this.closed&&this.byNative.size)void this.reconnect();};
    rpc.on('fault',invalidate);
    try{await initializeCodex(rpc, this.env.CODEX_HOME);
     this.methods = undefined;
     if (this.observedVersion && (!this.config.registeredVersion || matchesPinnedVersion(this.observedVersion, this.config.registeredVersion))) {
       this.methods = await readCodexMethods(this.config.command, this.env).catch(() => undefined);
     }
     if(this.rpc!==rpc||nativeIdentity!==this.config.runtimeIdentity||endpoint!==this.config.endpoint)throw new Error('Codex connection lost or registration changed during initialization');this.connectionIdentity=nativeIdentity;this.connectionEndpoint=endpoint;this.epoch=this.context.openConnection(undefined,nativeIdentity);return rpc;}catch(e){invalidate(e instanceof Error?e:new Error(String(e)));throw e;}
  }
  async reconnect(){if(this.reconnecting)return;this.reconnecting=true;try{let delay=250;while(!this.closed){await new Promise<void>(resolve=>{const timer=setTimeout(resolve,delay);timer.unref();});if(this.closed)return;try{for(const id of this.byNative.values())await this.resumeSession(this.context.getSession(id));return;}catch(e){for(const id of this.byNative.values())this.fault(id,e);delay=Math.min(delay*2,10000);}}}finally{this.reconnecting=false;}}
  async createSession(id:string,w:Workspace,model?:ModelIdentity){
    const rpc=await this.connection(w.path);
    const r=await rpc.request<Native>('thread/start',{cwd:w.path,approvalPolicy:'on-request',sandbox:'workspace-write',...(model?{model:model.modelId,modelProvider:model.providerId}:{})});
    if(this.rpc!==rpc)throw new Error('Codex connection lost during session creation');
    this.byNative.set(r.thread.id,id);this.loaded.add(id);
    return{nativeSessionId:r.thread.id as string,binding:this.binding(r.thread.id,this.control,this.config.runtimeIdentity),model:typeof r.modelProvider==='string'&&r.modelProvider&&typeof r.model==='string'&&r.model?{providerId:r.modelProvider,modelId:r.model,label:r.model}:undefined};
  }
   async resumeSession(s:Session,nativeIdentity?:string){
     if(s.binding?.nativeIdentity&&s.binding.nativeIdentity!==this.config.runtimeIdentity)throw new Error('Codex session belongs to a different registered app-server identity');
     const rpc=await this.connection(s.cwd);if(!nativeIdentity)this.byNative.set(s.ref.nativeSessionId,s.id);
     // A newly started thread has no rollout until its first turn. Read the
     // already loaded thread in memory instead of trying to resume its file.
     if(!nativeIdentity&&this.loaded.has(s.id)&&this.submitting.has(s.id)){
       const current=await rpc.request<Native>('thread/read',{threadId:s.ref.nativeSessionId,includeTurns:false});
       if(this.rpc!==rpc||current.thread?.id!==s.ref.nativeSessionId||current.thread.cwd!==s.cwd)throw new Error('Codex loaded thread identity or authorized cwd changed before submission');
       if(current.thread.status?.type!=='idle')throw new Error('Previous Codex turn is not confirmed idle');
       return;
     }
     if(!nativeIdentity&&this.loaded.has(s.id)&&!this.submitting.has(s.id)&&!ACTIVE.includes(s.state)&&!this.pendingControls(s.id).some(p=>p.command.action==='submit'))return;
     const r=await rpc.request<Native>('thread/resume',{threadId:s.ref.nativeSessionId});if(this.rpc!==rpc||r.thread?.id!==s.ref.nativeSessionId)throw new Error('Codex connection lost or native identity changed during resume');
     if(typeof r.thread.cwd==='string'&&r.thread.cwd!==s.cwd)throw new Error('Codex native thread cwd does not match the authorized session');
     if(nativeIdentity&&(this.connectionIdentity!==nativeIdentity||this.config.runtimeIdentity!==nativeIdentity||this.connectionEndpoint!==this.config.endpoint||r.thread.cwd!==s.cwd||!['idle','active'].includes(r.thread.status?.type)||(this.byNative.has(s.ref.nativeSessionId)&&this.byNative.get(s.ref.nativeSessionId)!==s.id)))throw new Error('Codex authorized thread identity, cwd or status changed during attachment');
     this.byNative.set(s.ref.nativeSessionId,s.id);this.loaded.add(s.id);this.attachSession(s,this.control,this.config.runtimeIdentity);
    if(typeof r.modelProvider==='string'&&r.modelProvider&&typeof r.model==='string'&&r.model)this.context.emit(s.id,'model.confirmed',{model:{providerId:r.modelProvider,modelId:r.model,label:r.model}});
      for(const turn of r.thread.turns || [])for(const item of turn.items || []){if(item.type==='userMessage'&&typeof turn.id==='string'&&turn.id&&typeof item.id==='string')this.acceptSubmission(s.id,item.id,turn.id);this.mapItem(s.id,item,turn.id,true,true);}
    if(!this.submitting.has(s.id)&&this.pendingControls(s.id).some(p=>p.command.action==='submit')){this.context.emit(s.id,'run.updated',{state:'uncertain',detail:'Native history has not confirmed the pending input identity'});return;}
    const turns=r.thread.turns || [];const last=turns.at(-1);
    if(this.submitting.has(s.id)){if(r.thread.status?.type!=='idle')throw new Error('Previous Codex turn is not confirmed idle');return;}
    if(this.context.getSession(s.id).state==='accepted')return;
    const current=this.context.getSession(s.id);const target=turns.find((turn:Native)=>turn.id===current.nativeRunId)||(!current.nativeRunId?last:undefined);
    if(target&&['completed','interrupted','failed'].includes(target.status))this.context.emit(s.id,'run.updated',{...this.completion(target),nativeRunId:target.id});
    else if(r.thread.status?.type==='idle'&&!last&&!current.runId)this.context.emit(s.id,'run.updated',{state:'idle'});
    if(r.thread.status?.type==='active'&&last?.status==='inProgress')this.context.emit(s.id,'run.updated',{state:'running',nativeRunId:last.id,nativeAccepted:true});
   }
   messageId(id:string,itemId:string,turnId?:string){
    const session=this.context.getSession(id);const source=session.externalSource;
    if(source&&turnId){const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const candidate=digest([session.ref.hostId,'codex',source.namespace,source.nativeId]);
      const imported=digest([candidate,`${turnId}:${itemId}`]);
      if(session.messages.some(message=>message.id===imported))return imported;
    }
    return itemId;
  }
  async readExistingSession(s:Session,nativeIdentity:string):Promise<CodexThreadSnapshot>{
     if(s.ref.engineId!=='codex'||s.ref.runtimeInstanceId!==this.context.runtimeInstanceId||!s.ref.nativeSessionId||!s.cwd||!nativeIdentity||nativeIdentity!==this.config.runtimeIdentity)throw new Error('Codex authorized session or registered app-server identity mismatch');
     if(s.binding?.nativeIdentity&&s.binding.nativeIdentity!==nativeIdentity)throw new Error('Codex session belongs to a different app-server identity');
     const owner=this.byNative.get(s.ref.nativeSessionId);if(owner&&owner!==s.id)throw new Error('Codex native thread is already managed by another session');
     const endpoint=this.config.endpoint;const rpc=await this.connection(s.cwd);
     const first = await readCodexHistoryPage(rpc, s.ref.nativeSessionId, s.cwd);
     const read = first.snapshot;
     const seen = new Set<string>();
     let cursor = first.cursor;
     while (cursor) {
       if (seen.has(cursor) || seen.size >= 40 || read.thread.turns.length >= 2000) throw new Error('Codex native history exceeds pagination budget');
       seen.add(cursor);
       const page = await readCodexHistoryPage(rpc, s.ref.nativeSessionId, s.cwd, cursor);
       if (read.thread.turns.length + page.snapshot.thread.turns.length > 2000) throw new Error('Codex native history exceeds pagination budget');
       read.thread.turns.push(...page.snapshot.thread.turns);
       cursor = page.cursor;
     }
     if(this.rpc!==rpc||this.config.runtimeIdentity!==nativeIdentity||this.connectionIdentity!==nativeIdentity||this.config.endpoint!==endpoint||this.connectionEndpoint!==endpoint)throw new Error('Codex registered app-server connection changed during verification');
     if(read.thread?.id!==s.ref.nativeSessionId||read.thread.cwd!==s.cwd)throw new Error('Codex native thread cwd or identity does not match the authorized session');
     if(!['idle','active','notLoaded'].includes(read.thread.status?.type))throw new Error('Codex saved thread is not available for verified resume');
     if(!Array.isArray(read.thread.turns)||read.thread.turns.some(turn=>typeof turn.id!=='string'||!turn.id||!Array.isArray(turn.items)))throw new Error('Codex native thread history is incomplete');
     return read;
   }
   async attachExistingSession(s:Session,nativeIdentity:string){
     await this.readExistingSession(s,nativeIdentity);
     await this.resumeSession(s,nativeIdentity);
     return this.binding(s.ref.nativeSessionId,this.control,nativeIdentity);
   }
   clearApprovals(){
     for(const pending of this.approvals.values())if(pending.interactionId)this.context.emit(pending.sessionId,'interaction.closed',{id:pending.interactionId,status:'stale'});
     this.approvals.clear();
   }
  async submit(s:Session,input:Submission){
    this.submitting.add(s.id);try{await this.resumeSession(s);}finally{this.submitting.delete(s.id);}const model=s.nextModel;
    const content:Native[]=[{type:'text',text:input.text,text_elements:[]}];
    for(const a of input.attachments)if(a.mime.startsWith('image/'))content.push({type:'image',url:`data:${a.mime};base64,${a.dataBase64}`});else content[0].text+='\n附件（项目内路径）：'+a.relativePath;
    const rpc=this.rpc!;const completed=new Map<string,Completion>();this.starting.set(s.id,completed);
    try{const r=await rpc.request<Native>('turn/start',{threadId:s.ref.nativeSessionId,input:content,clientUserMessageId:input.nativeRequestId||input.requestId,...(model?{model:model.modelId}:{})},120_000);
    if(this.rpc!==rpc)throw new Error('Codex connection lost during turn start');
    if(typeof r.turn?.id!=='string'||!r.turn.id)throw new Error('Codex turn/start did not confirm a native turn ID');
    if(typeof r.modelProvider==='string'&&r.modelProvider&&typeof r.model==='string'&&r.model)this.context.emit(s.id,'model.confirmed',{model:{providerId:r.modelProvider,modelId:r.model,label:r.model}});
    const state=this.context.getSession(s.id).state;
    if(completed.has(r.turn.id))for(const i of this.context.getSession(s.id).interactions)if(i.status==='responding'||i.status==='pending')this.context.emit(s.id,'interaction.closed',{id:i.id,status:i.status==='responding'?'resolved':'stale'});
    this.context.emit(s.id,'run.updated',{...completed.get(r.turn.id),state:completed.get(r.turn.id)?.state||(state==='accepted'?'running':state),runId:input.runId||r.turn.id,nativeRunId:r.turn.id,nativeRequestId:input.nativeRequestId||input.requestId,nativeAccepted:true});
    }finally{this.starting.delete(s.id);}
  }
  async requestCancel(s:Session){const turnId=s.nativeRunId;if(!turnId)throw new Error('Native turn ID is not known');const operation=this.cancelOperation(s);const rpc=await this.connection(s.cwd);await rpc.request('turn/interrupt',{threadId:s.ref.nativeSessionId,turnId});if(operation)this.context.reconcileReceipt?.(operation.deviceId,operation.clientRequestId,{status:'native_accepted',nativeRunId:turnId,detail:'Native turn/interrupt acknowledgement received; termination is separate'});}
  async configure(s:Session,model:ModelIdentity){
    if(s.model && s.model.providerId!==model.providerId)throw new Error('Codex provider is fixed by this native thread; create a new session');
    await this.resumeSession(s);
    const rpc=await this.connection(s.cwd);
    const before=await rpc.request<Native>('thread/read',{threadId:s.ref.nativeSessionId,includeTurns:false});
    if(this.rpc!==rpc||before.thread?.id!==s.ref.nativeSessionId||before.thread.cwd!==s.cwd||before.thread.status?.type!=='idle')throw new Error('Codex thread identity, cwd or idle state changed before model selection');
    if(before.thread.modelProvider!==model.providerId)throw new Error('Codex native thread provider changed; select a model for the confirmed provider');
    await rpc.request('thread/settings/update',{threadId:s.ref.nativeSessionId,model:model.modelId});
    const after=await rpc.request<Native>('thread/read',{threadId:s.ref.nativeSessionId,includeTurns:false});
    if(this.rpc!==rpc||after.thread?.id!==s.ref.nativeSessionId||after.thread.cwd!==s.cwd||after.thread.modelProvider!==model.providerId||after.thread.model!==model.modelId)throw new Error('Codex model setting was not confirmed by the native thread; reconcile before retrying');
    this.context.emit(s.id,'model.confirmed',{model:{providerId:after.thread.modelProvider,modelId:after.thread.model,label:model.label}});
  }
  completion(turn:Native):Completion{return{state:turn.status==='interrupted'?'cancelled':turn.status==='failed'?'failed':turn.status==='completed'?'completed':'uncertain',reason:turn.status,...(turn.error?{error:turn.error}:{})};}
  mapItem(id:string,item:Native,turnId:string,complete:boolean,historical=false){
    const emit=(type:Parameters<typeof this.context.emit>[1],data:Native)=>this.context.emit(id,type,{...data,nativeRunId:turnId,historical});
    if(item.type==='agentMessage'){if(complete)emit('message.completed',{id:this.messageId(id,item.id,turnId),text:item.text,role:'assistant'});return;}
    if(['commandExecution','fileChange','mcpToolCall','webSearch'].includes(item.type)){
      const status=item.status==='completed'?'completed':['failed','declined'].includes(item.status)?'failed':item.status==='inProgress'?'running':'uncertain';
      emit('tool.updated',{id:item.id,title:item.command||item.tool||item.type,status,output:item.aggregatedOutput,exitCode:item.exitCode,error:item.error,changes:item.changes,detail:JSON.stringify(item,null,2)});return;
    }
    if(item.type==='collabAgentToolCall'){for(const [child,v]of Object.entries(item.agentsStates||{}))emit('agent.updated',{id:child,title:item.tool,state:(v as Native).status,detail:(v as Native).message||''});return;}
    if(item.type==='userMessage')return;
    let remaining=8192;
    const bounded=(value:unknown,depth=0):unknown=>{
      if(remaining<=0||depth>6)return '[truncated]';
      if(typeof value==='string'){const text=value.slice(0,Math.min(remaining,2048)).replace(/Bearer\s+\S+|(?:sk-|ghp_)[A-Za-z0-9_-]+/gi,'[redacted]');remaining-=text.length;return text;}
      if(Array.isArray(value))return value.slice(0,32).map(v=>bounded(v,depth+1));
      if(value&&typeof value==='object'){const out:Native={};for(const [key,v]of Object.entries(value).slice(0,32)){if(remaining<160)break;remaining-=key.slice(0,128).length+32;out[key.slice(0,128)]=/token|secret|password|authorization|credential|api.?key/i.test(key)?'[redacted]':bounded(v,depth+1);}return out;}
      remaining-=16;return value;
    };
    emit('tool.updated',{id:item.id,title:'Unknown Codex item',status:'uncertain',nativeType:bounded(item.type),nativeItem:bounded(item),detail:'Unsupported native item; outcome is not inferred'});
  }
  request(m:RpcMessage){
    const p=m.params as Native;const id=this.byNative.get(p?.threadId);if(!id||m.id===undefined){if(m.id!==undefined)this.rpc!.reject(m.id,'Session not managed by this console');return;}
    const session=this.context.getSession(id);
    if(p.turnId&&session.nativeRunId&&(p.turnId!==session.nativeRunId||['completed','failed','cancelled'].includes(session.state))&&!this.starting.has(id)){
      this.rpc!.reject(m.id,'Native approval belongs to a different or ended turn');return;
    }
     if(!m.method||this.approvals.has(m.id))return;
     const pending:PendingApproval={method:m.method,params:p,sessionId:id,rpc:this.rpc};this.approvals.set(m.id,pending);
     const interact=(fields:Partial<Interaction>)=>{const i=this.interaction(id,m.id!,pending.method,fields);pending.interactionId=i.id;return i;};
    if(m.method==='item/permissions/requestApproval'){
       interact({title:p.reason||'Additional permissions',detail:JSON.stringify(p),choices:[{id:'turn',label:'Allow this turn',scope:'turn',allows:true},{id:'session',label:'Allow this session',scope:'session',allows:true},{id:'deny',label:'Deny',scope:'turn',allows:false}]});
    }else if(m.method==='item/commandExecution/requestApproval'||m.method==='item/fileChange/requestApproval'){
       interact({title:p.command || p.reason || '文件修改审批',detail:JSON.stringify(p,null,2),writeRoots:[p.grantRoot,p.cwd].filter(v=>typeof v==='string'),choices:[{id:'accept',label:'仅这一次',scope:'native:once',allows:true},{id:'acceptForSession',label:m.method.includes('fileChange')?'允许这些文件后续修改':'当前会话允许',scope:'native:session',allows:true},{id:'decline',label:'拒绝',scope:'native:once',allows:false},{id:'cancel',label:'拒绝并停止轮次',scope:'native:turn',allows:false}]});
    } else if(m.method==='item/tool/requestUserInput'){
       const i=interact({kind:'question',title:'需要你的回答',detail:JSON.stringify(p),nativeRequest:p,questions:p.questions.map((q:Native)=>({id:q.id,title:q.question,options:(q.options||[]).map((o:Native)=>o.label),multiple:false,freeText:!q.options?.length||q.isOther===true,isSecret:q.isSecret===true}))});if(p.isBlocking===false)this.context.emit(id,'run.updated',{state:'running',nonBlockingInteractionId:i.id});
    }else{this.approvals.delete(m.id);this.rpc!.reject(m.id,`Native request not implemented: ${m.method}`);}
  }
  async respond(s:Session,i:Interaction,d:Decision){
     const pending=this.approvals.get(i.nativeId);if(!this.rpc||!pending||pending.sessionId!==s.id||pending.rpc!==this.rpc||pending.interactionId!==i.id||pending.method!==i.nativeMethod)throw new Error('Native request is no longer pending');
    if(i.nativeMethod==='item/permissions/requestApproval'){if(!['turn','session','deny'].includes(d.choiceId||''))throw new Error('Invalid permission scope');const permissions:Native={};if(d.choiceId!=='deny')for(const key of ['network','fileSystem'])if(pending.params.permissions?.[key]!=null)permissions[key]=pending.params.permissions[key];this.rpc!.respond(i.nativeId,{permissions,scope:d.choiceId==='session'?'session':'turn'});}
    else if(i.nativeMethod==='item/tool/requestUserInput'){const answers:Native={};for(const q of pending.params.questions){const v=d.answers?.[q.id];if(!v)throw new Error('Missing native question answer');answers[q.id]={answers:v};}this.rpc!.respond(i.nativeId,{answers});}
    else {if(!['accept','acceptForSession','decline','cancel'].includes(d.choiceId||''))throw new Error('Invalid approval decision');this.rpc!.respond(i.nativeId,{decision:d.choiceId});}
    this.approvals.delete(i.nativeId);this.context.emit(s.id,'interaction.closed',{id:i.id});
  }
  notification(m:RpcMessage){
    const p=m.params as Native;
    if(m.method==='serverRequest/resolved'){const pending=this.approvals.get(p?.requestId);if(pending&&pending.rpc===this.rpc&&(!p.threadId||this.byNative.get(p.threadId)===pending.sessionId)){this.approvals.delete(p.requestId);if(pending.interactionId)this.context.emit(pending.sessionId,'interaction.closed',{id:pending.interactionId});}return;}
    const id=this.byNative.get(p?.threadId);if(!id)return;
    const emit=(type:any,data:Native)=>this.context.emit(id,type,data);
    if(m.method==='thread/settings/updated'){
      const settings=p.threadSettings;const s=this.context.getSession(id);
      if(settings?.cwd===s.cwd&&typeof settings.model==='string'&&settings.model&&typeof settings.modelProvider==='string'&&settings.modelProvider&&(!s.model||s.model.providerId===settings.modelProvider))emit('model.confirmed',{model:{providerId:settings.modelProvider,modelId:settings.model,label:settings.model}});
      return;
    }
    if(m.method==='item/agentMessage/delta')emit('message.delta',{id:this.messageId(id,p.itemId,p.turnId),text:p.delta,role:'assistant',nativeRunId:p.turnId});
    if(m.method==='item/commandExecution/outputDelta')emit('tool.updated',{id:p.itemId,status:'running',outputDelta:p.delta,nativeRunId:p.turnId});
    if(m.method==='thread/status/changed'&&p.status?.type==='active'&&!this.starting.has(id))emit('run.updated',{state:'running',nativeStatus:p.status});
    if(m.method==='item/started'||m.method==='item/completed'){
      this.mapItem(id,p.item,p.turnId,m.method==='item/completed');
    }
     if(m.method==='turn/started'&&!this.submitting.has(id)&&!this.pendingControls(id).some(p=>p.command.action==='submit'))emit('run.updated',{state:'running',nativeRunId:p.turn.id,nativeAccepted:true});
    if(m.method==='turn/completed'){
      const starting=this.starting.get(id);if(starting){starting.set(p.turn.id,this.completion(p.turn));return;}
      const current=this.context.getSession(id);const nativeRunId=current.nativeRunId||current.runId;if(this.submitting.has(id)||(current.state==='accepted'&&nativeRunId!==p.turn.id)||(nativeRunId&&current.state!=='accepted'&&nativeRunId!==p.turn.id))return;
      for(const i of this.context.getSession(id).interactions)if(i.status==='responding'||i.status==='pending')emit('interaction.closed',{id:i.id,status:i.status==='responding'?'resolved':'stale'});
      emit('run.updated',{...this.completion(p.turn),nativeRunId:p.turn.id});
    }
    if(m.method==='error')emit('error',{message:p.error?.message||JSON.stringify(p)});
  }
  async probe() {
    const result = await super.probe();
    if (this.config.registeredVersion && this.config.runtimeIdentity) result.version = this.config.registeredVersion;
    else if (!result.installed) return result;
    try {
      checkRuntimePolicy(this.config, result.version);
      const rpc = await this.connection('');
      result.installed = true;
      const access = await this.historyAccess(rpc);
      const nativeSessionApi = this.methods || access.discover.state === 'supported' || access.history.state === 'supported';
      const control = nativeSessionApi ? this.control : { create:false, submit:false, observe:false, approve:false, answer:false, cancel:false, resume:false, attach:false, configure:false };
      result.controlCapabilities = control;
      result.generation = this.epoch;
      result.connectionState = 'attached';
      result.nativeIdentity = this.config.runtimeIdentity;
      result.detail = '共享 app-server 已完成原生握手。';
      result.capabilities = { text:control.submit, image:false, files:false, history:false, permission:control.approve, questions:control.answer, cancelScope:control.cancel ? 'thread + turn' : 'unavailable', models:false };
      result.capabilities.history = access.history.state === 'supported';
      if (access.discover.state !== 'supported') result.detail += ' 会话列表不可用：' + access.discover.reason;
      if (!result.capabilities.history) result.detail += ' 历史读取不可用：' + access.history.reason;
      try { result.models = await this.listModels(); result.capabilities.models = true; }
      catch (error) { result.detail += ' 模型目录不可用：' + String(error); }
    } catch (error) { result.detail = (error as Error).message; }
    return result;
  }
  async releaseSession(s: Session) {
    const native = s.ref.nativeSessionId;
    if (this.byNative.get(native) !== s.id) return;
    const rpc = await this.connection(s.cwd);
    const info = (await rpc.request<Native>('thread/read',{threadId:native,includeTurns:false})).thread;
    if (info?.id !== native || info.cwd !== s.cwd || !['idle','notLoaded'].includes(info.status?.type)) throw new Error('Codex 会话仍在运行或目录已改变');
    await rpc.request('thread/unsubscribe',{threadId:native});
    this.loaded.delete(s.id); this.byNative.delete(native);
    this.context.disconnect?.([s.id],'已归档，恢复后可重新连接');
  }
  async prepareDelete(s: Session) {
    const native = s.ref.nativeSessionId, identity = this.config.runtimeIdentity;
    if (!identity || s.binding?.nativeIdentity && s.binding.nativeIdentity !== identity) throw new Error('Codex 注册实例已改变');
    const rpc = await this.connection(s.cwd);
    const read = () => rpc.request<Native>('thread/read',{threadId:native,includeTurns:false});
    const absent = (e: unknown) => /thread not found|no rollout found|thread .* not found/i.test(String(e));
    try {
      const info = (await read()).thread;
      if (info?.id !== native || info.cwd !== s.cwd || !['idle','notLoaded'].includes(info.status?.type)) throw new Error('Codex 尚未确认原会话空闲');
    } catch (e) { if (s.deletionPending && absent(e)) return async () => {}; throw e; }
    return async () => {
      if (this.rpc !== rpc || this.connectionIdentity !== identity) throw new Error('Codex 连接已改变');
      await rpc.request('thread/delete',{threadId:native});
      this.loaded.delete(s.id); this.byNative.delete(native);
    };
  }
    close(){this.closed=true;const rpc=this.rpc;this.rpc=undefined;this.loaded.clear();this.clearApprovals();rpc?.close();}
}

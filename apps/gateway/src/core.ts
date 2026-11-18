import { captureRejectionSymbol, EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { AdapterContext, AgentAdapter, Attachment, Command, Decision, EngineId, ModelIdentity, Receipt, Session, Workspace, RuntimeBinding, RunRecord } from '../../../packages/protocol/src/types.ts';
import { ACTIVE, ENGINES, NO_CONTROL, TERMINAL } from '../../../packages/protocol/src/types.ts';
import { exactRef, object, requireValue, validateCommand, validateFormAnswer } from '../../../packages/protocol/src/validation.ts';
import { editCatalog, type LibraryChange } from './session-library.ts';
import { Store, digest } from './store.ts';
import { canonical, inside, overlaps, readProject, MAX_FILE } from './files.ts';
import { NativeProjects, type ProjectPolicy } from './native-projects.ts';
import { WorkspaceCreator } from './workspace-create.ts';
import { ExternalSessions } from './external.ts';
import type { AutomationSettings } from './automation.ts';
import type { WorkspaceDiscovery } from './workspace-discovery.ts';
import type { ExternalSync } from './external-sync.ts';
import { WorkspaceIdentities } from './workspace-identity.ts';
import type { RuntimeUpdateMonitor } from './runtime-updates.ts';
export class Core extends EventEmitter {
  store:Store;hostId:string;allowedRoots:string[];adapters=new Map<EngineId,AgentAdapter>();
  private inFlight=new Set<Promise<void>>();
  private queues=new Map<string,Promise<void>>();
  workspaceCreator=new WorkspaceCreator(this);
  external=new ExternalSessions(this);
  workspaceIdentities=new WorkspaceIdentities(this);
  automation?:{settings:AutomationSettings;discovery:WorkspaceDiscovery;externalSync:ExternalSync};
  runtimeUpdates?:RuntimeUpdateMonitor;
  lastListenerFailure?:{code:'listener_failed';at:number};
  readonly projects: NativeProjects;
  constructor(store:Store,hostId:string,allowedRoots:string[],policy?:ProjectPolicy){super({captureRejections:true});this.store=store;this.hostId=hostId;this.allowedRoots=allowedRoots;this.projects=new NativeProjects(this,policy);}
  [captureRejectionSymbol](){this.lastListenerFailure={code:'listener_failed',at:Date.now()};}
  emitAutomation(type:string,value:unknown,onFailure:()=>void){
    const failed=()=>{try{onFailure();}catch{}};
    for(const listener of this.rawListeners(type)){
      try{void Promise.resolve(listener.call(this,value)).catch(failed);}catch{failed();}
    }
  }
  session(id:string){const s=this.store.get<Session>('session',id);requireValue(s,'session_missing','Session not found',404);return s;}
  visibleWorkspaces(): Workspace[] {
    return this.store.list<Workspace>('workspace').flatMap(w => { try { return [this.workspace(w.id)]; } catch { return []; } });
  }
  workspace(id:string,engine?:EngineId){const w=this.store.get<Workspace>('workspace',id);requireValue(w,'workspace_missing','Project not found',404);const engines=this.projects.engines(w.path);
    requireValue(!engines || (engine ? engines.includes(engine) : engines.length>0),'root_not_granted','Project is outside current host-configured workspace roots',403);
    for (const root of [w.path,...w.writeRoots]) requireValue(this.projects.permits(w,root),'root_not_granted','Project is outside current host-configured workspace roots',403);
    this.workspaceIdentities.verify(id);
    return engines ? {...w,engines} : w;
  }
  context(engineId:EngineId):AdapterContext{
    let runtime=this.store.get<{id:string;epoch:number}>('runtime',engineId);if(!runtime){runtime={id:randomUUID(),epoch:0};this.store.put('runtime',engineId,runtime);}
    return{runtimeInstanceId:runtime.id,epoch:runtime.epoch,generation:runtime.epoch,
       getSession:id=>this.session(id),
       getRun:id=>this.store.get<RunRecord>('run',id),
       pendingCommands:id=>this.store.pendingCommands(id),
       bindSession:(id,binding)=>this.bindSession(id,binding),
       disconnect:(ids,reason)=>{for(const s of this.store.list<Session>('session').filter(s=>s.ref.engineId===engineId&&s.binding?.state!=='unbound'&&(!ids||ids.includes(s.id)))){if(s.binding)s.binding={...s.binding,state:'disconnected',reason};this.store.put('session',s.id,s);}this.emit('catalog.changed');},
       reconcileReceipt:(device,id,evidence)=>{const receipt=this.store.getReceipt(device,id);requireValue(receipt&&this.store.intent(device,id),'receipt_missing','Unknown delivery intent',404);this.setReceipt(device,{...receipt,...evidence});},
       openConnection:(ids?:string[],nativeIdentity?:string)=>{
         const r=this.store.get<{id:string;epoch:number;nativeIdentity?:string}>('runtime',engineId)!;
         const changed=!nativeIdentity||nativeIdentity!==r.nativeIdentity;
         if(changed)r.epoch++;if(nativeIdentity)r.nativeIdentity=nativeIdentity;this.store.put('runtime',engineId,r);
         for(const s of this.store.list<Session>('session').filter(s=>s.ref.engineId===engineId&&s.binding?.state!=='unbound'&&(!ids||ids.includes(s.id)))){s.epoch=r.epoch;if(s.binding)s.binding={...s.binding,generation:r.epoch,state:'disconnected',nativeIdentity,reason:'Native control handle requires attachment'};if(changed)s.interactions=s.interactions.map(i=>i.status==='resolved'?i:{...i,status:'stale'});this.store.put('session',s.id,s);}
        return r.epoch;
      },
      emit:(id,type,data)=>{
        const before=this.session(id);
        const childTerminal=['completed','failed','cancelled','errored','shutdown'];
        if(type==='run.updated'&&['completed','failed','cancelled'].includes(data.state as string)&&before.agents.some(a=>!childTerminal.includes(a.state))){
          data={...data,parentEndState:data.state,state:'uncertain',nativeAccepted:true,detail:'Parent turn ended; observed child tasks still need native termination confirmation'};
        }
        const e=this.store.event(id,type,data);this.emit('event',e);
        const active=this.store.get<{device:string;requestId:string}>('active-command',id);
         if(active&&type==='run.updated'&&!e.data.ignored&&(data.nativeAccepted===true||TERMINAL.includes(data.state as Session['state']))){
           const receipt=this.store.getReceipt(active.device,active.requestId);if(receipt&&['received','uncertain'].includes(receipt.status))this.setReceipt(active.device,{...receipt,status:'native_accepted',runId:e.runId,nativeRunId:this.session(id).nativeRunId});
        }
        const after=this.session(id);
        if(type==='agent.updated'&&after.state==='uncertain'&&after.parentEndState&&after.agents.every(a=>childTerminal.includes(a.state))){
          const settled=this.store.event(id,'run.updated',{state:after.parentEndState});this.emit('event',settled);
        }
      }};
  }
  bindSession(id:string,binding:RuntimeBinding){
    const s=this.session(id);const runtime=this.store.get<{id:string;epoch:number}>('runtime',s.ref.engineId);
    const adopting=s.externalSource&&s.binding?.state==='unbound'&&runtime?.id===binding.runtimeInstanceId;
    requireValue((binding.runtimeInstanceId===s.ref.runtimeInstanceId||adopting)&&binding.nativeSessionId===s.ref.nativeSessionId&&Number.isSafeInteger(binding.generation)&&binding.generation>=s.epoch,'binding_mismatch','Binding does not match registered session identity',409);
    this.workspace(s.ref.workspaceId,s.ref.engineId);if(adopting)s.ref={...s.ref,runtimeInstanceId:binding.runtimeInstanceId};
    if(binding.generation!==(s.binding?.generation??s.epoch))s.interactions=s.interactions.map(i=>i.status==='resolved'?i:{...i,status:'stale'});
    s.binding=binding;s.epoch=binding.generation;this.store.put('session',id,s);
    if(adopting)this.emit('session.bound',s);
    this.emit('catalog.changed');
  }
  setReceipt(device:string,receipt:Receipt){this.store.receipt(device,receipt);this.emit('receipt',{device,receipt:this.store.getReceipt(device,receipt.clientRequestId)??receipt});}
  async reconcile(id:string){
    const previous=(this.queues.get(id)??Promise.resolve()).catch(()=>{});
    const work=previous.then(async()=>{
      const s=this.session(id);this.workspace(s.ref.workspaceId,s.ref.engineId);
      requireValue(!s.archived && !s.deletionPending,'session_archived','请先恢复归档会话',409);
      requireValue(s.binding&&s.binding.state!=='unbound','binding_unavailable','Read-only history has no runtime binding',409);
      const a=this.adapters.get(s.ref.engineId);requireValue(a,'runtime_missing','Runtime adapter unavailable',409);
      try {
        if(s.externalSource){
          requireValue(a.attachExistingSession&&s.binding.nativeIdentity,'attachment_unavailable','Existing native ownership must be verified again',409);
          const binding=await a.attachExistingSession(s,s.binding.nativeIdentity);this.bindSession(id,binding);
        }else await a.resumeSession(s);
      }catch(error){this.context(s.ref.engineId).disconnect?.([id],'Native ownership reconciliation failed');throw error;}
    });
    this.queues.set(id,work);this.inFlight.add(work);try{await work;}finally{this.inFlight.delete(work);if(this.queues.get(id)===work)this.queues.delete(id);}
  }
  async attachExisting(device:string,id:string,request:Record<string,unknown>):Promise<Session>{
    requireValue(Object.keys(request).every(key=>['protocolVersion','hostId','clientRequestId','runtimeInstanceId','ref'].includes(key)),'request_invalid','Unknown attachment field');
    requireValue(request.protocolVersion===2&&request.hostId===this.hostId,'host_mismatch','Attachment targets another host or protocol',409);
    requireValue(typeof request.clientRequestId==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(request.clientRequestId),'request_invalid','Invalid attachment request ID');
    requireValue(typeof request.runtimeInstanceId==='string'&&request.runtimeInstanceId.length>0,'runtime_missing','Select a registered native runtime');
    const ref=object(request.ref);const initial=this.session(id);this.workspace(initial.ref.workspaceId,initial.ref.engineId);
    const requestId=request.clientRequestId;
    const received=this.store.receive(device,requestId,{kind:'session.attach',sessionId:id,...request});
    if(!received.fresh){
      requireValue(received.receipt.status==='native_accepted','attachment_uncertain',received.receipt.detail??'Attachment has already been received; inspect current state before retrying',409);
      return this.session(id);
    }
    const key=`attach:${request.runtimeInstanceId}:${initial.ref.nativeSessionId}`;
    const previous=Promise.all([this.queues.get(id),this.queues.get(key)].map(p=>p?.catch(()=>{})));
    const work=previous.then(async()=>{
      const s=this.session(id);this.workspace(s.ref.workspaceId,s.ref.engineId);
      requireValue(!s.archived && !s.deletionPending,'session_archived','请先恢复归档会话',409);
      requireValue(exactRef(ref,s.ref),'target_mismatch','Attachment source identity changed',409);
      requireValue(s.externalSource&&s.binding&&s.binding.state!=='attached','binding_exists','Only unbound or disconnected history requires explicit attachment',409);
      const runtime=this.context(s.ref.engineId);
      requireValue(request.runtimeInstanceId===runtime.runtimeInstanceId,'runtime_mismatch','Attachment targets an unregistered runtime',409);
      const adapter=this.adapters.get(s.ref.engineId);
      requireValue(adapter?.attachExistingSession,'attachment_unavailable','This runtime cannot verify ownership of an existing session',409);
      const descriptor=await adapter.probe();
      requireValue(descriptor.controlCapabilities?.attach===true&&descriptor.connectionState==='attached'&&descriptor.nativeIdentity,'attachment_unavailable',descriptor.detail||'Native session attachment has not been verified',409);
      requireValue(!this.store.list<Session>('session').some(other=>other.id!==id&&other.binding?.state!=='unbound'&&other.ref.runtimeInstanceId===runtime.runtimeInstanceId&&other.ref.nativeSessionId===s.ref.nativeSessionId),'native_session_owned','This native session already has a managed projection',409);
      requireValue(exactRef(this.session(id).ref,ref)&&this.session(id).binding?.state!=='attached','target_mismatch','Attachment source changed during verification',409);
      this.workspace(s.ref.workspaceId,s.ref.engineId);
      this.store.dispatching(device,requestId);
      const binding=await adapter.attachExistingSession({...s,ref:{...s.ref,runtimeInstanceId:runtime.runtimeInstanceId}},descriptor.nativeIdentity);
      requireValue(binding.nativeIdentity===descriptor.nativeIdentity&&binding.state==='attached','binding_mismatch','Native attachment was not confirmed by the selected runtime',409);
      this.bindSession(id,binding);
      this.setReceipt(device,{clientRequestId:requestId,status:'native_accepted',generation:binding.generation,detail:'Attached to the verified existing native session; no task was submitted'});
    }).catch(error=>{
      const phase=this.store.intent(device,requestId)?.phase;
      // Attachment verifies ownership and subscribes; it never creates a native
      // session or sends input. Failed verification can safely be retried with
      // a new request after disabling any partially established binding.
      if(phase==='dispatching')this.context(initial.ref.engineId).disconnect?.([id],'Native attachment verification failed');
      this.setReceipt(device,{clientRequestId:requestId,status:'rejected',detail:error instanceof Error?error.message:String(error)});
      throw error;
    });
    this.queues.set(id,work);this.queues.set(key,work);this.inFlight.add(work);
    try{await work;return this.session(id);}finally{this.inFlight.delete(work);for(const queue of [id,key])if(this.queues.get(queue)===work)this.queues.delete(queue);}
  }
  async registerWorkspace(path:string,name:string,writeRoots:string[]=[]){
    const actual=await canonical(path);const roots=await Promise.all([actual,...writeRoots].map(canonical));
    for(const r of roots)requireValue(this.allowedRoots.some(base=>inside(base,r)),'root_not_granted','Project is outside host-configured workspace roots',403);
    // Recheck immediately before insertion, after all asynchronous canonicalization.
    const all=this.store.list<Workspace>('workspace');
    for(const w of all)requireValue(!w.writeRoots.some(a=>roots.some(b=>overlaps(a,b))),'overlapping_project','Managed project roots overlap',409);
    const w:Workspace={id:randomUUID(),hostId:this.hostId,name,path:actual,writeRoots:[...new Set(roots)]};this.store.transaction(()=>{this.projects.index(w);this.store.put('workspace',w.id,w);});this.emit('catalog.changed');return w;
  }
  async ensureWorkspace(path:string,name:string,validate?:()=>Promise<void>,notify=true,automaticRoot?:string){
    const actual=await canonical(path);
    if(validate)await validate();
    requireValue(this.allowedRoots.some(base=>inside(base,actual)),'root_not_granted','Project is outside host-configured workspace roots',403);
    const all=this.store.list<Workspace>('workspace');
    const previous=all.find(w=>w.path===actual);
    if(previous){this.workspace(previous.id);if(automaticRoot)this.workspaceIdentities.verify(previous.id,true);return previous;}
    for(const w of all)requireValue(![w.path,...w.writeRoots].some(root=>overlaps(root,actual)),'overlapping_project','Managed project roots overlap',409);
    const w:Workspace={id:randomUUID(),hostId:this.hostId,name,path:actual,writeRoots:[actual]};
    this.store.transaction(()=>{if(automaticRoot)this.workspaceIdentities.bindNew(w,automaticRoot);this.projects.index(w);this.store.put('workspace',w.id,w);});if(notify)this.emit('catalog.changed');return w;
  }
  async createSession(device:string,requestId:string,wid:string,engineId:EngineId,model?:ModelIdentity,runtimeInstanceId?:string){
    requireValue(ENGINES.includes(engineId),'engine_invalid','Unknown runtime');const w=this.workspace(wid,engineId);const adapter=this.adapters.get(engineId);
    requireValue(adapter,'runtime_missing','Runtime adapter is unavailable');
    if(model)requireValue(typeof model.providerId==='string'&&model.providerId.length>0&&typeof model.modelId==='string'&&model.modelId.length>0&&typeof model.label==='string','model_invalid','Invalid model identity');
    const runtimeContext=this.context(engineId);requireValue(!runtimeInstanceId||runtimeInstanceId===runtimeContext.runtimeInstanceId,'runtime_mismatch','Creation targets another runtime',409);
    const identity={kind:'session.create',wid,engineId,model,runtimeInstanceId:runtimeContext.runtimeInstanceId};const r=this.store.receive(device,requestId,identity);
    const registered=this.store.get<{sessionId:string}>('creation',device+':'+requestId);if(registered)return this.session(registered.sessionId);
    requireValue(r.fresh,'creation_uncertain','Creation has already been received; inspect native state before creating another session',409);
    const id=randomUUID();
    let nativeStarted=false;
    try{
      const descriptor=await adapter.probe();const control=descriptor.controlCapabilities??descriptor.binding?.capabilities;
      requireValue(control?.create===true,'capability_unavailable',descriptor.detail||'Runtime has not verified native creation capability',409);
      if(model)requireValue((adapter.listModels?await adapter.listModels(w):descriptor.models).some(m=>m.providerId===model.providerId&&m.modelId===model.modelId),'model_not_registered','Select an explicitly registered native model');
      this.store.dispatching(device,requestId);
      nativeStarted=true;
      const native=await adapter.createSession(id,w,model);
      const runtime=this.store.get<{id:string;epoch:number}>('runtime',engineId)!;
      const confirmed=native.model&&typeof native.model.providerId==='string'&&native.model.providerId.length>0&&typeof native.model.modelId==='string'&&native.model.modelId.length>0?native.model:undefined;
      requireValue(typeof native.nativeSessionId==='string'&&native.nativeSessionId.length>0&&native.nativeAccepted!==false,'native_creation_unconfirmed','Native session creation was not confirmed',409);
      const binding=native.binding??{runtimeInstanceId:runtime.id,generation:runtime.epoch,nativeSessionId:native.nativeSessionId,state:'attached' as const,capabilities:control??{...NO_CONTROL}};
      requireValue(binding.state==='attached'&&binding.runtimeInstanceId===runtime.id&&binding.nativeSessionId===native.nativeSessionId,'binding_mismatch','Native creation returned an invalid binding',409);
      const s:Session={id,ref:{hostId:this.hostId,workspaceId:wid,engineId,runtimeInstanceId:runtime.id,nativeSessionId:native.nativeSessionId},binding,title:'新会话',cwd:w.path,state:'idle',epoch:binding.generation,model:confirmed,nextModel:model&&(!confirmed||confirmed.providerId!==model.providerId||confirmed.modelId!==model.modelId)?model:undefined,messages:[],tools:[],agents:[],interactions:[],watermark:0,historyStart:1,updatedAt:Date.now()};
      this.store.transaction(()=>{this.store.put('session',id,s);this.store.put('creation',device+':'+requestId,{sessionId:id});});this.emit('catalog.changed');this.setReceipt(device,{clientRequestId:requestId,status:'native_accepted',generation:binding.generation});return s;
    }catch(e){this.setReceipt(device,{clientRequestId:requestId,status:nativeStarted?'uncertain':'rejected',detail:e instanceof Error?e.message:'Creation failed'});throw e;}
  }
  accept(device:string,command:unknown):Receipt{
    requireValue(validateCommand(command),'invalid_command',JSON.stringify(validateCommand.errors));const c=command as Command;
    requireValue(c.hostId===this.hostId,'host_mismatch','Command targets another host',409);
    const s=this.session(c.sessionId);requireValue(exactRef(c.ref,s.ref),'target_mismatch','Full native session identity does not match',409);
    const r=this.store.receive(device,c.clientRequestId,c);if(!r.fresh)return r.receipt;
    const previous=(this.queues.get(s.id)??Promise.resolve()).catch(()=>{});
    const work=previous.then(()=>new Promise<void>(resolve=>setImmediate(resolve))).then(()=>this.execute(device,c)).catch(e=>{const phase=this.store.intent(device,c.clientRequestId)?.phase;this.setReceipt(device,{clientRequestId:c.clientRequestId,status:phase==='dispatching'?'uncertain':'rejected',detail:(e as Error).message});});
    this.queues.set(s.id,work);void work.finally(()=>{if(this.queues.get(s.id)===work)this.queues.delete(s.id);});
    this.inFlight.add(work);void work.finally(()=>this.inFlight.delete(work));return r.receipt;
  }
  async editSession(id: string, change: LibraryChange) {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => editCatalog(this, id, change));
    const work = result.then(() => {}, () => {});
    this.queues.set(id, work); this.inFlight.add(work);
    try { return await result; }
    finally { this.inFlight.delete(work); if (this.queues.get(id) === work) this.queues.delete(id); }
  }
  private activeWriteRoots(session: Session): string[] {
    const project = this.store.get<Workspace>('workspace',session.ref.workspaceId);
    return [...(project?.writeRoots ?? [session.cwd]), ...(session.writeRoots ?? []), ...(session.grantedRoots ?? [])];
  }
  async drain(){await Promise.all([...this.inFlight]);}
  async execute(device:string,c:Command){
    const s=this.session(c.sessionId);const a=this.adapters.get(s.ref.engineId);const p=c.payload;
    requireValue(a,'runtime_missing','Runtime adapter unavailable',409);requireValue(c.hostId===this.hostId&&exactRef(c.ref,s.ref),'target_mismatch','Session identity changed',409);this.workspace(s.ref.workspaceId,s.ref.engineId);
    requireValue(!s.archived && !s.deletionPending,'session_archived','请先从归档恢复会话',409);
    const b=s.binding;requireValue(b?.state==='attached','binding_unavailable',b?.reason??'No native control binding',409);
    requireValue(p.expectedGeneration===b.generation,'generation_mismatch','Command targets an obsolete runtime generation',409);
    const capability=c.action==='decide'?(s.interactions.find(i=>i.id===p.interactionId)?.kind==='permission'?'approve':'answer'):c.action;
    requireValue(b.capabilities[capability]===true,'capability_unavailable','Native binding does not offer this operation',409);
    if(c.action==='slash'||c.action==='steer'){
      requireValue(s.ref.engineId==='deepseek-harness','capability_unavailable','Native DSH operation required',409);
      const steer=c.action==='steer';const text=steer?p.text:p.line;
      requireValue(typeof text==='string'&&text.length<=100000&&(steer||text.startsWith('/')),'input_invalid','Invalid native input');
      requireValue(steer?s.state==='running'&&p.runId===s.runId&&s.runGeneration===b.generation:!ACTIVE.includes(s.state),'run_mismatch',steer?'Steer must target the current running turn':'Execute native commands between runs',409);
      requireValue(!this.store.unresolvedCancel(s.id)&&!this.store.unresolvedSubmission(s.id),'operation_unresolved','Previous native operation requires reconciliation',409);
      const ids=p.attachmentIds??[];requireValue(Array.isArray(ids)&&ids.length<=10&&ids.every(id=>typeof id==='string'),'attachments_invalid','Invalid attachment IDs');
      const w=this.workspace(s.ref.workspaceId,s.ref.engineId);requireValue(await realpath(w.path)===w.path,'workspace_changed','Project identity changed');
      const attachments=await Promise.all(ids.map(async id=>{const attachment=this.store.get<Attachment>('attachment',id);requireValue(attachment&&attachment.workspaceId===w.id,'attachment_mismatch','Attachment is not in this project',403);const bytes=await readProject(w,attachment.relativePath,MAX_FILE);requireValue(digest(bytes)===attachment.sha256,'attachment_changed','Uploaded attachment changed',409);return{...attachment,dataBase64:bytes.toString('base64')};}));
      requireValue(text.trim()||attachments.length,'empty_input','Input is empty');
      const roots=[...w.writeRoots,...(s.grantedRoots||[])];
      for(const root of roots)requireValue(this.projects.permits(w,root),'root_not_granted','A previous grant is outside current host-configured workspace roots',403);
      for(const other of this.store.list<Session>('session'))if(other.id!==s.id&&other.binding?.state!=='unbound'&&(ACTIVE.includes(other.state)||this.store.unresolvedSubmission(other.id))){requireValue(!this.activeWriteRoots(other).some(x=>roots.some(y=>overlaps(x,y))),'directory_busy','Another managed operation owns this directory',409);}
      const latest=this.session(s.id);requireValue(latest.binding?.state==='attached'&&latest.binding.generation===b.generation&&latest.runId===s.runId&&latest.state===s.state,'generation_mismatch','Native session changed during validation',409);
      const nativeRequestId=digest(JSON.stringify([device,c.clientRequestId]));
      this.setReceipt(device,{clientRequestId:c.clientRequestId,status:'received',generation:b.generation,nativeRequestId,...(steer?{runId:s.runId}:{})});this.store.dispatching(device,c.clientRequestId);
      const input={text,attachments,requestId:c.clientRequestId,nativeRequestId,generation:b.generation};
      if(steer){await a.submit(s,{...input,runId:s.runId,mode:'steer'});this.context(s.ref.engineId).emit(s.id,'message.completed',{id:c.clientRequestId,role:'user',text});this.setReceipt(device,{clientRequestId:c.clientRequestId,status:'native_accepted'});}
      else{requireValue(a.executeNativeCommand,'capability_unavailable','Native command execution unavailable',409);const result=await a.executeNativeCommand(s,text,input);this.setReceipt(device,{clientRequestId:c.clientRequestId,status:'native_accepted',result});}
    }else if(c.action==='submit'){
      requireValue(typeof p.text==='string'&&p.text.length<=100_000,'text_invalid','Invalid text');
      const attachmentIds=p.attachmentIds??[];requireValue(Array.isArray(attachmentIds)&&attachmentIds.length<=10&&attachmentIds.every(id=>typeof id==='string'),'attachments_invalid','Invalid attachment IDs');
      const refs=(attachmentIds as string[]).map(id=>{const v=this.store.get<Attachment>('attachment',id);requireValue(v&&v.workspaceId===s.ref.workspaceId,'attachment_mismatch','Attachment is not in this project',403);return v;});
      requireValue(p.text.trim()||refs.length,'empty_input','Input is empty');
      const w=this.workspace(s.ref.workspaceId,s.ref.engineId);requireValue(await realpath(w.path)===w.path,'workspace_changed','Project identity changed');
      const attachments=await Promise.all(refs.map(async a=>{const bytes=await readProject(w,a.relativePath,MAX_FILE);requireValue(digest(bytes)===a.sha256,'attachment_changed','Uploaded attachment has changed',409);return{...a,dataBase64:bytes.toString('base64')};}));
      const roots=[...w.writeRoots,...(s.grantedRoots||[])];
      for(const root of roots)requireValue(this.projects.permits(w,root),'root_not_granted','A previous grant is outside current host-configured workspace roots',403);
      requireValue(!ACTIVE.includes(this.session(s.id).state),'run_active','Wait for native termination or reconciliation before continuing',409);
      await a.prepareSubmission?.(this.session(s.id));
      this.workspace(s.ref.workspaceId,s.ref.engineId);
      requireValue(!this.store.unresolvedCancel(s.id),'cancel_unresolved','Previous cancellation delivery still requires reconciliation',409);
      requireValue(!this.store.unresolvedSubmission(s.id),'submission_unresolved','Previous submission delivery still requires reconciliation',409);
      requireValue(this.session(s.id).binding?.generation===b.generation&&this.session(s.id).binding?.state==='attached','generation_mismatch','Binding changed during submit validation',409);
      for(const other of this.store.list<Session>('session'))if(other.binding?.state!=='unbound'&&(ACTIVE.includes(other.state)||this.store.unresolvedSubmission(other.id))){
        requireValue(!this.activeWriteRoots(other).some(x=>roots.some(y=>overlaps(x,y))),'directory_busy','A managed task still owns this directory; verify or stop it first',409);
      }
      this.store.put('active-command',s.id,{device,requestId:c.clientRequestId});
      const run:RunRecord={runId:randomUUID(),sessionId:s.id,generation:b.generation,clientRequestId:c.clientRequestId,deviceId:device,nativeRequestId:randomUUID(),state:'accepted'};
      this.store.dispatching(device,c.clientRequestId,run);this.setReceipt(device,{clientRequestId:c.clientRequestId,status:'received',runId:run.runId,generation:b.generation,nativeRequestId:run.nativeRequestId});
      this.context(s.ref.engineId).emit(s.id,'run.updated',{state:'accepted',runId:run.runId,generation:b.generation});
      this.context(s.ref.engineId).emit(s.id,'message.completed',{id:c.clientRequestId,role:'user',text:p.text});
      const current=this.session(s.id);if(current.title==='新会话'){current.title=(p.text as string).slice(0,40)||'附件任务';this.store.put('session',s.id,current);}
      try{
        this.store.dispatching(device,c.clientRequestId);
        await a.submit(this.session(s.id),{text:p.text as string,attachments,requestId:c.clientRequestId,runId:run.runId,generation:b.generation,nativeRequestId:run.nativeRequestId});
      }catch(e){this.context(s.ref.engineId).emit(s.id,'run.updated',{state:'uncertain'});throw e;}
    }else if(c.action==='cancel'){
      requireValue(typeof p.runId==='string'&&p.runId===s.runId&&s.runGeneration===b.generation,'run_mismatch','Cancellation does not target the active run and generation',409);
      requireValue(ACTIVE.includes(s.state),'no_active_run','No active run to cancel',409);
      this.store.dispatching(device,c.clientRequestId);
      this.context(s.ref.engineId).emit(s.id,'run.updated',{state:'cancel_requested'});await a.requestCancel(s);this.setReceipt(device,{clientRequestId:c.clientRequestId,status:'native_accepted',detail:'Cancellation requested; awaiting native termination'});
    }else if(c.action==='configure'){
      requireValue(!ACTIVE.includes(s.state),'run_active','Change next-turn model between runs',409);
      requireValue(!this.store.unresolvedSubmission(s.id),'operation_unresolved','Previous native operation requires reconciliation',409);
      const model=object(p.model) as unknown as ModelIdentity;
      const descriptor=await a.probe();requireValue((a.listModels?await a.listModels(this.workspace(s.ref.workspaceId,s.ref.engineId)):descriptor.models).some(m=>m.providerId===model.providerId&&m.modelId===model.modelId),'model_not_registered','Select an explicitly registered native model');
      this.store.dispatching(device,c.clientRequestId);await a.configure(s,model);const updated=this.session(s.id);updated.nextModel=!updated.model||updated.model.providerId!==model.providerId||updated.model.modelId!==model.modelId?model:undefined;this.store.put('session',s.id,updated);
      this.emit('catalog.changed');
      this.setReceipt(device,{clientRequestId:c.clientRequestId,status:'native_accepted',detail:'Next-turn model requested; character updates only after native confirmation'});
    }else if(c.action==='decide'){
      const answer=p.answer===undefined?{}:object(p.answer);const d={...p,...answer,interactionId:p.interactionId,epoch:b.generation,expectedGeneration:b.generation} as unknown as Decision;const i=s.interactions.find(v=>v.id===d.interactionId);
      requireValue(i&&(i.generation??i.epoch)===b.generation&&(!i.runId||i.runId===s.runId)&&!TERMINAL.includes(s.state)&&!['cancel_requested','uncertain'].includes(s.state)&&i.status==='pending','stale_interaction','Native request is stale, stopping, uncertain or already handled',409);
      if(i.kind==='permission')requireValue(i.choices.some(choice=>choice.id===d.choiceId),'choice_invalid','Decision not offered by native runtime');
      else if(d.cancelled)requireValue(i.canCancel,'cancel_not_offered','Native question has no cancel response');
      else if(!d.cancelled&&!i.form){
        const answers=object(d.answers);for(const key of Object.keys(answers))requireValue(i.questions.some(q=>q.id===key),'question_invalid','Unknown question');
        for(const q of i.questions){const v=answers[q.id];requireValue(Array.isArray(v)&&v.every(x=>typeof x==='string'&&x.length<=10_000)&&v.length>0&&(q.multiple||v.length===1),'answer_invalid','Invalid answer');if(!q.freeText)requireValue(v.every(x=>q.options.includes(x)),'answer_invalid','Answer is outside native options');}
      }
      if(i.form&&!d.cancelled)validateFormAnswer(i.form,object(p.answer));
       const expanded=i.choices.find(choice=>choice.id===d.choiceId)?.allows&&i.writeRoots?.length?await Promise.all(i.writeRoots.map(canonical)):[];
       if(expanded.length){
         const w=this.workspace(s.ref.workspaceId,s.ref.engineId);
         for(const root of expanded)requireValue(this.projects.permits(w,root),'root_not_granted','Native permission is outside host-configured workspace roots',403);
         for(const other of this.store.list<Session>('session'))if(other.id!==s.id&&other.binding?.state!=='unbound'&&ACTIVE.includes(other.state)){
          const occupied=this.activeWriteRoots(other);requireValue(!expanded.some(x=>occupied.some(y=>overlaps(x,y))),'directory_busy','Native permission would overlap another active project',409);
        }
       }
       const latest=this.session(s.id);
       requireValue(latest.binding?.state==='attached'&&latest.binding.generation===b.generation&&latest.runId===s.runId&&!TERMINAL.includes(latest.state)&&!['cancel_requested','uncertain'].includes(latest.state),'stale_interaction','Native request changed while validating its permission scope',409);
       const currentInteraction=latest.interactions.find(item=>item.id===i.id);
       requireValue(currentInteraction&&exactRef(currentInteraction,i),'stale_interaction','Native interaction changed while validating its permission scope',409);
       this.workspace(latest.ref.workspaceId);
       const claimed=this.store.claimDecision(s.id,i.id,d.epoch,d);
      if(expanded.length){const current=this.session(s.id);const scope=i.choices.find(choice=>choice.id===d.choiceId)!.scope;
        if(scope==='allow_always'){const workspace=this.workspace(s.ref.workspaceId,s.ref.engineId);workspace.writeRoots=[...new Set([...workspace.writeRoots,...expanded])];this.store.put('workspace',workspace.id,workspace);}
        else if(scope==='native:session')current.grantedRoots=[...new Set([...(current.grantedRoots||[]),...expanded])];
        else current.writeRoots=[...new Set([...(current.writeRoots||[]),...expanded])];this.store.put('session',s.id,current);}
      this.context(s.ref.engineId).emit(s.id,'interaction.created',claimed as unknown as Record<string,unknown>);
      this.store.dispatching(device,c.clientRequestId);await a.respond(s,claimed,d);this.setReceipt(device,{clientRequestId:c.clientRequestId,status:'native_accepted'});
    }
  }
}

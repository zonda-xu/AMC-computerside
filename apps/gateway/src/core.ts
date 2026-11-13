import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { AdapterContext, AgentAdapter, Attachment, Command, Decision, EngineId, ModelIdentity, Receipt, Session, Workspace } from '../../../packages/protocol/src/types.ts';
import { ACTIVE, ENGINES } from '../../../packages/protocol/src/types.ts';
import { exactRef, Fault, object, requireValue, stable, string, validateCommand } from '../../../packages/protocol/src/validation.ts';
import { Store, digest } from './store.ts';
import { canonical, inside, overlaps, readProject, MAX_FILE } from './files.ts';
import { WorkspaceCreator } from './workspace-create.ts';
import { ExternalSessions } from './external.ts';
export class Core extends EventEmitter {
  store:Store;hostId:string;allowedRoots:string[];adapters=new Map<EngineId,AgentAdapter>();
  private inFlight=new Set<Promise<void>>();
  workspaceCreator=new WorkspaceCreator(this);
  external=new ExternalSessions(this);
  constructor(store:Store,hostId:string,allowedRoots:string[]){super();this.store=store;this.hostId=hostId;this.allowedRoots=allowedRoots;}
  session(id:string){const s=this.store.get<Session>('session',id);requireValue(s,'session_missing','Session not found',404);return s;}
  workspace(id:string){const w=this.store.get<Workspace>('workspace',id);requireValue(w,'workspace_missing','Project not found',404);for(const root of [w.path,...w.writeRoots])requireValue(this.allowedRoots.some(base=>inside(base,root)),'root_not_granted','Project is outside current host-configured workspace roots',403);return w;}
  context(engineId:EngineId):AdapterContext{
    let runtime=this.store.get<{id:string;epoch:number}>('runtime',engineId);if(!runtime){runtime={id:randomUUID(),epoch:0};this.store.put('runtime',engineId,runtime);}
    return{runtimeInstanceId:runtime.id,epoch:runtime.epoch,
      getSession:id=>this.session(id),
      openConnection:(ids?:string[])=>{
        const r=this.store.get<{id:string;epoch:number}>('runtime',engineId)!;r.epoch++;this.store.put('runtime',engineId,r);
        for(const s of this.store.list<Session>('session').filter(s=>s.ref.engineId===engineId&&(!ids||ids.includes(s.id)))){s.epoch=r.epoch;s.interactions=s.interactions.map(i=>i.status==='resolved'?i:{...i,status:'stale'});this.store.put('session',s.id,s);}
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
        if(active&&type==='run.updated'&&(data.nativeAccepted===true||['completed','failed','cancelled'].includes(data.state as string))){
          const receipt=this.store.getReceipt(active.device,active.requestId);if(receipt&&receipt.status==='received')this.setReceipt(active.device,{...receipt,status:'native_accepted'});
        }
        const after=this.session(id);
        if(type==='agent.updated'&&after.state==='uncertain'&&after.parentEndState&&after.agents.every(a=>childTerminal.includes(a.state))){
          const settled=this.store.event(id,'run.updated',{state:after.parentEndState});this.emit('event',settled);
        }
      }};
  }
  setReceipt(device:string,receipt:Receipt){this.store.receipt(device,receipt);this.emit('receipt',{device,receipt});}
  async registerWorkspace(path:string,name:string,writeRoots:string[]=[]){
    const actual=await canonical(path);const roots=await Promise.all([actual,...writeRoots].map(canonical));
    for(const r of roots)requireValue(this.allowedRoots.some(base=>inside(base,r)),'root_not_granted','Project is outside host-configured workspace roots',403);
    // Recheck immediately before insertion, after all asynchronous canonicalization.
    const all=this.store.list<Workspace>('workspace');
    for(const w of all)requireValue(!w.writeRoots.some(a=>roots.some(b=>overlaps(a,b))),'overlapping_project','Managed project roots overlap',409);
    const w:Workspace={id:randomUUID(),hostId:this.hostId,name,path:actual,writeRoots:[...new Set(roots)]};this.store.put('workspace',w.id,w);this.emit('catalog.changed');return w;
  }
  async createSession(device:string,requestId:string,wid:string,engineId:EngineId,model?:ModelIdentity){
    requireValue(ENGINES.includes(engineId),'engine_invalid','Unknown runtime');const w=this.workspace(wid);const adapter=this.adapters.get(engineId);
    requireValue(adapter,'runtime_missing','Runtime adapter is unavailable');
    if(model)requireValue(typeof model.providerId==='string'&&model.providerId.length>0&&typeof model.modelId==='string'&&model.modelId.length>0&&typeof model.label==='string','model_invalid','Invalid model identity');
    const identity={kind:'session.create',wid,engineId,model};const r=this.store.receive(device,requestId,identity);
    const registered=this.store.get<{sessionId:string}>('creation',device+':'+requestId);if(registered)return this.session(registered.sessionId);
    requireValue(r.fresh,'creation_uncertain','Creation has already been received; inspect native state before creating another session',409);
    const id=randomUUID();
    let nativeStarted=false;
    try{
      if(model){const descriptor=await adapter.probe();requireValue(descriptor.models.some(m=>m.providerId===model.providerId&&m.modelId===model.modelId),'model_not_registered','Select an explicitly registered native model');}
      nativeStarted=true;
      const native=await adapter.createSession(id,w,model);
      const runtime=this.store.get<{id:string;epoch:number}>('runtime',engineId)!;
      const confirmed=native.model&&typeof native.model.providerId==='string'&&native.model.providerId.length>0&&typeof native.model.modelId==='string'&&native.model.modelId.length>0?native.model:undefined;
      const s:Session={id,ref:{hostId:this.hostId,workspaceId:wid,engineId,runtimeInstanceId:runtime.id,nativeSessionId:native.nativeSessionId},title:'新会话',cwd:w.path,state:'idle',epoch:runtime.epoch,model:confirmed,nextModel:model&&(!confirmed||confirmed.providerId!==model.providerId||confirmed.modelId!==model.modelId)?model:undefined,messages:[],tools:[],agents:[],interactions:[],watermark:0,historyStart:1,updatedAt:Date.now()};
      this.store.transaction(()=>{this.store.put('session',id,s);this.store.put('creation',device+':'+requestId,{sessionId:id});});this.emit('catalog.changed');this.setReceipt(device,{clientRequestId:requestId,status:engineId==='claude-code'?'received':'native_accepted',...(engineId==='claude-code'?{detail:'Session UUID durably reserved; native creation is not yet confirmed'}:{})});return s;
    }catch(e){this.setReceipt(device,{clientRequestId:requestId,status:nativeStarted?'uncertain':'rejected',detail:e instanceof Error?e.message:'Creation failed'});throw e;}
  }
  accept(device:string,command:unknown):Receipt{
    requireValue(validateCommand(command),'invalid_command',JSON.stringify(validateCommand.errors));const c=command as Command;
    requireValue(c.hostId===this.hostId,'host_mismatch','Command targets another host',409);
    const s=this.session(c.sessionId);requireValue(exactRef(c.ref,s.ref),'target_mismatch','Full native session identity does not match',409);
    requireValue(!s.externalSource,'external_read_only','External history is read-only; original writer stop and control lease are not verified',409);
    const r=this.store.receive(device,c.clientRequestId,c);if(!r.fresh)return r.receipt;
    // Persist first, dispatch once. Restart recovery never schedules these again.
    const work=new Promise<void>(resolve=>setImmediate(()=>{void this.execute(device,c).catch(e=>this.setReceipt(device,{clientRequestId:c.clientRequestId,status:e instanceof Fault?'rejected':'uncertain',detail:(e as Error).message})).finally(resolve);}));
    this.inFlight.add(work);void work.finally(()=>this.inFlight.delete(work));return r.receipt;
  }
  async drain(){await Promise.all([...this.inFlight]);}
  async execute(device:string,c:Command){
    const s=this.session(c.sessionId);const a=this.adapters.get(s.ref.engineId)!;const p=c.payload;
    requireValue(!s.externalSource,'external_read_only','External projection cannot dispatch native mutations',409);
    if(c.action==='submit'){
      requireValue(typeof p.text==='string'&&p.text.length<=100_000,'text_invalid','Invalid text');
      requireValue(Array.isArray(p.attachmentIds)&&p.attachmentIds.length<=10&&p.attachmentIds.every(id=>typeof id==='string'),'attachments_invalid','Invalid attachment IDs');
      const refs=(p.attachmentIds as string[]).map(id=>{const v=this.store.get<Attachment>('attachment',id);requireValue(v&&v.workspaceId===s.ref.workspaceId,'attachment_mismatch','Attachment is not in this project',403);return v;});
      requireValue(p.text.trim()||refs.length,'empty_input','Input is empty');
      const w=this.workspace(s.ref.workspaceId);requireValue(await realpath(w.path)===w.path,'workspace_changed','Project identity changed');
      const attachments=await Promise.all(refs.map(async a=>{const bytes=await readProject(w,a.relativePath,MAX_FILE);requireValue(digest(bytes)===a.sha256,'attachment_changed','Uploaded attachment has changed',409);return{...a,dataBase64:bytes.toString('base64')};}));
      const roots=[...w.writeRoots,...(s.grantedRoots||[])];
      for(const root of roots)requireValue(this.allowedRoots.some(base=>inside(base,root)),'root_not_granted','A previous grant is outside current host-configured workspace roots',403);
      // All awaits precede this synchronous lock decision + durable accepted event.
      for(const other of this.store.list<Session>('session'))if(ACTIVE.includes(other.state)){
        const ow=this.workspace(other.ref.workspaceId);
        requireValue(![...ow.writeRoots,...(other.writeRoots||[]),...(other.grantedRoots||[])].some(x=>roots.some(y=>overlaps(x,y))),'directory_busy','A managed task still owns this directory; verify or stop it first',409);
      }
      this.store.put('active-command',s.id,{device,requestId:c.clientRequestId});
      this.context(s.ref.engineId).emit(s.id,'run.updated',{state:'accepted',runId:c.clientRequestId});
      this.context(s.ref.engineId).emit(s.id,'message.completed',{id:c.clientRequestId,role:'user',text:p.text});
      const current=this.session(s.id);if(current.title==='新会话'){current.title=(p.text as string).slice(0,40)||'附件任务';this.store.put('session',s.id,current);}
      try{
        await a.submit(this.session(s.id),{text:p.text as string,attachments,requestId:c.clientRequestId});
        if(['codex','deepseek-harness'].includes(a.engineId))this.setReceipt(device,{clientRequestId:c.clientRequestId,status:'native_accepted',runId:this.session(s.id).runId});
      }catch(e){this.context(s.ref.engineId).emit(s.id,'run.updated',{state:'uncertain'});throw e;}
    }else if(c.action==='cancel'){
      requireValue(ACTIVE.includes(s.state),'no_active_run','No active run to cancel',409);
      this.context(s.ref.engineId).emit(s.id,'run.updated',{state:'cancel_requested'});await a.requestCancel(s);this.setReceipt(device,{clientRequestId:c.clientRequestId,status:'native_accepted',detail:'Cancellation requested; awaiting native termination'});
    }else if(c.action==='configure'){
      requireValue(!ACTIVE.includes(s.state),'run_active','Change next-turn model between runs',409);
      const model=object(p.model) as unknown as ModelIdentity;
      const descriptor=await a.probe();requireValue(descriptor.models.some(m=>m.providerId===model.providerId&&m.modelId===model.modelId),'model_not_registered','Select an explicitly registered native model');
      await a.configure(s,model);const updated=this.session(s.id);if(!updated.model||updated.model.providerId!==model.providerId||updated.model.modelId!==model.modelId){updated.nextModel=model;this.store.put('session',s.id,updated);}
      this.emit('catalog.changed');
      this.setReceipt(device,{clientRequestId:c.clientRequestId,status:'native_accepted',detail:'Next-turn model requested; character updates only after native confirmation'});
    }else if(c.action==='decide'){
      const d=p as unknown as Decision;const i=s.interactions.find(v=>v.id===d.interactionId);
      requireValue(i&&Number.isSafeInteger(d.epoch)&&i.epoch===d.epoch&&s.epoch===d.epoch,'stale_interaction','Native request is stale',409);
      if(i.kind==='permission')requireValue(i.choices.some(choice=>choice.id===d.choiceId),'choice_invalid','Decision not offered by native runtime');
      else if(d.cancelled)requireValue(i.canCancel,'cancel_not_offered','Native question has no cancel response');
      else if(!d.cancelled){
        const answers=object(d.answers);for(const key of Object.keys(answers))requireValue(i.questions.some(q=>q.id===key),'question_invalid','Unknown question');
        for(const q of i.questions){const v=answers[q.id];requireValue(Array.isArray(v)&&v.every(x=>typeof x==='string'&&x.length<=10_000)&&v.length>0&&(q.multiple||v.length===1),'answer_invalid','Invalid answer');if(!q.freeText)requireValue(v.every(x=>q.options.includes(x)),'answer_invalid','Answer is outside native options');}
      }
      const previous=this.store.get('decision',i.id);if(previous){requireValue(stable(previous)===stable(d),'decision_conflict','Native request already has another decision',409);this.setReceipt(device,{clientRequestId:c.clientRequestId,status:'native_accepted',detail:'Decision already submitted; waiting for native acknowledgement'});return;}
      const expanded=i.choices.find(choice=>choice.id===d.choiceId)?.allows&&i.writeRoots?.length?await Promise.all(i.writeRoots.map(canonical)):[];
      if(expanded.length){
        for(const other of this.store.list<Session>('session'))if(other.id!==s.id&&ACTIVE.includes(other.state)){
          const w=this.workspace(other.ref.workspaceId);requireValue(!expanded.some(x=>[...w.writeRoots,...(other.writeRoots||[]),...(other.grantedRoots||[])].some(y=>overlaps(x,y))),'directory_busy','Native permission would overlap another active project',409);
        }
      }
      const claimed=this.store.claimDecision(s.id,i.id,d.epoch,d);
      if(expanded.length){const current=this.session(s.id);const scope=i.choices.find(choice=>choice.id===d.choiceId)!.scope;
        if(scope==='allow_always'){const workspace=this.workspace(s.ref.workspaceId);workspace.writeRoots=[...new Set([...workspace.writeRoots,...expanded])];this.store.put('workspace',workspace.id,workspace);}
        else if(scope==='native:session')current.grantedRoots=[...new Set([...(current.grantedRoots||[]),...expanded])];
        else current.writeRoots=[...new Set([...(current.writeRoots||[]),...expanded])];this.store.put('session',s.id,current);}
      this.context(s.ref.engineId).emit(s.id,'interaction.created',claimed as unknown as Record<string,unknown>);
      await a.respond(s,claimed,d);this.setReceipt(device,{clientRequestId:c.clientRequestId,status:'native_accepted'});
    }
  }
}

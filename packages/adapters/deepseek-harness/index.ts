import type WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, Decision, Interaction, ModelIdentity, Session, Submission, Workspace } from '../../protocol/src/types.ts';
import { AdapterBase } from '../common/base.ts';
import type { RuntimeDescriptor } from '../../protocol/src/types.ts';
type Native=Record<string,any>;
export class DshAdapter extends AdapterBase implements AgentAdapter {
  socket?:WebSocket; byNative=new Map<string,string>();pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  attach(socket:WebSocket){
    if(this.config.enabled===false){socket.close(1008,'Runtime disabled');return;}
    if(this.socket){socket.close(1008,'One bridge per logical runtime');return;}
    this.socket=socket;this.epoch=this.context.openConnection();
    socket.on('error',e=>{for(const id of this.byNative.values())this.fault(id,e);socket.close();});
    socket.on('message',raw=>{try{const m=JSON.parse(raw.toString());if(m.id){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);if(m.error)p.reject(new Error(m.error));else p.resolve(m.result);}}}catch(e){for(const id of this.byNative.values())this.fault(id,e);}});
    socket.on('close',()=>{this.socket=undefined;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('DSH bridge disconnected'));}this.pending.clear();for(const id of this.byNative.values())this.fault(id,new Error('DSH host disconnected'));});
  }
  call(method:string,params:Native={},timeout=120_000):Promise<Native>{if(!['probe','externalList','externalHistory','externalObserve'].includes(method))return Promise.reject(new Error('DSH rc.5 bridge is read-only; managed control and approval competition are unverified'));if(!this.socket)return Promise.reject(new Error('DSH bridge is not connected'));const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`DSH ${method} did not confirm`));},timeout);this.pending.set(id,{resolve,reject,timer});this.socket!.send(JSON.stringify({id,method,params}));});}
  async probe():Promise<RuntimeDescriptor>{
    const capabilities={text:false,image:false,files:false,history:false,permission:false,questions:false,cancelScope:'unavailable',models:false};
    const result:RuntimeDescriptor={id:this.engineId,runtimeInstanceId:this.context.runtimeInstanceId,version:'',installed:false,authentication:'unknown',verified:false,detail:'DSH plugin not connected; CLI installation/version does not verify the host API',capabilities,models:[]};
    if(this.config.enabled===false){result.detail='DSH runtime disabled';return result;}
    if(!this.socket)return result;
    try{
      const r=await this.call('probe',{},10_000);
      result.version=typeof r.version==='string'?r.version:'';
      result.installed=true;
      const matched=r.version==='0.2.1-rc.5'&&r.version===this.config.expectedVersion&&r.externalProtocol===2&&r.apiProfile==='dsh-controller-0.2.1-rc.5-page-v2'&&r.controllerDigest==='a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386'&&r.control===false&&typeof r.instanceId==='string'&&!!r.instanceId;
      capabilities.history=matched;
      result.detail=matched?'Verified rc.5 controller API: external list/history/manual refresh only; managed creation, send, approvals and takeover disabled; no native E2E recorded':!r.apiProfile&&typeof r.detail==='string'?r.detail:r.version!==this.config.expectedVersion?'DSH controller package version does not match expectedVersion; controller rc.5 is required':'DSH controller API/protocol fingerprint mismatch; CLI version alone is insufficient';
      return result;
    }catch(e){result.detail=e instanceof Error?e.message:String(e);return result;}
  }
  async createSession(id:string,w:Workspace,model?:ModelIdentity){await this.checkVersion();const r=await this.call('create',{cwd:w.path,requestId:id});this.byNative.set(r.sessionId,id);let selected:ModelIdentity|undefined;if(model){const confirmed=await this.call('selectModel',{sessionId:r.sessionId,provider:model.providerId,model:model.modelId});if(typeof confirmed.selected?.provider==='string'&&confirmed.selected.provider&&typeof confirmed.selected?.model==='string'&&confirmed.selected.model)selected={providerId:confirmed.selected.provider,modelId:confirmed.selected.model,label:confirmed.selected.model};}return{nativeSessionId:r.sessionId as string,model:selected};}
  async resumeSession(s:Session){this.byNative.set(s.ref.nativeSessionId,s.id);const r=await this.call('state',{sessionId:s.ref.nativeSessionId,cwd:s.cwd,afterNativeSeq:s.nativeCursor||0});if(r.running===false&&this.context.getSession(s.id).state!=='uncertain')this.context.emit(s.id,'run.updated',{state:'idle'});else if(r.running===true)this.context.emit(s.id,'run.updated',{state:'running'});}
  async submit(s:Session,input:Submission){
    this.byNative.set(s.ref.nativeSessionId,s.id);if(s.nextModel)await this.configure(s,s.nextModel);
    const r=await this.call('prompt',{sessionId:s.ref.nativeSessionId,requestId:input.requestId,text:input.text,attachments:input.attachments.map(a=>({relativePath:a.relativePath,mime:a.mime,name:a.name,dataBase64:a.dataBase64}))});
    if(r.accepted!==true)throw new Error('DSH native acceptance was not confirmed');
  }
  async requestCancel(s:Session){await this.call('cancel',{sessionId:s.ref.nativeSessionId});}
  async configure(s:Session,model:ModelIdentity){const r=await this.call('selectModel',{sessionId:s.ref.nativeSessionId,provider:model.providerId,model:model.modelId});if(typeof r.selected?.provider==='string'&&r.selected.provider&&typeof r.selected?.model==='string'&&r.selected.model)this.context.emit(s.id,'model.confirmed',{model:{providerId:r.selected.provider,modelId:r.selected.model,label:r.selected.model}});}
  async respond(s:Session,i:Interaction,d:Decision){await this.call('respond',{sessionId:s.ref.nativeSessionId,nativeId:i.nativeId,choiceId:d.choiceId,answers:d.answers,cancelled:d.cancelled});this.context.emit(s.id,'interaction.closed',{id:i.id});this.context.emit(s.id,'run.updated',{state:'running'});}
  event(p:Native){
    const id=this.byNative.get(p.sessionId);if(!id)return;
    if(p.type==='interaction')this.interaction(id,p.nativeId,p.nativeMethod,p.interaction);
    else if(p.type==='interaction.closed'){for(const i of this.context.getSession(id).interactions)if(i.nativeId===p.nativeId)this.context.emit(id,'interaction.closed',{id:i.id});}
    else if(['message.delta','message.completed','run.updated','tool.updated','agent.updated','model.confirmed','error'].includes(p.type)){
      if(p.type==='message.completed'&&p.data.nativeKey){const prior=this.context.getSession(id).messages.findLast(m=>m.nativeKey===p.data.nativeKey&&m.role===p.data.role&&!m.complete);if(prior)p.data.id=prior.id;}
      this.context.emit(id,p.type,p.data);
    }
  }
  close(){this.socket?.close();}
}

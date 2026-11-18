import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { ACTIVE, type AdapterContext, type Decision, type Interaction, type ModelIdentity, type Session, type Submission, type Workspace } from '../../protocol/src/types.ts';
import { AdapterBase, type RuntimeConfig } from '../common/base.ts';
import { OpenCodeAdapter } from './index.ts';
import { OpenCodeExternalProvider } from './external.ts';
import { devEcoEndpoint } from './deveco-service.ts';

type Native=Record<string,any>;
const inputId=(request:string)=>'msg_'+createHash('sha256').update(request).digest('hex').slice(0,32);
const scoped=(route:string,cwd:string)=>route+(route.includes('?')?'&':'?')+'directory='+encodeURIComponent(cwd);
const messageText=(message:Native)=>message.parts.filter((p:Native)=>p.type==='text' && !p.ignored && !p.synthetic).map((p:Native)=>p.text).join('\n');
const messageModel=(info:Native):ModelIdentity|undefined=>typeof info.providerID==='string' && typeof info.modelID==='string'
  ?{providerId:info.providerID,modelId:info.modelID,label:info.modelID}:undefined;

/** DevEco has the OpenCode v2 catalogue and an independently versioned conversation API. */
export class DevEcoCodeAdapter extends OpenCodeAdapter {
  readonly serviceRoot:string;
  private poll?:ReturnType<typeof setInterval>;
  private nextRead=new Map<string,number>();
  private requested=new Map<string,string>();
  constructor(config:RuntimeConfig,ctx:AdapterContext,serviceRoot:string){super('opencode',config,ctx);this.serviceRoot=serviceRoot;}
  async checkVersion(){if(this.config.enabled===false)throw Error('DevEco Code 未启用');}
  async discover(){
    const service=await devEcoEndpoint(this.serviceRoot,this.config);
    const response=await fetch(service.url+'/doc',{headers:service.headers,redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error('DevEco Code 未发布原生接口描述');
    const doc=await response.json() as Native;
    if(!doc.paths?.['/api/session']?.get || !doc.paths?.['/api/event']?.get || !doc.paths?.['/session/{sessionID}/prompt_async']?.post ||
        !doc.paths?.['/session/{sessionID}/message']?.get || !doc.paths?.['/session/status']?.get)throw Error('此 DevEco Code 服务缺少接续所需会话接口');
    return service;
  }
  async probe(){
    const result=await AdapterBase.prototype.probe.call(this);
    if(!result.installed)return result;
    try{
      await this.connection();
      result.connectionState='attached';result.nativeIdentity=this.endpoint!.identity;result.generation=this.epoch;
      result.controlCapabilities=this.control;result.detail='已连接 DevEco Code 原生会话服务';
      result.capabilities={text:true,image:false,files:false,history:true,permission:true,questions:true,cancelScope:'session current execution',models:true};
      result.models=await this.listModels().catch(()=>[]);
    }catch(e){result.detail=e instanceof Error?e.message:String(e);}
    return result;
  }
  async verify(native:string,cwd:string){
    const s=await this.http(scoped('/session/'+encodeURIComponent(native),cwd));
    if(s.id!==native || typeof s.directory!=='string' || await realpath(s.directory)!==await realpath(cwd))throw Error('DevEco Code 原会话或项目目录不一致');
    return s;
  }
  async attachExistingSession(s:Session,identity:string){
    if(s.externalSource && (s.externalSource.namespace!==this.context.runtimeInstanceId+':'+identity ||
        s.externalSource.nativeId!==s.ref.nativeSessionId))throw Error('DevEco Code 原会话的数据来源已改变');
    return super.attachExistingSession(s,identity);
  }
  async transcript(native:string,cwd:string){
    await this.verify(native,cwd);
    const rows:unknown=await this.http(scoped('/session/'+encodeURIComponent(native)+'/message?limit=100',cwd));
    if(!Array.isArray(rows)||rows.some(m=>m.info?.sessionID!==native||typeof m.info?.id!=='string'||!Array.isArray(m.parts)))throw Error('DevEco Code 历史记录身份不一致');
    return rows as Native[];
  }
  async status(native:string,cwd:string){
    const states=await this.http(scoped('/session/status',cwd));return states[native]?.type||'idle';
  }
  async createSession(id:string,w:Workspace){
    await this.connection();
    const s=await this.http(scoped('/session',w.path),'POST',{});
    if(typeof s.id!=='string')throw Error('DevEco Code 未返回新会话编号');
    await this.verify(s.id,w.path);this.byNative.set(s.id,id);
    // Core retains the requested model for the first turn, until a native reply confirms it.
    return {nativeSessionId:s.id,binding:this.binding(s.id,this.control,this.endpoint!.identity),model:undefined};
  }
  async openStream(){
    await super.openStream();
    if(!this.poll){this.poll=setInterval(()=>{
      for(const [native,id] of this.byNative){
        const due=this.nextRead.get(id)||0;if(due>Date.now())continue;
        const session=this.context.getSession(id);
        this.nextRead.set(id,Date.now()+(ACTIVE.includes(session.state)?1300:30000));this.refreshSnapshot(native,id);
      }
    },1000);this.poll.unref();}
  }
  event(event:Native){
    const data=event.data||event.properties||{},native=data.sessionID||data.info?.sessionID||data.part?.sessionID;
    const id=this.byNative.get(native);if(id && (this.nextRead.get(id)||0)>Date.now()+500)this.nextRead.set(id,Date.now()+300);
  }
  private async interactionsFor(s:Session){
    const [permissions,questions]=await Promise.all(['/permission','/question'].map(route=>this.http(scoped(route,s.cwd))));
    if(!Array.isArray(permissions)||!Array.isArray(questions))throw Error('DevEco Code 未返回审批状态');
    return [...permissions.filter(p=>p.sessionID===s.ref.nativeSessionId).map(p=>({kind:'permission',p})),
      ...questions.filter(p=>p.sessionID===s.ref.nativeSessionId).map(p=>({kind:'question',p}))];
  }
  async reconcile(native:string,id:string){
    const s=this.context.getSession(id);
    const [rows,status,pending]=await Promise.all([this.transcript(native,s.cwd),this.status(native,s.cwd),this.interactionsFor(s)]);
    if(this.byNative.get(native)!==id)return;
    const current=this.context.getSession(id),user=rows.filter(m=>m.info.role==='user').at(-1);
    const assistant=rows.filter(m=>m.info.role==='assistant'&&user&&m.info.parentID===user.info.id).at(-1);
    const managed=current.runId?this.context.getRun?.(current.runId):undefined;
    const request=managed?.nativeRequestId||this.requested.get(id);
    const own=!!request&&user?.info.id===inputId(request);
    if(own)this.acceptSubmission(id,request!);
    const managedInputs=new Set<string>();
    for(const msg of current.messages)if(msg.role==='user'&&msg.runId){
      const saved=this.context.getRun?.(msg.runId)?.nativeRequestId;if(saved)managedInputs.add(inputId(saved));
    }
    if(request)managedInputs.add(inputId(request));
    for(const m of rows){
      const info=m.info;
      if(info.role==='user' && !managedInputs.has(info.id)){
        const key=this.messageId(id,info.id),text=messageText(m);
        if(text&&!current.messages.some(prior=>prior.id===key))this.context.emit(id,'message.completed',{id:key,role:'user',text,historical:true});
      }else if(info.role==='assistant'){
        const text=messageText(m),key=this.messageId(id,info.id);
        const old=current.messages.find(v=>v.id===key);
        if(text && (!old || old.text!==text || !old.complete && !!info.time?.completed)){
          if(info.time?.completed)this.context.emit(id,'message.completed',{id:key,role:'assistant',text});
          else if(!old || text.startsWith(old.text))this.context.emit(id,'message.delta',{id:key,role:'assistant',text:text.slice(old?.text.length||0)});
        }
        for(const part of m.parts.filter((p:Native)=>p.type==='tool')){
          const existing=current.tools.find(t=>t.id===part.id);
          const detail=String(part.state?.output||part.state?.error||JSON.stringify(part.state?.input||{})).slice(0,8192);
          const state=part.state?.status==='error'?'failed':part.state?.status||'pending';
          if(!existing || existing.status!==state || existing.detail!==detail)this.context.emit(id,'tool.updated',{id:part.id,title:part.tool,status:state,detail});
        }
      }
    }
    const model=assistant&&messageModel(assistant.info);
    if(model&&(current.model?.modelId!==model.modelId || current.model.providerId!==model.providerId))this.context.emit(id,'model.confirmed',{model});
    for(const {kind,p} of pending){
      if(current.interactions.some(i=>i.nativeId===p.id&&i.generation===this.epoch&&['pending','responding'].includes(i.status)))continue;
      this.interaction(id,p.id,kind,{kind:kind==='permission'?'permission':'question',title:p.permission||p.questions?.[0]?.header||'DevEco Code',detail:JSON.stringify(kind==='permission'?{patterns:p.patterns,metadata:p.metadata}:p.questions).slice(0,8192),nativeRequest:p,
        choices:kind==='permission'?[{id:'once',label:'允许一次',scope:'once',allows:true},{id:'reject',label:'拒绝',scope:'once',allows:false}]:[],
        questions:(p.questions||[]).map((q:Native,i:number)=>({id:String(i),title:q.question,options:q.options.map((opt:Native)=>opt.label),multiple:q.multiple===true,freeText:q.custom!==false}))});
    }
    for(const i of current.interactions)if(['pending','responding'].includes(i.status)&&!pending.some(x=>x.p.id===i.nativeId))this.context.emit(id,'interaction.closed',{id:i.id});
    // A previous completed assistant message cannot terminate a freshly queued order.
    if(managed && ACTIVE.includes(current.state) && !own)return;
    const error=assistant?.info.error;
    const state=pending.length?(pending[0].kind==='permission'?'waiting_permission':'waiting_input'):
      status!=='idle'?'running':error?(error.name==='MessageAbortedError'?'cancelled':'failed'):
      assistant?.info.time?.completed && assistant.info.finish && assistant.info.finish!=='tool-calls'?'completed':!user?'idle':undefined;
    if(state && current.state!==state && !(current.state==='cancel_requested'&&state==='running')){
      this.context.emit(id,'run.updated',{state,...(own?{nativeAccepted:true,nativeInputId:user!.info.id}:{}),...(error?{detail:String(error.data?.message||error.message||error.name)}:{})});
    }
  }
  async submit(s:Session,input:Submission){
    if(input.attachments.length)throw Error('此 DevEco Code 接口仅支持文本点单');
    await this.connection();const native=s.ref.nativeSessionId;await this.verify(native,s.cwd);
    if(await this.status(native,s.cwd)!=='idle')throw Error('DevEco Code 原会话仍在执行');
    const request=input.nativeRequestId||input.requestId, model=s.nextModel||s.model;
    this.requested.set(s.id,request);
    await this.http(scoped('/session/'+encodeURIComponent(native)+'/prompt_async',s.cwd),'POST',{
      messageID:inputId(request),parts:[{type:'text',text:input.text}],...(model?{model:{providerID:model.providerId,modelID:model.modelId}}:{})
    });
    this.acceptSubmission(s.id,request);this.nextRead.set(s.id,0);
  }
  async requestCancel(s:Session){
    await this.verify(s.ref.nativeSessionId,s.cwd);
    const current=this.context.getSession(s.id);
    if(!s.runId || s.runId!==current.runId || !ACTIVE.includes(current.state))throw Error('DevEco Code 轮次已变化');
    const response:unknown=await this.http(scoped('/session/'+encodeURIComponent(s.ref.nativeSessionId)+'/abort',s.cwd),'POST');
    if(response!==true)throw Error('DevEco Code 未确认停止请求');
    const pending=this.cancelOperation(s);
    if(pending)this.context.reconcileReceipt?.(pending.deviceId,pending.clientRequestId,{status:'native_accepted',detail:'DevEco Code 已接收停止请求'});
    this.nextRead.set(s.id,0);
  }
  async respond(s:Session,i:Interaction,d:Decision){
    await this.verify(s.ref.nativeSessionId,s.cwd);
    const entry=(await this.interactionsFor(s)).find(e=>e.p.id===i.nativeId);
    if(!entry){await this.reconcile(s.ref.nativeSessionId,s.id);throw Error('此审批已由另一端处理');}
    const rid=encodeURIComponent(entry.p.id);
    if(entry.kind==='permission'){
      if(d.choiceId!=='once'&&d.choiceId!=='reject')throw Error('请选择允许一次或拒绝');
      await this.http(scoped('/permission/'+rid+'/reply',s.cwd),'POST',{reply:d.choiceId});
    }else if(d.cancelled)await this.http(scoped('/question/'+rid+'/reject',s.cwd),'POST',{});
    else{
      const answers=entry.p.questions.map((_:Native,n:number)=>d.answers?.[String(n)]);
      if(answers.some((v:unknown)=>!Array.isArray(v)||!v.length))throw Error('请回答原问题');
      await this.http(scoped('/question/'+rid+'/reply',s.cwd),'POST',{answers});
    }
    this.nextRead.set(s.id,0);
  }
  async configure(s:Session,model:ModelIdentity){
    await this.verify(s.ref.nativeSessionId,s.cwd);
    if(ACTIVE.includes(s.state)||!(await this.listModels()).some(m=>m.providerId===model.providerId&&m.modelId===model.modelId))throw Error('当前轮次或模型目录已改变');
  }
  async releaseSession(s:Session){
    await this.verify(s.ref.nativeSessionId,s.cwd);
    if(await this.status(s.ref.nativeSessionId,s.cwd)!=='idle')throw Error('DevEco Code 原会话仍在执行');
    this.byNative.delete(s.ref.nativeSessionId);this.loaded.delete(s.id);this.requested.delete(s.id);this.nextRead.delete(s.id);
    this.context.disconnect?.([s.id],'会话已归档');
  }
  async prepareDelete(s:Session){
    await this.releaseSession(s);
    return async()=>{await this.verify(s.ref.nativeSessionId,s.cwd);if(await this.status(s.ref.nativeSessionId,s.cwd)!=='idle')throw Error('DevEco Code 原会话仍在执行');
      const ok:unknown=await this.http(scoped('/session/'+encodeURIComponent(s.ref.nativeSessionId),s.cwd),'DELETE');if(ok!==true)throw Error('DevEco Code 未确认删除');};
  }
  close(){if(this.poll)clearInterval(this.poll);super.close();}
}
export class DevEcoExternalProvider extends OpenCodeExternalProvider {
  readonly native:DevEcoCodeAdapter;
  constructor(adapter:DevEcoCodeAdapter){super(adapter);this.native=adapter;}
  async profile(){
    const p=await super.profile();
    if(p.discover.state==='supported'){p.profile='deveco-session-api';p.coverage='DevEco Code 项目会话、消息与工具记录';}
    return p;
  }
  async history(cwd:string,id:string,cursor?:string){
    await this.native.verify(id,cwd);
    const query=new URLSearchParams({limit:'100'});if(cursor)query.set('cursor',cursor);else query.set('order','asc');
    const page=await this.native.http(this.native.path(id,'/message?'+query));
    if(!Array.isArray(page.data)||page.data.length>100||page.cursor?.next!=null&&typeof page.cursor.next!=='string')throw Error('DevEco Code 原生历史分页无效');
    const rows:Native[]=page.data.filter((m:Native)=>m.type==='user'||m.type==='assistant');
    if(rows.some(m=>typeof m.id!=='string'||m.type==='assistant'&&!Array.isArray(m.content)))throw Error('DevEco Code 历史消息缺少原生记录');
    await this.native.verify(id,cwd);
    return {items:rows.map(m=>({nativeEventId:m.id,role:m.type,text:m.type==='user'?m.text:m.content.filter((p:Native)=>p.type==='text').map((p:Native)=>p.text).join('\n')})),
      tools:rows.flatMap(m=>(m.content||[]).filter((p:Native)=>p.type==='tool').map((p:Native)=>({id:p.id,title:p.name,status:p.state?.status==='error'?'failed':p.state?.status||'pending',detail:String(p.state?.result||JSON.stringify(p.state?.input||{})).slice(0,8192)}))),
      cursor:page.cursor?.next||undefined};
  }
}

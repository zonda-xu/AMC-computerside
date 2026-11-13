import { join } from 'node:path';
import type { AgentAdapter, Decision, Interaction, ModelIdentity, Session, Submission, Workspace } from '../../protocol/src/types.ts';
import { AdapterBase } from '../common/base.ts';
import { StdioRpc, type RpcMessage } from '../common/rpc.ts';
import { ACTIVE } from '../../protocol/src/types.ts';
type Native = Record<string, any>;
export class CodexAdapter extends AdapterBase implements AgentAdapter {
  rpc?: StdioRpc; connecting?:Promise<StdioRpc>; byNative = new Map<string,string>(); loaded=new Set<string>(); submitting=new Set<string>(); starting=new Map<string,Map<string,'completed'|'failed'|'cancelled'|'uncertain'>>();
  async connection(cwd:string){
    if(this.connecting)return this.connecting;
    this.connecting=this.connect(cwd);
    try{return await this.connecting;}finally{this.connecting=undefined;}
  }
  createRpc(cwd:string){return new StdioRpc(this.config.command,['app-server','--stdio'],cwd,this.env);}
  async connect(cwd:string){
    if(this.rpc)return this.rpc;
    await this.checkVersion();this.epoch=this.context.openConnection();
    const rpc=this.createRpc(cwd);this.rpc=rpc;
    rpc.on('notification',(m:RpcMessage)=>{if(this.rpc===rpc)this.notification(m);});
    rpc.on('request',(m:RpcMessage)=>{if(this.rpc===rpc)this.request(m);});
    const invalidate=(e:Error)=>{if(this.rpc!==rpc)return;this.rpc=undefined;this.loaded.clear();rpc.close();for(const id of this.byNative.values())this.fault(id,e);};
    rpc.on('fault',invalidate);
    try{await rpc.request('initialize',{clientInfo:{name:'ai_maid_cafe',title:'AI Maid Café',version:'0.1.0'},capabilities:{experimentalApi:true}});
    if(this.rpc!==rpc)throw new Error('Codex connection lost during initialization');rpc.notify('initialized');return rpc;}catch(e){invalidate(e instanceof Error?e:new Error(String(e)));throw e;}
  }
  async createSession(id:string,w:Workspace,model?:ModelIdentity){
    const rpc=await this.connection(w.path);
    const r=await rpc.request<Native>('thread/start',{cwd:w.path,...(model?{model:model.modelId,modelProvider:model.providerId}:{})});
    if(this.rpc!==rpc)throw new Error('Codex connection lost during session creation');
    this.byNative.set(r.thread.id,id);this.loaded.add(id);
    return{nativeSessionId:r.thread.id as string,model:typeof r.modelProvider==='string'&&r.modelProvider&&typeof r.model==='string'&&r.model?{providerId:r.modelProvider,modelId:r.model,label:r.model}:undefined};
  }
  async resumeSession(s:Session){
    const rpc=await this.connection(s.cwd);this.byNative.set(s.ref.nativeSessionId,s.id);
    if(this.loaded.has(s.id)&&(this.submitting.has(s.id)||!ACTIVE.includes(s.state)))return;
    const r=await rpc.request<Native>('thread/resume',{threadId:s.ref.nativeSessionId,cwd:s.cwd,excludeTurns:false});if(this.rpc!==rpc)throw new Error('Codex connection lost during resume');this.loaded.add(s.id);
    if(typeof r.modelProvider==='string'&&r.modelProvider&&typeof r.model==='string'&&r.model)this.context.emit(s.id,'model.confirmed',{model:{providerId:r.modelProvider,modelId:r.model,label:r.model}});
    for(const turn of r.thread.turns || [])for(const item of turn.items || [])if(item.type==='agentMessage')this.context.emit(s.id,'message.completed',{id:item.id,text:item.text,role:'assistant'});
    const turns=r.thread.turns || [];const last=turns.at(-1);
    if(this.submitting.has(s.id)){if(r.thread.status?.type!=='idle')throw new Error('Previous Codex turn is not confirmed idle');return;}
    if(this.context.getSession(s.id).state==='accepted')return;
    if(r.thread.status?.type==='idle' && (!last || ['completed','interrupted','failed'].includes(last.status)))this.context.emit(s.id,'run.updated',{state:last?.status==='interrupted'?'cancelled':last?.status==='failed'?'failed':last?'completed':'idle'});
    else if(r.thread.status?.type==='active')this.context.emit(s.id,'run.updated',{state:'running',runId:last?.id});
  }
  async submit(s:Session,input:Submission){
    this.submitting.add(s.id);try{await this.resumeSession(s);}finally{this.submitting.delete(s.id);}const model=s.nextModel;
    const content:Native[]=[{type:'text',text:input.text,text_elements:[]}];
    for(const a of input.attachments)if(a.mime.startsWith('image/'))content.push({type:'image',url:`data:${a.mime};base64,${a.dataBase64}`});else content[0].text+='\n附件（项目内路径）：'+a.relativePath;
    const rpc=this.rpc!;const completed=new Map<string,'completed'|'failed'|'cancelled'|'uncertain'>();this.starting.set(s.id,completed);
    try{const r=await rpc.request<Native>('turn/start',{threadId:s.ref.nativeSessionId,input:content,clientUserMessageId:input.requestId,...(model?{model:model.modelId}:{})},120_000);
    if(this.rpc!==rpc)throw new Error('Codex connection lost during turn start');
    if(typeof r.modelProvider==='string'&&r.modelProvider&&typeof r.model==='string'&&r.model)this.context.emit(s.id,'model.confirmed',{model:{providerId:r.modelProvider,modelId:r.model,label:r.model}});
    const state=this.context.getSession(s.id).state;
    if(completed.has(r.turn.id))for(const i of this.context.getSession(s.id).interactions)if(i.status==='responding'||i.status==='pending')this.context.emit(s.id,'interaction.closed',{id:i.id,status:i.status==='responding'?'resolved':'stale'});
    this.context.emit(s.id,'run.updated',{state:completed.get(r.turn.id)||(state==='accepted'?'running':state),runId:r.turn.id,nativeAccepted:true});
    }finally{this.starting.delete(s.id);}
  }
  async requestCancel(s:Session){if(!s.runId)throw new Error('Native turn ID is not known');await this.rpc!.request('turn/interrupt',{threadId:s.ref.nativeSessionId,turnId:s.runId});}
  async configure(s:Session,model:ModelIdentity){if(s.model && s.model.providerId!==model.providerId)throw new Error('Codex provider is fixed by this native thread; create a new session');}
  request(m:RpcMessage){
    const p=m.params as Native;const id=this.byNative.get(p?.threadId);if(!id||m.id===undefined){if(m.id!==undefined)this.rpc!.reject(m.id,'Session not managed by this console');return;}
    if(m.method==='item/commandExecution/requestApproval'||m.method==='item/fileChange/requestApproval'){
      this.interaction(id,m.id,m.method,{title:p.command || p.reason || '文件修改审批',detail:JSON.stringify(p,null,2),writeRoots:[p.grantRoot,p.cwd].filter(v=>typeof v==='string'),choices:[{id:'accept',label:'仅这一次',scope:'native:once',allows:true},{id:'acceptForSession',label:m.method.includes('fileChange')?'允许这些文件后续修改':'当前会话允许',scope:'native:session',allows:true},{id:'decline',label:'拒绝',scope:'native:once',allows:false},{id:'cancel',label:'拒绝并停止轮次',scope:'native:turn',allows:false}]});
    } else if(m.method==='item/tool/requestUserInput'){
      this.interaction(id,m.id,m.method,{kind:'question',title:'需要你的回答',detail:'Codex 原生用户问题',questions:p.questions.map((q:Native)=>({id:q.id,title:q.question,options:(q.options||[]).map((o:Native)=>o.label),multiple:false,freeText:!q.options?.length||q.isOther}))});
    }else this.rpc!.reject(m.id,`Native request not implemented: ${m.method}`);
  }
  async respond(s:Session,i:Interaction,d:Decision){
    if(i.nativeMethod==='item/tool/requestUserInput'){const answers:Native={};for(const [k,v]of Object.entries(d.answers||{}))answers[k]={answers:v};this.rpc!.respond(i.nativeId,{answers});}
    else this.rpc!.respond(i.nativeId,{decision:d.choiceId});
  }
  notification(m:RpcMessage){
    const p=m.params as Native;const id=this.byNative.get(p?.threadId);if(!id)return;
    const emit=(type:any,data:Native)=>this.context.emit(id,type,data);
    if(m.method==='item/agentMessage/delta')emit('message.delta',{id:p.itemId,text:p.delta,role:'assistant'});
    if(m.method==='item/started'||m.method==='item/completed'){
      const i=p.item;const complete=m.method==='item/completed';
      if(i.type==='agentMessage'&&complete)emit('message.completed',{id:i.id,text:i.text,role:'assistant'});
      if(['commandExecution','fileChange','mcpToolCall','webSearch'].includes(i.type))emit('tool.updated',{id:i.id,title:i.command||i.tool||i.type,status:i.status||(complete?'completed':'running'),detail:JSON.stringify(i,null,2)});
      if(i.type==='collabAgentToolCall')for(const [child,v]of Object.entries(i.agentsStates||{}))emit('agent.updated',{id:child,title:i.tool,state:(v as Native).status,detail:(v as Native).message||''});
    }
    if(m.method==='serverRequest/resolved')for(const i of this.context.getSession(id).interactions)if(i.nativeId===p.requestId)emit('interaction.closed',{id:i.id});
    if(m.method==='turn/started'&&!this.submitting.has(id))emit('run.updated',{state:'running',runId:p.turn.id,nativeAccepted:true});
    if(m.method==='turn/completed'){
      const starting=this.starting.get(id);if(starting){starting.set(p.turn.id,p.turn.status==='interrupted'?'cancelled':p.turn.status==='failed'?'failed':p.turn.status==='completed'?'completed':'uncertain');return;}
      const current=this.context.getSession(id);if(this.submitting.has(id)||(current.state==='accepted'&&current.runId!==p.turn.id)||(current.runId&&current.state!=='accepted'&&current.runId!==p.turn.id))return;
      for(const i of this.context.getSession(id).interactions)if(i.status==='responding'||i.status==='pending')emit('interaction.closed',{id:i.id,status:i.status==='responding'?'resolved':'stale'});
      emit('run.updated',{state:p.turn.status==='interrupted'?'cancelled':p.turn.status==='failed'?'failed':p.turn.status==='completed'?'completed':'uncertain',runId:p.turn.id});
    }
    if(m.method==='error')emit('error',{message:p.error?.message||JSON.stringify(p)});
  }
  close(){const rpc=this.rpc;this.rpc=undefined;this.loaded.clear();rpc?.close();}
}

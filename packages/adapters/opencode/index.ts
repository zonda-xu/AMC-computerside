import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentAdapter, Decision, Interaction, ModelIdentity, Session, Submission, Workspace } from '../../protocol/src/types.ts';
import { AdapterBase } from '../common/base.ts';
import { StdioRpc, type RpcMessage } from '../common/rpc.ts';
type Native=Record<string,any>;
export class OpenCodeAdapter extends AdapterBase implements AgentAdapter {
  rpc?:StdioRpc; connecting?:Promise<StdioRpc>; byNative=new Map<string,string>(); loaded=new Set<string>(); loading=new Set<string>(); chunks=new Map<string,string>(); configOptions=new Map<string,Native[]>();
  async connection(cwd:string){
    if(this.connecting)return this.connecting;
    this.connecting=this.connect(cwd);try{return await this.connecting;}finally{this.connecting=undefined;}
  }
  createRpc(cwd:string){return new StdioRpc(this.config.command,['acp'],cwd,this.env);}
  async connect(cwd:string){
    if(this.rpc)return this.rpc;await this.checkVersion();this.epoch=this.context.openConnection();
    const rpc=this.createRpc(cwd);this.rpc=rpc;
    rpc.on('notification',(m:RpcMessage)=>{if(this.rpc===rpc)this.notification(m);});rpc.on('request',(m:RpcMessage)=>{if(this.rpc===rpc)this.request(m);});
    const invalidate=(e:Error)=>{if(this.rpc!==rpc)return;this.rpc=undefined;this.loaded.clear();this.chunks.clear();this.configOptions.clear();rpc.close();for(const id of this.byNative.values())this.fault(id,e);};
    rpc.on('fault',invalidate);
    try{const r=await rpc.request<{protocolVersion:number;agentCapabilities?:{loadSession?:boolean}}>('initialize',{protocolVersion:1,clientInfo:{name:'ai-maid-cafe',version:'0.1.0'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false,elicitation:{form:true}}});
    if(this.rpc!==rpc||r.protocolVersion!==1||!r.agentCapabilities?.loadSession)throw new Error('OpenCode ACP v1 with session/load is required');return rpc;}catch(e){invalidate(e instanceof Error?e:new Error(String(e)));throw e;}
  }
  async createSession(id:string,w:Workspace,model?:ModelIdentity){
    const rpc=await this.connection(w.path);const r=await rpc.request<Native>('session/new',{cwd:w.path,mcpServers:[],additionalDirectories:w.writeRoots.filter(p=>p!==w.path)});
    if(model)await rpc.request('session/set_config_option',{sessionId:r.sessionId,configId:'model',value:`${model.providerId}/${model.modelId}`});
    if(this.rpc!==rpc)throw new Error('OpenCode connection lost during session creation');
    this.byNative.set(r.sessionId,id);this.loaded.add(id);this.configOptions.set(id,r.configOptions||[]);
    return {nativeSessionId:r.sessionId as string,model:model||this.currentModel(r.configOptions||[])};
  }
  currentModel(options:Native[]):ModelIdentity|undefined{const m=options.find(o=>o.id==='model')?.currentValue;if(typeof m!=='string')return;const slash=m.indexOf('/');if(slash<1)return;return{providerId:m.slice(0,slash),modelId:m.slice(slash+1),label:m};}
  async resumeSession(s:Session){
    const rpc=await this.connection(s.cwd);this.byNative.set(s.ref.nativeSessionId,s.id);if(this.loaded.has(s.id))return;
    this.loading.add(s.id);
    try{const r=await rpc.request<Native>('session/load',{sessionId:s.ref.nativeSessionId,cwd:s.cwd,mcpServers:[]});if(this.rpc!==rpc)throw new Error('OpenCode connection lost during load');this.loaded.add(s.id);this.configOptions.set(s.id,r.configOptions||[]);
    const model=this.currentModel(r.configOptions||[]);if(model)this.context.emit(s.id,'model.confirmed',{model});
    if(s.state==='uncertain'||s.state==='cancel_requested')this.context.emit(s.id,'run.updated',{state:'uncertain',detail:'ACP session/load provides history, not detached prompt termination; directory ownership retained'});
    }finally{this.loading.delete(s.id);}
  }
  async submit(s:Session,input:Submission){
    await this.resumeSession(s);if(s.nextModel)await this.configure(s,s.nextModel);
    const prompt:Native[]=[{type:'text',text:input.text}];
    for(const a of input.attachments){const path=join(s.cwd,a.relativePath);if(a.mime.startsWith('image/'))prompt.push({type:'image',mimeType:a.mime,data:a.dataBase64});else prompt.push({type:'resource_link',uri:pathToFileURL(path).href,name:a.name,mimeType:a.mime});}
    this.chunks.delete(s.id);this.chunks.delete(s.id+':thinking');
    // Prompt result is the end-of-turn response; accepting the write is not completion.
    const rpc=this.rpc!;
    void rpc.request<{stopReason?:string}>('session/prompt',{sessionId:s.ref.nativeSessionId,prompt},24*60*60*1000).then(r=>{
      if(this.rpc!==rpc||this.context.getSession(s.id).runId!==input.requestId)return;
      for(const i of this.context.getSession(s.id).interactions)if(i.status==='pending'||i.status==='responding')this.context.emit(s.id,'interaction.closed',{id:i.id,status:i.status==='responding'?'resolved':'stale'});
      this.context.emit(s.id,'run.updated',{state:r.stopReason==='cancelled'?'cancelled':['end_turn','max_tokens','max_turn_requests','refusal'].includes(r.stopReason||'')?'completed':'uncertain'});
    }).catch(e=>{if(this.rpc===rpc)this.fault(s.id,e);});
  }
  async requestCancel(s:Session){this.rpc!.notify('session/cancel',{sessionId:s.ref.nativeSessionId});}
  async configure(s:Session,model:ModelIdentity){const r=await this.rpc!.request<Native>('session/set_config_option',{sessionId:s.ref.nativeSessionId,configId:'model',value:`${model.providerId}/${model.modelId}`});const confirmed=this.currentModel(r.configOptions||[]);if(!confirmed)throw new Error('Native model change was not confirmed');this.context.emit(s.id,'model.confirmed',{model:confirmed});}
  request(m:RpcMessage){
    const p=m.params as Native;const id=this.byNative.get(p?.sessionId);if(!id||m.id===undefined){if(m.id!==undefined)this.rpc!.reject(m.id,'Unmanaged session');return;}
    if(m.method==='session/request_permission')this.interaction(id,m.id,m.method,{title:p.toolCall?.title||'OpenCode 权限请求',detail:JSON.stringify(p.toolCall,null,2),writeRoots:(p.toolCall.locations||[]).map((l:Native)=>dirname(l.path)),choices:p.options.map((o:Native)=>({id:o.optionId,label:o.name,scope:o.kind,allows:['allow_once','allow_always'].includes(o.kind)}))});
    else if(m.method==='elicitation/create'&&p.mode==='form'){
      const props=p.requestedSchema.properties as Native;const questions=Object.entries(props).map(([key,v])=>({id:key,title:v.title||key,options:v.enum||(v.oneOf||v.items?.oneOf||[]).map((o:Native)=>o.const),multiple:v.type==='array',freeText:v.type==='string'&&!v.enum&&!v.oneOf}));
      this.interaction(id,m.id,m.method,{kind:'question',canCancel:true,title:p.message,detail:JSON.stringify(p.requestedSchema,null,2),questions});
    }else this.rpc!.reject(m.id,`Unsupported native client request: ${m.method}`);
  }
  async respond(s:Session,i:Interaction,d:Decision){
    if(i.kind==='permission')this.rpc!.respond(i.nativeId,{outcome:d.cancelled?{outcome:'cancelled'}:{outcome:'selected',optionId:d.choiceId}});
    else {const content:Native={};for(const q of i.questions)content[q.id]=q.multiple?d.answers?.[q.id]||[]:d.answers?.[q.id]?.[0]||'';this.rpc!.respond(i.nativeId,d.cancelled?{action:'cancel'}:{action:'accept',content});}
  }
  notification(m:RpcMessage){
    const p=m.params as Native;const id=this.byNative.get(p?.sessionId);if(!id||this.loading.has(id)||m.method!=='session/update')return;const u=p.update;
    if(u.sessionUpdate==='agent_message_chunk'||u.sessionUpdate==='agent_thought_chunk'){
      if(this.context.getSession(id).state==='accepted')this.context.emit(id,'run.updated',{state:'running',nativeAccepted:true});
      if(u.content?.type!=='text')return;const key=id+(u.sessionUpdate==='agent_thought_chunk'?':thinking':'');let msg=this.chunks.get(key);if(!msg){msg=`${this.context.getSession(id).runId||'history'}:${key}:${Date.now()}`;this.chunks.set(key,msg);}
      this.context.emit(id,'message.delta',{id:msg,text:u.content.text,role:u.sessionUpdate==='agent_thought_chunk'?'reasoning':'assistant'});
    }
    if(u.sessionUpdate==='tool_call'||u.sessionUpdate==='tool_call_update'){
      if(this.context.getSession(id).state==='accepted')this.context.emit(id,'run.updated',{state:'running',nativeAccepted:true});
      this.chunks.delete(id);this.chunks.delete(id+':thinking');
      this.context.emit(id,'tool.updated',{id:u.toolCallId,title:u.title||'工具调用',status:u.status||'pending',detail:JSON.stringify(u.content||u.rawOutput||u.rawInput||{},null,2)});
      const child=u._meta?.['opencode/child-session'];if(child){const previous=this.context.getSession(id).agents.find(a=>a.id===child.id);const state=['running','completed','failed','cancelled','errored','shutdown'].includes(child.status)?child.status:previous?.state||'uncertain';this.context.emit(id,'agent.updated',{id:child.id,title:child.title||child.id,state,detail:JSON.stringify(child)});}
    }
    if(u.sessionUpdate==='config_option_update'){const model=this.currentModel(u.configOptions);if(model)this.context.emit(id,'model.confirmed',{model});}
  }
  close(){const rpc=this.rpc;this.rpc=undefined;this.loaded.clear();this.chunks.clear();this.configOptions.clear();rpc?.close();}
}

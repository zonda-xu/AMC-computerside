import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, Decision, Interaction, ModelIdentity, Session, Submission, Workspace } from '../../protocol/src/types.ts';
import { AdapterBase } from '../common/base.ts';
import { ACTIVE } from '../../protocol/src/types.ts';
import { nativeCommand } from '../common/command.ts';
type Native=Record<string,any>;
interface Live { process:ChildProcessWithoutNullStreams; server:Server; token:string; directory:string; epoch:number; pending:Map<string,{res:ServerResponse;input:Native}>; active:boolean; messageId?:string }
export class ClaudeCodeAdapter extends AdapterBase implements AgentAdapter {
  live=new Map<string,Live>(); starting=new Map<string,Promise<Live>>();
  reservation(nativeId:string){if(!/^[0-9a-f-]{36}$/.test(nativeId))throw new Error('Invalid Claude session UUID');return join(this.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),'ai-maid-reservations',nativeId+'.json');}
  async createSession(id:string,w:Workspace,model?:ModelIdentity){await this.checkVersion();const nativeSessionId=randomUUID();const path=this.reservation(nativeSessionId);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,JSON.stringify({id,cwd:w.path}),{flag:'wx',mode:0o600});return{nativeSessionId};}
  async resumeSession(s:Session){
    if(ACTIVE.includes(s.state)&&!this.live.has(s.id)){this.context.emit(s.id,'run.updated',{state:'uncertain',detail:'Claude CLI cannot verify termination of a detached previous process; retain directory ownership'});throw new Error('Detached Claude run requires native termination verification');}
    await this.start(s);
  }
  async start(s:Session):Promise<Live>{
    const pending=this.starting.get(s.id);if(pending)return pending;
    const work=this.startProcess(s);this.starting.set(s.id,work);try{return await work;}finally{this.starting.delete(s.id);}
  }
  createProcess(args:string[],cwd:string){const native=nativeCommand(this.config.command);return spawn(native.command,[...native.args,...args],{cwd,env:this.env,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});}
  async startProcess(s:Session):Promise<Live>{
    const existing=this.live.get(s.id);if(existing)return existing;
    await this.checkVersion();let reserved=false;try{const value=JSON.parse(await readFile(this.reservation(s.ref.nativeSessionId),'utf8'));if(value.id!==s.id||value.cwd!==s.cwd)throw new Error('Claude reservation identity mismatch');reserved=true;}catch(e){if(!(e instanceof Error)||!('code' in e)||e.code!=='ENOENT')throw e;}
    const token=randomBytes(32).toString('hex');const directory=await mkdtemp(join(tmpdir(),'ai-maid-claude-'));
    const pending:Live['pending']=new Map();
    const server=createServer(async(req,res)=>{
      try{
        const auth=req.headers.authorization?.replace(/^Bearer /,'')||'';
        if(auth.length!==token.length||!timingSafeEqual(Buffer.from(auth),Buffer.from(token))||req.method!=='POST'||req.url!=='/permission'){res.writeHead(403).end();return;}
        let body='';for await(const chunk of req){body+=chunk;if(body.length>1024*1024)throw new Error('Permission payload too large');}
        const call=JSON.parse(body);const input=call.input||{};
        const question=call.tool_name==='AskUserQuestion';
        const i=this.interaction(s.id,randomUUID(),'claude/permission',{kind:question?'question':'permission',canCancel:question,writeRoots:!question&&['Edit','Write'].includes(call.tool_name)&&isAbsolute(input.file_path||'')?[dirname(input.file_path)]:!question&&call.tool_name==='Bash'&&isAbsolute(input.cwd||'')?[input.cwd]:[],title:question?'Claude 需要你的回答':call.tool_name,detail:JSON.stringify(input,null,2),questions:question?(input.questions||[]).map((q:Native)=>({id:q.question,title:q.question,options:(q.options||[]).map((o:Native)=>o.label),multiple:q.multiSelect===true,freeText:true})):[],choices:question?[]:[{id:'allow',label:'仅这一次',scope:'native:tool_call',allows:true},{id:'deny',label:'拒绝',scope:'native:tool_call'}]});
        pending.set(i.id,{res,input});
        res.on('close',()=>{if(pending.delete(i.id))this.context.emit(s.id,'interaction.closed',{id:i.id,status:'stale'});});
      }catch{res.writeHead(400).end();}
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw new Error('Local permission server failed');
    const tokenFile=join(directory,'approval.secret');await writeFile(tokenFile,token,{mode:0o600});
    const mcp=join(directory,'mcp.json');await writeFile(mcp,JSON.stringify({mcpServers:{amc_permissions:{command:process.execPath,args:[fileURLToPath(new URL('./permission-mcp.mjs',import.meta.url))],env:{AMC_APPROVAL_URL:`http://127.0.0.1:${address.port}/permission`,AMC_APPROVAL_TOKEN_FILE:tokenFile}}}}),{mode:0o600});
    const model=s.nextModel||s.model;
    const args=['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--mcp-config',mcp,'--permission-prompt-tool','mcp__amc_permissions__approve',reserved?'--session-id':'--resume',s.ref.nativeSessionId];
    if(model)args.push('--model',model.modelId);
    const epoch=this.context.openConnection([s.id]);
    const child=this.createProcess(args,s.cwd);
    const live:Live={process:child,server,token,directory,epoch,pending,active:false};this.live.set(s.id,live);child.stderr.resume();
    createInterface({input:child.stdout,crlfDelay:Infinity}).on('line',line=>{try{if(line.length>8*1024*1024)throw new Error('CLI frame too large');this.frame(s.id,JSON.parse(line));}catch(e){this.fault(s.id,e);}});
    child.on('error',e=>this.fault(s.id,e));
    child.on('close',()=>{if(live.active)this.fault(s.id,new Error('Claude CLI exited before confirming the turn'));if(this.live.get(s.id)===live)this.live.delete(s.id);server.close();for(const p of pending.values())p.res.destroy();void rm(directory,{recursive:true,force:true});});
    return live;
  }
  async submit(s:Session,input:Submission){
    const live=await this.start(s);if(live.active)throw new Error('A Claude turn is already running');live.active=true;
    const content:Native[]=[{type:'text',text:input.text}];
    for(const a of input.attachments)if(a.mime.startsWith('image/'))content.push({type:'image',source:{type:'base64',media_type:a.mime,data:a.dataBase64}});else content[0].text+='\n附件（项目内路径）：'+a.relativePath;
    live.process.stdin.write(JSON.stringify({type:'user',uuid:input.requestId,session_id:s.ref.nativeSessionId,parent_tool_use_id:null,message:{role:'user',content}})+'\n');
    // Native acceptance comes from the first system/assistant frame, not this stdin write.
  }
  frame(id:string,f:Native){
    const emit=(type:any,data:Native)=>this.context.emit(id,type,data);const live=this.live.get(id)!;
    if(f.session_id&&f.session_id!==this.context.getSession(id).ref.nativeSessionId){this.fault(id,new Error('Claude returned a different native session'));return;}
    if(f.type==='system'&&f.subtype==='init'){if(f.model)emit('model.confirmed',{model:{providerId:'anthropic',modelId:f.model,label:f.model}});if(live.active)emit('run.updated',{state:'running'});}
    if(f.type==='stream_event'){
      const event=f.event;
      if(event.type==='message_start')live['messageId']=event.message.id;
      if(event.type==='content_block_delta'&&event.delta.type==='text_delta')emit('message.delta',{id:live['messageId']||f.uuid,text:event.delta.text,role:'assistant'});
    }
    if(f.type==='assistant'){
      void rm(this.reservation(this.context.getSession(id).ref.nativeSessionId),{force:true}).catch(e=>this.fault(id,e));
      const text=(f.message.content||[]).filter((c:Native)=>c.type==='text').map((c:Native)=>c.text).join('\n');
      if(text)emit('message.completed',{id:f.message.id,text,role:'assistant',model:{providerId:'anthropic',modelId:f.message.model,label:f.message.model}});
      for(const c of f.message.content||[])if(c.type==='tool_use')emit('tool.updated',{id:c.id,title:c.name,status:'running',detail:JSON.stringify(c.input,null,2)});
      emit('run.updated',{state:'running',nativeAccepted:true});
    }
    if(f.type==='user')for(const c of f.message?.content||[])if(c.type==='tool_result')emit('tool.updated',{id:c.tool_use_id,status:c.is_error?'failed':'completed',detail:typeof c.content==='string'?c.content:JSON.stringify(c.content)});
    if(f.type==='result'){
      if(!live.active)return;
      void rm(this.reservation(this.context.getSession(id).ref.nativeSessionId),{force:true}).catch(e=>this.fault(id,e));
      live.active=false;
      for(const i of this.context.getSession(id).interactions)if(i.status==='responding')emit('interaction.closed',{id:i.id});
      const stopping=this.context.getSession(id).state==='cancel_requested';
      emit('run.updated',{state:stopping?(f.stop_reason==='interrupt'||f.stop_reason==='cancelled'?'cancelled':'uncertain'):f.is_error?'failed':'completed'});
      if(f.is_error)emit('error',{message:JSON.stringify(f.errors||f.result||f.subtype)});
    }
    if(f.type==='system'&&f.subtype==='task_notification')emit('agent.updated',{id:f.task_id,title:f.summary||f.task_id,state:f.status,detail:f.output_file||''});
  }
  async requestCancel(s:Session){
    const live=this.live.get(s.id);if(!live)throw new Error('Claude process not attached; native state needs verification');
    live.process.stdin.write(JSON.stringify({type:'control_request',request_id:randomUUID(),request:{subtype:'interrupt'}})+'\n');
  }
  async respond(s:Session,i:Interaction,d:Decision){
    const p=this.live.get(s.id)?.pending.get(i.id);if(!p)throw new Error('Claude permission request is no longer live');
    let result:Native;
    if(i.kind==='question')result=d.cancelled?{behavior:'deny',message:'User cancelled the question'}:{behavior:'allow',updatedInput:{...p.input,answers:Object.fromEntries(Object.entries(d.answers||{}).map(([k,v])=>[k,v.join(', ')]))}};
    else result=d.choiceId==='allow'?{behavior:'allow',updatedInput:p.input}:{behavior:'deny',message:'Denied by user'};
    this.live.get(s.id)!.pending.delete(i.id);p.res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
    this.context.emit(s.id,'interaction.closed',{id:i.id});this.context.emit(s.id,'run.updated',{state:'running'});
  }
  async configure(s:Session,model:ModelIdentity){if(this.live.get(s.id)?.active)throw new Error('Change Claude model between turns');const live=this.live.get(s.id);if(live){live.process.stdin.end();await new Promise<void>(resolve=>live.process.once('close',()=>resolve()));}}
  close(){for(const v of this.live.values()){v.process.stdin.end();v.server.close();}}
}

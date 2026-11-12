import WebSocket from 'ws';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mapDurable } from './mapping.mjs';

// Host semantic boundary based on the documented Session Controller and
// ChenJun25/dsh-console-plugin@566639b… event names. Independently implemented.
export default async function activate(ctx, config = {}) {
  const ctl=ctx.get('sessionController');
  if(!ctl)throw new Error('DSH Session Controller is required');
  const endpoint=new URL(config.gatewayUrl||'ws://127.0.0.1:8898');
  if(endpoint.hostname!=='127.0.0.1'||endpoint.protocol!=='ws:')throw new Error('Bridge endpoint must be local ws://127.0.0.1');
  const token=(await readFile(config.tokenFile,'utf8')).trim();
  let ws;let retry;let stopped=false;let delay=250;
  const managed=new Map();const requests=new Map();const attempts=new Map();const dispose=[];
  const send=(params)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({method:'event',params}));};
  function listen(name,fn,options){dispose.push(ctx.on(name,fn,options));}
  function claim(kind){return(req,next)=>{
    const sessionId=req.agent.id;
    if(!managed.has(sessionId))return next();
    const nativeId=randomUUID();const question=kind==='question';
    const interaction={kind,canCancel:question,title:question?'需要你的回答':req.toolName,detail:question?'DSH 原生用户问题':req.reason,choices:question?[]:[{id:'allowed-once',label:'仅这一次',scope:'native:once',allows:true},{id:'rejected',label:'拒绝',scope:'native:once'},{id:'cancelled',label:'取消',scope:'native:request'}],questions:question?req.questions.map(q=>({id:q.id,title:q.question,options:q.options.map(o=>o.label),multiple:q.multiSelect===true,freeText:true})):[]};
    send({sessionId:sessionId,type:'interaction',nativeId,nativeMethod:question?'user-questions/request':'approval/request',interaction});
    return new Promise((resolvePromise,reject)=>{
      let settled=false;const cancelDesktop=new AbortController();const nativeSignal=req.signal;
      req.signal=nativeSignal?AbortSignal.any([nativeSignal,cancelDesktop.signal]):cancelDesktop.signal;
      const finish=(value)=>{if(settled)return;settled=true;requests.delete(nativeId);resolvePromise(value);send({sessionId:sessionId,type:'interaction.closed',nativeId});};
      requests.set(nativeId,{sessionId:sessionId,kind,interaction,finish,withdraw:()=>cancelDesktop.abort()});
      Promise.resolve(next()).then(value=>{if(value!==undefined&&value!=='unavailable')finish(value);},reject);
      nativeSignal?.addEventListener('abort',()=>finish(question?{answers:[]}:'cancelled'),{once:true});
    });
  };}
  listen('approval/request',claim('permission'),{prepend:true});
  listen('user-questions/request',claim('question'),{prepend:true});
  function publishNative(sessionId,event){
    try{const mapped=mapDurable(event,attempts.get(sessionId));
    for(const item of mapped)send({sessionId,...item});}catch(e){send({sessionId,type:'error',data:{message:e.message}});send({sessionId,type:'run.updated',data:{state:'uncertain'}});}
  }
  listen('session/event',(session,event)=>{if(managed.has(session.id))publishNative(session.id,event);});
  listen('agent/assistant-stream',({agent,frame})=>{
    if(!managed.has(agent.id))return;
    if(frame.type==='start')attempts.set(agent.id,{id:'dsh:attempt:'+frame.attemptId,turn:frame.turn,step:frame.step,next:0,text:'',reasoning:''});
    const attempt=attempts.get(agent.id);if(!attempt)return;
    if(frame.type==='chunk'){
      if(frame.index!==attempt.next++){send({sessionId:agent.id,type:'error',data:{message:'DSH assistant stream index gap; reconcile native history'}});return;}
      if(frame.chunk.type==='text-delta'){attempt.text+=frame.chunk.text;send({sessionId:agent.id,type:'message.delta',data:{id:attempt.id,role:'assistant',text:frame.chunk.text,nativeKey:attempt.turn+':'+attempt.step}});}
      if(frame.chunk.type==='reasoning-delta'){attempt.reasoning+=frame.chunk.text;send({sessionId:agent.id,type:'message.delta',data:{id:attempt.id+':reasoning',role:'reasoning',text:frame.chunk.text,nativeKey:attempt.turn+':'+attempt.step}});}
    }
    if(frame.type==='end'&&frame.outcome.kind==='abandoned'){for(const [role,text] of [['assistant',attempt.text],['reasoning',attempt.reasoning]])if(text)send({sessionId:agent.id,type:'message.completed',data:{id:attempt.id+(role==='reasoning'?':reasoning':''),role,text,nativeKey:attempt.turn+':'+attempt.step}});send({sessionId:agent.id,type:'tool.updated',data:{id:attempt.id+':end',title:'模型尝试中断',status:'failed',detail:'原生流报告此尝试已放弃；任务终态以 turn/end 为准'}});}
  });
  const handlers={
    probe:()=>({version:config.hostVersion}),
    async create(p){const r=await ctl.create({cwd:p.cwd,sessionId:p.requestId});managed.set(r.sessionId,await realpath(p.cwd));return{sessionId:r.sessionId};},
    async state(p){
      const signal=AbortSignal.timeout(30000);const rows=await ctl.list({},signal);const row=rows.items.find(r=>r.sessionId===p.sessionId);
      if(!row||await realpath(row.cwd)!==await realpath(p.cwd))throw new Error('DSH session project identity mismatch');
      managed.set(p.sessionId,await realpath(p.cwd));
      const pages=[];let beforeSeq;
      for(;;){const page=await ctl.events({address:{kind:'session',sessionId:p.sessionId},maxMessages:100,...(beforeSeq?{beforeSeq}:{})},signal);
        pages.unshift(page.records.filter(r=>r.event.seq>p.afterNativeSeq));
        if(!page.hasMore||!page.records.length||page.records[0].event.seq<=p.afterNativeSeq)break;
        const next=page.records[0].event.seq;if(beforeSeq!==undefined&&next>=beforeSeq)throw new Error('DSH history cursor made no progress');beforeSeq=next;
      }
      for(const page of pages)for(const record of page)publishNative(p.sessionId,record.event);
      return ctl.state({sessionId:p.sessionId},signal);
    },
    async prompt(p){
      const cwd=managed.get(p.sessionId);if(!cwd)throw new Error('Unmanaged DSH session');
      const content=[{type:'text',text:p.text}];
      for(const a of p.attachments){const path=await realpath(resolve(cwd,a.relativePath));const r=relative(cwd,path);if(isAbsolute(r)||r==='..'||r.startsWith('..'+sep))throw new Error('Attachment leaves project');
        if(a.mime.startsWith('image/'))content.push({type:'image',mediaType:a.mime,data:a.dataBase64,name:a.name});
        else content[0].text+='\n附件（项目内路径）：'+a.relativePath;
      }
      const r=await ctl.prompt({sessionId:p.sessionId,requestId:p.requestId,mode:'queue',content},AbortSignal.timeout(120000));
      if(r?.accepted!==true)throw new Error('DSH did not confirm native acceptance');return r;
    },
    cancel:p=>ctl.cancel({sessionId:p.sessionId}),
    selectModel:p=>ctl.selectModel({sessionId:p.sessionId,provider:p.provider,model:p.model}),
    respond(p){const r=requests.get(p.nativeId);if(!r||r.sessionId!==p.sessionId)throw new Error('Stale DSH interaction');const value=r.kind==='permission'?p.choiceId:{answers:Object.entries(p.answers||{}).map(([id,selected])=>({id,selected}))};r.finish(value);r.withdraw();return{accepted:true};}
  };
  function connect(){
    if(stopped)return;
    const socket=new WebSocket(endpoint,{headers:{authorization:`Bearer ${token}`}});ws=socket;
    socket.on('open',()=>{delay=250;for(const sessionId of managed.keys())send({sessionId,type:'run.updated',data:{state:'uncertain',detail:'Bridge reconnected; reconcile native history before releasing directory ownership'}});for(const [nativeId,r] of requests)send({sessionId:r.sessionId,type:'interaction',nativeId,nativeMethod:r.kind==='question'?'user-questions/request':'approval/request',interaction:r.interaction});});
    socket.on('message',async raw=>{let m;try{m=JSON.parse(raw.toString());const handler=handlers[m.method];if(!handler)throw new Error('Unsupported bridge command');const result=await handler(m.params);if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({id:m.id,result}));}catch(e){if(m?.id&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({id:m.id,error:e.message}));}});
    socket.on('error',()=>socket.close());
    socket.on('close',()=>{if(stopped)return;retry=setTimeout(connect,delay);delay=Math.min(delay*2,10000);retry.unref?.();});
  }
  connect();
  return()=>{stopped=true;clearTimeout(retry);ws?.close();for(const d of dispose)if(typeof d==='function')d();};
}

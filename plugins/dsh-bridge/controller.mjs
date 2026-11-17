import { randomUUID, createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { service, sessionRows, resolveAgent, modelCatalog, normalizeSelection, validateUploads, promptContent, requestIdentity, nativeReceipts, attachWorkspace, validatePage, validateFollowFrame } from './features.mjs';

export function controllerBridge(ctx,ctl,pluginInstanceId,publish){
  const pending=new Map();const subscriptions=new Map();const sessionSubscriptions=new Map();const states=new Map();const disposers=[];const cancelReceipts=new Map();const promptReceipts=new Map();const slashReceipts=new Map();
  function send(params){publish({method:'event',params:{...params,pluginInstanceId}});}
  async function track(sessionId,frame,signal){
    let records=frame.type==='snapshot'?[...(frame.records||[])]:frame.type==='event'?[frame]:[];
    let more=frame.type==='snapshot'&&frame.hasMore;let before=records[0]?.event?.seq;
    if(more&&(frame.cursor===undefined||before===undefined))throw new Error('DSH snapshot missing pinned page cut');
    while(more&&!records.some(record=>record.event?.type==='turn/start')){const page=await ctl.page({address:{kind:'session',sessionId},throughSeq:frame.cursor,beforeSeq:before,maxMessages:100},signal);const first=page.records?.[0]?.event?.seq;if(first===undefined||before!==undefined&&first>=before)throw new Error('DSH state page did not advance');records=[...page.records,...records];before=first;more=page.hasMore;}
    if(signal?.aborted)return;
    for(const record of records||[]){const event=record.event;if(!event)continue;const state=states.get(sessionId)||{seq:-1};if(event.seq<=state.seq)continue;state.seq=event.seq;if(event.type==='turn/start'){state.turn=event.data.turn;state.active=true;}if(event.type==='turn/end'&&event.data.turn===state.turn&&event.data.reason.kind!=='forked'){state.active=false;for(const entry of pending.values())if(entry.sessionId===sessionId&&entry.turn===state.turn)entry.finishOnce(entry.kind==='permission'?'cancelled':{answers:[]},'native');}states.set(sessionId,state);}
  }
  function register(kind,request,next){
    const sessionId=request.agent?.sessionId||request.agent?.session?.id;
    if(typeof sessionId!=='string')return next();
    // Requests can arrive before the phone follows this session, or while the
    // bridge is disconnected. Read the live Agent's journal, never a history
    // file, so the resolver is associated with the actual open native turn.
    const nativeSession=request.agent?.session;
    if(Number.isSafeInteger(nativeSession?.seq)&&typeof nativeSession.eventAt==='function'){
      for(let seq=nativeSession.seq-1;seq>=0;seq--){
        const event=nativeSession.eventAt(seq);
        if(event?.type==='turn/end'){states.set(sessionId,{seq:nativeSession.seq-1,turn:event.data.turn,active:false});break;}
        if(event?.type==='turn/start'){states.set(sessionId,{seq:nativeSession.seq-1,turn:event.data.turn,active:true});break;}
      }
    }
    const state=states.get(sessionId);if(!state?.active)return next();
    const interactionId=randomUUID();const presentation=new AbortController();
    const originalSignal=request.signal;const nativeRequest={...request};delete nativeRequest.agent;delete nativeRequest.signal;
    const entry={pluginInstanceId,sessionId,turn:state.turn,interactionId,callId:request.callId||request.wait?.callId,kind,request:nativeRequest,settled:false};
    return new Promise((resolve,reject)=>{
      function finishOnce(result,source='phone'){
        if(entry.settled)return false;entry.settled=true;pending.delete(interactionId);originalSignal?.removeEventListener('abort',abort);
        send({sessionId,type:'interaction.closed',interactionId,source});resolve(result);presentation.abort();return true;
      }
      const abort=()=>finishOnce(kind==='permission'?'cancelled':{answers:[]},'native');
      entry.finishOnce=finishOnce;pending.set(interactionId,entry);send({sessionId,type:'interaction',interaction:publicEntry(entry)});
      originalSignal?.addEventListener('abort',abort,{once:true});if(originalSignal?.aborted){abort();return;}
      request.signal=originalSignal?AbortSignal.any([originalSignal,presentation.signal]):presentation.signal;
      Promise.resolve().then(()=>next()).then(result=>{if(kind==='permission'&&result==='unavailable')return;if(kind==='permission'&&!['allowed-once','rejected','cancelled'].includes(result))return;if(kind==='question'&&!Array.isArray(result?.answers))return;finishOnce(result,'desktop');},error=>{if(!presentation.signal.aborted&&!originalSignal?.aborted){entry.desktopError=error instanceof Error?error.message:String(error);}});
    });
  }
  function publicEntry(entry){const {finishOnce,...value}=entry;return value;}
  disposers.push(ctx.on('approval/request',(request,next)=>register('permission',request,next),{prepend:true}));
  disposers.push(ctx.on('user-questions/request',(request,next)=>register('question',request,next),{prepend:true}));
  disposers.push(ctx.on('session/event',(session,event)=>{
    if(!states.has(session.id))return;
    void track(session.id,{type:'event',event}).catch(error=>send({sessionId:session.id,type:'error',message:error.message}));
  }));
  disposers.push(ctx.on('session/disposed',session=>{
    const state=states.get(session.id);if(state)state.active=false;
    for(const entry of pending.values())if(entry.sessionId===session.id)entry.finishOnce(entry.kind==='permission'?'cancelled':{answers:[]},'native');
  }));
  const handlers={
    async attach(p){
      if(p.pluginInstanceId!==pluginInstanceId)throw new Error('DSH plugin generation changed');
      const rows=sessionRows(await ctl.list({},AbortSignal.timeout(30000)));
      const row=rows.find(row=>row.sessionId===p.sessionId);
      if(!row||row.agentAvailable!==true||row.formatStatus!=='current'||row.origin==='subagent')throw new Error('DSH session is not owned by a live ordinary Agent in this host');
      if(typeof row.cwd!=='string'||typeof p.cwd!=='string'||await realpath(row.cwd)!==await realpath(p.cwd))throw new Error('DSH session workspace changed');
      return{pluginInstanceId,sessionId:row.sessionId,cwd:await realpath(row.cwd),agentAvailable:true};
    },
    async create(p){
      const created=await ctl.create({cwd:p.cwd,...(p.agentPreset?{agentPreset:p.agentPreset}:{})});
      if(typeof created?.sessionId!=='string'||!created.sessionId)throw new Error('DSH create returned no session identity');
      return {...created,workspace:await attachWorkspace(ctx,created.sessionId,p.cwd)};
    },
    async models(){return modelCatalog(ctx,ctl);},
    async configure(p){
      if(typeof ctl.selectModel!=='function')throw new Error('DSH model selection unavailable');
      const requested=p.model;
      if(typeof requested?.providerId!=='string'||typeof requested.modelId!=='string')throw new Error('Invalid DSH model');
      const result=await ctl.selectModel({sessionId:p.sessionId,provider:requested.providerId,model:requested.modelId,...(requested.reasoningEffort?{reasoningEffort:requested.reasoningEffort}:{})});
      const selected=normalizeSelection(result?.selected);
      return {selected};
    },
    async slashCommands(p){const agent=await resolveAgent(ctx,ctl,p.sessionId);const commands=service(ctx,'commands');if(typeof commands?.list!=='function')throw new Error('DSH slash commands unavailable');return {commands:await commands.list(agent)};},
    async slash(p){
      if(typeof p.requestId!=='string'||!p.requestId||typeof p.line!=='string'||!p.line.startsWith('/')||p.line.length>100000)throw new Error('Invalid DSH slash request');
      const uploads=validateUploads(p.attachments);
      const key=JSON.stringify([p.sessionId,p.requestId]);const hash=createHash('sha256').update(JSON.stringify([p.line,uploads.map(u=>[u.name,u.mime,u.sha256])])).digest('hex');
      const prior=slashReceipts.get(key);if(prior){if(prior.hash!==hash)throw new Error('DSH slash requestId conflict');return prior.result;}
      if(slashReceipts.size>=5000)throw new Error('DSH slash receipt capacity exceeded');
      const operation={hash};
      operation.result=Promise.resolve().then(async()=>{
        const agent=await resolveAgent(ctx,ctl,p.sessionId);const commands=service(ctx,'commands');
        if(typeof commands?.execute!=='function')throw new Error('DSH slash execution unavailable');
        const parts=await promptContent(ctx,ctl,p.sessionId,'',uploads);
        const result=await commands.execute(agent,p.line,parts,AbortSignal.timeout(120000));
        if(!result)throw new Error('DSH slash command not found');
        // Do not invent an LLM turn or human message for native commands.
        return {accepted:true,result};
      }).then(result=>{operation.receipt={pluginInstanceId,sessionId:p.sessionId,requestId:p.requestId,...result};return result;});
      slashReceipts.set(key,operation);return operation.result;
    },
    async prompt(p){
      if(typeof p.requestId!=='string'||!p.requestId||typeof p.text!=='string'||p.text.length>100000)throw new Error('DSH native requestId and text required');
      const mode=p.mode??'queue';if(!['queue','steer'].includes(mode))throw new Error('Invalid DSH prompt mode');
      const uploads=validateUploads(p.attachments);if(!p.text.trim()&&!uploads.length)throw new Error('DSH prompt is empty');
      const hash=createHash('sha256').update(JSON.stringify([p.text,mode,p.clientTimeZone??'',uploads.map(u=>[u.name,u.mime,u.sha256])])).digest('hex');
      const key=JSON.stringify([p.sessionId,p.requestId]);const prior=promptReceipts.get(key);
      if(prior){if(prior.hash!==hash)throw new Error('DSH requestId already used for different input');return prior.result;}
      if(promptReceipts.size>=5000)throw new Error('DSH prompt receipt capacity exceeded');
      const operation={hash};
      operation.result=Promise.resolve().then(async()=>{
        const existing=(await nativeReceipts(ctx,ctl,p.sessionId)).find(r=>r.requestId===p.requestId);
        if(existing){if(existing.hash&&existing.hash!==hash)throw new Error('DSH requestId already used for different input');return {accepted:true,replayed:true};}
        if(mode==='steer'){const agent=await resolveAgent(ctx,ctl,p.sessionId);if(typeof agent.steer!=='function')throw new Error('DSH steer unavailable');}
        const content=await promptContent(ctx,ctl,p.sessionId,p.text,uploads);
        return ctl.prompt({requestId:requestIdentity(p.requestId,hash),sessionId:p.sessionId,mode,content,...(p.clientTimeZone?{clientTimeZone:p.clientTimeZone}:{})},AbortSignal.timeout(30000));
      }).then(receipt=>{if(receipt?.accepted===true)operation.receipt={pluginInstanceId,sessionId:p.sessionId,requestId:p.requestId,accepted:true};return receipt;});
      promptReceipts.set(key,operation);return operation.result;
    },
    cancel(p){if(p.pluginInstanceId!==undefined&&p.pluginInstanceId!==pluginInstanceId)throw new Error('DSH plugin generation changed');const prior=cancelReceipts.get(p.operationId);if(prior){if(prior.sessionId!==p.sessionId||prior.runId!==p.runId||prior.turn!==p.turn)throw new Error('DSH cancel operation ownership mismatch');return prior;}const state=states.get(p.sessionId);if(!state?.active||p.turn!==state.turn)throw new Error('DSH current turn changed or is not known');const receipt=ctl.cancel({sessionId:p.sessionId});if(receipt?.accepted===true&&typeof p.operationId==='string'&&typeof p.runId==='string'){cancelReceipts.set(p.operationId,{pluginInstanceId,operationId:p.operationId,sessionId:p.sessionId,runId:p.runId,turn:p.turn,accepted:true});}return receipt;},
    async snapshot(p){const projection=await ctl.projections({sessionId:p.sessionId},AbortSignal.timeout(30000));const durable=await nativeReceipts(ctx,ctl,p.sessionId);return{pluginInstanceId,projection,state:states.get(p.sessionId),pending:[...pending.values()].filter(e=>e.sessionId===p.sessionId).map(publicEntry),promptReceipts:[...durable.map(r=>({pluginInstanceId,sessionId:p.sessionId,requestId:r.requestId,accepted:true})),...[...promptReceipts.values()].flatMap(e=>e.receipt?.sessionId===p.sessionId?[e.receipt]:[])],slashReceipts:[...slashReceipts.values()].flatMap(e=>e.receipt?.sessionId===p.sessionId?[e.receipt]:[]),cancelReceipts:[...cancelReceipts.values()].filter(e=>e.sessionId===p.sessionId)};},
    async subscribe(p){if(typeof p.subscriptionId!=='string'||subscriptions.has(p.subscriptionId))throw new Error('Invalid subscriptionId');const previous=sessionSubscriptions.get(p.sessionId);if(previous){subscriptions.get(previous)?.abort();subscriptions.delete(previous);}const controller=new AbortController();subscriptions.set(p.subscriptionId,controller);sessionSubscriptions.set(p.sessionId,p.subscriptionId);void(async()=>{try{for await(const frame of ctl.follow({address:{kind:'session',sessionId:p.sessionId},maxMessages:100,assistantStream:true},controller.signal)){validateFollowFrame(frame);await track(p.sessionId,frame,controller.signal);if(controller.signal.aborted)return;send({sessionId:p.sessionId,subscriptionId:p.subscriptionId,type:'follow',frame});}if(!controller.signal.aborted)throw new Error('DSH follow ended before cancellation');}catch(error){if(!controller.signal.aborted)send({sessionId:p.sessionId,subscriptionId:p.subscriptionId,type:'error',message:error.message});}finally{if(subscriptions.get(p.subscriptionId)===controller)subscriptions.delete(p.subscriptionId);if(sessionSubscriptions.get(p.sessionId)===p.subscriptionId)sessionSubscriptions.delete(p.sessionId);}})();return{subscriptionId:p.subscriptionId};},
    unsubscribe(p){subscriptions.get(p.subscriptionId)?.abort();subscriptions.delete(p.subscriptionId);return{unsubscribed:true};},
    async page(p){return validatePage(await ctl.page({address:{kind:'session',sessionId:p.sessionId},throughSeq:p.throughSeq,...(p.beforeSeq===undefined?{}:{beforeSeq:p.beforeSeq}),maxMessages:100},AbortSignal.timeout(30000)),p.throughSeq);},
    decide(p){if(p.pluginInstanceId!==pluginInstanceId)throw new Error('DSH plugin generation changed');const entry=pending.get(p.interactionId);const state=states.get(p.sessionId);if(!entry||entry.sessionId!==p.sessionId||entry.turn!==p.turn||!state?.active||state.turn!==entry.turn)throw new Error('Interaction already settled or stale');let result;
      if(entry.kind==='permission'){if(!['allowed-once','rejected'].includes(p.outcome))throw new Error('Invalid approval outcome');result=p.outcome;}
       else{if(!Array.isArray(p.answers))throw new Error('Invalid DSH question answers');const answers=[];for(const q of entry.request.questions){const a=p.answers.find(a=>a.id===q.id);if(!a||!Array.isArray(a.selected)||a.selected.some(v=>typeof v!=='string')||new Set(a.selected).size!==a.selected.length||!q.multiSelect&&a.selected.length+(a.custom?1:0)>1||q.options&&a.selected.some(v=>!q.options.some(o=>o.label===v))||a.custom!==undefined&&typeof a.custom!=='string'||!a.selected.length&&!a.custom)throw new Error('Invalid DSH question selection');answers.push({id:q.id,selected:a.selected,...(a.custom?{custom:a.custom}:{})});}result={answers};}
      if(!entry.finishOnce(result))throw new Error('Interaction already settled');return{accepted:true};},
  };
  // A transport disconnect does not end the host's observation. It must still
  // see turn/end and invalidate resolvers that did not carry an AbortSignal.
  // A new subscription replaces its predecessor with a fresh snapshot.
  function disconnect(){}
  return{handlers,pending,states,disconnect,close(){for(const c of subscriptions.values())c.abort();subscriptions.clear();sessionSubscriptions.clear();for(const e of pending.values())e.finishOnce(e.kind==='permission'?'unavailable':{answers:[]},'host');for(const dispose of disposers)if(typeof dispose==='function')dispose();}};
}

export function turnState(reason){
  switch(reason.kind){case'completed':return'completed';case'aborted':return'cancelled';case'error':case'blocked':case'max-tokens':return'failed';case'interrupted':case'forked':return'uncertain';default:throw new Error(`Unknown DSH turn-end reason: ${reason.kind}`);}
}
export function streamText(records=[],type='text-chunks'){return records.map(r=>r.type===type?(r.texts||[]).join(''):r.type===(type==='text-chunks'?'text-delta':'reasoning-delta')?r.text||'':r.chunk?streamText([r.chunk],type):'').join('');}
export function mapDurable(event,attempt){
  const d=event.data;const nativeSeq=event.seq;const out=[];const emit=(type,data)=>out.push({type,data:{...data,nativeSeq}});
  if(event.type==='assistant/message'||event.type==='assistant/attempt'){
    const matched=attempt&&!attempt.abandoned&&!attempt.finalized&&attempt.turn===d.turn&&attempt.step===d.step&&(attempt.committedSeq===undefined||attempt.committedSeq===nativeSeq);
    const id=matched?attempt.id:`dsh:event:${nativeSeq}`;
    const text=streamText(d.stream);const reasoning=streamText(d.stream,'reasoning-chunks');
    const model=d.message?.source?{providerId:d.message.source.provider,modelId:d.message.source.model,label:d.message.source.model}:undefined;
    const temporary=event.type==='assistant/attempt';
    const nativeKey=temporary?(matched?attempt.id:`${d.turn}:${d.step}:attempt:${nativeSeq}`):`${d.turn}:${d.step}`;
    const state={temporary,abandoned:false,...(matched?{attemptId:attempt.attemptId,revision:attempt.revision}:{})};
    if(text||matched)emit('message.completed',{id,role:'assistant',text,nativeKey,...state,...(model?{model}:{})});
    if(reasoning)emit('message.completed',{id:id+':reasoning',role:'reasoning',text:reasoning,nativeKey,...state});
    if(matched)attempt.finalized=true;
  }else if(event.type==='tool/call')emit('tool.updated',{id:d.callId,title:d.name,status:'running',detail:d.arguments});
  else if(event.type==='tool/result')emit('tool.updated',{id:d.message.toolCallId,status:d.message.isError?'failed':'completed',detail:JSON.stringify({content:d.message.content,error:d.error,meta:d.meta})});
    else if(event.type==='turn/start')emit('run.updated',{state:'running',nativeAccepted:true,nativeTurnId:d.turn,nativeRunId:String(d.turn)});
    else if(event.type==='turn/end'&&d.reason.kind!=='forked')emit('run.updated',{state:turnState(d.reason),detail:JSON.stringify(d.reason),nativeTurnId:d.turn,nativeRunId:String(d.turn),reasonCode:d.reason.kind==='max-tokens'?'output_limit':d.reason.kind});
  else if(event.type==='request/context')emit('model.confirmed',{model:{providerId:d.provider,modelId:d.model,label:d.model}});
  return out;
}

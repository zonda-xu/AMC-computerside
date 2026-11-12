// Wire contract pinned to deepseek-harness fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159.
export function turnState(reason){
  switch(reason.kind){case'completed':case'max-tokens':return'completed';case'aborted':return'cancelled';case'error':case'blocked':return'failed';case'interrupted':case'forked':return'uncertain';default:throw new Error(`Unknown DSH turn-end reason: ${reason.kind}`);}
}
export function streamText(records,type='text-chunks'){return records.filter(r=>r.type===type).flatMap(r=>r.texts).join('');}
export function mapDurable(event,attempt){
  const d=event.data;const nativeSeq=event.seq;const out=[];const emit=(type,data)=>out.push({type,data:{...data,nativeSeq}});
  if(event.type==='assistant/message'||event.type==='assistant/attempt'){
    const id=attempt&&attempt.turn===d.turn&&attempt.step===d.step?attempt.id:`dsh:event:${nativeSeq}`;
    const text=streamText(d.stream);const reasoning=streamText(d.stream,'reasoning-chunks');
    const model=d.message?{providerId:d.message.source.provider,modelId:d.message.source.model,label:d.message.source.model}:undefined;
    const nativeKey=`${d.turn}:${d.step}`;
    if(text)emit('message.completed',{id,role:'assistant',text,nativeKey,...(model?{model}:{})});
    if(reasoning)emit('message.completed',{id:id+':reasoning',role:'reasoning',text:reasoning,nativeKey});
  }else if(event.type==='tool/call')emit('tool.updated',{id:d.callId,title:d.name,status:'running',detail:d.arguments});
  else if(event.type==='tool/result')emit('tool.updated',{id:d.message.toolCallId,status:d.message.isError?'failed':'completed',detail:JSON.stringify({content:d.message.content,error:d.error,meta:d.meta})});
  else if(event.type==='turn/start')emit('run.updated',{state:'running',nativeAccepted:true});
  else if(event.type==='turn/end')emit('run.updated',{state:turnState(d.reason),detail:JSON.stringify(d.reason)});
  else if(event.type==='request/context')emit('model.confirmed',{model:{providerId:d.provider,modelId:d.model,label:d.model}});
  return out;
}

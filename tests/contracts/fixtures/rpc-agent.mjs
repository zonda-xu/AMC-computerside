import { createInterface } from 'node:readline';
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(!m.id)return;
  if(m.method==='initialize'&&process.env.RPC_REJECT_INITIALIZE==='1'){send({id:m.id,error:{code:-32603,message:'fixture initialization rejected'}});return;}
  let result={};
  if(m.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true}};
  if(m.method==='thread/resume'){
    send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'old-turn',status:'completed'}}});
    result={modelProvider:'openai',model:'test-model',thread:{status:{type:'idle'},turns:[{id:'old-turn',status:'completed',items:[]}]}};
  }
  if(m.method==='turn/start'){
    if(process.env.RPC_EARLY_COMPLETION==='1'){send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'new-turn',status:'completed'}}});send({id:m.id,result:{turn:{id:'new-turn'}}});return;}
    setTimeout(()=>{send({method:'turn/started',params:{threadId:m.params.threadId,turn:{id:'new-turn'}}});send({id:m.id,result:{turn:{id:'new-turn'}}});},80);
    return;
  }
  if(m.method==='session/load'){
    send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'old history'}}}});
    send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'tool_call_update',toolCallId:'historical-tool',status:'completed',_meta:{'opencode/child-session':{id:'child',status:'completed'}}}}});
    result={configOptions:[]};
  }
  if(m.method==='session/prompt')result={stopReason:process.env.RPC_STOP_REASON||'end_turn'};
  send({id:m.id,result});
});

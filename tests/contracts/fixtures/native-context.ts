import type { AdapterContext, EngineId, EventType, Session, Workspace } from '../../../packages/protocol/src/types.ts';
export function nativeContext(engineId:EngineId='codex'){
  const session:Session={id:'managed',ref:{hostId:'host',workspaceId:'workspace',runtimeInstanceId:'runtime',engineId,nativeSessionId:'native'},cwd:process.cwd(),title:'Contract',state:'idle',epoch:1,messages:[],tools:[],agents:[],interactions:[],watermark:0,updatedAt:0,historyStart:0};
  const events:Array<{type:EventType;data:Record<string,any>}>=[];
  const context:AdapterContext={runtimeInstanceId:'runtime',epoch:1,openConnection:()=>1,getSession:()=>session,bindSession:(_,binding)=>{session.binding=binding;},emit:(_,type,data)=>{events.push({type,data});if(type==='run.updated'){session.state=data.state as Session['state'];if(typeof data.runId==='string')session.runId=data.runId;}if(type==='interaction.created')session.interactions.push(data as unknown as Session['interactions'][number]);if(type==='interaction.closed'){const i=session.interactions.find(i=>i.id===data.id);if(i)i.status='resolved';}}};
  const workspace:Workspace={id:'workspace',hostId:'host',name:'Contract',path:process.cwd(),writeRoots:[process.cwd()]};
  return{session,context,events,workspace};
}
export async function until(predicate:()=>boolean){for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Contract condition timed out');}

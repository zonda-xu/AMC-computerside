import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Core } from '../apps/gateway/src/core.ts';
import { Store } from '../apps/gateway/src/store.ts';
import type { AgentAdapter, AdapterContext, Command, Decision, Interaction, ModelIdentity, Session, Submission, Workspace } from '../packages/protocol/src/types.ts';
export class TestAdapter implements AgentAdapter {
  engineId='codex' as const;epoch=1;context:AdapterContext;submitted=0;decisions=0;
  constructor(context:AdapterContext){this.context=context;}
  async probe(){return{id:this.engineId,runtimeInstanceId:this.context.runtimeInstanceId,version:'test-double',installed:true,authentication:'ready' as const,verified:false,detail:'TEST DOUBLE',capabilities:{text:true,image:true,files:true,history:true,permission:true,questions:true,cancelScope:'turn',models:true},models:[{providerId:'openai',modelId:'test-model',label:'test-model'}]};}
  async createSession(){return{nativeSessionId:'same-native-id'};}
  async resumeSession(){}
  async submit(s:Session,input:Submission){this.submitted++;this.context.emit(s.id,'run.updated',{state:'running',nativeAccepted:true});}
  async requestCancel(){}
  async respond(){this.decisions++;}
  async configure(){}
  close(){}
}
export async function fixture(hostId='test-host'){
  const dir=await realpath(await mkdtemp(join(tmpdir(),'amc-test-')));const root=join(dir,'projects');await mkdir(root);const a=join(root,'a');const b=join(root,'b');await mkdir(a);await mkdir(b);
  const store=new Store(join(dir,'console.sqlite'));const core=new Core(store,hostId,[root]);const adapter=new TestAdapter(core.context('codex'));core.adapters.set('codex',adapter);const w=await core.registerWorkspace(a,'A');const wb=await core.registerWorkspace(b,'B');const s=await core.createSession('device','create-1',w.id,'codex');
  return{dir,root,store,core,adapter,w,wb,s,close:async()=>{await core.drain();store.close();await rm(dir,{recursive:true,force:true});}};
}
export function command(s:Session,action='submit',payload:Record<string,unknown>={text:'Update README',attachmentIds:[]}):Command{return{protocolVersion:1,hostId:s.ref.hostId,clientRequestId:randomUUID(),sessionId:s.id,ref:s.ref,action:action as Command['action'],payload};}
export const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));


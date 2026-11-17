import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type { AdapterContext, Capabilities, ControlCapabilities, EngineId, Interaction, ModelIdentity, RuntimeDescriptor, RuntimeBinding, Session } from '../../protocol/src/types.ts';
import { nativeEnvironment } from './rpc.ts';
import { nativeCommand } from './command.ts';
import { ACTIVE } from '../../protocol/src/types.ts';
import { assessComponentVersion, type CompatibilityPolicy } from '../../protocol/src/compatibility.ts';
export interface RuntimeConfig { command: string; expectedVersion: string; enabled?: boolean; env?:Record<string,string>; models?: ModelIdentity[]; bridgeTokenFile?: string; endpoint?:string; runtimeIdentity?:string; sdkModule?:string; serviceModule?:string; executablePath?:string;compatibilityMode?:CompatibilityPolicy['mode'] }
export const unavailableCapabilities:Capabilities={text:false,image:false,files:false,history:false,permission:false,questions:false,cancelScope:'unavailable',models:false};
export class AdapterBase {
  private catalogs=new Map<string,{until:number;promise:Promise<ModelIdentity[]>}>();
  protected cachedModels(scope:string,read:()=>Promise<ModelIdentity[]>):Promise<ModelIdentity[]>{
    const key=JSON.stringify([this.context.runtimeInstanceId,this.epoch,this.config.runtimeIdentity,this.config.endpoint,scope]);
    const old=this.catalogs.get(key);if(old&&old.until>Date.now())return old.promise;
    const promise=read().catch(error=>{this.catalogs.delete(key);throw error;});
    if(this.catalogs.size>32)this.catalogs.clear();this.catalogs.set(key,{until:Date.now()+30000,promise});return promise;
  }
  engineId:EngineId; config:RuntimeConfig; context:AdapterContext; epoch:number;
  constructor(engine:EngineId,config:RuntimeConfig,ctx:AdapterContext){this.engineId=engine;this.config=config;this.context=ctx;this.epoch=ctx.epoch;}
  get env(){return nativeEnvironment(this.engineId,this.config.env);}
  binding(nativeSessionId:string,capabilities:ControlCapabilities,nativeIdentity?:string):RuntimeBinding{return{runtimeInstanceId:this.context.runtimeInstanceId,generation:this.epoch,nativeSessionId,state:'attached',capabilities,nativeIdentity};}
  attachSession(session:Session,capabilities:ControlCapabilities,nativeIdentity?:string){this.context.bindSession?.(session.id,this.binding(session.ref.nativeSessionId,capabilities,nativeIdentity));}
  async probe():Promise<RuntimeDescriptor>{
    try{
      if(this.config.enabled===false)throw new Error('Runtime disabled');
      const native=nativeCommand(this.config.command);
      const {stdout}=await promisify(execFile)(native.command,[...native.args,'--version'],{env:this.env,timeout:10_000,windowsHide:true});
      const version=stdout.trim();const pinned=this.config.expectedVersion && version===this.config.expectedVersion;
      return {id:this.engineId,runtimeInstanceId:this.context.runtimeInstanceId,version,installed:true,authentication:'unknown',verified:false,detail:pinned?'Version matched; native connection not established':'Native version does not match configuration',capabilities:{...unavailableCapabilities},models:[]};
    }catch(e){return{id:this.engineId,runtimeInstanceId:this.context.runtimeInstanceId,version:'',installed:false,authentication:'unknown',verified:false,detail:e instanceof Error?e.message:String(e),capabilities:{...unavailableCapabilities},models:[]};}
  }
  async checkVersion(){if(this.config.enabled===false)throw new Error(`${this.engineId}: runtime disabled`);const r=await AdapterBase.prototype.probe.call(this);if(!r.installed)throw new Error(`${this.engineId}: native executable is unavailable`);if(this.engineId==='deepseek-harness'){if(this.config.compatibilityMode==='pinned'&&r.version!==this.config.expectedVersion)throw new Error('DSH pinned CLI version mismatch');return;}const assessed=assessComponentVersion(this.engineId,'cli',r.version,this.config.compatibilityMode,this.config.expectedVersion);if(!assessed.permittedToProbe)throw new Error(`${this.engineId}: ${assessed.reason}`);}
  pendingControls(sessionId:string){const s=this.context.getSession(sessionId);if(s.ref.engineId!==this.engineId||s.ref.runtimeInstanceId!==this.context.runtimeInstanceId)return[];return(this.context.pendingCommands?.(sessionId)||[]).filter(p=>['received','uncertain'].includes(p.receipt.status)&&(p.receipt.generation===undefined||p.receipt.generation===p.command.payload.expectedGeneration)&&p.command.sessionId===s.id&&p.command.ref.hostId===s.ref.hostId&&p.command.ref.workspaceId===s.ref.workspaceId&&p.command.ref.runtimeInstanceId===s.ref.runtimeInstanceId&&p.command.ref.engineId===s.ref.engineId&&p.command.ref.nativeSessionId===s.ref.nativeSessionId);}
  acceptSubmission(sessionId:string,nativeRequestId:unknown,nativeRunId?:string){if(typeof nativeRequestId!=='string'||!nativeRequestId)return;for(const p of this.pendingControls(sessionId)){if(!['submit','steer'].includes(p.command.action))continue;const run=p.command.action==='steer'?undefined:p.receipt.runId?this.context.getRun?.(p.receipt.runId):undefined;if(run&&(run.sessionId!==sessionId||run.clientRequestId!==p.clientRequestId||run.deviceId!==p.deviceId||run.generation!==p.command.payload.expectedGeneration))continue;const expected=p.receipt.nativeRequestId||run?.nativeRequestId;if(expected===nativeRequestId)this.context.reconcileReceipt?.(p.deviceId,p.clientRequestId,{status:'native_accepted',nativeRunId,detail:'Native input identity confirmed; no input was resent'});}}
  cancelOperation(s:Session){const candidates=this.pendingControls(s.id).filter(p=>p.command.action==='cancel'&&p.command.payload.runId===s.runId&&p.command.payload.expectedGeneration===(s.runGeneration??s.binding?.generation??s.epoch));if(candidates.length!==1)return;const p=candidates[0];return{...p,operationId:createHash('sha256').update(JSON.stringify([p.deviceId,p.clientRequestId])).digest('hex')};}
  interaction(sessionId:string,nativeId:string|number,method:string,fields:Partial<Interaction>):Interaction {
    const session=this.context.getSession(sessionId);const i:Interaction={id:randomUUID(),sessionId,kind:'permission',epoch:session.epoch,generation:session.binding?.generation??session.epoch,runId:session.runId,runtimeInstanceId:this.context.runtimeInstanceId,title:method,detail:'',choices:[],questions:[],status:'pending',nativeId,nativeMethod:method,...fields};
    this.context.emit(sessionId,'interaction.created',i as unknown as Record<string,unknown>);
    this.context.emit(sessionId,'run.updated',{state:i.kind==='permission'?'waiting_permission':'waiting_input',nativeAccepted:true});return i;
  }
  fault(sessionId:string,e:unknown){this.context.emit(sessionId,'error',{message:e instanceof Error?e.message:String(e),engineId:this.engineId});if(ACTIVE.includes(this.context.getSession(sessionId).state))this.context.emit(sessionId,'run.updated',{state:'uncertain'});}
}

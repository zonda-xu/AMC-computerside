import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { AdapterContext, Capabilities, EngineId, Interaction, ModelIdentity, RuntimeDescriptor } from '../../protocol/src/types.ts';
import { nativeEnvironment } from './rpc.ts';
import { nativeCommand } from './command.ts';
import { ACTIVE } from '../../protocol/src/types.ts';
export interface RuntimeConfig { command: string; expectedVersion: string; enabled?: boolean; env?:Record<string,string>; models?: ModelIdentity[]; bridgeTokenFile?: string }
export const fullCapabilities:Capabilities={text:true,image:true,files:true,history:true,permission:true,questions:true,cancelScope:'当前轮次',models:true};
export class AdapterBase {
  engineId:EngineId; config:RuntimeConfig; context:AdapterContext; epoch:number;
  constructor(engine:EngineId,config:RuntimeConfig,ctx:AdapterContext){this.engineId=engine;this.config=config;this.context=ctx;this.epoch=ctx.epoch;}
  get env(){return nativeEnvironment(this.engineId,this.config.env);}
  async probe():Promise<RuntimeDescriptor>{
    try{
      if(this.config.enabled===false)throw new Error('Runtime disabled');
      const native=nativeCommand(this.config.command);
      const {stdout}=await promisify(execFile)(native.command,[...native.args,'--version'],{env:this.env,timeout:10_000,windowsHide:true});
      const version=stdout.trim();const pinned=this.config.expectedVersion && version===this.config.expectedVersion;
      return {id:this.engineId,runtimeInstanceId:this.context.runtimeInstanceId,version,installed:true,authentication:'unknown',verified:false,detail:pinned?'版本符合配置；真实端到端验收尚未记录':'接入未完成：请固定完整 --version 输出并完成契约验收',capabilities:fullCapabilities,models:this.config.models||[]};
    }catch{return{id:this.engineId,runtimeInstanceId:this.context.runtimeInstanceId,version:'',installed:false,authentication:'unknown',verified:false,detail:'未找到原生程序；请在主机安装并完成官方登录',capabilities:fullCapabilities,models:[]};}
  }
  async checkVersion(){if(this.config.enabled===false)throw new Error(`${this.engineId}: runtime disabled`);const r=await this.probe();if(!r.installed||r.version!==this.config.expectedVersion)throw new Error(`${this.engineId}: exact expectedVersion must match native --version output`);}
  interaction(sessionId:string,nativeId:string|number,method:string,fields:Partial<Interaction>):Interaction {
    const i:Interaction={id:randomUUID(),sessionId,kind:'permission',epoch:this.context.getSession(sessionId).epoch,title:method,detail:'',choices:[],questions:[],status:'pending',nativeId,nativeMethod:method,...fields};
    this.context.emit(sessionId,'interaction.created',i as unknown as Record<string,unknown>);
    this.context.emit(sessionId,'run.updated',{state:i.kind==='permission'?'waiting_permission':'waiting_input',nativeAccepted:true});return i;
  }
  fault(sessionId:string,e:unknown){this.context.emit(sessionId,'error',{message:e instanceof Error?e.message:String(e),engineId:this.engineId});if(ACTIVE.includes(this.context.getSession(sessionId).state))this.context.emit(sessionId,'run.updated',{state:'uncertain'});}
}

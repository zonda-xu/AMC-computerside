import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { nativeCommand } from '../common/command.ts';
import { nativeEnvironment } from '../common/rpc.ts';
import type { RuntimeConfig } from '../common/base.ts';

export function isDevEco(command:string):boolean {
  return /^deveco(?:\.exe|\.cmd)?$/i.test(basename(command.replaceAll('\\','/')));
}
interface LocalService { url:string; pid:number; password:string; store:string; command:string; profile?:string }
export async function devEcoEndpoint(root:string,config:RuntimeConfig,start=false) {
  const file=join(root,'deveco-service.json');
  const native=nativeCommand(config.command);
  const env=nativeEnvironment('opencode',config.env);
  // Distinguish data profiles without persisting provider credentials.
  const scope=createHash('sha256').update(JSON.stringify([native.command,native.args,env.XDG_DATA_HOME||'',env.DEVECO_DB||'',env.USERPROFILE||env.HOME||''])).digest('hex');
  const profile=createHash('sha256').update(JSON.stringify([env.XDG_CONFIG_HOME,env.DEVECO_CONFIG_DIR,env.DEVECO_CONFIG,env.OPENCODE_CONFIG_DIR,env.OPENCODE_CONFIG])).digest('hex');
  let record:LocalService|undefined;
  try{record=JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(record && (record.store!==scope||record.command!==config.command||record.profile && record.profile!==profile))throw Error('DevEco Code 数据目录、配置来源或程序已改变，请登记对应运行时');
  let live=false;
  if(record){
    if(!Number.isSafeInteger(record.pid)||record.pid<=0)throw Error('DevEco Code 运行时登记无效');
    try{process.kill(record.pid,0);live=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
  }
  if(!live){
    if(!start)throw Error('请在电脑工作台启动 DevEco Code 运行时');
    const probe=createServer();
    await new Promise<void>((ok,fail)=>{probe.once('error',fail);probe.listen(0,'127.0.0.1',ok);});
    const port=(probe.address() as {port:number}).port;
    await new Promise<void>((ok,fail)=>probe.close(e=>e?fail(e):ok()));
    const password=randomBytes(32).toString('base64url');
    const child=spawn(native.command,[...native.args,'serve','--hostname','127.0.0.1','--port',String(port)],{
      env:{...env,OPENCODE_SERVER_USERNAME:'cafe',OPENCODE_SERVER_PASSWORD:password,DEVECO_SERVER_USERNAME:'cafe',DEVECO_SERVER_PASSWORD:password},
      detached:true,stdio:'ignore',windowsHide:true
    });
    await new Promise<void>((ok,fail)=>{child.once('error',fail);child.once('spawn',ok);});child.unref();
    record={url:'http://127.0.0.1:'+port,pid:child.pid!,password,store:scope,command:config.command,profile};
    const temp=file+'.'+randomUUID();
    try{await writeFile(temp,JSON.stringify(record),{mode:0o600,flag:'wx'});await rename(temp,file);}
    catch(e){child.kill();await rm(temp,{force:true});throw e;}
  }
  if(!record||!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(record.url)||!record.password)throw Error('DevEco Code 本机登记无效');
  const headers:Record<string,string>={authorization:'Basic '+Buffer.from('cafe:'+record.password).toString('base64')};
  const options={headers,redirect:'error' as const};
  for(let attempt=0;;attempt++){
    try{
      const reply=await fetch(record.url+'/global/health',{...options,signal:AbortSignal.timeout(1800)});
      const health=await reply.json() as {healthy:boolean;version:string};
      if(!reply.ok||health.healthy!==true||!health.version)throw Error('DevEco Code 健康检查失败');
      const challenge=await fetch(record.url+'/session/status',{redirect:'error',signal:AbortSignal.timeout(2000)});
      await challenge.body?.cancel();if(challenge.status!==401)throw Error('DevEco Code 服务未启用本机认证');
      return {url:record.url,headers,identity:'deveco:'+scope,version:health.version,pid:record.pid};
    }catch(e){if(live||!start||attempt>=36)throw e;await new Promise(ok=>setTimeout(ok,200));}
  }
}

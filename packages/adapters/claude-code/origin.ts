import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, realpath, lstat, readdir, rm, unlink } from 'node:fs/promises';
import { nativeCommand } from '../common/command.ts';

export async function accountScope(executable: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const native=nativeCommand(executable);
    const {stdout}=await promisify(execFile)(native.command,[...native.args,'auth','status','--json'],{env,cwd,timeout:8000,windowsHide:true,maxBuffer:32768});
    const account=JSON.parse(stdout);
    if(account.loggedIn!==true || !(account.email || account.accountUuid || account.orgId || env.ANTHROPIC_API_KEY)) return;
    // Include project route overrides as well as the process environment.
    const config=resolve(env.CLAUDE_CONFIG_DIR || join(homedir(),'.claude'));
    const routes: Record<string,string>={};
    for(const file of [join(config,'settings.json'),join(cwd,'.claude','settings.json'),join(cwd,'.claude','settings.local.json')]){
      const raw=await readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return '{}';throw e;});
      const settings=JSON.parse(raw);
      if(settings.apiKeyHelper && !(account.email || account.accountUuid)) return;
      for(const [key,value] of Object.entries(settings.env || {})) if(/BASE_URL|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|API_KEY|AUTH_TOKEN/.test(key))routes[key]=String(value);
    }
    for(const [key,value] of Object.entries(env)) if(/^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_REGION|CLOUD_ML_REGION)/.test(key) && /BASE_URL|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|API_KEY|AUTH_TOKEN|REGION/.test(key)) routes[key]=value||'';
    return createHash('sha256').update(JSON.stringify([await realpath(cwd),config,account.authMethod,account.apiProvider,account.email,account.accountUuid,account.orgId,Object.entries(routes).sort()])).digest('hex');
  } catch { return; }
}

export async function transcriptRemoval(root: string, uuid: string, cwd: string, pending: boolean) {
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid))throw new Error('Claude 原生会话编号无效');
  const base=await realpath(root), matches:string[]=[];
  for(const child of await readdir(base,{withFileTypes:true})){
    if(!child.isDirectory() || child.isSymbolicLink())continue;
    const path=join(base,child.name,uuid+'.jsonl');
    const st=await lstat(path).catch(e=>{if(e.code==='ENOENT')return;throw e;});
    if(st){if(!st.isFile()||st.isSymbolicLink()||await realpath(path)!==path)throw new Error('Claude 历史路径已改变');matches.push(path);}
  }
  if(!matches.length && pending)return async()=>{};
  if(matches.length!==1)throw new Error('无法唯一定位 Claude 原始记录');
  const file=matches[0], dir=file.slice(0,-6);
  const {open}=await import('node:fs/promises');
  const fd=await open(file,'r'); let verified=false;
  try {
    const head=Buffer.alloc(512*1024); const {bytesRead}=await fd.read(head,0,head.length,0);
    for(const line of head.toString('utf8',0,bytesRead).split('\n')){
      let record; try{record=JSON.parse(line);}catch{continue;}
      if(record.sessionId===uuid && typeof record.cwd==='string' && await realpath(record.cwd).catch(()=>'')===cwd){verified=true;break;}
    }
  } finally {await fd.close();}
  if(!verified)throw new Error('Claude 原始记录的项目或会话身份无法核验');
  const identity=await lstat(file,{bigint:true});
  return async()=>{
    const current=await lstat(file,{bigint:true});
    if(current.dev!==identity.dev || current.ino!==identity.ino || current.mtimeNs!==identity.mtimeNs || await realpath(file)!==file)throw new Error('Claude 对话正在变化，已停止删除');
    const children=join(dir,'subagents');
    const child=await lstat(children).catch(e=>{if(e.code==='ENOENT')return;throw e;});
    if(child) {
      if(!child.isDirectory()||child.isSymbolicLink()||await realpath(dir)!==dir||await realpath(children)!==children)throw new Error('Claude 子代理记录位置异常');
      await rm(children,{recursive:true});
    }
    await unlink(file);
  };
}

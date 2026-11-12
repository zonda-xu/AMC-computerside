import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Store } from './store.ts';
import { Core } from './core.ts';
import { makeServer } from './server.ts';
import { canonical } from './files.ts';
import { CodexAdapter } from '../../../packages/adapters/codex/index.ts';
import { ClaudeCodeAdapter } from '../../../packages/adapters/claude-code/index.ts';
import { OpenCodeAdapter } from '../../../packages/adapters/opencode/index.ts';
import { DshAdapter } from '../../../packages/adapters/deepseek-harness/index.ts';
import type { RuntimeConfig } from '../../../packages/adapters/common/base.ts';
import type { EngineId } from '../../../packages/protocol/src/types.ts';
export interface HostConfig { hostId:string;name:string;os:string;listen:string;port:number;publicEndpoint:string;dataDir:string;caFile:string;certFile:string;keyFile:string;allowedWorkspaceRoots:string[];runtimes:Record<EngineId,RuntimeConfig> }
const configPath=process.argv[2]||'host.config.json';
const c=JSON.parse(await readFile(configPath,'utf8')) as HostConfig;
if(!c.hostId||!c.name||c.port!==8899||!c.allowedWorkspaceRoots?.length)throw new Error('Invalid host configuration');
const stateDir=process.env.AMC_STATE_DIR||join(homedir(),'.ai-maid-cafe');await mkdir(stateDir,{recursive:true,mode:0o700});
const lockPath=join(stateDir,'gateway.lock');
try { const old=JSON.parse(await readFile(lockPath,'utf8'));let running=true;try{process.kill(old.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')running=false;}if(running)throw new Error('A gateway already runs for this OS user');await unlink(lockPath); }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid}));await lock.close();
await mkdir(c.dataDir,{recursive:true,mode:0o700});
const store=new Store(join(c.dataDir,'console.sqlite'));store.recover();
const core=new Core(store,c.hostId,await Promise.all(c.allowedWorkspaceRoots.map(canonical)));
core.adapters.set('codex',new CodexAdapter('codex',c.runtimes.codex,core.context('codex')));
core.adapters.set('claude-code',new ClaudeCodeAdapter('claude-code',c.runtimes['claude-code'],core.context('claude-code')));
core.adapters.set('opencode',new OpenCodeAdapter('opencode',c.runtimes.opencode,core.context('opencode')));
const dsh=new DshAdapter('deepseek-harness',c.runtimes['deepseek-harness'],core.context('deepseek-harness'));core.adapters.set('deepseek-harness',dsh);
const server=makeServer(core,{cert:await readFile(c.certFile),key:await readFile(c.keyFile),minVersion:'TLSv1.2'},{name:c.name,os:c.os});
const bridgeToken=(await readFile(c.runtimes['deepseek-harness'].bridgeTokenFile!,'utf8')).trim();
const bridgeHTTP=createServer((_req,res)=>res.writeHead(404).end());const bridgeWS=new WebSocketServer({noServer:true,maxPayload:8*1024*1024});
bridgeHTTP.on('upgrade',(req,socket,head)=>{const token=req.headers.authorization?.replace(/^Bearer /,'')||'';if(token.length!==bridgeToken.length||!timingSafeEqual(Buffer.from(token),Buffer.from(bridgeToken))){socket.destroy();return;}bridgeWS.handleUpgrade(req,socket,head,ws=>dsh.attach(ws));});
let stopping=false;
async function shutdown(code=0){if(stopping)return;stopping=true;server.close();bridgeHTTP.close();bridgeWS.close();for(const a of core.adapters.values())a.close();await unlink(lockPath).catch(()=>{});store.close();process.exit(code);}
const listen=(server:import('node:net').Server,port:number,address:string)=>new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,address,resolve);});
try{await Promise.all([listen(bridgeHTTP,8898,'127.0.0.1'),listen(server,c.port,c.listen)]);console.log(`AI Maid Café: ${c.name} (${c.hostId}) — ${c.listen}:${c.port}`);process.send?.({type:'ready'});}catch(e){console.error((e as Error).message);await shutdown(1);}
process.on('message',message=>{const m=message as {type?:string;id?:string};if(m.type==='shutdown')void shutdown();if(m.type==='revoke'&&m.id)core.emit('device-revoked',m.id);});
if(process.send)process.once('disconnect',()=>void shutdown());
process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());

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
import { CodexExternalProvider } from '../../../packages/adapters/codex/external.ts';
import { ClaudeCodeAdapter } from '../../../packages/adapters/claude-code/index.ts';
import { ClaudeExternalProvider } from '../../../packages/adapters/claude-code/external.ts';
import { OpenCodeAdapter } from '../../../packages/adapters/opencode/index.ts';
import { OpenCodeExternalProvider } from '../../../packages/adapters/opencode/external.ts';
import { DevEcoCodeAdapter, DevEcoExternalProvider } from '../../../packages/adapters/opencode/deveco.ts';
import { isDevEco } from '../../../packages/adapters/opencode/deveco-service.ts';
import { DshAdapter } from '../../../packages/adapters/deepseek-harness/index.ts';
import { DshExternalProvider } from '../../../packages/adapters/deepseek-harness/external.ts';
import type { RuntimeConfig } from '../../../packages/adapters/common/base.ts';
import type { EngineId } from '../../../packages/protocol/src/types.ts';
import { automationSettings, type AutomationConfig } from './automation.ts';
import { WorkspaceDiscovery } from './workspace-discovery.ts';
import { ExternalSync } from './external-sync.ts';
import { PushCoordinator } from './push.ts';
import { HuaweiPushTransport, type HuaweiPushConfig } from './huawei-push.ts';
import { RuntimeManager } from '../../desktop/src/runtime.ts';
import { desktopCatalog } from './desktop-catalog.ts';
import { RuntimeRecovery } from './runtime-recovery.ts';
import { RuntimeUpdateMonitor, type RuntimeUpdateConfig } from './runtime-updates.ts';
export interface HostConfig { hostId:string;name:string;os:string;listen:string;port:number;publicEndpoint:string;dataDir:string;caFile:string;certFile:string;keyFile:string;allowedWorkspaceRoots:string[];runtimes:Record<EngineId,RuntimeConfig>;automation?:AutomationConfig;push?:HuaweiPushConfig;runtimeUpdates?:RuntimeUpdateConfig }
const configPath=process.argv[2]||'host.config.json';
const c=JSON.parse(await readFile(configPath,'utf8')) as HostConfig;
const automation=automationSettings(c.automation);
if(!c.hostId||!c.name||c.port!==8899||!c.allowedWorkspaceRoots?.length)throw new Error('Invalid host configuration');
const stateDir=process.env.AMC_STATE_DIR||join(homedir(),'.ai-maid-cafe');await mkdir(stateDir,{recursive:true,mode:0o700});
const lockPath=join(stateDir,'gateway.lock');
try { const old=JSON.parse(await readFile(lockPath,'utf8'));let running=true;try{process.kill(old.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')running=false;}if(running)throw new Error('A gateway already runs for this OS user');await unlink(lockPath); }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid}));await lock.close();
await mkdir(c.dataDir,{recursive:true,mode:0o700});
const store=new Store(join(c.dataDir,'console.sqlite'));store.recover();
const core=new Core(store,c.hostId,await Promise.all(c.allowedWorkspaceRoots.map(canonical)));
if(c.runtimes.codex.enabled!==false){
  try{const registered=await new RuntimeManager(c.dataDir).connect('codex',c.runtimes.codex);c.runtimes.codex={...c.runtimes.codex,endpoint:registered.endpoint,runtimeIdentity:registered.identity,registeredVersion:registered.version};}
  catch(error){c.runtimes.codex={...c.runtimes.codex,runtimeIdentity:undefined,registeredVersion:undefined};console.error('Codex 共享运行时未连接：',(error as Error).message);}
}
const codex=new CodexAdapter('codex',c.runtimes.codex,core.context('codex'));core.adapters.set('codex',codex);
core.external.providers.set('codex',new CodexExternalProvider(codex));
const claude=new ClaudeCodeAdapter('claude-code',c.runtimes['claude-code'],core.context('claude-code'));
core.adapters.set('claude-code',claude);core.external.providers.set('claude-code',new ClaudeExternalProvider(claude));
const openConfig=c.runtimes.opencode,openContext=core.context('opencode');
const opencode=isDevEco(openConfig.command)?new DevEcoCodeAdapter(openConfig,openContext,c.dataDir):new OpenCodeAdapter('opencode',openConfig,openContext);
core.adapters.set('opencode',opencode);
core.external.providers.set('opencode',opencode instanceof DevEcoCodeAdapter?new DevEcoExternalProvider(opencode):new OpenCodeExternalProvider(opencode));
const dsh=new DshAdapter('deepseek-harness',c.runtimes['deepseek-harness'],core.context('deepseek-harness'));core.adapters.set('deepseek-harness',dsh);
core.external.providers.set('deepseek-harness',new DshExternalProvider(dsh));
const discovery=new WorkspaceDiscovery(core,automation);const externalSync=new ExternalSync(core,automation,c.runtimes);
const runtimeRecovery=new RuntimeRecovery(core);
const runtimeUpdates=new RuntimeUpdateMonitor(c.runtimeUpdates);core.runtimeUpdates=runtimeUpdates;
core.automation={settings:automation,discovery,externalSync};
const pushTransport=c.push?await HuaweiPushTransport.load(c.push):undefined;
const push=new PushCoordinator(store,c.hostId,{transport:pushTransport,authorize:async(session,signal)=>{signal.throwIfAborted();core.workspaceIdentities.verify(session.ref.workspaceId,true);return true;}});
store.notificationIntent=(event,session)=>{push.enqueue(session.id,event.seq);};
const server=makeServer(core,{cert:await readFile(c.certFile),key:await readFile(c.keyFile),minVersion:'TLSv1.2'},{name:c.name,os:c.os},push);
const bridgeConfig=c.runtimes['deepseek-harness'];
const bridgeTokenFile=bridgeConfig.enabled!==false && bridgeConfig.expectedVersion!=='DISABLED' ? bridgeConfig.bridgeTokenFile : undefined;
const bridgeToken=bridgeTokenFile?(await readFile(bridgeTokenFile,'utf8')).trim():'';
if(bridgeTokenFile&&(!bridgeToken||Buffer.byteLength(bridgeToken)>4096))throw new Error('Invalid DSH bridge token configuration');
const bridgeHTTP=createServer((_req,res)=>res.writeHead(404).end());const bridgeWS=new WebSocketServer({noServer:true,maxPayload:8*1024*1024});
bridgeHTTP.on('upgrade',(req,socket,head)=>{const token=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'')||'');const expected=Buffer.from(bridgeToken);if(!expected.length||token.length!==expected.length||!timingSafeEqual(token,expected)){socket.destroy();return;}bridgeWS.handleUpgrade(req,socket,head,ws=>dsh.attach(ws));});
let stopping=false;
async function shutdown(code=0){if(stopping)return;stopping=true;server.close();bridgeHTTP.close();bridgeWS.close();runtimeUpdates.stop();await Promise.all([discovery.close(),externalSync.close(),core.external.close(),push.stop(),runtimeRecovery.close()]);for(const a of core.adapters.values())a.close();await core.drain();await unlink(lockPath).catch(()=>{});store.close();process.exit(code);}
const listen=(server:import('node:net').Server,port:number,address:string)=>new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,address,resolve);});
try {
  const listeners = [listen(server, c.port, c.listen)];
  if (bridgeToken) listeners.push(listen(bridgeHTTP, 8898, '127.0.0.1'));
  await Promise.all(listeners);
  discovery.start();externalSync.start();push.start();runtimeRecovery.start();runtimeUpdates.start();
  console.log(`AI Maid Café: ${c.name} (${c.hostId}) — ${c.listen}:${c.port}`);
  process.send?.({type:'ready'});
} catch (error) {
  const failure = error as NodeJS.ErrnoException & { port?:number };
  if (process.connected && process.send && failure.port && ['EADDRINUSE','EADDRNOTAVAIL','EACCES'].includes(failure.code || '')) {
    const message = { type:'listen-failed', code:failure.code, port:failure.port };
    await new Promise<void>(done => process.send!(message, undefined, undefined, () => done()));
  }
  console.error(failure.message);
  await shutdown(1);
}
process.on('message',(message: {type?:string; requestId?:string; input?:Record<string,unknown>})=>{
  if(message?.type !== 'session-library' || !message.requestId || !message.input) return;
  void desktopCatalog(core,message.input,true).then(
    data=>process.send?.({type:'session-library-result',requestId:message.requestId,data}),
    error=>process.send?.({type:'session-library-result',requestId:message.requestId,error:error instanceof Error?error.message:'会话操作失败'}));
});
process.on('message',message=>{const m=message as {type?:string;id?:string};if(m.type==='shutdown')void shutdown();if(m.type==='revoke'&&m.id)core.emit('device-revoked',m.id);});
if(process.send)process.once('disconnect',()=>void shutdown());
process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());

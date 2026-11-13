import { createServer, type ServerOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Core } from './core.ts';
import { Fault, object, requireValue, string, validateWorkspaceCreate } from '../../../packages/protocol/src/validation.ts';
import { MAX_FILE, listProject, projectDiff, readProject, upload } from './files.ts';
import type { ConsoleEvent, EngineId, ModelIdentity, Session, Workspace } from '../../../packages/protocol/src/types.ts';
import { digest } from './store.ts';
import { basename } from 'node:path';
export function snapshotWindow(s:Session):Session{return{...s,messages:s.messages.slice(-100),tools:s.tools.slice(-100),historyStart:s.messages.length>100?s.messages.at(-100)!.startSeq||1:1};}
export async function jsonBody(req:IncomingMessage,max=24*1024*1024){let length=0;const chunks:Buffer[]=[];for await(const c of req){length+=c.length;requireValue(length<=max,'body_large','Request exceeds limit',413);chunks.push(c);}try{return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){if(e instanceof Fault)throw e;throw new Fault(400,'invalid_json','Invalid JSON body');}}
export function makeServer(core:Core,tls:ServerOptions,about:{name:string;os:string}){
  const peers=new Map<WebSocket,{device:string; sessions:Set<string>}>();const rate=new Map<string,{since:number;count:number}>();
  const envelope=(data:unknown)=>({protocolVersion:1,hostId:core.hostId,data});
  function send(ws:WebSocket,value:unknown){if(ws.readyState!==WebSocket.OPEN)return;if(ws.bufferedAmount>1024*1024){ws.close(1013,'Reconnect for snapshot');return;}ws.send(JSON.stringify(envelope(value)));}
  function auth(req:IncomingMessage){requireValue(req.headers['x-amc-host']===core.hostId,'host_mismatch','Wrong host identity',409);return core.store.authenticate(req.headers.authorization?.replace(/^Bearer /,'')||'');}
  const server=createServer(tls,async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Type','application/json; charset=utf-8');
    const reply=(data:unknown,status=200)=>{res.writeHead(status);res.end(JSON.stringify(envelope(data)));};
    try{
      const url=new URL(req.url||'/','https://gateway.invalid');const path=url.pathname;
      if(path==='/v1/hello'&&req.method==='GET'){reply({...about,hostId:core.hostId,protocolVersion:1});return;}
      if(path==='/v1/pair'&&req.method==='POST'){
        const ip=req.socket.remoteAddress||'';let r=rate.get(ip);if(!r||Date.now()-r.since>60_000){r={since:Date.now(),count:0};rate.set(ip,r);}requireValue(++r.count<=8,'pair_rate_limit','Too many pairing attempts',429);if(rate.size>10000)rate.clear();
        const p=await jsonBody(req,32_768);requireValue(p.hostId===core.hostId,'host_mismatch','Pairing targets another host',409);reply({...core.store.redeem(string(p.ticket,'ticket',200),string(p.deviceName,'deviceName',100)),...about});return;
      }
      const device=auth(req);
      if(path==='/v1/workspace-roots'&&req.method==='GET'){reply({items:await core.workspaceCreator.roots()});return;}
      if(path==='/v1/workspaces/create'&&req.method==='POST'){const p=await jsonBody(req,32_768);requireValue(validateWorkspaceCreate(p),'invalid_field','Invalid directory creation request');reply(await core.workspaceCreator.create(device,p.clientRequestId,p.rootId,p.directoryName,p.name));return;}
      const directoryOperation=path.match(/^\/v1\/workspace-operations\/([A-Za-z0-9_.:-]+)$/);
      if(directoryOperation&&req.method==='GET'){reply(core.workspaceCreator.status(device,directoryOperation[1]));return;}
      if(path==='/v1/external-capabilities'&&req.method==='GET'){reply({items:await core.external.capabilities()});return;}
      if(path==='/v1/external-sessions'&&req.method==='GET'){const engineId=url.searchParams.get('engineId');requireValue(engineId==='codex'||engineId==='claude-code'||engineId==='opencode'||engineId==='deepseek-harness','engine_invalid','Unknown external engine');reply(await core.external.discover(string(url.searchParams.get('workspaceId'),'workspaceId'),engineId,url.searchParams.get('cursor')||undefined));return;}
      const external=path.match(/^\/v1\/external-sessions\/([a-f0-9]{64})\/(history|import)$/);
      if(external&&external[2]==='history'&&req.method==='GET'){reply(await core.external.history(external[1],url.searchParams.get('cursor')||undefined));return;}
      if(external&&external[2]==='import'&&req.method==='POST'){const p=await jsonBody(req,4096);reply(await core.external.import(device,string(p.clientRequestId,'clientRequestId',100),external[1]));return;}
      const observation=path.match(/^\/v1\/sessions\/([A-Za-z0-9-]+)\/observation$/);
      if(observation&&req.method==='POST'){const p=await jsonBody(req,4096);reply(await core.external.sync(observation[1],p.cursor===undefined?undefined:string(p.cursor,'cursor',4096)));return;}
      const handoff=path.match(/^\/v1\/sessions\/([A-Za-z0-9-]+)\/(handoffs|control-leases)$/);
      if(handoff&&req.method==='POST'){const session=core.session(handoff[1]);core.workspace(session.ref.workspaceId);requireValue(session.externalSource,'source_missing','Not an external source',409);throw new Fault(409,'handoff_unverified','No verified original-writer termination, child termination or exclusive host-control evidence. Create a separate gateway-managed session; external continuation and leases remain disabled.');}
      if(path==='/v1/bootstrap'&&req.method==='GET'){reply({...about,workspaces:core.store.list('workspace'),sessions:core.store.list<Session>('session').map(s=>({...s,messages:[],tools:[],agents:[],interactions:s.interactions.filter(i=>i.status==='pending'||i.status==='responding')})),runtimes:await Promise.all([...core.adapters.values()].map(a=>a.probe())),devices:core.store.devices()});return;}
      if(path==='/v1/workspaces'&&req.method==='POST'){const p=await jsonBody(req,32_768);reply(await core.registerWorkspace(string(p.path,'path',4096),string(p.name,'name',100)));return;}
      if(path==='/v1/sessions'&&req.method==='POST'){const p=await jsonBody(req,32_768);reply(await core.createSession(device,string(p.clientRequestId,'clientRequestId'),string(p.workspaceId,'workspaceId'),p.engineId as EngineId,p.model as ModelIdentity|undefined));return;}
      if(path==='/v1/commands'&&req.method==='POST'){reply(core.accept(device,await jsonBody(req)));return;}
      const receipt=path.match(/^\/v1\/commands\/([A-Za-z0-9_.:-]+)$/);if(receipt&&req.method==='GET'){const r=core.store.getReceipt(device,receipt[1]);requireValue(r,'receipt_missing','Request not found',404);reply(r);return;}
      const s=path.match(/^\/v1\/sessions\/([A-Za-z0-9-]+)\/(snapshot|events|history|messages|reconcile)$/);
      if(s){const session=core.session(s[1]);
        if(s[2]==='snapshot'&&req.method==='GET'){reply(snapshotWindow(session));return;}
        if(s[2]==='reconcile'&&req.method==='POST'){core.workspace(session.ref.workspaceId);requireValue(!session.externalSource,'external_read_only','Use passive external observation, not native resume',409);await core.adapters.get(session.ref.engineId)!.resumeSession(session);reply(snapshotWindow(core.session(session.id)));return;}
        if(s[2]==='messages'&&req.method==='GET'){const before=Number(url.searchParams.get('before')||session.watermark+1);requireValue(Number.isSafeInteger(before)&&before>0,'cursor_invalid','Invalid cursor');const all=session.messages.filter(m=>(m.startSeq||1)<before);const messages=all.slice(-100);reply({messages,hasMore:all.length>100,beforeSeq:messages[0]?.startSeq||1});return;}
        if((s[2]==='events'||s[2]==='history')&&req.method==='GET'){
          const cursor=Number(url.searchParams.get(s[2]==='events'?'after':'before')||(s[2]==='events'?0:session.watermark+1));requireValue(Number.isSafeInteger(cursor)&&cursor>=0,'cursor_invalid','Invalid cursor');
          const items=s[2]==='events'?core.store.events(session.id,cursor):core.store.history(session.id,cursor);reply({items,watermark:session.watermark,historyStart:session.historyStart,hasMore:s[2]==='history'?items.length>0&&items[0].seq>session.historyStart:items.length>0&&items.at(-1)!.seq<session.watermark});return;
        }
      }
      const f=path.match(/^\/v1\/workspaces\/([A-Za-z0-9-]+)\/(attachments|files|read|download|diff)$/);
      if(f){const w=core.workspace(f[1]);
        if(f[2]==='attachments'&&req.method==='POST'){const p=await jsonBody(req);const base=string(p.data,'data',Math.ceil(MAX_FILE*4/3)+4);requireValue(/^[A-Za-z0-9+/]*={0,2}$/.test(base),'base64_invalid','Invalid attachment encoding');const a=await upload(w,string(p.name,'name',160),string(p.mime,'mime',100),Buffer.from(base,'base64'));core.store.put('attachment',a.id,a);reply(a);return;}
        if(f[2]==='files'&&req.method==='GET'){reply({items:await listProject(w,url.searchParams.get('path')||'.')});return;}
        if(f[2]==='read'&&req.method==='GET'){reply({text:(await readProject(w,url.searchParams.get('path')||'')).toString('utf8')});return;}
        if(f[2]==='download'&&req.method==='GET'){const path=url.searchParams.get('path')||'';const bytes=await readProject(w,path,MAX_FILE);reply({name:basename(path),data:bytes.toString('base64'),sha256:digest(bytes)});return;}
        if(f[2]==='diff'&&req.method==='GET'){reply(await projectDiff(w));return;}
      }
      const d=path.match(/^\/v1\/devices\/([A-Za-z0-9-]+)$/);if(d&&req.method==='DELETE'){core.store.revoke(d[1]);for(const [ws,p]of peers)if(p.device===d[1])ws.close(4001,'Device revoked');reply({revoked:true});return;}
      throw new Fault(404,'not_found','No such endpoint');
    }catch(e){const f=e instanceof Fault?e:new Fault(500,'operation_failed',(e as Error).message);reply({error:{code:f.code,message:f.message}},f.status);}
  });
  const wss=new WebSocketServer({noServer:true,maxPayload:64*1024,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{try{requireValue(req.url==='/v1/events','not_found','Unknown event path');const device=auth(req);wss.handleUpgrade(req,socket,head,ws=>{peers.set(ws,{device,sessions:new Set()});wss.emit('connection',ws);});}catch{socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();}});
  wss.on('connection',ws=>{
    ws.on('message',raw=>{try{
      const m=JSON.parse(raw.toString());requireValue(m.type==='subscribe'&&m.hostId===core.hostId&&Array.isArray(m.sessionIds)&&m.sessionIds.length<=1000,'subscribe_invalid','Invalid subscription');
      const p=peers.get(ws)!;const sessions=m.sessionIds.map((id:string)=>core.session(id));
      // No await between this cut and registration. SQLite and JS callbacks are
      // synchronous here, so subsequent events cannot fall into a snapshot gap.
      p.sessions=new Set(sessions.map((s:Session)=>s.id));for(const s of sessions)send(ws,{type:'snapshot',snapshot:snapshotWindow(s)});
      send(ws,{type:'ready'});
    }catch{ws.close(1008,'Invalid subscription');}});
    ws.on('close',()=>peers.delete(ws));ws.on('error',()=>peers.delete(ws));
  });
  const onEvent=(event:ConsoleEvent)=>{for(const [ws,p]of peers)if(p.sessions.has(event.sessionId))send(ws,{type:'event',event});};
  const onReceipt=({device,receipt}:any)=>{for(const[ws,p]of peers)if(p.device===device)send(ws,{type:'receipt',receipt});};
  core.on('event',onEvent);core.on('receipt',onReceipt);
  const onCatalog=()=>{for(const ws of peers.keys())send(ws,{type:'catalog.changed'});};
  core.on('catalog.changed',onCatalog);
  const onRevoke=(id:string)=>{for(const[ws,p]of peers)if(p.device===id)ws.close(4001,'Device revoked');};
  core.on('device-revoked',onRevoke);
  server.on('close',()=>{core.off('event',onEvent);core.off('receipt',onReceipt);core.off('catalog.changed',onCatalog);core.off('device-revoked',onRevoke);for(const ws of peers.keys())ws.terminate();wss.close();});
  return server;
}

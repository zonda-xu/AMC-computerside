import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpsRequest } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { makeServer } from '../../apps/gateway/src/server.ts';
import { fixture, command, tick } from '../helpers.ts';
import { automationSettings } from '../../apps/gateway/src/automation.ts';
import { WorkspaceDiscovery } from '../../apps/gateway/src/workspace-discovery.ts';
import { ExternalSync } from '../../apps/gateway/src/external-sync.ts';
async function certificates(dir:string){
  const candidates=[process.env.OPENSSL||'openssl',...(process.platform==='win32'?['mingw64','usr'].map(part=>join(process.env.ProgramFiles||'C:\\Program Files','Git',part,'bin','openssl.exe')):[])];let executable='';
  for(const candidate of candidates){try{await promisify(execFile)(candidate,['version']);executable=candidate;break;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  assert.ok(executable,'OpenSSL is required for TLS security tests; install it or set OPENSSL');
  const key=join(dir,'key.pem'),crt=join(dir,'cert.pem');await promisify(execFile)(executable,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',crt,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);return{key:await readFile(key),cert:await readFile(crt)};
}
test('HTTPS pairing, WSS snapshot cut, offline execution and device revocation',async()=>{
  const f=await fixture();const tls=await certificates(f.dir);const server=makeServer(f.core,tls,{name:'Test Host',os:'test'});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('No test server');const port=address.port;
  const req=(path:string,method='GET',body:unknown=undefined,token='',host='test-host',servername='localhost',ca=tls.cert)=>new Promise<any>((resolve,reject)=>{const r=httpsRequest({hostname:'127.0.0.1',port,path,method,servername,ca,headers:{'Content-Type':'application/json','X-AMC-Host':host,...(token?{Authorization:'Bearer '+token}:{})}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(data)}));});r.on('error',reject);r.end(body?JSON.stringify(body):undefined);});
  const sockets:WebSocket[]=[];
  const connect=(token:string)=>new Promise<WebSocket>((resolve,reject)=>{const ws=new WebSocket(`wss://localhost:${port}/v2/events`,{ca:tls.cert,headers:{'X-AMC-Host':'test-host',Authorization:'Bearer '+token}});sockets.push(ws);ws.once('open',()=>resolve(ws));ws.once('error',reject);});
  try{
    assert.equal((await req('/v2/bootstrap')).status,401);
    for(const path of ['/v2/workspace-roots','/v2/external-capabilities','/v2/external-sessions','/v2/automation','/v2/push/status'])assert.equal((await req(path)).status,401);
    assert.equal((await req('/v2/workspaces/create','POST',{})).status,401);
    const t=f.store.ticket();const paired=await req('/v2/pair','POST',{hostId:'test-host',ticket:t.token,deviceName:'Test Phone'});assert.equal(paired.status,200);assert.equal(paired.protocolVersion,2);const token=paired.data.token;
    const modelsPath='/v2/workspaces/'+f.w.id+'/models?engineId=codex';
    const artifactsPath='/v2/sessions/'+f.s.id+'/artifacts';
    const previewPath='/v2/workspaces/'+f.w.id+'/preview?path=order.csv';
    for(const path of [modelsPath,artifactsPath,previewPath])assert.equal((await req(path)).status,401);
    const catalog=await req(modelsPath,'GET',undefined,token);assert.equal(catalog.data.workspaceId,f.w.id);assert.equal(catalog.data.models[0].modelId,'test-model');
    await writeFile(join(f.w.path,'order.csv'),'Item,Count\nCoffee,2');
    const preview=await req(previewPath,'GET',undefined,token);assert.equal(preview.data.kind,'table');assert.deepEqual(preview.data.rows,[['Coffee','2']]);
    assert.equal((await req(artifactsPath,'GET',undefined,token)).data.sessionId,f.s.id);
    const rootsBefore=f.core.allowedRoots;f.core.allowedRoots=[];
    for(const path of [modelsPath,artifactsPath,previewPath])assert.equal((await req(path,'GET',undefined,token)).status,403);
    f.core.allowedRoots=rootsBefore;
    assert.equal((await req('/v1/bootstrap','GET',undefined,token)).status,404);
    const defaults=await req('/v2/automation','GET',undefined,token);assert.equal(defaults.status,200);assert.equal(defaults.data.enabled,false);assert.equal(defaults.data.limited,false);assert.equal(defaults.data.scanIntervalSeconds,60);assert.deepEqual(defaults.data.roots,f.core.allowedRoots);
    const pushStatus=await req('/v2/push/status','GET',undefined,token);assert.deepEqual(pushStatus.data,{configured:false,state:'unconfigured'});
    const settings=automationSettings({enabled:true});const discovery=new WorkspaceDiscovery(f.core,settings);const externalSync=new ExternalSync(f.core,settings,{});
    f.core.automation={settings,discovery,externalSync};discovery.status={state:'partial',checked:1000,added:1,errors:['Discovery budget exhausted: private provider credentials'],finishedAt:1234};
    externalSync.statuses.set('fixture',{workspaceId:f.w.id,engineId:'codex',state:'failed',failures:1,nextAt:5000,lastSuccessAt:1200,error:'secret native failure'});
    const automation=await req('/v2/automation','GET',undefined,token);assert.equal(automation.data.enabled,true);assert.equal(automation.data.limited,true);assert.equal(automation.data.lastFailureAt,1234);assert.equal(automation.data.lastSuccessAt,1200);assert.equal(automation.data.lastFailureCode,'automation_budget');assert.ok(!JSON.stringify(automation.data).includes('secret'));assert.ok(!JSON.stringify(automation.data).includes('credentials'));
    assert.equal((await req('/v2/bootstrap','GET',undefined,token,'wrong-host')).status,409);
    await assert.rejects(()=>req('/v2/hello','GET',undefined,'','test-host','wrong.invalid'));
    const ws=await connect(token);const frames:any[]=[];ws.on('message',raw=>frames.push(JSON.parse(raw.toString()).data));ws.send(JSON.stringify({protocolVersion:2,type:'subscribe',hostId:'test-host',sessionIds:[f.s.id]}));
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No ready frame')),3000);const listener=(raw:Buffer)=>{if(JSON.parse(raw.toString()).data.type==='ready'){clearTimeout(timer);ws.off('message',listener);resolve();}};ws.on('message',listener);});
    const snapshot=frames.find(v=>v.type==='snapshot').snapshot;assert.equal(snapshot.watermark,0);
    const roots=await req('/v2/workspace-roots','GET',undefined,token);assert.equal(roots.status,200);assert.equal(roots.data.items.length,1);
    const directory={clientRequestId:'transport-directory',rootId:roots.data.items[0].rootId,directoryName:'transport-new',name:'Transport'};
    const created=await req('/v2/workspaces/create','POST',directory,token);assert.equal(created.status,200);
    assert.equal((await req('/v2/workspaces/create','POST',directory,token)).data.id,created.data.id);
    assert.equal((await req('/v2/workspace-operations/transport-directory','GET',undefined,token)).data.stage,'done');
    assert.equal((await req('/v2/workspaces/create','POST',{...directory,path:'../../escape'},token)).status,400);
    assert.equal((await req('/v2/external-capabilities','GET',undefined,token)).data.items.length,4);
    const imported={...f.s,id:'fixture-imported',binding:{...f.s.binding!,state:'unbound' as const},externalSource:{namespace:'fixture-instance',nativeId:f.s.ref.nativeSessionId,generation:'fixture-generation',profile:'TEST DOUBLE',readOnly:true}};f.store.put('session',imported.id,imported);
    const attachBody={protocolVersion:2,hostId:'test-host',clientRequestId:'http-attach',runtimeInstanceId:f.adapter.context.runtimeInstanceId,ref:imported.ref};
    assert.equal((await req('/v2/sessions/'+imported.id+'/attach','POST',attachBody)).status,401);
    assert.equal((await req('/v2/sessions/'+imported.id+'/attach','POST',{...attachBody,hostId:'wrong-host'},token)).status,409);
    assert.equal((await req('/v2/sessions/'+imported.id+'/attach','POST',attachBody,token)).data.error.code,'attachment_unavailable');
    assert.equal((await req('/v2/commands/http-attach','GET',undefined,token)).data.status,'rejected');
    for(const action of ['submit','cancel','configure','decide']){const c=command(imported,action,{runId:'unknown',interactionId:'unknown',text:'denied'});assert.equal((await req('/v2/commands','POST',c,token)).data.status,'received');await f.core.drain();assert.equal((await req('/v2/commands/'+c.clientRequestId,'GET',undefined,token)).data.status,'rejected');}
    assert.equal((await req('/v2/sessions/'+imported.id+'/reconcile','POST',{},token)).data.error.code,'binding_unavailable');
    for(const operation of ['handoffs','control-leases'])assert.equal((await req('/v2/sessions/'+imported.id+'/'+operation,'POST',{},token)).data.error.code,'handoff_unverified');
    const c=command(f.s);assert.equal((await req('/v2/commands','POST',c,token)).data.status,'received');await f.core.drain();assert.equal(f.adapter.submitted,1);
    ws.close();await new Promise<void>(r=>ws.once('close',()=>r()));
    assert.equal(f.core.session(f.s.id).state,'running');f.adapter.context.emit(f.s.id,'message.completed',{id:'offline-result',role:'assistant',text:'Completed while phone was offline'});f.adapter.context.emit(f.s.id,'run.updated',{state:'completed'});
    const ws2=await connect(token);const restored=await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No restored snapshot')),3000);ws2.on('message',raw=>{const frame=JSON.parse(raw.toString()).data;if(frame.type==='snapshot'){clearTimeout(timer);resolve(frame.snapshot);}});ws2.send(JSON.stringify({protocolVersion:2,type:'subscribe',hostId:'test-host',sessionIds:[f.s.id]}));});
    assert.equal(restored.state,'completed');assert.equal(restored.messages.filter((m:{id:string})=>m.id==='offline-result').length,1);assert.equal(restored.messages.at(-1).text,'Completed while phone was offline');
    const replay=await connect(token);const replayed:any[]=[];await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Replay not ready')),3000);replay.on('message',raw=>{const frame=JSON.parse(raw.toString()).data;replayed.push(frame);if(frame.type==='ready'){clearTimeout(timer);resolve();}});replay.send(JSON.stringify({protocolVersion:2,type:'subscribe',hostId:'test-host',sessionIds:[f.s.id],afterSeq:{[f.s.id]:1}}));});
    assert.equal(replayed.some(f=>f.type==='snapshot'),false);assert.deepEqual(replayed.filter(f=>f.type==='event').map(f=>f.event.seq),f.store.events(f.s.id,1).map(e=>e.seq));assert.equal(replayed.at(-1).watermarks[f.s.id],restored.watermark);
     const history=await req('/v2/sessions/'+f.s.id+'/events?afterSeq=1','GET',undefined,token);assert.deepEqual(history.data.items.map((e:any)=>e.seq),f.store.events(f.s.id,1).map(e=>e.seq));assert.equal((await req('/v2/sessions/'+f.s.id,'GET',undefined,token)).data.state,'completed');
     const authorizedRoots=f.core.allowedRoots;f.core.allowedRoots=[];
     for(const suffix of ['', '/snapshot', '/events?afterSeq=0', '/history', '/messages'])assert.equal((await req('/v2/sessions/'+f.s.id+suffix,'GET',undefined,token)).status,403);
     const restricted=await req('/v2/bootstrap','GET',undefined,token);assert.deepEqual(restricted.data.workspaces,[]);assert.deepEqual(restricted.data.sessions,[]);
     f.core.allowedRoots=authorizedRoots;
    const closed=new Promise<number>(r=>ws2.once('close',code=>r(code)));assert.equal((await req('/v2/devices/'+paired.data.deviceId,'DELETE',undefined,token)).status,200);assert.equal(await closed,4001);assert.equal((await req('/v2/bootstrap','GET',undefined,token)).status,401);
  }finally{for(const ws of sockets)ws.terminate();await new Promise<void>(r=>server.close(()=>r()));await f.close();}
});

test('existing WSS subscriptions stop delivering events after workspace authorization is revoked',async()=>{
  const f=await fixture();const tls=await certificates(f.dir);const server=makeServer(f.core,tls,{name:'Test Host',os:'test'});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No test server');
  const paired=f.store.redeem(f.store.ticket().token,'Test Phone');
  const ws=new WebSocket(`wss://localhost:${address.port}/v2/events`,{ca:tls.cert,headers:{'X-AMC-Host':'test-host',Authorization:'Bearer '+paired.token}});
  let events=0;
  try{
    await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('No ready frame')),3000);
      ws.on('message',raw=>{const text=raw.toString();if(text.includes('"type":"event"'))events++;if(text.includes('"type":"ready"')){clearTimeout(timer);resolve();}});
      ws.send(JSON.stringify({protocolVersion:2,type:'subscribe',hostId:'test-host',sessionIds:[f.s.id]}));
    });
    const closed=new Promise<number>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Unauthorized subscription remained open')),3000);ws.once('close',code=>{clearTimeout(timer);resolve(code);});});
    f.core.allowedRoots=[];f.adapter.context.emit(f.s.id,'message.completed',{id:'private-output',role:'assistant',text:'No longer authorized'});
    assert.equal(await closed,1008);assert.equal(events,0);
  }finally{ws.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});

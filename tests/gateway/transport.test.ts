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
async function certificates(dir:string){const key=join(dir,'key.pem'),crt=join(dir,'cert.pem');await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',crt,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);return{key:await readFile(key),cert:await readFile(crt)};}
test('HTTPS pairing, WSS snapshot cut, offline execution and device revocation',async()=>{
  const f=await fixture();const tls=await certificates(f.dir);const server=makeServer(f.core,tls,{name:'Test Host',os:'test'});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('No test server');const port=address.port;
  const req=(path:string,method='GET',body:unknown=undefined,token='',host='test-host',servername='localhost',ca=tls.cert)=>new Promise<any>((resolve,reject)=>{const r=httpsRequest({hostname:'127.0.0.1',port,path,method,servername,ca,headers:{'Content-Type':'application/json','X-AMC-Host':host,...(token?{Authorization:'Bearer '+token}:{})}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(data)}));});r.on('error',reject);r.end(body?JSON.stringify(body):undefined);});
  const sockets:WebSocket[]=[];
  const connect=(token:string)=>new Promise<WebSocket>((resolve,reject)=>{const ws=new WebSocket(`wss://localhost:${port}/v1/events`,{ca:tls.cert,headers:{'X-AMC-Host':'test-host',Authorization:'Bearer '+token}});sockets.push(ws);ws.once('open',()=>resolve(ws));ws.once('error',reject);});
  try{
    assert.equal((await req('/v1/bootstrap')).status,401);
    for(const path of ['/v1/workspace-roots','/v1/external-capabilities','/v1/external-sessions'])assert.equal((await req(path)).status,401);
    assert.equal((await req('/v1/workspaces/create','POST',{})).status,401);
    const t=f.store.ticket();const paired=await req('/v1/pair','POST',{hostId:'test-host',ticket:t.token,deviceName:'Test Phone'});assert.equal(paired.status,200);const token=paired.data.token;
    assert.equal((await req('/v1/bootstrap','GET',undefined,token,'wrong-host')).status,409);
    await assert.rejects(()=>req('/v1/hello','GET',undefined,'','test-host','wrong.invalid'));
    const ws=await connect(token);const frames:any[]=[];ws.on('message',raw=>frames.push(JSON.parse(raw.toString()).data));ws.send(JSON.stringify({type:'subscribe',hostId:'test-host',sessionIds:[f.s.id]}));
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No ready frame')),3000);const listener=(raw:Buffer)=>{if(JSON.parse(raw.toString()).data.type==='ready'){clearTimeout(timer);ws.off('message',listener);resolve();}};ws.on('message',listener);});
    const snapshot=frames.find(v=>v.type==='snapshot').snapshot;assert.equal(snapshot.watermark,0);
    const roots=await req('/v1/workspace-roots','GET',undefined,token);assert.equal(roots.status,200);assert.equal(roots.data.items.length,1);
    const directory={clientRequestId:'transport-directory',rootId:roots.data.items[0].rootId,directoryName:'transport-new',name:'Transport'};
    const created=await req('/v1/workspaces/create','POST',directory,token);assert.equal(created.status,200);
    assert.equal((await req('/v1/workspaces/create','POST',directory,token)).data.id,created.data.id);
    assert.equal((await req('/v1/workspace-operations/transport-directory','GET',undefined,token)).data.stage,'done');
    assert.equal((await req('/v1/workspaces/create','POST',{...directory,path:'../../escape'},token)).status,400);
    assert.equal((await req('/v1/external-capabilities','GET',undefined,token)).data.items.length,4);
    const imported={...f.s,id:'fixture-imported',externalSource:{namespace:'fixture-instance',nativeId:f.s.ref.nativeSessionId,generation:'fixture-generation',profile:'TEST DOUBLE',readOnly:true}};f.store.put('session',imported.id,imported);
    for(const action of ['submit','cancel','configure','decide'])assert.equal((await req('/v1/commands','POST',command(imported,action),token)).data.error.code,'external_read_only');
    assert.equal((await req('/v1/sessions/'+imported.id+'/reconcile','POST',{},token)).data.error.code,'external_read_only');
    for(const operation of ['handoffs','control-leases'])assert.equal((await req('/v1/sessions/'+imported.id+'/'+operation,'POST',{},token)).data.error.code,'handoff_unverified');
    const c=command(f.s);assert.equal((await req('/v1/commands','POST',c,token)).data.status,'received');await f.core.drain();assert.equal(f.adapter.submitted,1);
    ws.close();await new Promise<void>(r=>ws.once('close',()=>r()));
    assert.equal(f.core.session(f.s.id).state,'running');f.adapter.context.emit(f.s.id,'message.completed',{id:'offline-result',role:'assistant',text:'Completed while phone was offline'});f.adapter.context.emit(f.s.id,'run.updated',{state:'completed'});
    const ws2=await connect(token);const restored=await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No restored snapshot')),3000);ws2.on('message',raw=>{const frame=JSON.parse(raw.toString()).data;if(frame.type==='snapshot'){clearTimeout(timer);resolve(frame.snapshot);}});ws2.send(JSON.stringify({type:'subscribe',hostId:'test-host',sessionIds:[f.s.id]}));});
    assert.equal(restored.state,'completed');assert.equal(restored.messages.filter((m:{id:string})=>m.id==='offline-result').length,1);assert.equal(restored.messages.at(-1).text,'Completed while phone was offline');
    const closed=new Promise<number>(r=>ws2.once('close',code=>r(code)));assert.equal((await req('/v1/devices/'+paired.data.deviceId,'DELETE',undefined,token)).status,200);assert.equal(await closed,4001);assert.equal((await req('/v1/bootstrap','GET',undefined,token)).status,401);
  }finally{for(const ws of sockets)ws.terminate();await new Promise<void>(r=>server.close(()=>r()));await f.close();}
});

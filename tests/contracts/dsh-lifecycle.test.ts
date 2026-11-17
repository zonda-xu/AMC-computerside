import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { apply } from '../../plugins/dsh-bridge/cordis.mjs';

test('DSH Cordis entry waits for the host controller and releases transport/listeners on unload',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'amc-dsh-lifecycle-'));const tokenFile=join(directory,'token');await writeFile(tokenFile,'fixture-only');
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  let injected:((ctx:any)=>void)|undefined;const cleanups:Array<()=>void>=[];const subscriptions=new Set<string>();
  const ctl:any={create(){},prompt(){},cancel(){},list:async()=>({items:[]}),page(){},follow(){},projections(){}};
  const ctx:any={get:(name:string)=>name==='sessionController'?ctl:undefined,on:(name:string)=>{subscriptions.add(name);return()=>subscriptions.delete(name);},effect:(effect:()=>()=>void)=>{cleanups.push(effect());},inject:(names:string[],fn:(child:any)=>void)=>{assert.deepEqual(names,['sessionController']);injected=fn;}};
  try{
    apply(ctx,{tokenFile,gatewayUrl:`ws://127.0.0.1:${address.port}`});assert.equal(subscriptions.size,0);assert.ok(injected);
    const connection=once(server,'connection',{signal:AbortSignal.timeout(5000)});injected(ctx);const [socket]=await connection;
    const response=once(socket,'message',{signal:AbortSignal.timeout(5000)});socket.send(JSON.stringify({id:'probe',method:'probe'}));const probe=JSON.parse((await response)[0].toString()).result;
    assert.equal(probe.apiProfile,'dsh-controller-capabilities-v2');assert.equal(probe.control,true);assert.ok(subscriptions.has('approval/request'));
    const closed=once(socket,'close',{signal:AbortSignal.timeout(5000)});for(const close of cleanups)close();await closed;assert.equal(subscriptions.size,0);
  }finally{for(const close of cleanups)close();for(const client of server.clients)client.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});

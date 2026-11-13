import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import activate from '../../plugins/dsh-bridge/index.mjs';

test('DSH bridge survives connection errors, reconnects, and retains host subscriptions',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'amc-dsh-reconnect-'));const tokenFile=join(directory,'token');await writeFile(tokenFile,'test-token');
  const first=new WebSocketServer({host:'127.0.0.1',port:0});await once(first,'listening');const address=first.address();if(!address||typeof address==='string')throw new Error('Expected a TCP listener');const port=address.port;await new Promise<void>(resolve=>first.close(()=>resolve()));
  let disposed=0;const listeners=new Map<string,()=>void>();let stop:(()=>void)|undefined;let server:WebSocketServer|undefined;
  try{
    stop=await activate({get:()=>({create:async()=>({sessionId:'native'})}),on:(name:string,fn:()=>void)=>{listeners.set(name,fn);return()=>{disposed++;};}},{tokenFile,gatewayUrl:`ws://127.0.0.1:${port}`});
    await delay(80);
    server=new WebSocketServer({host:'127.0.0.1',port});
    const [socket]=await once(server,'connection',{signal:AbortSignal.timeout(5000)});
    const created=once(socket,'message',{signal:AbortSignal.timeout(5000)});socket.send(JSON.stringify({id:'create',method:'create',params:{cwd:directory,requestId:'create'}}));assert.match(JSON.parse((await created)[0].toString()).error,/unverified|read-only/);
    const reconnected=once(server,'connection',{signal:AbortSignal.timeout(5000)});socket.terminate();const [next]=await reconnected;
    const probed=once(next,'message',{signal:AbortSignal.timeout(5000)});next.send(JSON.stringify({id:'probe',method:'probe',params:{}}));const profile=JSON.parse((await probed)[0].toString()).result;
    assert.equal(profile.externalProtocol,2);assert.equal(profile.apiProfile,'');assert.equal(profile.control,false);
    assert.equal(disposed,0);assert.equal(listeners.size,1);assert.ok(!listeners.has('approval/request'));assert.ok(!listeners.has('user-questions/request'));
    stop();stop=undefined;assert.equal(disposed,1);next.terminate();
  }finally{stop?.();if(server){for(const client of server.clients)client.terminate();const active=server;await new Promise<void>(resolve=>active.close(()=>resolve()));}await rm(directory,{recursive:true,force:true});}
});

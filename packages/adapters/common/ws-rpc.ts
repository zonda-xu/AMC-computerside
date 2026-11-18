import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { RpcMessage } from './rpc.ts';

export class WebSocketRpc extends EventEmitter {
  socket:WebSocket;
  pending=new Map<string|number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  ready:Promise<void>;
  unavailableMethods = new Set<string>();
  constructor(endpoint:string){
    super();const url=new URL(endpoint);if(!['ws:','wss:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Codex endpoint must be a registered loopback WebSocket');
    this.socket=new WebSocket(url,{handshakeTimeout:10000,maxPayload:16*1024*1024});
    this.ready=new Promise((resolve,reject)=>{this.socket.once('open',resolve);this.socket.once('error',reject);});
    this.socket.on('message',raw=>{try{const m:RpcMessage=JSON.parse(raw.toString());if(m.method)this.emit(m.id===undefined?'notification':'request',m);else if(m.id!==undefined){const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(Object.assign(new Error(m.error.message),{code:m.error.code}));else p.resolve(m.result);}}}catch(e){this.fail(e instanceof Error?e:new Error(String(e)));this.socket.close();}});
    this.socket.on('error',e=>this.fail(e));this.socket.on('close',()=>this.fail(new Error('Shared app-server disconnected')));
  }
  fail(error:Error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('fault',error);}
  send(message:RpcMessage){if(this.socket.readyState!==WebSocket.OPEN)throw new Error('Shared app-server is not connected');this.socket.send(JSON.stringify(message));}
  async request<T=Record<string,unknown>>(method:string,params:Record<string,unknown>,timeout=30000):Promise<T>{
    if(this.unavailableMethods.has(method))throw new Error(`Codex 未提供 ${method} 接口`);
    await this.ready;
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method}: native acknowledgement unavailable`));},timeout);
      this.pending.set(id,{resolve:v=>resolve(v as T),timer,reject:error=>{
        if((error as Error & {code?:number}).code===-32601)this.unavailableMethods.add(method);
        reject(error);
      }});
      try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  notify(method:string,params:Record<string,unknown>={}){this.send({method,params});}
  respond(id:string|number,result:unknown){this.send({id,result});}
  reject(id:string|number,message:string){this.send({id,error:{code:-32601,message}});}
  close(){this.socket.close();this.fail(new Error('Connection closed'));}
}

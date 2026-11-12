import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { nativeCommand } from './command.ts';
export interface RpcMessage { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }
// Standard NDJSON JSON-RPC over native stdio. This is not a terminal renderer.
export class StdioRpc extends EventEmitter {
  process: ChildProcessWithoutNullStreams;
  pending = new Map<string | number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    super(); const native=nativeCommand(command);this.process=spawn(native.command,[...native.args,...args],{cwd,env,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});
    this.process.on('error',e=>this.fail(e));
    const lines=createInterface({input:this.process.stdout,crlfDelay:Infinity});
    lines.on('line',line=>{
      try {
        if(Buffer.byteLength(line)>8*1024*1024)throw new Error('Native frame exceeds 8 MiB');
        const m=JSON.parse(line) as RpcMessage;
        if(m.method) this.emit(m.id===undefined?'notification':'request',m);
        else if(m.id!==undefined) { const p=this.pending.get(m.id); if(p){clearTimeout(p.timer);this.pending.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result);} }
      } catch(e) { this.fail(e as Error); this.process.kill(); }
    });
    // Never log raw stderr: it may contain provider credentials or prompt content.
    this.process.stderr.resume();
    this.process.on('exit',(code,signal)=>{this.fail(new Error(`Native process exited (${code ?? signal})`));this.emit('exit',{code,signal});});
  }
  fail(e: Error) { for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();this.emit('fault',e); }
  send(m: RpcMessage) { if(this.process.stdin.destroyed)throw new Error('Native stdin is closed');this.process.stdin.write(JSON.stringify(m)+'\n'); }
  request<T=Record<string,unknown>>(method:string,params:Record<string,unknown>,timeout=30_000):Promise<T> {
    const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method} did not confirm its result`));},timeout);this.pending.set(id,{resolve:v=>resolve(v as T),reject,timer});try{this.send({jsonrpc:'2.0',id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});
  }
  notify(method:string,params:Record<string,unknown>={}) { this.send({jsonrpc:'2.0',method,params}); }
  respond(id:string|number,result:unknown) { this.send({jsonrpc:'2.0',id,result}); }
  reject(id:string|number,message:string) { this.send({jsonrpc:'2.0',id,error:{code:-32601,message}}); }
  close(){this.process.stdin.end();}
}
export function nativeEnvironment(engine: string, extra: Record<string,string>={}):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={};
  const common=['PATH','Path','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','TMPDIR','TMP','TEMP','SystemRoot','COMSPEC','SHELL','LANG','LC_ALL','SSH_AUTH_SOCK','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SSL_CERT_FILE','NODE_EXTRA_CA_CERTS'];
  const auth:Record<string,string[]>={codex:['CODEX_HOME','OPENAI_API_KEY','OPENAI_BASE_URL'],'claude-code':['CLAUDE_CONFIG_DIR','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','AWS_PROFILE','AWS_REGION','GOOGLE_APPLICATION_CREDENTIALS'],'opencode':['OPENCODE_CONFIG','OPENCODE_CONFIG_DIR']};
  for(const k of [...common,...(auth[engine]||[])])if(process.env[k]!==undefined)env[k]=process.env[k];
  return {...env,...extra};
}

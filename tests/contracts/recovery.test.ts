import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ConsoleEvent } from '../../packages/protocol/src/types.ts';
import { spawn } from 'node:child_process';
import { fixture, command } from '../helpers.ts';
import { CodexAdapter } from '../../packages/adapters/codex/index.ts';
import { OpenCodeAdapter } from '../../packages/adapters/opencode/index.ts';
import { ClaudeCodeAdapter } from '../../packages/adapters/claude-code/index.ts';
import { StdioRpc } from '../../packages/adapters/common/rpc.ts';

test('Codex cold submit retains directory ownership through historical completion',async t=>{
  const f=await fixture();const a=new CodexAdapter('codex',{command:'unused',expectedVersion:'unused'},f.adapter.context);
  const exits:Promise<void>[]=[];
  t.mock.method(a,'checkVersion',async()=>{});
  t.mock.method(a,'createRpc',(cwd:string)=>{const rpc=new StdioRpc(process.execPath,[fileURLToPath(new URL('./fixtures/rpc-agent.mjs',import.meta.url))],cwd,process.env);exits.push(new Promise<void>(resolve=>rpc.process.once('close',()=>resolve())));return rpc;});
  f.core.adapters.set('codex',a);
  try{
    const restored=new Promise<void>(resolve=>{f.core.on('event',(e:ConsoleEvent)=>{if(e.type==='model.confirmed')resolve();});});
    const pending=f.core.execute('device',command(f.s));
    await restored;
    assert.ok(['accepted','running'].includes(f.core.session(f.s.id).state));
    await assert.rejects(f.core.execute('device',command(f.s)),/owns this directory/);
    await pending;
    assert.equal(f.core.session(f.s.id).state,'running');
    assert.equal(f.core.session(f.s.id).runId,'new-turn');
    a.notification({method:'turn/completed',params:{threadId:f.s.ref.nativeSessionId,turn:{id:'old-turn',status:'completed'}}});
    assert.equal(f.core.session(f.s.id).state,'running');
  }finally{a.close();await Promise.all(exits);await f.close();}
});

test('Codex and OpenCode fault invalidation reconnects, handshakes and reloads',async t=>{
  const f=await fixture();const exits:Promise<void>[]=[];
  try{for(const a of [new CodexAdapter('codex',{command:'unused',expectedVersion:'unused'},f.adapter.context),new OpenCodeAdapter('opencode',{command:'unused',expectedVersion:'unused'},f.adapter.context)]){
    t.mock.method(a,'checkVersion',async()=>{});
    t.mock.method(a,'createRpc',(cwd:string)=>{const rpc=new StdioRpc(process.execPath,[fileURLToPath(new URL('./fixtures/rpc-agent.mjs',import.meta.url))],cwd,process.env);exits.push(new Promise<void>(resolve=>rpc.process.once('close',()=>resolve())));return rpc;});
    try{
      const [first,shared]=await Promise.all([a.connection(f.s.cwd),a.connection(f.s.cwd)]);assert.equal(first,shared);
      await a.resumeSession(f.s);assert.equal(a.loaded.has(f.s.id),true);
      first.fail(new Error('fixture transport failure'));assert.equal(a.rpc,undefined);assert.equal(a.loaded.size,0);
      const second=await a.connection(f.s.cwd);assert.notEqual(first,second);
      first.emit('fault',new Error('late old process exit'));assert.equal(a.rpc,second);
      await a.resumeSession(f.s);assert.equal(a.loaded.has(f.s.id),true);
    }finally{a.close();}
  }}finally{await Promise.all(exits);await f.close();}
});

test('Claude reservation survives adapter restart without claiming native acceptance',async t=>{
  const f=await fixture();const config={command:'unused',expectedVersion:'unused',env:{CLAUDE_CONFIG_DIR:f.dir}};
  const a=new ClaudeCodeAdapter('claude-code',config,f.core.context('claude-code'));t.mock.method(a,'checkVersion',async()=>{});f.core.adapters.set('claude-code',a);
  try{
    const s=await f.core.createSession('device','claude-reservation',f.w.id,'claude-code');
    const restarted=new ClaudeCodeAdapter('claude-code',config,a.context);
    assert.deepEqual(JSON.parse(await readFile(restarted.reservation(s.ref.nativeSessionId),'utf8')),{id:s.id,cwd:s.cwd});
    assert.equal(f.store.getReceipt('device','claude-reservation')?.status,'received');
    a.context.emit(s.id,'run.updated',{state:'uncertain'});
    await assert.rejects(restarted.resumeSession(f.core.session(s.id)),/termination verification/);
    assert.equal(f.core.session(s.id).state,'uncertain');assert.equal(restarted.live.size,0);
  }finally{await f.close();}
});

test('Failed native initialization is discarded and can be retried',async t=>{
  const f=await fixture();const exits:Promise<void>[]=[];
  try{for(const a of [new CodexAdapter('codex',{command:'unused',expectedVersion:'unused'},f.adapter.context),new OpenCodeAdapter('opencode',{command:'unused',expectedVersion:'unused'},f.adapter.context)]){
    let reject=true;t.mock.method(a,'checkVersion',async()=>{});
    t.mock.method(a,'createRpc',(cwd:string)=>{const rpc=new StdioRpc(process.execPath,[fileURLToPath(new URL('./fixtures/rpc-agent.mjs',import.meta.url))],cwd,{...process.env,RPC_REJECT_INITIALIZE:reject?'1':'0'});exits.push(new Promise<void>(resolve=>rpc.process.once('close',()=>resolve())));return rpc;});
    try{await assert.rejects(a.connection(f.s.cwd),/initialization rejected/);assert.equal(a.rpc,undefined);assert.equal(a.loaded.size,0);reject=false;await a.connection(f.s.cwd);assert.ok(a.rpc);}finally{a.close();}
  }}finally{await Promise.all(exits);await f.close();}
});

test('OpenCode loading history does not verify a detached uncertain prompt',async t=>{
  const f=await fixture();const exits:Promise<void>[]=[];const a=new OpenCodeAdapter('opencode',{command:'unused',expectedVersion:'unused'},f.adapter.context);
  t.mock.method(a,'checkVersion',async()=>{});
  t.mock.method(a,'createRpc',(cwd:string)=>{const rpc=new StdioRpc(process.execPath,[fileURLToPath(new URL('./fixtures/rpc-agent.mjs',import.meta.url))],cwd,process.env);exits.push(new Promise<void>(resolve=>rpc.process.once('close',()=>resolve())));return rpc;});
  try{f.adapter.context.emit(f.s.id,'run.updated',{state:'uncertain'});await a.resumeSession(f.core.session(f.s.id));assert.equal(f.core.session(f.s.id).state,'uncertain');await assert.rejects(f.core.execute('device',command(f.s)),/owns this directory/);}finally{a.close();await Promise.all(exits);await f.close();}
});

test('OpenCode child requires explicit native terminal status before parent unlocks',async()=>{
  const f=await fixture();const a=new OpenCodeAdapter('opencode',{command:'unused',expectedVersion:'unused'},f.adapter.context);a.byNative.set('native',f.s.id);
  const update=(status:string,childStatus?:string)=>a.notification({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'tool_call_update',toolCallId:'tool',status,_meta:{'opencode/child-session':{id:'child',...(childStatus?{status:childStatus}:{})}}}}});
  try{
    update('in_progress','running');f.adapter.context.emit(f.s.id,'run.updated',{state:'completed'});assert.equal(f.core.session(f.s.id).state,'uncertain');
    update('completed');assert.equal(f.core.session(f.s.id).state,'uncertain');
    update('completed','completed');assert.equal(f.core.session(f.s.id).state,'completed');
  }finally{await f.close();}
});

test('Codex completion before turn start response is applied only to the returned turn',async t=>{
  const f=await fixture();const exits:Promise<void>[]=[];const a=new CodexAdapter('codex',{command:'unused',expectedVersion:'unused'},f.adapter.context);
  t.mock.method(a,'checkVersion',async()=>{});
  t.mock.method(a,'createRpc',(cwd:string)=>{const rpc=new StdioRpc(process.execPath,[fileURLToPath(new URL('./fixtures/rpc-agent.mjs',import.meta.url))],cwd,{...process.env,RPC_EARLY_COMPLETION:'1'});exits.push(new Promise<void>(resolve=>rpc.process.once('close',()=>resolve())));return rpc;});
  f.core.adapters.set('codex',a);
  try{await f.core.execute('device',command(f.s));assert.equal(f.core.session(f.s.id).state,'completed');assert.equal(f.core.session(f.s.id).runId,'new-turn');assert.equal(a.starting.size,0);}finally{a.close();await Promise.all(exits);await f.close();}
});

test('Codex reconciliation rechecks native state even when thread is already loaded',async t=>{
  const f=await fixture();const exits:Promise<void>[]=[];const a=new CodexAdapter('codex',{command:'unused',expectedVersion:'unused'},f.adapter.context);
  t.mock.method(a,'checkVersion',async()=>{});
  t.mock.method(a,'createRpc',(cwd:string)=>{const rpc=new StdioRpc(process.execPath,[fileURLToPath(new URL('./fixtures/rpc-agent.mjs',import.meta.url))],cwd,process.env);exits.push(new Promise<void>(resolve=>rpc.process.once('close',()=>resolve())));return rpc;});
  try{await a.resumeSession(f.s);assert.equal(a.loaded.has(f.s.id),true);f.adapter.context.emit(f.s.id,'run.updated',{state:'uncertain'});await a.resumeSession(f.core.session(f.s.id));assert.equal(f.core.session(f.s.id).state,'completed');}finally{a.close();await Promise.all(exits);await f.close();}
});

test('OpenCode history replay cannot settle observed children or accept a new prompt',async t=>{
  const f=await fixture();const exits:Promise<void>[]=[];const a=new OpenCodeAdapter('opencode',{command:'unused',expectedVersion:'unused'},f.adapter.context);
  t.mock.method(a,'checkVersion',async()=>{});
  t.mock.method(a,'createRpc',(cwd:string)=>{const rpc=new StdioRpc(process.execPath,[fileURLToPath(new URL('./fixtures/rpc-agent.mjs',import.meta.url))],cwd,process.env);exits.push(new Promise<void>(resolve=>rpc.process.once('close',()=>resolve())));return rpc;});
  try{
    f.adapter.context.emit(f.s.id,'agent.updated',{id:'child',title:'child',state:'running'});f.adapter.context.emit(f.s.id,'run.updated',{state:'completed'});
    await a.resumeSession(f.core.session(f.s.id));assert.equal(f.core.session(f.s.id).state,'uncertain');assert.equal(f.core.session(f.s.id).agents[0].state,'running');assert.equal(f.core.session(f.s.id).messages.length,0);
    const s=f.core.session(f.s.id);s.state='accepted';f.store.put('session',s.id,s);a.loaded.clear();await a.resumeSession(s);assert.equal(f.core.session(s.id).state,'accepted');assert.equal(f.core.session(s.id).messages.length,0);
  }finally{a.close();await Promise.all(exits);await f.close();}
});

test('OpenCode unknown prompt stop reason remains uncertain and holds the directory',async t=>{
  const f=await fixture();const exits:Promise<void>[]=[];const a=new OpenCodeAdapter('opencode',{command:'unused',expectedVersion:'unused'},f.adapter.context);
  t.mock.method(a,'checkVersion',async()=>{});
  t.mock.method(a,'createRpc',(cwd:string)=>{const rpc=new StdioRpc(process.execPath,[fileURLToPath(new URL('./fixtures/rpc-agent.mjs',import.meta.url))],cwd,{...process.env,RPC_STOP_REASON:'unverified-new-reason'});exits.push(new Promise<void>(resolve=>rpc.process.once('close',()=>resolve())));return rpc;});
  f.core.adapters.set('codex',a);
  try{const settled=new Promise<void>(resolve=>{f.core.on('event',(e:ConsoleEvent)=>{if(e.type==='run.updated'&&e.data.state==='uncertain')resolve();});});await f.core.execute('device',command(f.s));await settled;assert.equal(f.core.session(f.s.id).state,'uncertain');await assert.rejects(f.core.execute('device',command(f.s)),/owns this directory/);}finally{a.close();await Promise.all(exits);await f.close();}
});

test('Claude cold reservation selects session-id once and concurrent attach shares a process',async t=>{
  const f=await fixture();const config={command:'unused',expectedVersion:'unused',env:{CLAUDE_CONFIG_DIR:f.dir}};const exits:Promise<void>[]=[];
  const original=new ClaudeCodeAdapter('claude-code',config,f.core.context('claude-code'));t.mock.method(original,'checkVersion',async()=>{});f.core.adapters.set('claude-code',original);
  const a=new ClaudeCodeAdapter('claude-code',config,original.context);t.mock.method(a,'checkVersion',async()=>{});const calls:string[][]=[];
  t.mock.method(a,'createProcess',(args:string[],cwd:string)=>{calls.push(args);const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/rpc-agent.mjs',import.meta.url))],{cwd,stdio:['pipe','pipe','pipe'],shell:false});exits.push(new Promise<void>(resolve=>child.once('close',()=>resolve())));return child;});
  try{
    const s=await f.core.createSession('device','claude-cold-start',f.w.id,'claude-code');const [first,second]=await Promise.all([a.start(s),a.start(s)]);assert.equal(first,second);assert.equal(calls.length,1);assert.ok(calls[0].includes('--session-id'));assert.equal(calls[0].includes('--resume'),false);assert.equal(calls[0].at(-1),s.ref.nativeSessionId);
    await a.configure(s,{providerId:'anthropic',modelId:'test',label:'test'});assert.equal(a.live.size,0);assert.equal(a.starting.size,0);
  }finally{a.close();await Promise.all(exits);await f.close();}
});

test('Claude spawn failure clears the live handle and preserves the cold reservation',async t=>{
  const f=await fixture();const a=new ClaudeCodeAdapter('claude-code',{command:'unused',expectedVersion:'unused',env:{CLAUDE_CONFIG_DIR:f.dir}},f.core.context('claude-code'));t.mock.method(a,'checkVersion',async()=>{});f.core.adapters.set('claude-code',a);const exits:Promise<void>[]=[];
  t.mock.method(a,'createProcess',(args:string[],cwd:string)=>{const child=spawn('amc-nonexistent-test-agent-executable',args,{cwd,stdio:['pipe','pipe','pipe'],shell:false});exits.push(new Promise<void>(resolve=>child.once('close',()=>resolve())));return child;});
  try{const s=await f.core.createSession('device','claude-spawn-failure',f.w.id,'claude-code');await a.start(s);await Promise.all(exits);assert.equal(a.live.size,0);assert.equal(a.starting.size,0);assert.equal(JSON.parse(await readFile(a.reservation(s.ref.nativeSessionId),'utf8')).id,s.id);}finally{a.close();await Promise.all(exits);await f.close();}
});

test('Unrecognized Codex completion status never releases directory ownership',async()=>{
  const f=await fixture();const a=new CodexAdapter('codex',{command:'unused',expectedVersion:'unused'},f.adapter.context);a.byNative.set(f.s.ref.nativeSessionId,f.s.id);
  try{f.adapter.context.emit(f.s.id,'run.updated',{state:'running',runId:'native-turn'});a.notification({method:'turn/completed',params:{threadId:f.s.ref.nativeSessionId,turn:{id:'native-turn',status:'unverified-status'}}});assert.equal(f.core.session(f.s.id).state,'uncertain');await assert.rejects(f.core.execute('device',command(f.s)),/owns this directory/);}finally{await f.close();}
});

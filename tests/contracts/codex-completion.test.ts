import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexAdapter } from '../../packages/adapters/codex/index.ts';
import type { CodexThreadSnapshot } from '../../packages/adapters/codex/index.ts';
import type { Command, Receipt, RunRecord } from '../../packages/protocol/src/types.ts';
import { nativeContext } from './fixtures/native-context.ts';
import { Store } from '../../apps/gateway/src/store.ts';
import type { Session } from '../../packages/protocol/src/types.ts';

class SyntheticRpc extends EventEmitter {
  calls: Array<{ method: string; params: { threadId?: string; clientUserMessageId?: string; model?: string } }> = [];
  responses: Array<{ id: string | number; result: object }> = [];
  snapshot: CodexThreadSnapshot;
  loseStart = false;
  beforeReply?: (method: string) => void;
  constructor(cwd: string) {
    super();
    this.snapshot = { thread: { id: 'native', cwd, status: { type: 'idle' }, turns: [] } };
  }
  async request(method: string, params: { threadId?: string; clientUserMessageId?: string; model?: string }) {
    this.calls.push({ method, params });
    this.beforeReply?.(method);
    if (method === 'initialize') return {};
    if (method === 'thread/settings/update') { this.snapshot.thread.model=params.model; return {}; }
    if (method === 'turn/start') {
      if (this.loseStart) throw new Error('Synthetic lost acknowledgement');
      return { turn: { id: 'turn' } };
    }
    assert.ok(['thread/read', 'thread/resume'].includes(method));
    return structuredClone(this.snapshot);
  }
  notify() {}
  respond(id: string | number, result: object) { this.responses.push({ id, result }); }
  reject() {}
  close() { this.emit('fault', new Error('Synthetic disconnect')); }
}

function harness(t: TestContext) {
  const f = nativeContext('codex');
  const adapter = new CodexAdapter('codex', { command: 'must-not-run', expectedVersion: 'codex-cli 0.169.0', endpoint: 'ws://127.0.0.1:1', runtimeIdentity: 'registered-server' }, f.context);
  let rpc = new SyntheticRpc(f.session.cwd);
  t.mock.method(adapter, 'checkVersion', async () => {});
  t.mock.method(adapter, 'createRpc', () => rpc);
  t.after(() => adapter.close());
  return { ...f, adapter, get rpc() { return rpc; }, replace() { rpc = new SyntheticRpc(f.session.cwd); return rpc; } };
}

function pending(f: ReturnType<typeof harness>) {
  const command: Command = { protocolVersion: 2, hostId: 'host', clientRequestId: 'client', sessionId: f.session.id, ref: { ...f.session.ref }, action: 'submit', payload: { expectedGeneration: 1, text: 'same text' } };
  const receipt: Receipt = { clientRequestId: 'client', status: 'uncertain', generation: 1, runId: 'run', nativeRequestId: 'persisted-input' };
  const run: RunRecord = { runId: 'run', sessionId: f.session.id, generation: 1, deviceId: 'device', clientRequestId: 'client', nativeRequestId: 'persisted-input', state: 'uncertain' };
  f.context.pendingCommands = () => receipt.status === 'uncertain' ? [{ deviceId: 'device', clientRequestId: 'client', command, receipt }] : [];
  f.context.getRun = () => run;
  f.context.reconcileReceipt = (device, client, evidence) => {
    assert.equal(device, 'device'); assert.equal(client, 'client'); Object.assign(receipt, evidence);
  };
  return { command, receipt, run };
}

test('Codex changes the native model and confirms it by reading the same thread without starting a turn', async t => {
  const f=harness(t);f.rpc.snapshot.thread.modelProvider='openai';f.rpc.snapshot.thread.model='gpt-6.1-sol';
  await f.adapter.configure(f.session,{providerId:'openai',modelId:'gpt-6-astra',label:'Astra'});
  assert.deepEqual(f.rpc.calls.find(c=>c.method==='thread/settings/update')?.params,{threadId:'native',model:'gpt-6-astra'});
  assert.equal(f.rpc.calls.some(c=>c.method==='turn/start'),false);
  assert.equal(f.events.findLast(e=>e.type==='model.confirmed')?.data.model.modelId,'gpt-6-astra');
});
for(const invalid of ['active','cwd','provider'])test('Codex model settings reject changed '+invalid+' before mutation',async t=>{
  const f=harness(t);await f.adapter.connection(f.session.cwd);f.adapter.loaded.add(f.session.id);f.rpc.snapshot.thread.modelProvider='openai';
  if(invalid==='active')f.rpc.snapshot.thread.status.type='active';
  if(invalid==='cwd')f.rpc.snapshot.thread.cwd+='-other';
  if(invalid==='provider')f.rpc.snapshot.thread.modelProvider='other';
  await assert.rejects(f.adapter.configure(f.session,{providerId:'openai',modelId:'gpt-6-astra',label:'Astra'}));
  assert.equal(f.rpc.calls.some(c=>c.method==='thread/settings/update'),false);
});
test('Codex native model setting notifications require the owned thread, provider and cwd',async t=>{
  const f=harness(t);f.adapter.byNative.set('native',f.session.id);f.session.model={providerId:'openai',modelId:'old',label:'old'};
  const settings={cwd:f.session.cwd,modelProvider:'openai',model:'gpt-6-astra'};
  for(const p of [{threadId:'other',threadSettings:settings},{threadId:'native',threadSettings:{...settings,cwd:'other'}},{threadId:'native',threadSettings:{...settings,modelProvider:'other'}}])f.adapter.notification({method:'thread/settings/updated',params:p});
  assert.equal(f.events.length,0);
  f.adapter.notification({method:'thread/settings/updated',params:{threadId:'native',threadSettings:settings}});
  assert.equal(f.events[0].data.model.modelId,'gpt-6-astra');
});

test('Codex submits a newly loaded thread without requiring a rollout file', async t => {
  const f = harness(t);
  await f.adapter.connection(f.session.cwd);
  f.adapter.loaded.add(f.session.id);
  f.rpc.beforeReply = method => { assert.notEqual(method, 'thread/resume', 'fresh threads have no rollout file'); };
  await f.adapter.submit(f.session, { text: 'First order', attachments: [], requestId: 'first-order' });
  assert.deepEqual(f.rpc.calls.find(call => call.method === 'thread/read')?.params, { threadId: 'native', includeTurns: false });
  assert.equal(f.rpc.calls.filter(call => call.method === 'turn/start').length, 1);
});

for (const mismatch of ['active', 'cwd', 'identity']) {
  test(`Codex refuses a loaded thread submission when ${mismatch} changed`, async t => {
    const f = harness(t);
    await f.adapter.connection(f.session.cwd);
    f.adapter.loaded.add(f.session.id);
    if (mismatch === 'active') f.rpc.snapshot.thread.status.type = 'active';
    if (mismatch === 'cwd') f.rpc.snapshot.thread.cwd += '-another';
    if (mismatch === 'identity') f.rpc.snapshot.thread.id = 'another';
    await assert.rejects(f.adapter.submit(f.session, { text: 'First order', attachments: [], requestId: 'first-order' }), /not confirmed idle|identity or authorized cwd/);
    assert.equal(f.rpc.calls.some(call => call.method === 'turn/start'), false);
  });
}

test('Codex lost submit acknowledgement recovers only persisted input identity from queried history', async t => {
  const f = harness(t);
  await f.adapter.connection(f.session.cwd);
  f.rpc.loseStart = true;
  await assert.rejects(f.adapter.submit(f.session, { text: 'same text', attachments: [], requestId: 'client', nativeRequestId: 'persisted-input' }), /lost acknowledgement/);
  assert.equal(f.rpc.calls.find(call => call.method === 'turn/start')?.params.clientUserMessageId, 'persisted-input');
  const p = pending(f);
  f.adapter.loaded.add(f.session.id);
  f.rpc.snapshot.thread.turns = [{ id: 'turn', status: 'completed', items: [{ type: 'userMessage', id: 'other' }, { type: 'agentMessage', id: 'answer', text: 'same text' }] }];
  f.adapter.notification({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'unrelated-turn' } } });
  assert.equal(p.receipt.status, 'uncertain');
  assert.equal(f.session.state, 'idle');
  await f.adapter.resumeSession(f.session);
  assert.equal(p.receipt.status, 'uncertain'); assert.equal(f.session.state, 'uncertain');
  f.rpc.snapshot.thread.turns[0].items[0].id = 'persisted-input';
  p.command.ref.workspaceId = 'other-workspace';
  await f.adapter.resumeSession(f.session); assert.equal(p.receipt.status, 'uncertain');
  p.command.ref.workspaceId = f.session.ref.workspaceId;
  p.run.deviceId = 'other-device';
  await f.adapter.resumeSession(f.session); assert.equal(p.receipt.status, 'uncertain');
  p.run.deviceId = 'device';
  await f.adapter.resumeSession(f.session);
  assert.equal(p.receipt.status, 'native_accepted'); assert.equal(p.receipt.nativeRunId, 'turn');
  assert.equal(f.session.state, 'completed');
  assert.equal(f.rpc.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('Codex reconnect rejoins the loaded shared thread and never reconstructs approvals from history', async t => {
  const f = harness(t);
  await f.adapter.resumeSession(f.session);
  const first = f.rpc;
  for (const id of [7, '7']) f.adapter.request({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'native', command: 'synthetic' } });
  const old = [...f.session.interactions];
  assert.equal(old.length, 2);
  await f.adapter.respond(f.session, old[0], { interactionId: old[0].id, epoch: 1, choiceId: 'accept' });
  assert.equal(first.responses[0].id, 7);
  f.adapter.closed = true;
  first.emit('fault', new Error('Synthetic connection loss'));
  assert.equal(f.adapter.approvals.size, 0); assert.equal(f.adapter.loaded.size, 0);
  assert.ok(f.events.some(event => event.type === 'interaction.closed' && event.data.id === old[1].id && event.data.status === 'stale'));
  const second = f.replace();
  second.snapshot.thread.status.type = 'active';
  second.snapshot.thread.turns = [{ id: 'surviving-turn', status: 'inProgress', items: [{ id: 'old-permission', type: 'commandExecution' }] }];
  await f.adapter.resumeSession(f.session);
  assert.equal(f.session.state, 'running'); assert.equal(f.adapter.approvals.size, 0);
  assert.deepEqual(second.calls.map(call => call.method), ['initialize', 'thread/resume']);
  assert.deepEqual(second.calls[1].params, { threadId: 'native' });
  f.adapter.request({ id: '7', method: 'item/commandExecution/requestApproval', params: { threadId: 'native', command: 'synthetic' } });
  await assert.rejects(f.adapter.respond(f.session, old[1], { interactionId: old[1].id, epoch: 1, choiceId: 'accept' }), /no longer pending/);
  const current = f.session.interactions.at(-1)!;
  await f.adapter.respond(f.session, current, { interactionId: current.id, epoch: 1, choiceId: 'decline' });
  assert.equal(second.responses[0].id, '7');
  first.emit('request', { id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'native' } });
  assert.equal(f.adapter.approvals.size, 0);
});

test('Codex authorized adoption verifies native cwd, runtime registration and actual loaded status', async t => {
  const f = harness(t);
  const read = await f.adapter.readExistingSession(f.session, 'registered-server');
  assert.equal(read.thread.cwd, f.session.cwd);
  assert.equal(f.adapter.byNative.size, 0); assert.equal(f.session.binding, undefined);
  const binding = await f.adapter.attachExistingSession(f.session, 'registered-server');
  assert.equal(binding.nativeIdentity, 'registered-server'); assert.equal(f.context.getSession(f.session.id).binding?.state, 'attached');
  assert.deepEqual(f.rpc.calls.map(call => call.method), ['initialize', 'thread/read', 'thread/read', 'thread/resume']);
  assert.equal(f.rpc.calls.some(call => ['thread/start', 'turn/start'].includes(call.method)), false);
});

test('an unloaded saved Codex thread resumes on its original ID and must become available', async t => {
  const f = harness(t);
  f.rpc.snapshot.thread.status.type = 'notLoaded';
  await assert.rejects(f.adapter.attachExistingSession(f.session, 'registered-server'), /status changed/);
  assert.equal(f.session.binding, undefined);
  f.rpc.beforeReply = method => { if (method === 'thread/resume') f.rpc.snapshot.thread.status.type = 'idle'; };
  await f.adapter.attachExistingSession(f.session, 'registered-server');
  assert.ok(f.rpc.calls.filter(call => call.method.startsWith('thread/')).every(call => call.params.threadId === 'native'));
  assert.equal(f.rpc.calls.some(call => call.method === 'turn/start' || call.method === 'thread/start'), false);
});

test('Codex adoption rejects changed cwd, thread, status, ownership and app-server identity before attach', async t => {
  const f = harness(t);
  await assert.rejects(f.adapter.attachExistingSession(f.session, 'other-server'), /identity mismatch/);
  assert.equal(f.rpc.calls.length, 0);
  for (const status of ['systemError', 'unexpected']) {
    f.rpc.snapshot.thread.status.type = status;
    await assert.rejects(f.adapter.attachExistingSession(f.session, 'registered-server'), /not available for verified resume/);
  }
  f.rpc.snapshot.thread.status.type = 'idle';
  f.rpc.snapshot.thread.cwd += '-not-authorized';
  await assert.rejects(f.adapter.attachExistingSession(f.session, 'registered-server'), /authorized session/);
  f.rpc.snapshot.thread.cwd = f.session.cwd;
  f.rpc.snapshot.thread.id = 'other-thread';
  await assert.rejects(f.adapter.attachExistingSession(f.session, 'registered-server'), /authorized session/);
  f.rpc.snapshot.thread.id = 'native';
  f.adapter.byNative.set('native', 'another-session');
  await assert.rejects(f.adapter.attachExistingSession(f.session, 'registered-server'), /already managed/);
  f.adapter.byNative.clear();
  f.adapter.config.runtimeIdentity = 'replacement-server';
  await assert.rejects(f.adapter.attachExistingSession(f.session, 'replacement-server'), /registration changed|connection changed/);
  assert.equal(f.session.binding, undefined); assert.equal(f.adapter.byNative.size, 0);
  assert.equal(f.rpc.calls.some(call => call.method === 'thread/resume'), false);
});

test('Codex adoption rechecks resume evidence and refuses a cwd changed after read', async t => {
  const f = harness(t);
  f.rpc.beforeReply = method => { if (method === 'thread/resume') f.rpc.snapshot.thread.cwd = 'not-authorized'; };
  await assert.rejects(f.adapter.attachExistingSession(f.session, 'registered-server'), /authorized session|changed during attachment/);
  assert.equal(f.session.binding, undefined); assert.equal(f.adapter.byNative.size, 0);
});

test('Codex managed reconnect refuses a different persisted app-server identity', async t => {
  const f = harness(t);
  await f.adapter.attachExistingSession(f.session, 'registered-server');
  const before = f.rpc.calls.length;
  f.adapter.config.runtimeIdentity = 'replacement-server';
  await assert.rejects(f.adapter.resumeSession(f.session), /different registered app-server/);
  assert.equal(f.rpc.calls.length, before);
});

test('Codex production item mapper restores command and file results with the same live mapping', async t => {
  const f=harness(t);
  const items=[{id:'cmd',type:'commandExecution',command:'node --test',status:'completed',aggregatedOutput:'failed test',exitCode:1},{id:'files',type:'fileChange',status:'failed',changes:[{path:'a.ts',kind:{type:'update'},diff:'patch'}],error:{message:'write denied'}}];
  f.rpc.snapshot.thread.turns=[{id:'turn',status:'failed',error:{message:'turn failed'},items}];
  await f.adapter.resumeSession(f.session);
  const history=f.events.filter(e=>e.type==='tool.updated');
  assert.equal(history[0].data.output,'failed test');assert.equal(history[0].data.exitCode,1);
  assert.deepEqual(history[1].data.error,{message:'write denied'});assert.deepEqual(history[1].data.changes,items[1].changes);
  assert.deepEqual(f.events.find(e=>e.type==='run.updated'&&e.data.state==='failed')?.data.error,{message:'turn failed'});
  for(const item of items)f.adapter.notification({method:'item/completed',params:{threadId:'native',turnId:'turn',item}});
  const live=f.events.filter(e=>e.type==='tool.updated').slice(2);
  assert.deepEqual(live.map(e=>({...e.data,historical:true})),history.map(e=>e.data));
});

test('Codex snapshot and late terminal remain associated with their actual turn',async t=>{
  const f=harness(t);f.session.runId='gateway';f.session.nativeRunId='old';f.session.state='uncertain';
  f.rpc.snapshot.thread.status.type='active';
  f.rpc.snapshot.thread.turns=[{id:'old',status:'failed',error:{message:'old error'},items:[]},{id:'new',status:'inProgress',items:[]}];
  await f.adapter.resumeSession(f.session);
  const terminal=f.events.find(e=>e.type==='run.updated'&&e.data.state==='failed');
  assert.equal(terminal?.data.nativeRunId,'old');assert.deepEqual(terminal?.data.error,{message:'old error'});
  f.session.nativeRunId='new';f.session.state='running';const count=f.events.length;
  f.adapter.notification({method:'turn/completed',params:{threadId:'native',turn:{id:'old',status:'completed'}}});
  assert.equal(f.events.length,count);assert.equal(f.session.state,'running');
});

test('Codex unknown items retain bounded redacted evidence without inferred success',async t=>{
  const f=harness(t);await f.adapter.resumeSession(f.session);
  f.adapter.notification({method:'item/completed',params:{threadId:'native',turnId:'turn',item:{id:'unknown',type:'future',apiKey:'secret-value',nested:{authorization:'Bearer token',text:'x'.repeat(50000)}}}});
  const data=f.events.at(-1)!.data;
  assert.equal(data.status,'uncertain');assert.equal(data.nativeType,'future');assert.equal(data.nativeItem.apiKey,'[redacted]');
  assert.ok(JSON.stringify(data).length<10000);assert.equal(JSON.stringify(data).includes('secret-value'),false);
  f.adapter.notification({method:'item/completed',params:{threadId:'native',turnId:'turn',item:{id:'cmd',type:'commandExecution'}}});
  assert.equal(f.events.at(-1)?.data.status,'uncertain');
});

test('Codex queried history through production Store preserves the old terminal while observing a new turn',async t=>{
  const f=harness(t);const store=new Store(':memory:');t.after(()=>store.db.close());
  f.session.runId='old-run';f.session.nativeRunId='old';f.session.state='failed';
  f.session.binding=f.adapter.binding('native',f.adapter.control,'registered-server');
  store.put('session',f.session.id,f.session);store.put('run','old-run',{runId:'old-run',sessionId:f.session.id,generation:1,nativeRunId:'old',state:'failed',result:{error:{message:'original'}}});
  f.context.getSession=()=>store.get<Session>('session',f.session.id)!;
  f.context.getRun=id=>store.get<RunRecord>('run',id);
  f.context.emit=(_,type,data)=>{store.event(f.session.id,type,data);};
  f.rpc.snapshot.thread.status.type='active';f.rpc.snapshot.thread.turns=[{id:'old',status:'completed',items:[{id:'old-cmd',type:'commandExecution',status:'completed',aggregatedOutput:'old output',exitCode:0}]},{id:'new',status:'inProgress',items:[]}];
  await f.adapter.resumeSession(f.session);
  const current=f.context.getSession(f.session.id);assert.equal(current.state,'running');assert.notEqual(current.runId,'old-run');assert.equal(current.nativeRunId,'new');
  assert.equal(store.get<RunRecord>('run','old-run')?.state,'failed');
  f.adapter.notification({method:'item/completed',params:{threadId:'native',turnId:'old',item:{id:'late',type:'commandExecution',status:'completed'}}});
  assert.equal(f.context.getSession(f.session.id).tools.some(tool=>tool.id==='late'),false);
});

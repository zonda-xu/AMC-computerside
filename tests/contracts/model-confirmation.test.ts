import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, command } from '../helpers.ts';
import { CodexAdapter } from '../../packages/adapters/codex/index.ts';
import { OpenCodeAdapter } from '../../packages/adapters/opencode/index.ts';
import { DshAdapter } from '../../packages/adapters/deepseek-harness/index.ts';
import { ClaudeCodeAdapter } from '../../packages/adapters/claude-code/index.ts';
import type { WebSocketRpc } from '../../packages/adapters/common/ws-rpc.ts';
import { nativeContext } from './fixtures/native-context.ts';

test('OpenCode v2 creation reports only native confirmed model identity', async t => {
  const f=nativeContext('opencode');const a=new OpenCodeAdapter('opencode',{command:'unused',expectedVersion:''},f.context);t.mock.method(a,'connection',async()=>{});t.mock.method(a,'http',async()=>({data:{id:'native',model:{id:'actual',providerID:'provider'}}}));assert.equal((await a.createSession('new',f.workspace,{providerId:'provider',modelId:'requested',label:'Requested'})).model?.modelId,'actual');
});

test('Claude missing official SDK fails closed instead of reserving a synthetic native session', async()=>{const f=nativeContext('claude-code');const a=new ClaudeCodeAdapter('claude-code',{command:process.execPath,expectedVersion:'',sdkModule:'amc-contract-missing-sdk'},f.context);await assert.rejects(a.createSession('new',f.workspace),/official SDK unavailable/);assert.equal(a.live.size,0);});

test('Codex creation never invents missing native identity', async () => {
  const f = await fixture();
  try {
    for (const model of [undefined, 'native-actual']) {
      const a = new CodexAdapter('codex', { command: 'unused', expectedVersion: 'not-run' }, f.adapter.context);
      mock.method(a, 'connection', async () => {
        const rpc = { request: async () => ({ thread: { id: 'native' }, modelProvider: model ? 'openai' : undefined, model }) };
        a.rpc = rpc as unknown as WebSocketRpc; return rpc;
      });
      assert.equal((await a.createSession('new', f.w, { providerId: 'openai', modelId: 'requested', label: 'Requested' })).model?.modelId, model);
    }
  } finally { await f.close(); }
});

test('DSH missing selectModel confirmation remains pending', async () => {
  const f = await fixture();
  try {
    const a = new DshAdapter('deepseek-harness', { command: 'unused', expectedVersion: 'not-run' }, f.adapter.context);
    mock.method(a, 'checkVersion', async () => {}); mock.method(a, 'call', async (method: string) => method === 'create' ? { sessionId: 'new-native' } : {});
    assert.equal((await a.createSession('new', f.w)).model, undefined);
    await assert.rejects(a.createSession('other',f.w,{providerId:'deepseek',modelId:'requested',label:'Requested'}),/model selection was not confirmed/);
  } finally { await f.close(); }
});

test('Core validates registration, preserves pending identity and dispatches a creation ID once', async () => {
  const f = await fixture();
  try {
    const model = { providerId: 'openai', modelId: 'test-model', label: 'Chosen' };
    const create = mock.method(f.adapter, 'createSession', async () => ({ nativeSessionId: 'new-native' }));
    await assert.rejects(() => f.core.createSession('device', 'invalid-model', f.w.id, 'codex', { ...model, modelId: 'not-registered' }));
    assert.equal(create.mock.callCount(), 0); assert.equal(f.store.getReceipt('device', 'invalid-model')?.status, 'rejected');
    const created = await f.core.createSession('device', 'chosen', f.w.id, 'codex', model); assert.equal(created.model, undefined); assert.deepEqual(created.nextModel, model);
    assert.equal((await f.core.createSession('device', 'chosen', f.w.id, 'codex', model)).id, created.id); assert.equal(create.mock.callCount(), 1);
    f.adapter.context.emit(created.id, 'model.confirmed', { model: { ...model, modelId: 'actual' } }); assert.deepEqual(f.core.session(created.id).nextModel, model);
    f.adapter.context.emit(created.id, 'model.confirmed', { model: { ...model, label: 'Native' } }); assert.equal(f.core.session(created.id).nextModel, undefined);
    await assert.rejects(() => f.core.createSession('device', 'chosen', f.w.id, 'codex', { ...model, label: 'Changed' }));
    create.mock.mockImplementation(async () => { throw new Error('Timeout'); });
    await assert.rejects(() => f.core.createSession('device', 'uncertain', f.w.id, 'codex', model));
    await assert.rejects(() => f.core.createSession('device', 'uncertain', f.w.id, 'codex', model), /already been received/); assert.equal(create.mock.callCount(), 2);
    f.core.adapters.delete('codex'); await assert.rejects(() => f.core.createSession('device', 'missing', f.w.id, 'codex', model), /unavailable/);
  } finally { await f.close(); }
});

test('Core compares provider/model without treating a native label change as pending', async () => {
  const f = await fixture();
  try {
    const model = { providerId: 'openai', modelId: 'test-model', label: 'Selected' };
    mock.method(f.adapter, 'configure', async () => { f.adapter.context.emit(f.s.id, 'model.confirmed', { model: { ...model, label: 'Native' } }); });
    f.core.accept('device', command(f.s, 'configure', { model })); await f.core.drain(); assert.equal(f.core.session(f.s.id).model?.label, 'Native'); assert.equal(f.core.session(f.s.id).nextModel, undefined);
  } finally { await f.close(); }
});

test('persisted next-turn model notifies connected catalogs without impersonating native confirmation', async () => {
  const f = await fixture();
  try {
    const model = { providerId: 'openai', modelId: 'test-model', label: 'Selected' };
    mock.method(f.adapter, 'configure', async () => {});
    let notifications = 0; f.core.on('catalog.changed', () => { notifications++; assert.deepEqual(f.core.session(f.s.id).nextModel, model); });
    const before = f.core.session(f.s.id).model;
    f.core.accept('device', command(f.s, 'configure', { model })); await f.core.drain();
    assert.equal(notifications, 1); assert.deepEqual(f.core.session(f.s.id).model, before);
    assert.deepEqual(f.core.session(f.s.id).nextModel, model);
  } finally { await f.close(); }
});

test('creating Codex leaves the existing DSH run intact and submission respects directory ownership', async () => {
  const f = await fixture();
  try {
    const dsh = new DshAdapter('deepseek-harness', { command: 'unused', expectedVersion: 'not-run' }, f.core.context('deepseek-harness'));
    mock.method(dsh,'probe',async()=>({id:'deepseek-harness' as const,runtimeInstanceId:dsh.context.runtimeInstanceId,version:'fixture',installed:true,authentication:'ready' as const,verified:false,detail:'Synthetic contract only',capabilities:{text:true,image:false,files:false,history:true,permission:true,questions:true,cancelScope:'turn',models:false},controlCapabilities:dsh.control,models:[]}));
    mock.method(dsh, 'createSession', async () => ({ nativeSessionId: 'dsh-native' })); f.core.adapters.set('deepseek-harness', dsh);
    const old = await f.core.createSession('device', 'old-dsh', f.w.id, 'deepseek-harness'); dsh.context.emit(old.id, 'run.updated', { state: 'running', runId: 'old-task' }); const ref = f.core.session(old.id).ref;
    const next = await f.core.createSession('device', 'new-codex', f.w.id, 'codex'); assert.equal(next.ref.engineId, 'codex'); assert.deepEqual(f.core.session(old.id).ref, ref); assert.equal(f.core.session(old.id).state, 'running');
    const submit = command(next); f.core.accept('device', submit); await f.core.drain(); assert.match(f.store.getReceipt('device', submit.clientRequestId)?.detail || '', /directory/); assert.equal(f.adapter.submitted, 0); assert.equal(f.core.session(old.id).runId, 'old-task');
  } finally { await f.close(); }
});

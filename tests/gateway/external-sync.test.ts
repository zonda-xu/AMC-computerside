import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExternalPage, ExternalProfile, Session } from '../../packages/protocol/src/types.ts';
import type { DiscoveryPage, ExternalSessionProvider } from '../../packages/adapters/common/external.ts';
import { closedProfile } from '../../packages/adapters/common/external.ts';
import { automationSettings } from '../../apps/gateway/src/automation.ts';
import { ExternalSync } from '../../apps/gateway/src/external-sync.ts';
import { Core } from '../../apps/gateway/src/core.ts';
import type { ExternalMessageIntent } from '../../apps/gateway/src/external.ts';
import { fixture as manualFixture } from '../helpers.ts';

async function fixture() {
  const f = await manualFixture();
  for (const workspace of [f.w, f.wb]) f.core.workspaceIdentities.confirm(workspace.id, f.root);
  return f;
}

class Provider implements ExternalSessionProvider {
  engineId: 'codex' | 'deepseek-harness'; namespace = 'fixture-source'; reads = 0;
  page: ExternalPage = { items: [{ nativeEventId: 'answer', role: 'assistant', text: 'baseline' }] };
  constructor(engineId: 'codex' | 'deepseek-harness' = 'codex') { this.engineId = engineId; }
  async profile(): Promise<ExternalProfile> {
    const p = closedProfile(this.engineId, 'TEST DOUBLE', 'No native control');
    return { ...p, namespace: this.namespace, profile: 'fixture-v1', discover: { state: 'supported', reason: 'fixture' }, history: { state: 'supported', reason: 'fixture' } };
  }
  async discover(cwd: string, cursor?: string): Promise<DiscoveryPage> { return { items: [{ nativeId: cwd + ':' + (cursor || 'first'), title: 'External read-only fixture', cwd }] }; }
  async history(_cwd: string, _id: string, _cursor?: string): Promise<ExternalPage> { this.reads++; return this.page; }
}
const runtime = { command: 'unused-fixture', expectedVersion: 'fixture', enabled: true };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('automatic scheduler covers both engines and all workspaces without command receipts or native mutations', async () => {
  const f = await fixture(); const sync = new ExternalSync(f.core, automationSettings({ enabled: true }), { codex: runtime, 'deepseek-harness': runtime });
  try {
    for (const engine of ['codex', 'deepseek-harness'] as const) f.core.external.providers.set(engine, new Provider(engine));
    const before = f.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get()!.n;
    const pending = sync.runOnce(); assert.equal(sync.runOnce(), pending); await pending;
    assert.equal(sync.statuses.size, 4); assert.ok([...sync.statuses.values()].every(s => s.state === 'complete'));
    const sessions = f.store.list<Session>('session').filter(s => s.externalSource); assert.equal(sessions.length, 4);
    assert.equal(f.store.list('external-baseline-v1').length, 4); assert.ok(sessions.every(s => s.messages.length === 1 && s.externalSource?.readOnly));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get()!.n, before);
    assert.equal(f.adapter.submitted, 0); assert.equal(f.adapter.decisions, 0);
  } finally { await sync.close(); await f.close(); }
});

test('whole history rounds exclude manual sync until all pages commit, including persistent silent baseline and revisions', async () => {
  const f = await fixture();
  try {
    const p = new Provider(); f.core.external.providers.set('codex', p);
    const c = (await f.core.external.discover(f.w.id, 'codex')).items[0]; const s = await f.core.external.ensureImport(c.candidateId);
    const entered = deferred<void>(); const unblock = deferred<void>(); const calls: (string | undefined)[] = []; const intents: ExternalMessageIntent[] = [];
    f.core.external.notificationIntent = intent => { intents.push(intent); f.store.put('test-intent', String(intent.event.seq), { silent: intent.silentBaseline }); };
    p.history = async (_cwd, _id, cursor) => {
      calls.push(cursor); if (calls.length === 1) { entered.resolve(); await unblock.promise; }
      return { items: [{ nativeEventId: cursor || 'one', role: 'assistant', text: 'history' }], cursor: cursor ? undefined : 'two' };
    };
    const round = f.core.external.syncRound(s.id); await entered.promise;
    const manual = f.core.external.sync(s.id); await delay(5); assert.equal(calls.length, 1);
    unblock.resolve(); await round; await manual;
    assert.deepEqual(calls, [undefined, 'two', undefined]); assert.ok(intents.every(i => i.silentBaseline));
    const restarted = new Core(f.store, f.core.hostId, [f.root]); restarted.external.providers.set('codex', p); restarted.external.notificationIntent = i => { intents.push(i); };
    p.history = async () => ({ items: [{ nativeEventId: 'one', role: 'assistant', text: 'updated' }, { nativeEventId: 'u', role: 'user', text: 'user' }, { nativeEventId: 'r', role: 'reasoning', text: 'private' }] });
    await restarted.external.syncRound(s.id);
    assert.equal(intents.length, 3); assert.equal(intents[2].silentBaseline, false); assert.equal(intents[2].automatic, true);
    assert.notEqual(intents[0].contentVersion, intents[2].contentVersion);
    await restarted.external.syncRound(s.id); assert.equal(intents.length, 3);
  } finally { await f.close(); }
});

test('notification intent failures roll back message, hash and intent together', async () => {
  const f = await fixture();
  try {
    const p = new Provider(); f.core.external.providers.set('codex', p);
    const c = (await f.core.external.discover(f.w.id, 'codex')).items[0]; const s = await f.core.external.ensureImport(c.candidateId);
    await f.core.external.syncRound(s.id); p.page.items[0].text = 'new answer';
    f.core.external.notificationIntent = intent => { f.store.put('test-intent', 'rollback', intent.contentVersion); throw new Error('outbox failed'); };
    await assert.rejects(() => f.core.external.syncRound(s.id), /outbox failed/);
    assert.equal(f.core.session(s.id).messages[0].text, 'baseline'); assert.equal(f.core.session(s.id).watermark, 1); assert.equal(f.store.get('test-intent', 'rollback'), undefined);
    f.core.external.notificationIntent = intent => { assert.equal(intent.silentBaseline, false); };
    await f.core.external.syncRound(s.id); assert.equal(f.core.session(s.id).watermark, 2);
  } finally { await f.close(); }
});

test('baseline completion extension shares its transaction and cannot mark failed baseline complete', async () => {
  const f = await fixture();
  try {
    const p = new Provider(); f.core.external.providers.set('codex', p);
    const c = (await f.core.external.discover(f.w.id, 'codex')).items[0]; const s = await f.core.external.ensureImport(c.candidateId);
    f.core.external.baselineCompleted = session => {
      assert.equal(f.store.db.isTransaction, true); assert.equal(session.watermark, 1);
      f.store.put('test-baseline', session.id, { complete: true }); throw new Error('baseline extension failed');
    };
    await assert.rejects(() => f.core.external.syncRound(s.id), /baseline extension failed/);
    assert.equal(f.store.get('external-baseline-v1', s.id), undefined); assert.equal(f.store.get('test-baseline', s.id), undefined);
    p.page.items[0].text = 'still baseline'; f.core.external.notificationIntent = i => { assert.equal(i.silentBaseline, true); };
    f.core.external.baselineCompleted = session => { assert.equal(f.store.db.isTransaction, true); f.store.put('test-baseline', session.id, { complete: true }); };
    await f.core.external.syncRound(s.id); assert.ok(f.store.get('external-baseline-v1', s.id)); assert.ok(f.store.get('test-baseline', s.id));
  } finally { await f.close(); }
});

test('global sync concurrency stays at two while different sessions progress independently', async () => {
  const f = await fixture();
  try {
    const p = new Provider(); f.core.external.providers.set('codex', p);
    p.discover = async cwd => ({ items: ['a', 'b', 'c'].map(nativeId => ({ nativeId, title: nativeId, cwd })) });
    const candidates = await f.core.external.discover(f.w.id, 'codex');
    const sessions = await Promise.all(candidates.items.map(c => f.core.external.ensureImport(c.candidateId)));
    const entered = deferred<void>(); const release = deferred<void>(); let active = 0; let peak = 0; let reads = 0;
    p.history = async () => { active++; peak = Math.max(peak, active); reads++; if (reads === 2) entered.resolve(); await release.promise; active--; return p.page; };
    const calls = sessions.map((s, n) => n === 1 ? f.core.external.sync(s.id) : f.core.external.syncRound(s.id));
    await entered.promise; assert.equal(reads, 2); release.resolve(); await Promise.all(calls); assert.equal(peak, 2); assert.equal(reads, 3);
  } finally { await f.close(); }
});

test('failed initial pagination remains silent until a complete round, and rejects repeated cursors and total budgets', async () => {
  const f = await fixture();
  try {
    const p = new Provider(); f.core.external.providers.set('codex', p);
    const c = (await f.core.external.discover(f.w.id, 'codex')).items[0]; const s = await f.core.external.import('device', 'manual-import', c.candidateId);
    await f.core.external.sync(s.id); assert.equal(f.store.get('external-baseline-v1', s.id), undefined);
    p.history = async (_cwd, _id, cursor) => ({ items: [{ nativeEventId: 'answer', role: 'assistant', text: cursor || 'partial' }], cursor: 'repeat' });
    await assert.rejects(() => f.core.external.syncRound(s.id), /Repeated/); assert.equal(f.store.get('external-baseline-v1', s.id), undefined);
    f.core.external.notificationIntent = intent => { assert.equal(intent.silentBaseline, true); };
    p.history = async () => ({ items: [{ nativeEventId: 'answer', role: 'assistant', text: 'retry baseline' }] });
    await assert.rejects(() => f.core.external.syncRound(s.id, { maxMessages: 0 }), /total budget/);
    await assert.rejects(() => f.core.external.syncRound(s.id, { maxBytes: 1 }), /total budget/);
    assert.equal(f.store.get('external-baseline-v1', s.id), undefined);
    await f.core.external.syncRound(s.id); assert.ok(f.store.get('external-baseline-v1', s.id));
  } finally { await f.close(); }
});

test('discovery rounds traverse all pages exclusively and reject cursor repetition and candidate budgets', async () => {
  const f = await fixture();
  try {
    const p = new Provider(); f.core.external.providers.set('codex', p);
    const entered = deferred<void>(); const release = deferred<void>(); const calls: (string | undefined)[] = [];
    p.discover = async (cwd, cursor) => {
      calls.push(cursor); if (calls.length === 1) { entered.resolve(); await release.promise; }
      return { items: [{ nativeId: cursor || 'first', title: 'fixture', cwd }], cursor: cursor ? undefined : 'next' };
    };
    const round = f.core.external.discoverRound(f.w.id, 'codex'); await entered.promise;
    const manual = f.core.external.discover(f.w.id, 'codex'); release.resolve(); assert.equal((await round).length, 2); await manual;
    assert.deepEqual(calls, [undefined, 'next', undefined]);
    p.discover = async () => ({ items: [], cursor: 'repeat' });
    await assert.rejects(() => f.core.external.discoverRound(f.w.id, 'codex'), /Repeated/);
    await assert.rejects(() => f.core.external.discoverRound(f.w.id, 'codex', { maxPages: 1 }), /page budget/);
    p.discover = async cwd => ({ items: [{ nativeId: 'first', title: 'fixture', cwd }] });
    await assert.rejects(() => f.core.external.discoverRound(f.w.id, 'codex', { maxCandidates: 0 }), /candidate budget/);
  } finally { await f.close(); }
});

test('scheduler reports failures, backs off per project, skips disabled engines and resumes with a fresh discovery cursor', async () => {
  const f = await fixture(); const sync = new ExternalSync(f.core, automationSettings({ enabled: true }), { codex: runtime, 'deepseek-harness': { ...runtime, enabled: false } });
  try {
    const p = new Provider(); f.core.external.providers.set('codex', p); let reads = 0;
    p.discover = async cwd => { reads++; if (cwd === f.w.path) throw new Error('expired cursor fixture'); return { items: [{ nativeId: cwd, title: 'fixture', cwd }] }; };
    await sync.runOnce(); assert.equal(reads, 2);
    const failed = sync.statuses.get(f.w.id + ':codex')!; assert.equal(failed.state, 'failed'); assert.equal(failed.failures, 1);
    assert.equal(sync.statuses.get(f.wb.id + ':codex')!.state, 'complete');
    await sync.runOnce(); assert.equal(reads, 2);
    failed.nextAt = 0; await sync.runOnce(); assert.equal(failed.failures, 1);
    const failedAgain = sync.statuses.get(f.w.id + ':codex')!; assert.equal(failedAgain.failures, 2); assert.ok(failedAgain.nextAt - Date.now() > 29000);
    failedAgain.failures = 30; failedAgain.nextAt = 0; await sync.runOnce();
    const capped = sync.statuses.get(f.w.id + ':codex')!; assert.ok(capped.nextAt - Date.now() <= 300000); assert.ok(capped.nextAt - Date.now() > 299000);
    p.discover = async (cwd, cursor) => { assert.equal(cursor, undefined); return { items: [{ nativeId: cwd, title: 'fixture', cwd }] }; };
    capped.nextAt = 0; await sync.runOnce(); assert.equal(sync.statuses.get(f.w.id + ':codex')!.failures, 0);
    f.core.allowedRoots = []; for (const status of sync.statuses.values()) status.nextAt = 0;
    await sync.runOnce(); assert.ok([...sync.statuses.values()].every(s => s.state === 'failed')); assert.ok(f.store.list('external-baseline-v1').length);
  } finally { await sync.close(); await f.close(); }
});

test('timeout and shutdown discard late native responses without projecting or establishing baseline', async () => {
  const f = await fixture(); const sync = new ExternalSync(f.core, automationSettings({ enabled: true }), { codex: runtime });
  try {
    const p = new Provider(); f.core.external.providers.set('codex', p); const late = deferred<ExternalPage>(); p.history = async () => late.promise;
    sync.roundBudgetMs = 20; await sync.runOnce();
    assert.ok([...sync.statuses.values()].every(s => s.state === 'failed')); assert.equal(f.store.list('external-baseline-v1').length, 0);
    late.resolve(p.page); await delay(5); assert.ok(f.store.list<Session>('session').filter(s => s.externalSource).every(s => s.watermark === 0));
    const blocked = deferred<ExternalPage>(); const entered = deferred<void>(); p.history = async () => { entered.resolve(); return blocked.promise; };
    for (const status of sync.statuses.values()) status.nextAt = 0;
    sync.roundBudgetMs = 60000; const pending = sync.runOnce(); await entered.promise; await sync.close(); await pending;
    blocked.resolve(p.page); await delay(5); assert.equal(f.store.list('external-baseline-v1').length, 0);
    const s = f.store.list<Session>('session').find(s => s.externalSource)!;
    const manualEntered = deferred<void>(); const manualLate = deferred<ExternalPage>(); p.history = async () => { manualEntered.resolve(); return manualLate.promise; };
    const manual = f.core.external.sync(s.id); const rejected = assert.rejects(manual, /stopped/); await manualEntered.promise; await f.core.external.close(); await rejected;
    manualLate.resolve(p.page); await delay(5); assert.equal(f.core.session(s.id).watermark, 0);
  } finally { await sync.close(); await f.close(); }
});

test('candidate failures and timeouts back off independently while healthy candidates continue', async () => {
  const f = await fixture(); const sync = new ExternalSync(f.core, automationSettings({ enabled: true }), { codex: runtime });
  try {
    sync.candidateBudgetMs = 500;
    const p = new Provider(); f.core.external.providers.set('codex', p);
    p.discover = async cwd => ({ items: ['broken', 'hanging', 'healthy'].map(name => ({ nativeId: cwd + ':' + name, title: name, cwd })) });
    const calls: string[] = []; const late = deferred<ExternalPage>();
    p.history = async (_cwd, nativeId) => { const id = nativeId.slice(nativeId.lastIndexOf(':') + 1); calls.push(id); if (id === 'broken') return { items: [], cursor: 'repeat' }; if (id === 'hanging') return late.promise; return p.page; };
    await sync.runOnce();
    assert.equal(sync.candidateStatuses.size, 4);
    assert.ok([...sync.candidateStatuses.values()].every(s => s.failures === 1));
    assert.equal(f.store.list('external-baseline-v1').length, 2);
    assert.ok([...sync.statuses.values()].every(s => s.failures === 0 && s.state === 'failed'));
    const before = calls.length;
    for (const status of sync.statuses.values()) status.nextAt = 0;
    await sync.runOnce(); assert.deepEqual(calls.slice(before), ['healthy', 'healthy']);
    late.resolve(p.page); await delay(5);
    assert.equal(f.store.list('external-baseline-v1').length, 2);
  } finally { await sync.close(); await f.close(); }
});

test('candidate budget rotation prevents total-round starvation', async () => {
  const f = await fixture(); const sync = new ExternalSync(f.core, automationSettings({ enabled: true }), { codex: runtime });
  try {
    sync.candidateBudgetMs = 2000; sync.roundBudgetMs = 1000;
    const p = new Provider(); f.core.external.providers.set('codex', p);
    p.discover = async cwd => ({ items: ['slow', 'healthy'].map(name => ({ nativeId: cwd + ':' + name, title: name, cwd })) });
    const late = deferred<ExternalPage>(); const reads: string[] = [];
    p.history = async (_cwd, nativeId) => { const id = nativeId.slice(nativeId.lastIndexOf(':') + 1); reads.push(id); return id === 'slow' ? late.promise : p.page; };
    await sync.runOnce(); assert.equal(f.store.list('external-baseline-v1').length, 0);
    for (const status of sync.statuses.values()) status.nextAt = 0;
    await sync.runOnce();
    assert.equal(f.store.list('external-baseline-v1').length, 2);
    assert.deepEqual(reads, ['slow', 'slow', 'healthy', 'slow', 'healthy', 'slow']); late.resolve(p.page);
  } finally { await sync.close(); await f.close(); }
});

test('source invalidation terminates candidates rather than treating it as an isolated history error', async () => {
  const f = await fixture(); const sync = new ExternalSync(f.core, automationSettings({ enabled: true }), { codex: runtime });
  try {
    const p = new Provider(); f.core.external.providers.set('codex', p); const calls: string[] = [];
    p.discover = async cwd => ({ items: ['changed', 'healthy'].map(nativeId => ({ nativeId, title: nativeId, cwd })) });
    p.history = async (_cwd, id) => { calls.push(id); p.namespace += '-changed'; return p.page; };
    await sync.runOnce(); assert.deepEqual(calls, ['changed', 'changed']);
    assert.ok([...sync.statuses.values()].every(s => s.error === 'source_changed'));
    assert.equal(sync.candidateStatuses.size, 0); assert.equal(f.store.list('external-baseline-v1').length, 0);
  } finally { await sync.close(); await f.close(); }
});

test('directory replacement during a history read prevents projection and future automatic reads', async () => {
  const f = await fixture(); const sync = new ExternalSync(f.core, automationSettings({ enabled: true }), { codex: runtime });
  try {
    const p = new Provider(); f.core.external.providers.set('codex', p); let reads = 0;
    p.history = async cwd => {
      reads++;
      if (cwd === f.w.path) { await rename(cwd, join(f.root, '.old-a')); await mkdir(cwd); }
      return p.page;
    };
    await sync.runOnce(); assert.equal(sync.statuses.get(f.w.id + ':codex')?.error, 'workspace_changed');
    assert.equal(f.store.list<Session>('session').find(s => s.externalSource && s.ref.workspaceId === f.w.id)?.watermark, 0);
    const before = reads; for (const status of sync.statuses.values()) status.nextAt = 0;
    await sync.runOnce(); assert.equal(reads, before + 1);
  } finally { await sync.close(); await f.close(); }
});

test('sync timer catches storage rejection and async listener failures and stops rescheduling on close', async () => {
  const f = await fixture(); const sync = new ExternalSync(f.core, automationSettings({ enabled: true }), { codex: runtime });
  try {
    const list = f.store.list.bind(f.store); let failed = false;
    f.store.list = kind => { if (kind === 'workspace' && !failed) { failed = true; throw new Error('private database detail'); } return list(kind); };
    sync.start(); await delay(30); assert.equal(sync.lastFailureCode, 'sync_failed'); assert.ok(sync.lastFailureAt);
    f.core.on('automation.sync', async () => { throw new Error('private listener detail'); });
    f.core.on('catalog.changed', async () => { throw new Error('private catalog listener detail'); });
    f.core.on('event', async () => { throw new Error('private event listener detail'); });
    f.core.external.providers.set('codex', new Provider()); await sync.runOnce(); await delay(5);
    assert.equal(sync.lastFailureCode, 'sync_listener_failed');
    assert.equal(f.core.lastListenerFailure?.code, 'listener_failed');
    await sync.close(); const at = sync.lastFailureAt; await delay(30); assert.equal(sync.lastFailureAt, at);
  } finally { await sync.close(); await f.close(); }
});

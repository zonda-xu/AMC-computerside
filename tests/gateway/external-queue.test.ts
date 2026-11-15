import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../helpers.ts';
import { closedProfile } from '../../packages/adapters/common/external.ts';
import type { ExternalPage } from '../../packages/protocol/src/types.ts';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function prepared() {
  const f = await fixture();
  const profile = closedProfile('codex', 'fixture', 'Queue fixture');
  let history: () => Promise<ExternalPage> = async () => ({ items: [] });
  f.core.external.providers.set('codex', {
    engineId: 'codex',
    profile: async () => ({ ...profile, namespace: 'queue', profile: 'queue-v1', discover: { state: 'supported', reason: 'fixture' }, history: { state: 'supported', reason: 'fixture' } }),
    discover: async cwd => ({ items: ['one', 'two', 'three'].map(nativeId => ({ nativeId, cwd, title: nativeId })) }),
    history: async () => history()
  });
  const candidates = await f.core.external.discover(f.w.id, 'codex');
  const sessions = await Promise.all(candidates.items.map(c => f.core.external.ensureImport(c.candidateId)));
  return { f, sessions, setHistory: (read: () => Promise<ExternalPage>) => { history = read; } };
}

test('cancelled same-session waiter settles promptly without allowing a later reader past its active predecessor', async () => {
  const p = await prepared(); const entered = deferred<void>(); const release = deferred<ExternalPage>(); let calls = 0;
  try {
    p.setHistory(async () => { calls++; entered.resolve(); return release.promise; });
    const first = p.f.core.external.sync(p.sessions[0].id); await entered.promise;
    const controller = new AbortController();
    const cancelled = p.f.core.external.syncRound(p.sessions[0].id, { signal: controller.signal });
    const checked = assert.rejects(cancelled, /queued cancellation/); controller.abort(new Error('queued cancellation'));
    await Promise.race([checked, delay(200).then(() => { throw new Error('Cancellation waited on active reader'); })]);
    const next = p.f.core.external.sync(p.sessions[0].id); await delay(10); assert.equal(calls, 1);
    release.resolve({ items: [] }); await Promise.all([first, next]); assert.equal(calls, 2);
  } finally { release.resolve({ items: [] }); await p.f.core.external.close(); await p.f.close(); }
});

test('aborting a global-slot waiter removes it without leaking a slot or delaying its cancellation', async () => {
  const p = await prepared(); const entered = deferred<void>(); const release = deferred<ExternalPage>(); let calls = 0;
  try {
    p.setHistory(async () => { calls++; if (calls === 2) entered.resolve(); return release.promise; });
    const first = p.f.core.external.sync(p.sessions[0].id); const second = p.f.core.external.sync(p.sessions[1].id); await entered.promise;
    const controller = new AbortController(); const cancelled = p.f.core.external.syncRound(p.sessions[2].id, { signal: controller.signal });
    const checked = assert.rejects(cancelled, /slot cancellation/); await delay(5); controller.abort(new Error('slot cancellation'));
    await Promise.race([checked, delay(200).then(() => { throw new Error('Slot cancellation blocked'); })]); assert.equal(calls, 2);
    release.resolve({ items: [] }); await Promise.all([first, second]);
    await p.f.core.external.sync(p.sessions[2].id); assert.equal(calls, 3);
  } finally { release.resolve({ items: [] }); await p.f.core.external.close(); await p.f.close(); }
});

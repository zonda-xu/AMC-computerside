import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, command } from '../helpers.ts';
import { PushCoordinator } from '../../apps/gateway/src/push.ts';
import { closedProfile } from '../../packages/adapters/common/external.ts';
import type { ExternalPage } from '../../packages/protocol/src/types.ts';

test('history imports never manufacture live completion notifications, managed terminals atomically enqueue', async () => {
  const f = await fixture();
  try {
    const push = new PushCoordinator(f.store, f.core.hostId);
    const ticket = f.store.ticket(); const device = f.store.redeem(ticket.token, 'Push integration');
    push.bind(device.deviceId, 'integration-token');
    f.store.notificationIntent = (event, session) => { push.enqueue(session.id, event.seq); };
    let page: ExternalPage = { items: [{ nativeEventId: 'answer', role: 'assistant', text: 'Old history' }] };
    const profile = closedProfile('codex', 'fixture', 'Fixture only');
    f.core.external.providers.set('codex', {
      engineId: 'codex',
      profile: async () => ({ ...profile, namespace: 'integration', profile: 'integration-v1', discover: { state: 'supported', reason: 'fixture' }, history: { state: 'supported', reason: 'fixture' } }),
      discover: async cwd => ({ items: [{ nativeId: 'thread', title: 'Existing thread', cwd }] }),
      history: async () => page
    });
    const candidate = (await f.core.external.discover(f.w.id, 'codex')).items[0];
    const session = await f.core.external.ensureImport(candidate.candidateId);
    await f.core.external.syncRound(session.id);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_jobs').get()!.n, 0);
    page = { items: [{ nativeEventId: 'answer', role: 'assistant', text: 'New response' }, { nativeEventId: 'private', role: 'reasoning', text: 'Hidden reasoning' }] };
    await f.core.external.syncRound(session.id);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_jobs').get()!.n, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_intents').get()!.n, 0);
    await f.core.external.syncRound(session.id);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_intents').get()!.n, 0);
    const managed = await f.core.createSession('device', 'push-managed-session', f.wb.id, 'codex');
    const submit = command(managed); f.core.accept('device', submit); await f.core.drain();
    const runId = f.core.session(managed.id).runId;
    assert.ok(runId);
    assert.throws(() => f.store.transaction(() => { f.store.event(managed.id, 'run.updated', { state: 'completed', runId }, false); throw Error('rollback'); }), /rollback/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_jobs').get()!.n, 0);
    f.store.event(managed.id, 'run.updated', { state: 'completed', runId });
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_jobs').get()!.n, 1);
    const stored = JSON.stringify(f.store.db.prepare('SELECT * FROM push_jobs').all());
    assert.ok(!stored.includes('New response') && !stored.includes('Hidden reasoning'));
    assert.equal(f.adapter.submitted, 1);
  } finally { await f.close(); }
});

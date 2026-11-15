import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers.ts';
import { PushCoordinator } from '../../apps/gateway/src/push.ts';
import { closedProfile } from '../../packages/adapters/common/external.ts';
import type { ExternalPage } from '../../packages/protocol/src/types.ts';

test('automatic history projection and push outbox share the silent baseline and message transaction', async () => {
  const f = await fixture();
  try {
    const push = new PushCoordinator(f.store, f.core.hostId);
    const ticket = f.store.ticket(); const device = f.store.redeem(ticket.token, 'Push integration');
    push.bind(device.deviceId, 'integration-token');
    f.core.external.notificationIntent = intent => { if (!intent.silentBaseline) push.enqueue(intent.session.id, intent.event.seq); };
    f.core.external.baselineCompleted = session => { push.completeBaseline(session.id, true); };
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
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_baselines').get()!.n, 1);
    page = { items: [{ nativeEventId: 'answer', role: 'assistant', text: 'New response' }, { nativeEventId: 'private', role: 'reasoning', text: 'Hidden reasoning' }] };
    await f.core.external.syncRound(session.id);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_jobs').get()!.n, 1);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_intents').get()!.n, 1);
    await f.core.external.syncRound(session.id);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_intents').get()!.n, 1);
    const stored = JSON.stringify(f.store.db.prepare('SELECT * FROM push_jobs').all());
    assert.ok(!stored.includes('New response') && !stored.includes('Hidden reasoning'));
    assert.equal(f.adapter.submitted, 0);
  } finally { await f.close(); }
});

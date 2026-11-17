import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers.ts';
import { RuntimeRecovery } from '../../apps/gateway/src/runtime-recovery.ts';
import type { Session } from '../../packages/protocol/src/types.ts';

test('host recovery reconnects the existing binding once without submitting or creating input', async t => {
  const f = await fixture(); const recovery = new RuntimeRecovery(f.core);
  try {
    const s = f.core.session(f.s.id); assert.ok(s.binding); s.binding.state = 'disconnected'; s.state = 'uncertain'; f.store.put('session', s.id, s);
    let resumed = 0;
    t.mock.method(f.adapter, 'resumeSession', async (session: Session) => {
      resumed++; assert.equal(session.ref.nativeSessionId, s.ref.nativeSessionId);
      const current = f.core.session(s.id); assert.ok(current.binding); current.binding.state = 'attached'; f.store.put('session', current.id, current);
    });
    await Promise.all([recovery.tick(), recovery.tick()]); await recovery.tick();
    assert.equal(resumed, 1); assert.equal(f.adapter.submitted, 0); assert.equal(f.core.session(s.id).state, 'uncertain');
    assert.equal(f.core.session(s.id).binding?.generation, s.binding.generation);
  } finally { await recovery.close(); await f.close(); }
});

test('failed native recovery keeps uncertainty and does not repeatedly invoke or fabricate a binding', async t => {
  const f = await fixture(); const recovery = new RuntimeRecovery(f.core);
  try {
    const s = f.core.session(f.s.id); assert.ok(s.binding); s.binding.state = 'disconnected'; s.state = 'uncertain'; f.store.put('session', s.id, s);
    let resumed = 0; t.mock.method(f.adapter, 'resumeSession', async () => { resumed++; throw Error('Native runtime unavailable'); });
    await recovery.tick(); await recovery.tick();
    assert.equal(resumed, 1); assert.equal(f.core.session(s.id).state, 'uncertain'); assert.equal(f.core.session(s.id).binding?.state, 'disconnected');
    assert.equal(f.adapter.submitted, 0);
  } finally { await recovery.close(); await f.close(); }
});

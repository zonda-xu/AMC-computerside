import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExternalPage, ExternalProfile, Session } from '../../packages/protocol/src/types.ts';
import type { DiscoveryPage, ExternalSessionProvider } from '../../packages/adapters/common/external.ts';
import { closedProfile } from '../../packages/adapters/common/external.ts';
import { fixture, command } from '../helpers.ts';
import { Core } from '../../apps/gateway/src/core.ts';
import { DshAdapter } from '../../packages/adapters/deepseek-harness/index.ts';
import { DshExternalProvider } from '../../packages/adapters/deepseek-harness/external.ts';

class FixtureProvider implements ExternalSessionProvider {
  engineId: 'codex' = 'codex';
  cwd: string; namespace = 'fixture-host-instance'; page: ExternalPage = { items: [{ nativeEventId: 'native-1', role: 'user', text: 'Fixture only' }, { nativeEventId: 'native-2', role: 'assistant', text: 'Fixture answer' }] };
  constructor(cwd: string) { this.cwd = cwd; }
  async profile(): Promise<ExternalProfile> {
    const p = closedProfile('codex', 'TEST DOUBLE', 'TEST DOUBLE; no native control proof');
    p.namespace = this.namespace; p.profile = 'fixture-v1'; p.syncMode = 'manual-refresh';
    p.discover = { state: 'supported', reason: 'fixture' }; p.history = p.discover; p.observe = p.discover; return p;
  }
  async discover(): Promise<DiscoveryPage> { return { items: [{ nativeId: 'same-native', title: 'Fixture source', cwd: this.cwd }] }; }
  async history(): Promise<ExternalPage> { return this.page; }
}
test('unknown tools fail closed and report all four independent profiles', async () => {
  const f = await fixture();
  try {
    const profiles = await f.core.external.capabilities(); assert.equal(profiles.length, 4);
    for (const p of profiles) { assert.notEqual(p.discover.state, 'supported'); assert.notEqual(p.submit.state, 'supported'); }
    await assert.rejects(() => f.core.external.discover(f.w.id, 'claude-code'), /verified/);
  } finally { await f.close(); }
});
test('DSH external fixture requires a nonempty pinned version and never probes a disabled runtime', async () => {
  const f = await fixture();
  try {
    const adapter = new DshAdapter('deepseek-harness', { command: 'fixture-only', expectedVersion: '' }, f.core.context('deepseek-harness'));
    let calls = 0; let version = '';
    adapter.call = async () => { calls++; return { version, externalProtocol: 2, apiProfile: 'dsh-controller-0.2.1-rc.5-page-v2', controllerDigest: 'a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386', control: false, instanceId: 'fixture-instance' }; };
    const provider = new DshExternalProvider(adapter);
    assert.equal((await provider.profile()).discover.state, 'unverified'); assert.equal(calls, 0);
    adapter.config.expectedVersion = '0.2.1-rc.5';
    assert.equal((await provider.profile()).discover.state, 'unverified');
    version = '0.2.1-rc.5';
    const supported = await provider.profile(); assert.equal(supported.discover.state, 'supported'); assert.equal(supported.submit.state, 'unverified');
    adapter.config.expectedVersion = 'different-version';
    assert.match((await provider.profile()).discover.reason, /does not match expectedVersion/);
    adapter.config.expectedVersion = version;
    adapter.config.enabled = false; const before = calls;
    assert.equal((await provider.profile()).discover.state, 'unverified'); assert.equal(calls, before);
    await assert.rejects(() => provider.discover(f.w.path), /version mismatch/); assert.equal(calls, before);
  } finally { await f.close(); }
});
test('external source import is idempotent, message sync deduplicates persistently and never changes run ownership', async () => {
  const f = await fixture();
  try {
    const p = new FixtureProvider(f.w.path); f.core.external.providers.set('codex', p);
    const c = (await f.core.external.discover(f.w.id, 'codex')).items[0];
    const s = await f.core.external.import('device', 'import', c.candidateId);
    assert.equal((await f.core.external.import('device', 'import', c.candidateId)).id, s.id);
    assert.equal((await f.core.external.import('other-device', 'import-other', c.candidateId)).id, s.id);
    f.adapter.context.emit(f.s.id, 'run.updated', { state: 'uncertain' });
    await f.core.external.sync(s.id); await f.core.external.sync(s.id);
    assert.equal(f.core.session(s.id).watermark, 2); assert.equal(f.core.session(s.id).messages.length, 2);
    assert.equal(f.core.session(s.id).state, 'idle'); assert.equal(f.core.session(f.s.id).state, 'uncertain');
    assert.equal(f.core.session(s.id).interactions.length, 0);
    const restart = new Core(f.store, f.core.hostId, [f.root]); restart.external.providers.set('codex', p);
    await restart.external.sync(s.id); assert.equal(restart.session(s.id).watermark, 2);
    p.page.items[1].text = 'Fixture completed answer'; await restart.external.sync(s.id);
    assert.equal(restart.session(s.id).messages.length, 2); assert.equal(restart.session(s.id).messages[1].text, 'Fixture completed answer');
    assert.equal(restart.session(s.id).watermark, 3);
  } finally { await f.close(); }
});
test('external projections cannot bypass read-only mutation guards through old commands or direct dispatch', async () => {
  const f = await fixture();
  try {
    const p = new FixtureProvider(f.w.path); f.core.external.providers.set('codex', p);
    const c = (await f.core.external.discover(f.w.id, 'codex')).items[0]; const s = await f.core.external.import('device', 'read-only', c.candidateId);
    for (const action of ['submit', 'cancel', 'configure', 'decide']) {
      assert.throws(() => f.core.accept('device', command(s, action)), /read-only/);
      await assert.rejects(() => f.core.execute('device', command(s, action)), /mutations/);
    }
    assert.equal(f.adapter.submitted, 0); assert.equal(f.adapter.decisions, 0);
  } finally { await f.close(); }
});
test('external import retries the original request after a local transaction rollback without duplicating sessions', async () => {
  const f = await fixture();
  try {
    const p = new FixtureProvider(f.w.path); f.core.external.providers.set('codex', p);
    const c = (await f.core.external.discover(f.w.id, 'codex')).items[0];
    const put = f.store.put.bind(f.store); let fail = true;
    f.store.put = (kind, id, value) => { if (kind === 'external-import-v1' && fail) { fail = false; throw new Error('injected import rollback'); } put(kind, id, value); };
    await assert.rejects(() => f.core.external.import('device', 'retry-import', c.candidateId), /injected/);
    assert.equal(f.store.list<Session>('session').filter(s => s.externalSource).length, 0);
    const restarted = new Core(f.store, f.core.hostId, [f.root]); restarted.external.providers.set('codex', p);
    const s = await restarted.external.import('device', 'retry-import', c.candidateId);
    assert.equal((await restarted.external.import('device', 'retry-import', c.candidateId)).id, s.id);
    assert.equal(f.store.list<Session>('session').filter(s => s.externalSource).length, 1);
    p.namespace = 'another-source';
    const other = (await restarted.external.discover(f.w.id, 'codex')).items[0];
    await assert.rejects(() => restarted.external.import('device', 'retry-import', other.candidateId), /different target or contents/);
  } finally { await f.close(); }
});
test('external history revalidates authorization and source identity after asynchronous native reads', async () => {
  const f = await fixture();
  try {
    const p = new FixtureProvider(f.w.path); f.core.external.providers.set('codex', p);
    const c = (await f.core.external.discover(f.w.id, 'codex')).items[0];
    const s = await f.core.external.import('device', 'read-race', c.candidateId);
    p.history = async () => { f.core.allowedRoots = [f.wb.path]; return p.page; };
    await assert.rejects(() => f.core.external.sync(s.id), /outside/);
    assert.equal(f.core.session(s.id).watermark, 0);
    f.core.allowedRoots = [f.root];
    p.history = async () => { p.namespace = 'changed-during-read'; return p.page; };
    await assert.rejects(() => f.core.external.sync(s.id), /identity or profile changed/);
    assert.equal(f.core.session(s.id).watermark, 0);
    assert.equal(f.core.session(f.s.id).state, 'idle');
  } finally { await f.close(); }
});
test('canonical workspace filtering and namespace identity prevent cross-directory and native-ID joins', async () => {
  const f = await fixture();
  try {
    const p = new FixtureProvider(f.wb.path); f.core.external.providers.set('codex', p);
    assert.equal((await f.core.external.discover(f.w.id, 'codex')).items.length, 0);
    p.cwd = f.w.path;
    const first = (await f.core.external.discover(f.w.id, 'codex')).items[0];
    const s = await f.core.external.import('device', 'first', first.candidateId);
    p.namespace = 'another-host-instance';
    const second = (await f.core.external.discover(f.w.id, 'codex')).items[0];
    assert.notEqual(first.candidateId, second.candidateId);
    const b = await f.core.external.import('device', 'second', second.candidateId); assert.notEqual(s.id, b.id);
    await assert.rejects(() => f.core.external.sync(s.id), /identity or profile changed/);
    f.core.allowedRoots = [f.wb.path]; await assert.rejects(() => f.core.external.sync(b.id), /outside/);
  } finally { await f.close(); }
});
test('external message validation rejects oversized and malformed history before projecting content', async () => {
  const f = await fixture();
  try {
    const p = new FixtureProvider(f.w.path); f.core.external.providers.set('codex', p);
    const c = (await f.core.external.discover(f.w.id, 'codex')).items[0]; const s = await f.core.external.import('device', 'budget', c.candidateId);
    p.page = { items: [{ nativeEventId: 'too-large', role: 'assistant', text: 'x'.repeat(100001) }] };
    await assert.rejects(() => f.core.external.sync(s.id), /Malformed/); assert.equal(f.core.session(s.id).watermark, 0);
    const before: Session = f.core.session(s.id); assert.equal(before.state, 'idle');
  } finally { await f.close(); }
});

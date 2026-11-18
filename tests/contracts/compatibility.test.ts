import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessCompatibility, compareLatestMetadata, compareNativeVersions, compatibilityProfile,
  DEFAULT_COMPATIBILITY_POLICY, parseNativeVersion, REQUIRED_PROTOCOL_GROUPS, requiredProtocolOperations,
  validateProtocolEvidence,
} from '../../packages/protocol/src/compatibility.ts';
import type {
  CompatibilityDescriptor, ComponentVersions, PinnedPolicy, ProtocolEvidence, ProtocolOperationGroup,
} from '../../packages/protocol/src/compatibility.ts';
import type { EngineId } from '../../packages/protocol/src/types.ts';

const now = 1_000_000;
function descriptor(id: EngineId = 'codex', versions?: ComponentVersions): CompatibilityDescriptor {
  const profile = compatibilityProfile(id);
  const components: ComponentVersions = {};
  for (const item of profile.components) components[item.component] = item.version;
  Object.assign(components, versions);
  return { id, version: components[profile.primary] ?? '', componentVersions: components, runtimeInstanceId: 'runtime-1', generation: 1, configurationId: 'config-digest-1' };
}
function evidenceFor(runtime: CompatibilityDescriptor): ProtocolEvidence {
  const profile = compatibilityProfile(runtime.id);
  return {
    profileId: profile.id, engineId: runtime.id,
    versions: { [profile.primary]: runtime.version, ...runtime.componentVersions },
    runtimeInstanceId: runtime.runtimeInstanceId, generation: runtime.generation,
    configurationId: runtime.configurationId, observedAt: now,
    groups: REQUIRED_PROTOCOL_GROUPS.map(group => ({ group, result: 'proven', detail: `Local fixture proof for ${group}` })),
  };
}
function withoutGroup(evidence: ProtocolEvidence, group: ProtocolOperationGroup): ProtocolEvidence {
  return { ...evidence, groups: evidence.groups.filter(item => item.group !== group) };
}

test('native version parsing is anchored and handles native labels, prereleases and build metadata', () => {
  for (const version of ['codex-cli 0.169.0', '2.1.325 (Claude Code)', 'opencode 2.3.0', 'v0.2.1-rc.5+local.7']) {
    assert.ok(parseNativeVersion(version));
  }
  for (const version of ['', 'latest', '1.2', '01.2.3', '1.2.3-01', '1.2.3-', 'error: 1.2.3', '1.2.3\n2.3.4', '9007199254740992.0.0']) {
    assert.equal(parseNativeVersion(version), undefined, version);
  }
  assert.equal(parseNativeVersion('codex-cli 0.169.0')?.canonical, '0.169.0');
  const ordered = ['0.2.1-rc.5', '0.2.1-rc.10', '0.2.1', '1.0.0-alpha', '1.0.0', '1000.0.0'];
  for (let i = 1; i < ordered.length; i++) {
    const a = parseNativeVersion(ordered[i - 1]);
    const b = parseNativeVersion(ordered[i]);
    assert.ok(a && b);
    assert.equal(compareNativeVersions(a, b), -1);
    assert.equal(compareNativeVersions(b, a), 1);
  }
  const a = parseNativeVersion('1.0.0+one');
  const b = parseNativeVersion('1.0.0+two');
  assert.ok(a && b);
  assert.equal(compareNativeVersions(a, b), 0);
});

test('all planned component baselines are explicit and baseline matches only permit probing', () => {
  const engines: EngineId[] = ['codex', 'claude-code', 'opencode', 'deepseek-harness'];
  assert.deepEqual(engines.map(id => compatibilityProfile(id).components.map(item => item.version)), [
    ['0.169.0'], ['0.3.325', '2.1.325'], ['2.3.0', '2.3.0'], ['0.2.1-rc.5'],
  ]);
  assert.equal(DEFAULT_COMPATIBILITY_POLICY.mode, 'latest-compatible');
  for (const id of engines) {
    const result = assessCompatibility(descriptor(id), { now });
    assert.equal(result.permittedToProbe, true);
    assert.equal(result.candidate, false);
    assert.equal(result.evidence.protocolComplete, false);
    assert.ok(Object.values(result.evidence.capabilities).every(value => value === false));
    assert.equal('nativeVerified' in result, false);
  }
});

test('arbitrary future minor and major versions remain candidates, never automatic support', () => {
  for (const version of ['0.170.0', '1.0.0', '999.999.999', '1000.0.0-rc.1']) {
    const runtime = descriptor('codex', { cli: version });
    const result = assessCompatibility(runtime, { now });
    assert.equal(result.permittedToProbe, true);
    assert.equal(result.candidate, true);
    assert.equal(result.evidence.capabilities.submit, false);
    assert.equal(assessCompatibility(runtime, { now }, undefined, evidenceFor(runtime)).evidence.protocolComplete, true);
  }
});

test('older and vendor-labelled components can prove their capabilities, missing component identities cannot', () => {
  const runtimes = [
    descriptor('codex', { cli: '0.168.99' }), descriptor('codex', { cli: '0.169.0-rc.1' }),
    descriptor('codex', { cli: 'invalid' }), descriptor('claude-code', { sdk: '0.3.324' }),
    descriptor('opencode', { client: '2.2.99' }), descriptor('deepseek-harness', { controller: '0.2.1-rc.4' }),
  ];
  for (const runtime of runtimes) {
    const result = assessCompatibility(runtime, { now }, undefined, evidenceFor(runtime));
    assert.equal(result.permittedToProbe, true);
    assert.equal(result.evidence.capabilities.create, true);
    assert.equal(assessCompatibility(runtime,{now}).evidence.capabilities.create, false);
  }
  const missing = { ...descriptor('claude-code'), componentVersions: { cli: '2.1.325' } };
  assert.equal(assessCompatibility(missing,{now}).permittedToProbe,false);
  assert.equal(validateProtocolEvidence(missing,evidenceFor(missing),{now}).valid,false);
  for (const version of ['0.2.1-rc.6', '0.2.1', '0.2.2-alpha.1']) {
    assert.equal(assessCompatibility(descriptor('deepseek-harness', { controller: version }), { now }).candidate, true);
  }
});

test('pinned policy requires every exact target and configuration, without bypassing the baseline', () => {
  const runtime = descriptor('claude-code');
  const policy: PinnedPolicy = { mode: 'pinned', targets: { sdk: '0.3.325', cli: '2.1.325' }, configurationId: runtime.configurationId };
  assert.equal(assessCompatibility(runtime, { now }, policy).permittedToProbe, true);
  assert.equal(assessCompatibility(runtime, { now }, policy).evidence.capabilities.submit, false);
  for (const changed of [
    { ...policy, configurationId: '' }, { ...policy, configurationId: 'other' },
    { ...policy, targets: { cli: '2.1.325' } }, { ...policy, targets: { sdk: '0.3.326', cli: '2.1.325' } },
  ]) assert.equal(assessCompatibility(runtime, { now }, changed).permittedToProbe, false);
  const future = descriptor('codex', { cli: '9.0.0+build.1' });
  assert.equal(assessCompatibility(future, { now }, policy).permittedToProbe, false);
  assert.equal(assessCompatibility(future, { now }, { mode: 'pinned', targets: { cli: '9.0.0+build.1' }, configurationId: future.configurationId }).permittedToProbe, true);
  assert.equal(assessCompatibility(future, { now }, { mode: 'pinned', targets: { cli: '9.0.0+build.2' }, configurationId: future.configurationId }).permittedToProbe, false);
  assert.equal(assessCompatibility(descriptor('codex', { cli: '0.168.0' }), { now }, { mode: 'pinned', targets: { cli: '0.168.0' }, configurationId: runtime.configurationId }).permittedToProbe, true);
});

test('passive handshake and passive claims never prove callbacks, terminal outcomes or cancellation', () => {
  const runtime = descriptor();
  const evidence = evidenceFor(runtime);
  const passive: ProtocolEvidence = { ...evidence, groups: evidence.groups.map(item => ({ ...item, result: 'passive' })) };
  const result = validateProtocolEvidence(runtime, passive, { now });
  assert.equal(result.valid, true);
  assert.equal(result.passiveHandshake, true);
  assert.equal(result.protocolComplete, false);
  assert.ok(Object.values(result.capabilities).every(value => value === false));
  for (const group of ['permission-callback', 'question-callback', 'terminal', 'cancellation']) assert.ok(result.missingGroups.some(item => item === group));
  assert.ok(requiredProtocolOperations().length > 0);
});

test('evidence cannot be replayed across time, versions, profiles, runtime, generation or configuration', () => {
  const runtime = descriptor();
  const evidence = evidenceFor(runtime);
  const invalid: ProtocolEvidence[] = [
    { ...evidence, observedAt: now - 300_001 }, { ...evidence, observedAt: now + 1 },
    { ...evidence, observedAt: NaN }, { ...evidence, versions: { cli: '0.170.0' } },
    { ...evidence, versions: {} }, { ...evidence, profileId: 'other' },
    { ...evidence, engineId: 'opencode' }, { ...evidence, runtimeInstanceId: 'replacement' },
    { ...evidence, generation: 2 }, { ...evidence, configurationId: 'changed' },
  ];
  for (const item of invalid) {
    const result = validateProtocolEvidence(runtime, item, { now });
    assert.equal(result.valid, false);
    assert.ok(Object.values(result.capabilities).every(value => value === false));
  }
  assert.equal(validateProtocolEvidence(runtime, evidence, { now: NaN }).valid, false);
  assert.equal(validateProtocolEvidence(runtime, evidence, { now, maxAgeMs: -1 }).valid, false);
  assert.equal(validateProtocolEvidence(runtime, evidence, { now: now + 300_000 }).valid, true);
});

test('per-operation degradation retains only independently proven capabilities', () => {
  const runtime = descriptor();
  const evidence = evidenceFor(runtime);
  const result = validateProtocolEvidence(runtime, withoutGroup(evidence, 'permission-callback'), { now });
  assert.equal(result.protocolComplete, false);
  assert.equal(result.capabilities.approve, false);
  assert.equal(result.capabilities.answer, true);
  assert.equal(result.capabilities.submit, true);
  const noTerminal = validateProtocolEvidence(runtime, withoutGroup(evidence, 'terminal'), { now });
  assert.equal(noTerminal.capabilities.submit, false);
  assert.equal(noTerminal.capabilities.cancel, false);
  assert.equal(noTerminal.capabilities.observe, true);
  const unsupported: ProtocolEvidence = { ...evidence, groups: evidence.groups.map(item => item.group === 'cancellation' ? { ...item, result: 'unsupported' } : item) };
  assert.equal(validateProtocolEvidence(runtime, unsupported, { now }).capabilities.cancel, false);
  const duplicate: ProtocolEvidence = { ...evidence, groups: [...evidence.groups, { group: 'question-callback', result: 'proven', detail: 'duplicate' }] };
  assert.equal(validateProtocolEvidence(runtime, duplicate, { now }).capabilities.answer, false);
  assert.ok(Object.values(validateProtocolEvidence(runtime, withoutGroup(evidence, 'handshake'), { now }).capabilities).every(value => value === false));
});

test('conflicting primary descriptor versions cannot acquire control', () => {
  const runtime = { ...descriptor(), version: '0.170.0' };
  assert.equal(assessCompatibility(runtime, { now }, undefined, evidenceFor(runtime)).permittedToProbe, false);
  assert.equal(validateProtocolEvidence(runtime, evidenceFor(runtime), { now }).valid, false);
});

test('optional latest metadata comparison is advisory and pure', () => {
  assert.equal(compareLatestMetadata('0.169.0', '99.0.0', '0.169.0').candidate, true);
  assert.equal(compareLatestMetadata('99.0.0', '0.169.0', '0.169.0').relation, 'older');
  assert.equal(compareLatestMetadata('0.169.0', '0.169.0+build', '0.169.0').relation, 'equal');
  assert.equal(compareLatestMetadata('0.1.0', '0.168.0', '0.169.0').candidate, true);
  assert.equal(compareLatestMetadata('bad', '99.0.0', '0.169.0').relation, 'invalid');
});

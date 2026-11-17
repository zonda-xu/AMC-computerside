import type { ControlCapabilities, EngineId } from './types.ts';

export type NativeComponent = 'cli' | 'sdk' | 'client' | 'controller';
export type ComponentVersions = Partial<Record<NativeComponent, string>>;
export interface NativeVersion {
  raw: string;
  canonical: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
  build: string;
}
export interface ComponentBaseline { component: NativeComponent; version: string }
export interface CompatibilityProfile {
  id: string;
  engineId: EngineId;
  primary: NativeComponent;
  components: readonly ComponentBaseline[];
}
export interface LatestCompatiblePolicy { mode: 'latest-compatible' }
export interface PinnedPolicy {
  mode: 'pinned';
  targets: ComponentVersions;
  configurationId: string;
}
export type CompatibilityPolicy = LatestCompatiblePolicy | PinnedPolicy;
export const DEFAULT_COMPATIBILITY_POLICY: Readonly<LatestCompatiblePolicy> = Object.freeze({ mode: 'latest-compatible' });

export function compatibilityProfile(engineId: EngineId): CompatibilityProfile {
  switch (engineId) {
    case 'codex': return { id: 'codex-app-server-0.169.0', engineId, primary: 'cli', components: [{ component: 'cli', version: '0.169.0' }] };
    case 'claude-code': return { id: 'claude-sdk-0.3.325-cli-2.1.325', engineId, primary: 'cli', components: [{ component: 'sdk', version: '0.3.325' }, { component: 'cli', version: '2.1.325' }] };
    case 'opencode': return { id: 'opencode-client-cli-2.3.0', engineId, primary: 'cli', components: [{ component: 'client', version: '2.3.0' }, { component: 'cli', version: '2.3.0' }] };
    case 'deepseek-harness': return { id: 'dsh-controller-0.2.1-rc.5', engineId, primary: 'controller', components: [{ component: 'controller', version: '0.2.1-rc.5' }] };
  }
}

export function parseNativeVersion(raw: string): NativeVersion | undefined {
  const match = /^(?:(?:codex-cli|opencode|claude|claude-code|dsh|deepseek-harness|session-controller)\s+)?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?: \(Claude Code\))?$/.exec(raw.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return undefined;
  const build = match[5] ?? '';
  const canonical = `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join('.')}` : ''}${build ? `+${build}` : ''}`;
  return { raw, canonical, major, minor, patch, prerelease, build };
}

export function compareNativeVersions(left: NativeVersion, right: NativeVersion): -1 | 0 | 1 {
  for (const difference of [left.major - right.major, left.minor - right.minor, left.patch - right.patch]) {
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const numericA = /^\d+$/.test(a);
    const numericB = /^\d+$/.test(b);
    if (numericA && numericB && a.length !== b.length) return a.length < b.length ? -1 : 1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export type ProtocolOperationGroup = 'handshake' | 'session' | 'submission' | 'observation' | 'permission-callback' | 'question-callback' | 'terminal' | 'cancellation' | 'resume' | 'configuration';
export interface OperationRequirement {
  operation: keyof ControlCapabilities;
  groups: readonly ProtocolOperationGroup[];
}
export const REQUIRED_PROTOCOL_GROUPS: readonly ProtocolOperationGroup[] = Object.freeze([
  'handshake', 'session', 'submission', 'observation', 'permission-callback', 'question-callback', 'terminal', 'cancellation', 'resume', 'configuration',
]);
export function requiredProtocolOperations(): readonly OperationRequirement[] {
  return [
    { operation: 'create', groups: ['session'] },
    { operation: 'submit', groups: ['session', 'submission', 'observation', 'terminal'] },
    { operation: 'observe', groups: ['observation'] },
    { operation: 'approve', groups: ['permission-callback'] },
    { operation: 'answer', groups: ['question-callback'] },
    { operation: 'cancel', groups: ['cancellation', 'terminal'] },
    { operation: 'resume', groups: ['resume', 'observation'] },
    { operation: 'configure', groups: ['configuration'] },
  ];
}
export interface ProtocolGroupEvidence {
  group: ProtocolOperationGroup;
  result: 'passive' | 'proven' | 'unsupported' | 'unverified';
  detail: string;
}
export interface CompatibilityDescriptor {
  id: EngineId;
  version: string;
  componentVersions?: ComponentVersions;
  runtimeInstanceId: string;
  generation: number;
  configurationId: string;
}
export interface ProtocolEvidence {
  profileId: string;
  engineId: EngineId;
  versions: ComponentVersions;
  runtimeInstanceId: string;
  generation: number;
  configurationId: string;
  observedAt: number;
  groups: readonly ProtocolGroupEvidence[];
}
export interface EvidenceOptions { now: number; maxAgeMs?: number }
export interface OperationCapabilityResult {
  operation: keyof ControlCapabilities;
  enabled: boolean;
  reason: string;
  missingGroups: readonly ProtocolOperationGroup[];
}
export interface ProtocolEvidenceAssessment {
  valid: boolean;
  reason: string;
  passiveHandshake: boolean;
  protocolComplete: boolean;
  missingGroups: readonly ProtocolOperationGroup[];
  capabilities: ControlCapabilities;
  operations: readonly OperationCapabilityResult[];
}
export interface ComponentAssessment {
  component: NativeComponent;
  actual: string | undefined;
  baseline: string;
  candidate: boolean;
  permittedToProbe: boolean;
  reason: string;
}
export function assessComponentVersion(engineId:EngineId,component:NativeComponent,actual:string,mode:CompatibilityPolicy['mode']='latest-compatible',expected?:string):ComponentAssessment {
  const target=compatibilityProfile(engineId).components.find(entry=>entry.component===component);
  const baseline=target?.version??'';const installed=parseNativeVersion(actual);const floor=parseNativeVersion(baseline);
  const pinned=parseNativeVersion(expected??baseline);
  const comparison=installed&&floor?compareNativeVersions(installed,floor):-1;
  const permittedToProbe=!!installed&&!!floor&&comparison>=0&&(mode!=='pinned'||!!pinned&&installed.canonical===pinned.canonical);
  return{component,actual,baseline,candidate:permittedToProbe&&comparison>0,permittedToProbe,reason:!installed?'Missing or invalid component version':!floor?'No component contract profile':comparison<0?'Component is older than profile baseline':mode==='pinned'&&!permittedToProbe?'Pinned version does not match':'Eligible for protocol probing only; no control capability is granted by a version'};
}
export interface CompatibilityAssessment {
  mode: CompatibilityPolicy['mode'];
  profile: CompatibilityProfile;
  actual: ComponentVersions;
  baseline: ComponentVersions;
  candidate: boolean;
  permittedToProbe: boolean;
  reason: string;
  components: readonly ComponentAssessment[];
  evidence: ProtocolEvidenceAssessment;
}

function descriptorVersions(descriptor: CompatibilityDescriptor, profile: CompatibilityProfile): ComponentVersions {
  return { [profile.primary]: descriptor.version, ...descriptor.componentVersions };
}

export function validateProtocolEvidence(descriptor: CompatibilityDescriptor, evidence: ProtocolEvidence | undefined, options: EvidenceOptions): ProtocolEvidenceAssessment {
  const profile = compatibilityProfile(descriptor.id);
  const actual = descriptorVersions(descriptor, profile);
  const maxAge = options.maxAgeMs ?? 300_000;
  let reason = 'Evidence matches this runtime, configuration, generation and component versions';
  let valid = true;
  if (!evidence) { valid = false; reason = 'Missing protocol evidence'; }
  else if (evidence.profileId !== profile.id || evidence.engineId !== descriptor.id || evidence.runtimeInstanceId !== descriptor.runtimeInstanceId || evidence.generation !== descriptor.generation || evidence.configurationId !== descriptor.configurationId) {
    valid = false; reason = 'Evidence runtime, profile, generation or configuration mismatch';
  } else if (!parseNativeVersion(descriptor.version) || parseNativeVersion(descriptor.version)?.canonical !== parseNativeVersion(actual[profile.primary] ?? '')?.canonical) {
    valid = false; reason = 'Conflicting descriptor primary version';
  } else if (profile.components.some(target => {
    const installed = parseNativeVersion(actual[target.component] ?? '');
    const baseline = parseNativeVersion(target.version);
    return !installed || !baseline || compareNativeVersions(installed, baseline) < 0;
  })) {
    valid = false; reason = 'Missing, invalid or below-baseline component version';
  } else if (!descriptor.runtimeInstanceId.trim() || !descriptor.configurationId.trim() || !Number.isSafeInteger(descriptor.generation) || descriptor.generation < 0) {
    valid = false; reason = 'Invalid runtime evidence scope';
  } else if (!Number.isFinite(options.now) || !Number.isFinite(maxAge) || maxAge < 0 || !Number.isFinite(evidence.observedAt) || evidence.observedAt > options.now || options.now - evidence.observedAt > maxAge) {
    valid = false; reason = 'Stale evidence or invalid evidence clock';
  } else if (profile.components.some(({ component }) => {
    const observed = parseNativeVersion(evidence.versions[component] ?? '');
    const installed = parseNativeVersion(actual[component] ?? '');
    return !observed || !installed || observed.canonical !== installed.canonical;
  })) { valid = false; reason = 'Evidence component version mismatch'; }
  const proven = (group: ProtocolOperationGroup): boolean => {
    if (!valid || !evidence) return false;
    const entries = evidence.groups.filter(entry => entry.group === group);
    return entries.length === 1 && (entries[0].result === 'proven' || group === 'handshake' && entries[0].result === 'passive');
  };
  const passiveHandshake = proven('handshake');
  const missingGroups = REQUIRED_PROTOCOL_GROUPS.filter(group => !proven(group));
  const capabilities: ControlCapabilities = { create: false, submit: false, observe: false, approve: false, answer: false, cancel: false, resume: false, configure: false };
  const operations = requiredProtocolOperations().map(requirement => {
    const groups: ProtocolOperationGroup[] = ['handshake', ...requirement.groups];
    const missing = groups.filter(group => !proven(group));
    const enabled = missing.length === 0;
    capabilities[requirement.operation] = enabled;
    return { operation: requirement.operation, enabled, reason: !valid ? reason : enabled ? 'Required operation evidence proven' : `Missing proven groups: ${missing.join(', ')}`, missingGroups: missing };
  });
  return { valid, reason, passiveHandshake, protocolComplete: missingGroups.length === 0, missingGroups, capabilities, operations };
}

export function assessCompatibility(descriptor: CompatibilityDescriptor, options: EvidenceOptions, policy: CompatibilityPolicy = DEFAULT_COMPATIBILITY_POLICY, evidence?: ProtocolEvidence): CompatibilityAssessment {
  const profile = compatibilityProfile(descriptor.id);
  const actual = descriptorVersions(descriptor, profile);
  const baseline: ComponentVersions = {};
  const components = profile.components.map(target => {
    baseline[target.component] = target.version;
    const raw = actual[target.component];
    const parsed = parseNativeVersion(raw ?? '');
    const floor = parseNativeVersion(target.version);
    const pinned = policy.mode === 'pinned' ? parseNativeVersion(policy.targets[target.component] ?? '') : undefined;
    const comparison = parsed && floor ? compareNativeVersions(parsed, floor) : -1;
    let permittedToProbe = !!parsed && comparison >= 0;
    let reason = !parsed ? 'Missing or invalid component version' : comparison < 0 ? 'Component is older than profile baseline' : 'Version eligible for protocol probing only';
    if (policy.mode === 'pinned' && (!pinned || parsed?.canonical !== pinned.canonical || !policy.configurationId.trim() || policy.configurationId !== descriptor.configurationId)) {
      permittedToProbe = false;
      reason = 'Pinned policy requires an exact component target and configuration match';
    }
    return { component: target.component, actual: raw, baseline: target.version, candidate: permittedToProbe && comparison > 0, permittedToProbe, reason };
  });
  const primary = parseNativeVersion(descriptor.version);
  const explicitPrimary = parseNativeVersion(actual[profile.primary] ?? '');
  const consistent = !!primary && primary.canonical === explicitPrimary?.canonical;
  const permittedToProbe = consistent && components.every(component => component.permittedToProbe);
  const blocked = components.find(component => !component.permittedToProbe);
  const reason = !consistent ? 'Descriptor primary version conflicts with component versions or is invalid' : blocked ? blocked.reason : 'Eligible to probe; version matching alone never establishes protocol support';
  const checked = validateProtocolEvidence(descriptor, permittedToProbe ? evidence : undefined, options);
  return { mode: policy.mode, profile, actual, baseline, candidate: permittedToProbe && components.some(component => component.candidate), permittedToProbe, reason, components, evidence: checked };
}

export interface LatestVersionComparison {
  actual: string;
  latest: string;
  relation: 'invalid' | 'older' | 'equal' | 'newer';
  candidate: boolean;
  reason: string;
}
export function compareLatestMetadata(actual: string, latest: string, baseline: string): LatestVersionComparison {
  const installed = parseNativeVersion(actual);
  const available = parseNativeVersion(latest);
  const floor = parseNativeVersion(baseline);
  if (!installed || !available || !floor) return { actual, latest, relation: 'invalid', candidate: false, reason: 'Invalid installed, metadata or baseline version' };
  const comparison = compareNativeVersions(available, installed);
  return { actual, latest, relation: comparison < 0 ? 'older' : comparison > 0 ? 'newer' : 'equal', candidate: comparison > 0 && compareNativeVersions(available, floor) >= 0, reason: 'Metadata is advisory only; installing or enabling controls requires separate policy and protocol evidence' };
}

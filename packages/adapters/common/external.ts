import type { EngineId, ExternalPage, ExternalProfile } from '../../protocol/src/types.ts';

export interface NativeCandidate { nativeId: string; title: string; cwd: string }
export interface DiscoveryPage { items: NativeCandidate[]; cursor?: string }
export interface ExternalSessionProvider {
  engineId: EngineId;
  profile(): Promise<ExternalProfile>;
  discover(cwd: string, cursor?: string): Promise<DiscoveryPage>;
  history(cwd: string, nativeId: string, cursor?: string): Promise<ExternalPage>;
}
export function closedProfile(engineId: EngineId, version: string, reason: string): ExternalProfile {
  const closed = { state: 'unverified', reason } satisfies ExternalProfile['discover'];
  return { engineId, version, profile: '', namespace: '', coverage: 'none', syncMode: 'unavailable',
    discover: closed, history: closed, observe: closed, continueManaged: closed, submit: closed,
    approve: closed, answer: closed, cancel: closed, configure: closed, stopVerification: closed };
}

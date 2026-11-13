import type { ExternalPage, ExternalProfile } from '../../protocol/src/types.ts';
import type { ExternalSessionProvider, DiscoveryPage } from '../common/external.ts';
import { closedProfile } from '../common/external.ts';
import { DshAdapter } from './index.ts';
import { requireValue } from '../../protocol/src/validation.ts';

export class DshExternalProvider implements ExternalSessionProvider {
  engineId: 'deepseek-harness' = 'deepseek-harness';
  adapter: DshAdapter;
  constructor(adapter: DshAdapter) { this.adapter = adapter; }
  async profile(): Promise<ExternalProfile> {
    if (this.adapter.config.enabled === false || !this.adapter.config.expectedVersion.trim()) return closedProfile(this.engineId, '', 'DSH external access requires an enabled runtime and an explicitly pinned native version');
    const r = await this.adapter.call('probe', {}, 10000);
    const p = closedProfile(this.engineId, typeof r.version === 'string' ? r.version : '', 'DSH approval claim competition and exclusive writer control are not verified; observation never claims');
    if (r.version !== this.adapter.config.expectedVersion || r.version !== '0.2.1-rc.5' || r.externalProtocol !== 2 || r.apiProfile !== 'dsh-controller-0.2.1-rc.5-page-v2' || r.controllerDigest !== 'a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386' || r.control !== false || typeof r.instanceId !== 'string' || !r.instanceId) {
      const reason = !r.apiProfile && typeof r.detail === 'string' ? r.detail
        : r.version !== this.adapter.config.expectedVersion ? 'DSH controller package version does not match expectedVersion; pin the verified controller version 0.2.1-rc.5, not a configured CLI assertion'
        : 'DSH requires the verified rc.5 controller artifact, loaded service identity and bridge protocol 2; CLI version/configured revision alone is not API evidence';
      p.discover = { state: 'unverified', reason };
      p.history = p.discover; p.observe = p.discover;
      return p;
    }
    p.profile = r.apiProfile; p.namespace = r.instanceId;
    p.coverage = 'durable user text, assistant text and reasoning; append-only journal view, including attempts; no attachments or historical approvals'; p.syncMode = 'manual-refresh';
    p.discover = { state: 'supported', reason: 'Same plugin host only; bounded immutable discovery snapshot pages' };
    p.history = { state: 'supported', reason: 'Verified rc.5 projections waterline and page traversal; no follow/state/resume/claim; unavailable or migration-required waterlines fail closed' };
    p.observe = { state: 'supported', reason: 'Manual durable history refresh; not native interactive control' };
    return p;
  }
  private async instance(): Promise<string> { const p = await this.profile(); requireValue(p.history.state === 'supported', 'external_unverified', 'DSH external protocol or version mismatch', 409); return p.namespace; }
  async discover(cwd: string, cursor?: string): Promise<DiscoveryPage> {
    const r = await this.adapter.call('externalList', { cwd, cursor, instanceId: await this.instance() });
    requireValue(Array.isArray(r.items) && r.items.length <= 50, 'external_format', 'Malformed DSH list');
    return { items: r.items, cursor: typeof r.cursor === 'string' ? r.cursor : undefined };
  }
  async history(cwd: string, nativeId: string, cursor?: string): Promise<ExternalPage> {
    requireValue(!cursor, 'cursor_invalid', 'DSH refresh is a bounded complete journal snapshot');
    const r = await this.adapter.call('externalHistory', { cwd, sessionId: nativeId, instanceId: await this.instance() });
    requireValue(Array.isArray(r.items), 'external_format', 'Malformed DSH history');
    return { items: r.items };
  }
}

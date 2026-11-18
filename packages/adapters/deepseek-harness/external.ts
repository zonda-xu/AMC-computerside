import type { ExternalPage, ExternalProfile } from '../../protocol/src/types.ts';
import type { ExternalSessionProvider, DiscoveryPage } from '../common/external.ts';
import { closedProfile } from '../common/external.ts';
import { DshAdapter } from './index.ts';
import { requireValue } from '../../protocol/src/validation.ts';

export class DshExternalProvider implements ExternalSessionProvider {
  engineId: 'deepseek-harness' = 'deepseek-harness';
  adapter: DshAdapter;
  private peer?:string;
  constructor(adapter: DshAdapter) { this.adapter = adapter; }
  async profile(): Promise<ExternalProfile> {
    if (this.adapter.config.enabled === false) return closedProfile(this.engineId, '', 'DSH runtime disabled');
    const r = await this.adapter.call('probe', {}, 10000);
    const p = closedProfile(this.engineId, typeof r.version === 'string' ? r.version : '', 'Observation does not claim native writer control');
    const legacy=r.version==='0.2.1-rc.5'&&r.apiProfile==='dsh-controller-0.2.1-rc.5-page-v2'&&r.controllerDigest==='a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386';
    const compatible=r.apiProfile==='dsh-controller-capabilities-v2'&&r.capabilities?.externalHistory===true;
    const pinned=this.adapter.config.compatibilityMode==='pinned';
    if ((!legacy&&!compatible)||r.externalProtocol!==2||typeof r.instanceId!=='string'||!r.instanceId||pinned&&(!r.version||r.version!==this.adapter.config.expectedVersion)) {
      const reason=pinned&&r.version!==this.adapter.config.expectedVersion?'DSH controller does not match expectedVersion':r.detail||'DSH compatible controller and bridge protocol 2 evidence required';
      p.discover={state:'unverified',reason};p.history=p.discover;p.observe=p.discover;return p;
    }
    this.peer = r.instanceId;
    p.profile = r.apiProfile;
    p.namespace = typeof r.historyNamespace==='string' && /^dsh-store:[a-f0-9]{64}$/.test(r.historyNamespace) ? r.historyNamespace : r.instanceId;
    p.coverage = 'durable user text, assistant text and reasoning; append-only journal view, including attempts; no attachments or historical approvals'; p.syncMode = 'manual-refresh';
    p.discover = { state: 'supported', reason: 'Same plugin host only; bounded immutable discovery snapshot pages' };
    p.history = { state: 'supported', reason: 'Controller projections waterline and validated page traversal; no follow/state/resume/claim; unavailable or migration-required waterlines fail closed' };
    p.observe = { state: 'supported', reason: 'Manual durable history refresh; not native interactive control' };
    return p;
  }
  private async instance(): Promise<string> { const p = await this.profile(); requireValue(p.history.state === 'supported', 'external_unverified', 'DSH external protocol or version mismatch', 409); return this.peer!; }
  async discover(cwd: string, cursor?: string): Promise<DiscoveryPage> {
    const r = await this.adapter.call('externalList', { cwd, cursor, instanceId: await this.instance() });
    requireValue(Array.isArray(r.items) && r.items.length <= 50, 'external_format', 'Malformed DSH list');
    return { items: r.items, cursor: typeof r.cursor === 'string' ? r.cursor : undefined };
  }
  async history(cwd: string, nativeId: string, cursor?: string): Promise<ExternalPage> {
    requireValue(!cursor, 'cursor_invalid', 'DSH refresh is a bounded complete journal snapshot');
    const r = await this.adapter.call('externalHistory', { cwd, sessionId: nativeId, instanceId: await this.instance() });
    requireValue(Array.isArray(r.items), 'external_format', 'Malformed DSH history');
    return { items: r.items, ...(r.tools ? {tools:r.tools} : {}) };
  }
}

import { externalRead } from './external.ts';
import type { Core } from './core.ts';
import type { AutomationSettings } from './automation.ts';
import type { EngineId, Workspace } from '../../../packages/protocol/src/types.ts';
import type { RuntimeConfig } from '../../../packages/adapters/common/base.ts';
import { Fault } from '../../../packages/protocol/src/validation.ts';

export interface ExternalSyncStatus { workspaceId: string; engineId: EngineId; state: 'running' | 'complete' | 'failed'; failures: number; nextAt: number; lastSuccessAt?: number; error?: string }
export interface CandidateSyncStatus { candidateId: string; workspaceId: string; engineId: EngineId; failures: number; nextAt: number; error?: string }
export class ExternalSync {
  core: Core; settings: AutomationSettings; runtimes: Partial<Record<EngineId, RuntimeConfig>>;
  statuses = new Map<string, ExternalSyncStatus>();
  candidateStatuses = new Map<string, CandidateSyncStatus>();
  lastFailureCode?: string; lastFailureAt?: number;
  candidateBudgetMs = 10000;
  private offsets = new Map<string, number>();
  roundBudgetMs = 60000; maxDiscoveryPages = 100; maxCandidates = 5000;
  private timer?: ReturnType<typeof setTimeout>; private pending?: Promise<void>; private stop = new AbortController();
  constructor(core: Core, settings: AutomationSettings, runtimes: Partial<Record<EngineId, RuntimeConfig>>) { this.core = core; this.settings = settings; this.runtimes = runtimes; }
  start() { if (!this.settings.enabled || this.stop.signal.aborted || this.timer || this.pending) return; this.schedule(0); }
  private schedule(delay: number) {
    this.timer = setTimeout(() => { this.timer = undefined; void this.runOnce().catch(() => { this.lastFailureCode = 'sync_failed'; this.lastFailureAt = Date.now(); }).finally(() => { if (!this.stop.signal.aborted) this.schedule(Math.min(1000, this.settings.syncIntervalSeconds * 1000)); }).catch(() => {}); }, delay); this.timer.unref();
  }
  runOnce(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.settings.enabled || this.stop.signal.aborted) return Promise.resolve();
    this.pending = this.run().finally(() => { this.pending = undefined; }); return this.pending;
  }
  private async run() {
    const results = await Promise.allSettled((['codex', 'deepseek-harness'] as const).map(async engineId => {
      const runtime = this.runtimes[engineId];
      if (!runtime || runtime.enabled === false || runtime.expectedVersion === 'DISABLED') return;
      for (const workspace of this.core.store.list<Workspace>('workspace')) {
        if (this.stop.signal.aborted) return;
        const key = workspace.id + ':' + engineId; const previous = this.statuses.get(key);
        if (previous && previous.nextAt > Date.now()) continue;
        const status: ExternalSyncStatus = { workspaceId: workspace.id, engineId, state: 'running', failures: previous?.failures ?? 0, nextAt: 0, lastSuccessAt: previous?.lastSuccessAt };
        this.statuses.set(key, status);
        const signal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(this.roundBudgetMs)]);
        try {
          this.core.workspaceIdentities.verify(workspace.id, true);
          signal.throwIfAborted();
          const candidates = await externalRead(this.core.external.discoverRound(workspace.id, engineId, { signal, maxPages: this.maxDiscoveryPages, maxCandidates: this.maxCandidates }), signal);
          this.core.workspaceIdentities.verify(workspace.id, true);
          const offset = (this.offsets.get(key) ?? 0) % Math.max(1, candidates.length);
          let candidateFailed = false;
          for (let index = 0; index < candidates.length; index++) {
            signal.throwIfAborted();
            this.core.workspaceIdentities.verify(workspace.id, true);
            const position = (offset + index) % candidates.length;
            const candidate = candidates[position];
            const candidateKey = key + ':' + candidate.candidateId;
            const old = this.candidateStatuses.get(candidateKey);
            if (old && old.nextAt > Date.now()) { candidateFailed = true; continue; }
            this.offsets.set(key, position + 1);
            const candidateSignal = AbortSignal.any([signal, AbortSignal.timeout(this.candidateBudgetMs)]);
            try {
              const session = await externalRead(this.core.external.ensureImport(candidate.candidateId, candidateSignal), candidateSignal);
              this.core.workspaceIdentities.verify(workspace.id, true); candidateSignal.throwIfAborted();
              await externalRead(this.core.external.syncRound(session.id, { signal: candidateSignal }), candidateSignal);
              candidateSignal.throwIfAborted(); this.core.workspaceIdentities.verify(workspace.id, true);
              this.candidateStatuses.delete(candidateKey);
            } catch (e) {
              signal.throwIfAborted(); this.core.workspaceIdentities.verify(workspace.id, true);
              if (e instanceof Fault && ['source_changed', 'source_identity', 'source_missing', 'external_unverified', 'root_not_granted', 'workspace_changed', 'workspace_missing', 'workspace_confirmation_required'].includes(e.code)) throw e;
              const failures = (old?.failures ?? 0) + 1;
              this.candidateStatuses.set(candidateKey, { candidateId: candidate.candidateId, workspaceId: workspace.id, engineId, failures,
                nextAt: Date.now() + Math.min(300000, this.settings.syncIntervalSeconds * 1000 * 2 ** Math.min(failures - 1, 20)), error: candidateSignal.aborted ? 'candidate_timeout' : e instanceof Fault && ['external_budget', 'external_cursor', 'external_format'].includes(e.code) ? e.code : 'candidate_failed' });
              candidateFailed = true;
            }
          }
          status.state = candidateFailed ? 'failed' : 'complete'; status.failures = 0;
          if (candidateFailed) status.error = 'candidate_failed'; else status.lastSuccessAt = Date.now();
          status.nextAt = Date.now() + this.settings.syncIntervalSeconds * 1000;
        } catch (e) {
          status.state = 'failed'; status.failures++; status.error = signal.aborted ? 'sync_aborted' : e instanceof Fault && ['source_changed', 'source_identity', 'source_missing', 'external_unverified', 'root_not_granted', 'workspace_changed', 'workspace_missing', 'workspace_confirmation_required', 'external_budget', 'external_cursor', 'external_format'].includes(e.code) ? e.code : 'sync_failed';
          status.nextAt = Date.now() + Math.min(300000, this.settings.syncIntervalSeconds * 1000 * 2 ** Math.min(status.failures - 1, 20));
        }
        this.core.emitAutomation('automation.sync', status, () => { this.lastFailureCode = 'sync_listener_failed'; this.lastFailureAt = Date.now(); });
      }
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  async close() { this.stop.abort(new Error('External synchronization stopped')); clearTimeout(this.timer); await this.pending?.catch(() => {}); }
}

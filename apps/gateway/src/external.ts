import { randomUUID } from 'node:crypto';
import type { Core } from './core.ts';
import type { EngineId, ExternalCandidate, ExternalPage, ExternalProfile, Session } from '../../../packages/protocol/src/types.ts';
import { ENGINES } from '../../../packages/protocol/src/types.ts';
import type { ExternalSessionProvider } from '../../../packages/adapters/common/external.ts';
import { closedProfile } from '../../../packages/adapters/common/external.ts';
import { canonical, inside } from './files.ts';
import { digest } from './store.ts';
import { requireValue, stable } from '../../../packages/protocol/src/validation.ts';

export class ExternalSessions {
  core: Core; providers = new Map<EngineId, ExternalSessionProvider>();
  constructor(core: Core) { this.core = core; }
  async capabilities(): Promise<ExternalProfile[]> {
    return Promise.all(ENGINES.map(async engine => {
      const provider = this.providers.get(engine);
      try { if (provider) return await provider.profile(); }
      catch { return closedProfile(engine, '', 'Provider unavailable; no native sessions were read'); }
      return closedProfile(engine, '', 'No verified native discovery/history profile for the deployed version');
    }));
  }
  async discover(workspaceId: string, engineId: EngineId, cursor?: string) {
    const w = this.core.workspace(workspaceId); const p = this.providers.get(engineId);
    requireValue(p, 'external_unverified', 'No verified external provider', 409);
    const profile = await p.profile(); requireValue(profile.discover.state === 'supported', 'external_unverified', profile.discover.reason, 409);
    requireValue(profile.namespace && profile.profile, 'source_identity', 'Provider has no source identity', 409);
    const page = await p.discover(w.path, cursor); const items: ExternalCandidate[] = [];
    requireValue(page.items.length <= 100, 'external_budget', 'Discovery exceeds page budget');
    for (const row of page.items) {
      requireValue(typeof row.nativeId === 'string' && row.nativeId.length > 0 && row.nativeId.length <= 200 && typeof row.title === 'string' && typeof row.cwd === 'string', 'external_format', 'Malformed native candidate');
      const cwd = await canonical(row.cwd).catch(() => '');
      this.core.workspace(workspaceId);
      if (!cwd || cwd !== w.path || !this.core.allowedRoots.some(root => inside(root, cwd))) continue;
      const candidateId = digest(stable([this.core.hostId, engineId, profile.namespace, row.nativeId]));
      const c: ExternalCandidate = { candidateId, engineId, workspaceId, title: row.title.slice(0, 160), cwd,
        source: { namespace: profile.namespace, nativeId: row.nativeId, generation: profile.namespace, profile: profile.profile, readOnly: true } };
      this.core.store.put('external-candidate-v1', candidateId, c); items.push(c);
    }
    return { items, cursor: page.cursor };
  }
  async candidate(id: string) {
    const c = this.core.store.get<ExternalCandidate>('external-candidate-v1', id);
    requireValue(c, 'candidate_missing', 'Discover this source again', 404);
    const w = this.core.workspace(c.workspaceId); requireValue(await canonical(c.cwd) === w.path, 'source_changed', 'External project changed', 409);
    const p = this.providers.get(c.engineId); requireValue(p, 'external_unverified', 'External provider unavailable', 409);
    const profile = await p.profile();
    requireValue(profile.history.state === 'supported' && profile.namespace === c.source.namespace && profile.profile === c.source.profile, 'source_changed', 'External source identity or profile changed', 409);
    this.core.workspace(c.workspaceId);
    return { c, p };
  }
  async history(id: string, cursor?: string): Promise<ExternalPage> {
    const { c, p } = await this.candidate(id);
    const page = await p.history(c.cwd, c.source.nativeId, cursor);
    requireValue(page.items.length <= 5000 && Buffer.byteLength(JSON.stringify(page)) <= 4 * 1024 * 1024, 'external_budget', 'History exceeds read budget');
    for (const m of page.items) requireValue(typeof m.nativeEventId === 'string' && m.nativeEventId.length > 0 && m.nativeEventId.length <= 400 && ['user', 'assistant', 'reasoning'].includes(m.role) && typeof m.text === 'string' && m.text.length <= 100000, 'external_format', 'Malformed historical message');
    const current = await this.candidate(id);
    requireValue(current.p === p, 'source_changed', 'External provider changed during history read', 409);
    return page;
  }
  async import(device: string, requestId: string, id: string): Promise<Session> {
    const { c } = await this.candidate(id);
    this.core.store.receive(device, requestId, { kind: 'external.import', candidateId: id });
    const previous = this.core.store.get<{ sessionId: string }>('external-import-v1', id);
    if (previous) return this.core.session(previous.sessionId);
    // No native action occurs here; the atomic local projection can safely retry after rollback.
    const sessionId = randomUUID();
    const s: Session = { id: sessionId, ref: { hostId: this.core.hostId, workspaceId: c.workspaceId, engineId: c.engineId, runtimeInstanceId: c.source.namespace, nativeSessionId: c.source.nativeId },
      title: c.title, cwd: c.cwd, state: 'idle', epoch: 0, messages: [], tools: [], agents: [], interactions: [], watermark: 0, historyStart: 1, updatedAt: Date.now(), externalSource: c.source };
    this.core.store.transaction(() => { this.core.store.put('session', sessionId, s); this.core.store.put('external-import-v1', id, { sessionId }); });
    this.core.emit('catalog.changed');
    return s;
  }
  async sync(sessionId: string, cursor?: string) {
    const s = this.core.session(sessionId); requireValue(s.externalSource, 'source_missing', 'Not an external projection', 409);
    const id = digest(stable([this.core.hostId, s.ref.engineId, s.externalSource.namespace, s.externalSource.nativeId]));
    const page = await this.history(id, cursor);
    for (const m of page.items) {
      const key = digest(stable([id, m.nativeEventId])); const hash = digest(stable(m));
      const event = this.core.store.transaction(() => {
        const old = this.core.store.get<{ hash: string }>('external-message-v1', key);
        if (old?.hash === hash) return;
        const e = this.core.store.event(s.id, 'message.completed', { id: key, role: m.role, text: m.text }, false);
        this.core.store.put('external-message-v1', key, { hash }); return e;
      });
      if (event) this.core.emit('event', event);
    }
    this.core.store.put('external-checkpoint-v1', s.id, { cursor: page.cursor, refreshedAt: Date.now() });
    return { snapshot: this.core.session(s.id), cursor: page.cursor };
  }
}

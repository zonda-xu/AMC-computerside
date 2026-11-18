import { randomUUID } from 'node:crypto';
import type { Core } from './core.ts';
import type { ConsoleEvent, EngineId, ExternalCandidate, ExternalPage, ExternalProfile, Session } from '../../../packages/protocol/src/types.ts';
import { ENGINES, NO_CONTROL } from '../../../packages/protocol/src/types.ts';
import type { ExternalSessionProvider } from '../../../packages/adapters/common/external.ts';
import { closedProfile } from '../../../packages/adapters/common/external.ts';
import { canonical, inside } from './files.ts';
import { digest } from './store.ts';
import { requireValue, stable } from '../../../packages/protocol/src/validation.ts';

export interface ExternalMessageIntent {
  session: Session; event: ConsoleEvent; messageId: string; contentVersion: string; silentBaseline: boolean; automatic: boolean;
}
export interface ExternalRoundOptions { signal?: AbortSignal; maxPages?: number; maxMessages?: number; maxBytes?: number }
export async function externalRead<T>(read: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) { void read.catch(() => {}); signal.throwIfAborted(); }
  if (!signal) return read;
  let abort: () => void = () => {};
  try {
    return await Promise.race([read, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
export class ExternalSessions {
  core: Core; providers = new Map<EngineId, ExternalSessionProvider>();
  notificationIntent?: (intent: ExternalMessageIntent) => void;
  baselineCompleted?: (session: Session) => void;
  private locks = new Map<string, Promise<void>>();
  private stop = new AbortController();
  private active = 0; private slots: (() => void)[] = [];
  private async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < 2) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const grant = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { const index = this.slots.indexOf(grant); if (index >= 0) this.slots.splice(index, 1); reject(signal.reason); };
      this.slots.push(grant); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  private async serial<T>(key: string, work: () => Promise<T>, slot = true, signal = this.stop.signal): Promise<T> {
    signal = this.signal(signal); signal.throwIfAborted();
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate); this.locks.set(key, tail);
    void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    let acquired = false;
    try {
      await externalRead(previous, signal);
      if (slot) { await this.acquire(signal); acquired = true; }
      signal.throwIfAborted(); return await work();
    } finally {
      if (acquired) { const next = this.slots.shift(); if (next) next(); else this.active--; }
      release();
    }
  }
  async close() { this.stop.abort(new Error('External sessions stopped')); await Promise.all([...this.locks.values()]); }
  private signal(signal?: AbortSignal) { return signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal; }
  constructor(core: Core) { this.core = core; }
  async capabilities(selected?: EngineId): Promise<ExternalProfile[]> {
    return Promise.all(ENGINES.filter(engine => !selected || engine === selected).map(async engine => {
      const provider = this.providers.get(engine);
      try { if (provider) return await provider.profile(); }
      catch { return closedProfile(engine, '', 'Provider unavailable; no native sessions were read'); }
      return closedProfile(engine, '', 'No verified native discovery/history profile for the deployed version');
    }));
  }
  async discover(workspaceId: string, engineId: EngineId, cursor?: string, signal?: AbortSignal) {
    return this.serial('discovery:' + engineId, () => this.discoverPage(workspaceId, engineId, cursor, this.signal(signal)), true, this.signal(signal));
  }
  async discoverRound(workspaceId: string, engineId: EngineId, options: { signal?: AbortSignal; maxPages?: number; maxCandidates?: number } = {}) {
    const signal = this.signal(options.signal);
    return this.serial('discovery:' + engineId, async () => {
      const items: ExternalCandidate[] = []; const seen = new Set<string>();
      let cursor: string | undefined; let identity: string | undefined; let count = 0;
      for (let n = 0; n < (options.maxPages ?? 100); n++) {
        signal.throwIfAborted();
        const page = await this.serial('discovery-read:' + engineId, () => this.discoverPage(workspaceId, engineId, cursor, signal), true, signal);
        count += page.candidateCount;
        requireValue(count <= (options.maxCandidates ?? 5000), 'external_budget', 'Discovery round candidate budget exhausted');
        requireValue(identity === undefined || identity === page.identity, 'source_changed', 'External source changed during discovery round'); identity = page.identity;
        items.push(...page.items);
        if (!page.cursor) return items;
        requireValue(!seen.has(page.cursor), 'external_cursor', 'Repeated discovery cursor'); seen.add(page.cursor); cursor = page.cursor;
      }
      throw new Error('Discovery round page budget exhausted');
    }, false, signal);
  }
  private async discoverPage(workspaceId: string, engineId: EngineId, cursor?: string, signal?: AbortSignal) {
    const w = this.core.workspace(workspaceId); const p = this.providers.get(engineId);
    requireValue(p, 'external_unverified', 'No verified external provider', 409);
    const profile = await externalRead(p.profile(), signal); requireValue(profile.discover.state === 'supported', 'external_unverified', profile.discover.reason, 409);
    requireValue(profile.namespace && profile.profile, 'source_identity', 'Provider has no source identity', 409);
    const page = await externalRead(p.discover(w.path, cursor), signal); const items: ExternalCandidate[] = [];
    requireValue(page.items.length <= 100, 'external_budget', 'Discovery exceeds page budget');
    const sessions = this.core.store.list<Session>('session');
    for (const row of page.items) {
      requireValue(typeof row.nativeId === 'string' && row.nativeId.length > 0 && row.nativeId.length <= 200 && typeof row.title === 'string' && typeof row.cwd === 'string', 'external_format', 'Malformed native candidate');
      const cwd = await canonical(row.cwd).catch(() => '');
      signal?.throwIfAborted();
      this.core.workspace(workspaceId);
      if (!cwd || cwd !== w.path || !this.core.allowedRoots.some(root => inside(root, cwd))) continue;
      const candidateId = digest(stable([this.core.hostId, engineId, profile.namespace, row.nativeId]));
      const c: ExternalCandidate = { candidateId, engineId, workspaceId, title: row.title.slice(0, 160), cwd,
        source: { namespace: profile.namespace, nativeId: row.nativeId, generation: profile.namespace, profile: profile.profile, readOnly: true } };
      c.registeredSessionId = this.registeredSession(c, sessions)?.id;
      items.push(c);
    }
    const current = await externalRead(p.profile(), signal);
    requireValue(this.providers.get(engineId) === p && current.namespace === profile.namespace && current.profile === profile.profile && current.discover.state === 'supported', 'source_changed', 'External provider changed during discovery', 409);
    this.core.workspace(workspaceId); signal?.throwIfAborted();
    for (const candidate of items) this.core.store.put('external-candidate-v1', candidate.candidateId, candidate);
    return { items, cursor: page.cursor, candidateCount: page.items.length, identity: stable([profile.namespace, profile.profile]) };
  }
  async candidate(id: string, signal?: AbortSignal) {
    signal = this.signal(signal); signal.throwIfAborted();
    const c = this.core.store.get<ExternalCandidate>('external-candidate-v1', id);
    requireValue(c, 'candidate_missing', 'Discover this source again', 404);
    const w = this.core.workspace(c.workspaceId); requireValue(await canonical(c.cwd) === w.path, 'source_changed', 'External project changed', 409);
    const p = this.providers.get(c.engineId); requireValue(p, 'external_unverified', 'External provider unavailable', 409);
    const profile = await externalRead(p.profile(), signal);
    requireValue(profile.history.state === 'supported' && profile.namespace === c.source.namespace && profile.profile === c.source.profile, 'source_changed', 'External source identity or profile changed', 409);
    this.core.workspace(c.workspaceId);
    return { c, p };
  }
  async history(id: string, cursor?: string, signal?: AbortSignal): Promise<ExternalPage> {
    signal = this.signal(signal);
    const { c, p } = await this.candidate(id, signal);
    const page = await externalRead(p.history(c.cwd, c.source.nativeId, cursor), signal);
    requireValue(page.items.length <= 5000 && Buffer.byteLength(JSON.stringify(page)) <= 4 * 1024 * 1024, 'external_budget', 'History exceeds read budget');
    for (const m of page.items) requireValue(typeof m.nativeEventId === 'string' && m.nativeEventId.length > 0 && m.nativeEventId.length <= 400 && ['user', 'assistant', 'reasoning'].includes(m.role) && typeof m.text === 'string' && m.text.length <= 100000, 'external_format', 'Malformed historical message');
    requireValue(!page.tools || Array.isArray(page.tools) && page.tools.length<=5000 && page.tools.every(t=>
      typeof t.id==='string' && !!t.id && t.id.length<=400 && typeof t.status==='string' && t.status.length<=64 &&
      (t.title===undefined || typeof t.title==='string' && t.title.length<=500) &&
      (t.detail===undefined || typeof t.detail==='string' && t.detail.length<=8192)), 'external_format','Malformed historical tool record');
    const current = await this.candidate(id, signal);
    requireValue(current.p === p && stable(current.c.source) === stable(c.source) && current.c.workspaceId === c.workspaceId, 'source_changed', 'External provider changed during history read', 409);
    return page;
  }
  async import(device: string, requestId: string, id: string): Promise<Session> {
    const { c } = await this.candidate(id, this.stop.signal); this.stop.signal.throwIfAborted();
    this.core.store.receive(device, requestId, { kind: 'external.import', candidateId: id });
    return this.importCandidate(c);
  }
  async ensureImport(id: string, signal?: AbortSignal): Promise<Session> {
    signal = this.signal(signal);
    const { c } = await this.candidate(id, signal); signal?.throwIfAborted(); return this.importCandidate(c);
  }
  private registeredSession(c: ExternalCandidate, sessions = this.core.store.list<Session>('session')): Session | undefined {
    const runtime = this.core.context(c.engineId).runtimeInstanceId;
    const matches = sessions.filter(s =>
      s.ref.hostId === this.core.hostId && s.ref.workspaceId === c.workspaceId && s.cwd === c.cwd
      && s.ref.engineId === c.engineId && s.ref.nativeSessionId === c.source.nativeId);
    // Prefer the durable owner even while its gateway connection is restarting.
    return matches.find(s => s.ref.runtimeInstanceId === runtime && !!s.binding?.nativeIdentity &&
      s.binding.state !== 'unbound' && (!s.externalSource || s.externalSource.namespace === c.source.namespace))
      ?? matches.find(s => s.externalSource?.namespace === c.source.namespace);
  }
  private importCandidate(c: ExternalCandidate): Session {
    const existing = this.registeredSession(c);
    if (existing) return existing;
    const id = c.candidateId;
    const previous = this.core.store.get<{ sessionId: string }>('external-import-v1', id);
    if (previous) return this.core.session(previous.sessionId);
    const sessionId = randomUUID();
    const s: Session = { id: sessionId, ref: { hostId: this.core.hostId, workspaceId: c.workspaceId, engineId: c.engineId, runtimeInstanceId: c.source.namespace, nativeSessionId: c.source.nativeId },
      title: c.title, cwd: c.cwd, state: 'uncertain', epoch: 0, binding:{runtimeInstanceId:c.source.namespace,nativeSessionId:c.source.nativeId,generation:0,state:'unbound',capabilities:{...NO_CONTROL,observe:true},reason:'Historical messages do not establish native execution state or control ownership'}, messages: [], tools: [], agents: [], interactions: [], watermark: 0, historyStart: 1, updatedAt: Date.now(), externalSource: c.source };
    this.core.store.transaction(() => { this.core.store.put('session', sessionId, s); this.core.store.put('external-import-v1', id, { sessionId }); });
    this.core.emit('catalog.changed');
    return s;
  }
  async sync(sessionId: string, cursor?: string) {
    return this.serial('session:' + sessionId, () => this.syncPage(sessionId, cursor, false, this.stop.signal));
  }
  async syncRound(sessionId: string, options: ExternalRoundOptions = {}) {
    options = { ...options, signal: this.signal(options.signal) };
    return this.serial('session:' + sessionId, async () => {
      const seen = new Set<string>(); let cursor: string | undefined; let messages = 0; let bytes = 0;
      for (let page = 0; page < (options.maxPages ?? 100); page++) {
        options.signal?.throwIfAborted();
        const result = await this.syncPage(sessionId, cursor, true, options.signal, history => {
          messages += history.items.length; bytes += Buffer.byteLength(JSON.stringify(history));
          requireValue(messages <= (options.maxMessages ?? 50000) && bytes <= (options.maxBytes ?? 32 * 1024 * 1024), 'external_budget', 'History round exceeds total budget');
          if (history.cursor) requireValue(!seen.has(history.cursor), 'external_cursor', 'Repeated history cursor');
        });
        if (!result.cursor) {
          options.signal?.throwIfAborted();
          this.core.store.transaction(() => {
            if (!this.core.store.get('external-baseline-v1', sessionId)) this.core.store.put('external-baseline-v1', sessionId, { completedAt: Date.now(), silent: true });
            this.baselineCompleted?.(this.core.session(sessionId));
          });
          return result;
        }
        seen.add(result.cursor); cursor = result.cursor;
      }
      throw new Error('History round page budget exhausted');
    }, true, options.signal);
  }
  private async syncPage(sessionId: string, cursor?: string, automatic = false, signal?: AbortSignal, validate?: (page: ExternalPage) => void) {
    const s = this.core.session(sessionId); requireValue(s.externalSource, 'source_missing', 'Not an external projection', 409);
    requireValue(!s.binding||s.binding.state==='unbound','source_attached','Native-bound sessions must reconcile through their owning adapter',409);
    const id = digest(stable([this.core.hostId, s.ref.engineId, s.externalSource.namespace, s.externalSource.nativeId]));
    const candidate = this.core.store.get<ExternalCandidate>('external-candidate-v1', id);
    requireValue(candidate && stable(candidate.source) === stable(s.externalSource) && candidate.workspaceId === s.ref.workspaceId, 'source_changed', 'Projection source identity or profile changed', 409);
    const page = await this.history(id, cursor, signal); signal?.throwIfAborted(); validate?.(page);
    const latest=this.core.session(sessionId);
    requireValue(!latest.archived && !latest.deletionPending && (!latest.binding || latest.binding.state==='unbound'),
      'source_changed','会话归属或归档状态已变化',409);
    const silentBaseline = !this.core.store.get('external-baseline-v1', sessionId);
    for (const m of page.items) {
      const key = digest(stable([id, m.nativeEventId])); const hash = digest(stable(m));
      const event = this.core.store.transaction(() => {
        const old = this.core.store.get<{ hash: string }>('external-message-v1', key);
        if (old?.hash === hash) return;
        const e = this.core.store.event(s.id, 'message.completed', { id: key, role: m.role, text: m.text }, false);
        this.core.store.put('external-message-v1', key, { hash });
        if (m.role === 'assistant') this.notificationIntent?.({ session: s, event: e, messageId: key, contentVersion: hash, silentBaseline, automatic });
        return e;
      });
      if (event) this.core.emit('event', event);
    }
    const tools = new Map(latest.tools.map(t=>[t.id,t]));
    for (const t of page.tools || []) {
      const previous=tools.get(t.id);
      if(previous && ['completed','failed','cancelled'].includes(previous.status) && ['running','uncertain'].includes(t.status)) continue;
      const next={id:t.id,title:t.title || previous?.title || '工具调用',status:t.status,detail:t.detail || previous?.detail || ''};
      if(previous?.title===next.title && previous.status===next.status && previous.detail===next.detail) continue;
      const event=this.core.store.event(s.id,'tool.updated',{...next,historical:true},false);
      tools.set(t.id,next); this.core.emit('event',event);
    }
    this.core.store.put('external-checkpoint-v1', s.id, { cursor: page.cursor, refreshedAt: Date.now() });
    return { snapshot: this.core.session(s.id), cursor: page.cursor };
  }
}

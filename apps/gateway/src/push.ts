import { randomUUID } from 'node:crypto';
import { Store, digest } from './store.ts';
import type { ConsoleEvent, Session } from '../../../packages/protocol/src/types.ts';
import { TERMINAL } from '../../../packages/protocol/src/types.ts';
import { requireValue, stable } from '../../../packages/protocol/src/validation.ts';

export type PushResult = 'accepted' | 'retry' | 'invalid_token' | 'permission' | 'authentication' | 'permanent';
export interface PushNotice { hostId: string; sessionId: string; eventId: string; interactionId?: string; notificationId: string; title: string; body: string; ttlSeconds: number }
export interface PushTransport { lastResult?: { code: string; requestId?: string }; send(token: string, notice: PushNotice, signal: AbortSignal): Promise<PushResult> }
export interface PushOptions { transport?: PushTransport; now?: () => number; random?: () => number; authorize?: (session: Session, signal: AbortSignal) => Promise<boolean> }
export class PushCoordinator {
  private store: Store;
  private hostId: string;
  private transport?: PushTransport;
  private now: () => number;
  private random: () => number;
  private authorize: (session: Session, signal: AbortSignal) => Promise<boolean>;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  private blocked?: 'permission' | 'authentication';
  private active = new Map<string, AbortController>();
  constructor(store: Store, hostId: string, options: PushOptions = {}) {
    this.store = store; this.hostId = hostId; this.transport = options.transport;
    this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
    this.authorize = options.authorize ?? (async () => true);
  }
  status() {
    return { state: !this.transport ? 'unconfigured' : this.blocked ?? (this.stopped ? 'stopped' : 'ready'),
      reason: !this.transport ? 'Harmony Push service account and notification category are not configured' : undefined };
  }
  private device(device: string) {
    requireValue(this.store.db.prepare('SELECT id FROM devices WHERE id=? AND revoked=0').get(device), 'unauthorized', 'Device authorization required', 401);
  }
  binding(device: string) {
    this.device(device);
    return { bound: !!this.store.db.prepare('SELECT device FROM push_bindings WHERE device=?').get(device), ...this.status() };
  }
  bind(device: string, token: unknown) {
    requireValue(typeof token === 'string' && token.length > 0 && Buffer.byteLength(token) <= 4096 && !/[\s\x00-\x1f\x7f]/.test(token), 'push_token_invalid', 'Invalid push token');
    const changed = this.store.transaction(() => {
      this.device(device);
      const current = this.store.db.prepare('SELECT token_hash FROM push_bindings WHERE device=?').get(device);
      const hash = digest(token);
      if (current?.token_hash === hash) return false;
      requireValue(!this.store.db.prepare('SELECT device FROM push_bindings WHERE token_hash=? AND device<>?').get(hash, device), 'push_token_conflict', 'Push binding unavailable', 409);
      const count = this.store.db.prepare('SELECT count(*) AS n FROM push_bindings').get()!;
      requireValue(current || Number(count.n) < 100, 'push_binding_limit', 'Push binding limit reached', 409);
      this.store.clearPush(device);
      this.store.db.prepare('INSERT INTO push_bindings VALUES(?,?,?,?)').run(device, token, hash, randomUUID());
      return true;
    });
    if (changed) this.active.get(device)?.abort();
    return this.binding(device);
  }
  unbind(device: string) {
    this.store.transaction(() => { this.device(device); this.store.clearPush(device); });
    this.active.get(device)?.abort();
    return this.binding(device);
  }
  private source(session: Session) {
    requireValue(session.ref.hostId === this.hostId, 'push_source_invalid', 'Push requires a local authorized session', 409);
    return digest(stable([session.ref, session.externalSource, session.binding?.generation]));
  }
  private actionable(session: Session, event: ConsoleEvent): boolean {
    if (TERMINAL.includes(session.state) || session.binding?.state !== 'attached' || event.generation !== session.binding.generation || event.runId !== session.runId) return false;
    return session.interactions.some(item => item.id === event.data.id && item.status === 'pending' && (item.generation ?? item.epoch) === event.generation && (!item.runId || item.runId === session.runId));
  }
  completeBaseline(sessionId: string, complete: boolean): boolean {
    requireValue(this.store.db.isTransaction, 'push_transaction_required', 'Baseline must share the sync transaction', 409);
    if (!complete) return false;
    const session = this.store.get<Session>('session', sessionId);
    requireValue(session, 'session_missing', 'Session not registered', 404);
    const source = this.source(session);
    const old = this.store.db.prepare('SELECT source FROM push_baselines WHERE session=?').get(sessionId);
    if (old?.source === source) return false;
    this.store.db.prepare('INSERT INTO push_baselines VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET source=excluded.source,watermark=excluded.watermark').run(sessionId, source, session.watermark);
    this.store.db.prepare("UPDATE push_jobs SET status='cancelled',lease=NULL WHERE session=? AND status IN ('pending','sending')").run(sessionId);
    return true;
  }
  enqueue(sessionId: string, seq: number): number {
    requireValue(this.store.db.isTransaction, 'push_transaction_required', 'Push intent must share the message transaction', 409);
    const session = this.store.get<Session>('session', sessionId);
    requireValue(session, 'session_missing', 'Session not registered', 404);
    const source = this.source(session);
    const row = this.store.db.prepare('SELECT json FROM events WHERE session=? AND seq=?').get(sessionId, seq);
    requireValue(row, 'push_event_missing', 'Committed projection event required', 409);
    const event = JSON.parse(row.json as string) as ConsoleEvent;
    if (event.data.ignored || event.data.silentBaseline || event.data.historical) return 0;
    const terminal = event.type === 'run.updated' && ['completed', 'failed', 'cancelled'].includes(String(event.data.state));
    const interaction = event.type === 'interaction.created';
    if (!terminal && !interaction) return 0;
    if (session.externalSource?.readOnly && session.binding?.state !== 'attached') return 0;
    if (interaction && !this.actionable(session,event)) return 0;
    const identity = interaction ? event.data.id : event.data.runId ?? session.runId;
    if (typeof identity !== 'string' || !identity) return 0;
    const version = digest(stable([source, terminal ? 'terminal' : 'interaction', identity]));
    const now = this.now(); let queued = 0;
    for (const b of this.store.db.prepare('SELECT b.device,b.revision FROM push_bindings b JOIN devices d ON d.id=b.device WHERE d.revoked=0').all()) {
      const key = digest(stable([b.device, sessionId, version]));
      if (this.store.db.prepare('SELECT id FROM push_intents WHERE id=?').get(key)) continue;
      const job = randomUUID();
      const eventId = String(seq);
      this.store.db.prepare("INSERT INTO push_jobs(id,device,revision,session,event,status,created,due,expires) VALUES(?,?,?,?,?,'pending',?,?,?)").run(job, b.device, b.revision, sessionId, eventId, now, now, now + 3_600_000);
      this.store.put('push-source', job, { source });
      this.store.db.prepare('INSERT INTO push_intents VALUES(?,?)').run(key, job); queued++;
    }
    return queued;
  }
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000); this.timer.unref();
    void this.tick().catch(() => {});
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = undefined; }); return this.running;
  }
  private async drain() {
    const now = this.now();
    this.store.db.prepare("UPDATE push_jobs SET status='expired',lease=NULL WHERE expires<=? AND status IN ('pending','sending')").run(now);
    if (!this.transport || this.blocked || this.stopped) return;
    for (let i = 0; i < 100 && !this.stopped && !this.blocked; i++) {
      const claim = this.store.transaction(() => {
        const time = this.now();
        this.store.db.prepare("UPDATE push_jobs SET status='pending',lease=NULL WHERE status='sending' AND lease_until<=?").run(time);
        this.store.db.prepare("UPDATE push_jobs SET status='cancelled',lease=NULL WHERE status IN ('pending','sending') AND NOT EXISTS (SELECT 1 FROM push_bindings b JOIN devices d ON d.id=b.device WHERE b.device=push_jobs.device AND b.revision=push_jobs.revision AND d.revoked=0)").run();
        const job = this.store.db.prepare("SELECT j.*,b.token FROM push_jobs j JOIN push_bindings b ON b.device=j.device AND b.revision=j.revision JOIN devices d ON d.id=b.device WHERE j.status='pending' AND j.due<=? AND j.expires>? AND d.revoked=0 ORDER BY j.due LIMIT 1").get(time, time);
        if (!job) return;
        const session = this.store.get<Session>('session', job.session as string);
        const savedSource = this.store.get<{ source: string }>('push-source', String(job.id));
        if (!session || session.ref.hostId !== this.hostId || (session.externalSource?.readOnly && session.binding?.state !== 'attached') || savedSource?.source !== this.source(session)) {
          this.store.db.prepare("UPDATE push_jobs SET status='cancelled',lease=NULL WHERE id=? AND status IN ('pending','sending')").run(job.id);
          return { skipped: true as const };
        }
        const lease = randomUUID();
        this.store.db.prepare("UPDATE push_jobs SET status='sending',attempts=attempts+1,lease=?,lease_until=? WHERE id=?").run(lease, time + 30_000, job.id);
        return { job, lease, session };
      });
      if (!claim) return;
      if ('skipped' in claim) continue;
      const { job, lease, session } = claim;
      const controller = new AbortController(); this.active.set(job.device as string, controller);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: PushResult | 'source_unavailable';
      try {
        result = await Promise.race([
          (async (): Promise<PushResult | 'source_unavailable'> => {
            const allowed = await this.authorize(session, controller.signal).catch(() => false);
            controller.signal.throwIfAborted();
            if (!allowed || !this.store.db.prepare("SELECT j.id FROM push_jobs j JOIN push_bindings b ON b.device=j.device AND b.revision=j.revision JOIN devices d ON d.id=b.device WHERE j.id=? AND j.lease=? AND j.status='sending' AND d.revoked=0").get(job.id, lease)) return 'source_unavailable';
             const row = this.store.db.prepare('SELECT json FROM events WHERE session=? AND seq=?').get(job.session, Number(job.event));
             if (!row || typeof row.json !== 'string') return 'source_unavailable';
             const event: ConsoleEvent = JSON.parse(row.json);
             const interactionId = event.type === 'interaction.created' && typeof event.data.id === 'string' ? event.data.id : undefined;
             const latest = this.store.get<Session>('session', session.id);
             if (!latest || this.source(latest) !== this.source(session)) return 'source_unavailable';
              if (interactionId && !this.actionable(latest,event)) return 'source_unavailable';
             const title = interactionId ? '任务需要您的处理' : event.data.state === 'cancelled' ? '当前轮已停止' : event.data.state === 'failed' ? '任务执行失败' : '任务已完成';
             return this.transport!.send(job.token as string, { hostId: this.hostId, sessionId: job.session as string, eventId: job.event as string, interactionId, notificationId: job.id as string, title, body: '打开应用查看当前状态', ttlSeconds: Math.max(1, Math.floor((Number(job.expires) - this.now()) / 1000)) }, controller.signal);
          })(),
          new Promise<PushResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve('retry'); }, 10_000); })
        ]);
      } catch { result = 'retry'; }
      finally { if (timer) clearTimeout(timer); this.active.delete(job.device as string); }
      this.store.transaction(() => {
        const current = this.store.db.prepare("SELECT id FROM push_jobs WHERE id=? AND lease=? AND status='sending'").get(job.id, lease);
        if (!current) return;
        if (this.transport?.lastResult) this.store.put('push-provider-result', String(job.id), { ...this.transport.lastResult, result, time: this.now() });
        if (result === 'invalid_token') {
          this.store.db.prepare('DELETE FROM push_bindings WHERE device=? AND revision=?').run(job.device, job.revision);
          this.store.db.prepare("UPDATE push_jobs SET status='cancelled',lease=NULL WHERE device=? AND revision=? AND status IN ('pending','sending')").run(job.device, job.revision);
          return;
        }
        if (result === 'authentication' || result === 'permission') this.blocked = result;
        const attempts = Number(job.attempts) + 1;
        const status = result === 'source_unavailable' ? 'cancelled' : result === 'accepted' ? 'accepted' : result === 'permanent' || attempts >= 10 ? 'failed' : 'pending';
        const delay = Math.floor(Math.min(300_000, 1000 * 2 ** Math.min(attempts, 9)) * (0.5 + this.random() * 0.5));
        this.store.db.prepare('UPDATE push_jobs SET status=?,due=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=?').run(status, this.now() + delay, job.id, lease);
      });
    }
  }
  resume() { this.blocked = undefined; }
  async stop() {
    this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    for (const controller of this.active.values()) controller.abort();
    await this.running;
  }
}

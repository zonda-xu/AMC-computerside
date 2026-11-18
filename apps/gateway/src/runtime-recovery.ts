import type { Session } from '../../../packages/protocol/src/types.ts';
import type { Core } from './core.ts';

export class RuntimeRecovery {
  private core: Core;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  private retries = new Map<string, { attempts: number; after: number }>();
  constructor(core: Core) { this.core = core; }
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 5000); this.timer.unref();
    void this.tick().catch(() => {});
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.recover().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async recover(): Promise<void> {
    for (const session of this.core.store.list<Session>('session')) {
      if (this.stopped) return;
      if (session.archived || session.deletionPending || session.binding?.state !== 'disconnected') { this.retries.delete(session.id); continue; }
      const retry = this.retries.get(session.id);
      if (retry && retry.after > Date.now()) continue;
      try { await this.core.reconcile(session.id); this.retries.delete(session.id); }
      catch {
        const attempts = (retry?.attempts ?? 0) + 1;
        this.retries.set(session.id, { attempts, after: Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 9)) });
      }
    }
  }
  async close(): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    await this.running;
  }
}

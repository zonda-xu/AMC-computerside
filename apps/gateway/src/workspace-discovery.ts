import { lstat, opendir, realpath } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { Stats } from 'node:fs';
import type { Core } from './core.ts';
import type { AutomationSettings } from './automation.ts';
import type { Workspace } from '../../../packages/protocol/src/types.ts';
import { requireValue } from '../../../packages/protocol/src/validation.ts';

const markers = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'oh-package.json5'];
const excluded = ['node_modules', 'vendor', 'dist', 'build', 'target', 'cache', 'caches', '__pycache__'];
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs && b.isDirectory() && !b.isSymbolicLink();
export interface DiscoveryStatus { state: 'idle' | 'running' | 'complete' | 'partial' | 'stopped'; checked: number; added: number; errors: string[]; finishedAt?: number }
export class WorkspaceDiscovery {
  core: Core; settings: AutomationSettings; status: DiscoveryStatus = { state: 'idle', checked: 0, added: 0, errors: [] };
  private timer?: ReturnType<typeof setTimeout>; private pending?: Promise<DiscoveryStatus>; private stopped = false;
  maxDirectories = 1000; budgetMs = 10000;
  constructor(core: Core, settings: AutomationSettings) { this.core = core; this.settings = settings; }
  start() { if (!this.settings.enabled || this.stopped || this.timer || this.pending) return; this.schedule(0); }
  private schedule(delay: number) {
    this.timer = setTimeout(() => { this.timer = undefined; void this.scan().catch(() => { this.status = { ...this.status, state: 'partial', errors: ['discovery_failed'], finishedAt: Date.now() }; }).finally(() => { if (!this.stopped) this.schedule(this.settings.scanIntervalSeconds * 1000); }).catch(() => {}); }, delay); this.timer.unref();
  }
  scan(): Promise<DiscoveryStatus> {
    if (this.pending) return this.pending;
    if (this.stopped || !this.settings.enabled) return Promise.resolve(this.status);
    this.pending = this.run().finally(() => { this.pending = undefined; }); return this.pending;
  }
  private async run() {
    const status: DiscoveryStatus = { state: 'running', checked: 0, added: 0, errors: [] }; this.status = status;
    const deadline = Date.now() + this.budgetMs;
    const known = new Set(this.core.store.list<Workspace>('workspace').map(w => w.id));
    const skip = new Set([...excluded, ...this.settings.excludedDirectoryNames].map(n => n.toLowerCase()));
    const checkBudget = () => requireValue(!this.stopped && Date.now() < deadline, 'scan_budget', 'Discovery stopped or time budget exhausted');
    for (const root of [...this.core.allowedRoots]) {
      try {
        checkBudget(); this.core.workspaceIdentities.authorizeRoot(root); const rootStat = await lstat(root);
         requireValue(rootStat.isDirectory() && !rootStat.isSymbolicLink() && await realpath(root) === root, 'root_changed', 'Authorized root identity changed');
         this.core.workspaceIdentities.authorizeRoot(root);
        const dir = await opendir(root);
        try {
          for await (const entry of dir) {
             checkBudget(); requireValue(this.core.allowedRoots.includes(root), 'root_not_granted', 'Authorized root was revoked');
            if (entry.name.startsWith('.') || skip.has(entry.name.toLowerCase()) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
            requireValue(status.checked < this.maxDirectories, 'scan_budget', 'Discovery directory budget exhausted'); status.checked++;
            const path = join(root, entry.name);
            try {
              const before = await lstat(path);
              if (!before.isDirectory() || before.isSymbolicLink() || await realpath(path) !== path) continue;
              let marked = false;
              for (const marker of markers) {
                checkBudget(); const st = await lstat(join(path, marker)).catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; });
                if (st && !st.isSymbolicLink() && (st.isFile() || marker === '.git' && st.isDirectory())) { marked = true; break; }
              }
              if (!marked) continue;
              const workspace = await this.core.ensureWorkspace(path, basename(path), async () => {
                checkBudget();
                requireValue(this.core.allowedRoots.includes(root) && same(rootStat, await lstat(root)) && await realpath(root) === root
                  && same(before, await lstat(path)) && await realpath(path) === path, 'workspace_changed', 'Project or authorized root identity changed');
                checkBudget(); requireValue(this.core.allowedRoots.includes(root), 'root_not_granted', 'Authorized root was revoked');
               }, false, root);
              if (!known.has(workspace.id)) { known.add(workspace.id); status.added++; }
            } catch (e) { status.errors.push(e instanceof Error ? e.message : String(e)); }
          }
        } finally { await dir.close().catch(() => {}); }
      } catch (e) { status.errors.push(e instanceof Error ? e.message : String(e)); }
      if (this.stopped || Date.now() >= deadline) { if (!this.stopped) status.errors.push('Discovery time budget exhausted'); break; }
    }
    status.state = this.stopped ? 'stopped' : status.errors.length ? 'partial' : 'complete'; status.finishedAt = Date.now();
    const failed = () => { status.state = this.stopped ? 'stopped' : 'partial'; status.errors.push('discovery_listener_failed'); };
    if (status.added) this.core.emitAutomation('catalog.changed', undefined, failed);
    this.core.emitAutomation('automation.discovery', status, failed); return status;
  }
   async close() { this.stopped = true; clearTimeout(this.timer); await this.pending?.catch(() => {}); this.status.state = 'stopped'; }
}

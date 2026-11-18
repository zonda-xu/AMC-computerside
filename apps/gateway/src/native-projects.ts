import { basename, isAbsolute, parse, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Core } from './core.ts';
import { inside } from './files.ts';
import { directoryIdentity } from './workspace-identity.ts';
import { ENGINES, type EngineId, type Workspace } from '../../../packages/protocol/src/types.ts';

export interface ProjectPolicy {
  syncEngines: EngineId[];
  creationRoot: string;
  manualProjects: string[];
  excludedProjects: string[];
  keepLegacyCreationRoots?: true;
}

export function effectiveProjectPolicy(config: {
  projectPolicy?: ProjectPolicy;
  allowedWorkspaceRoots: string[];
  runtimes: Partial<Record<EngineId, { enabled?: boolean; expectedVersion?: string }>>;
}): ProjectPolicy | undefined {
  if (config.projectPolicy || !config.allowedWorkspaceRoots?.length) return config.projectPolicy;
  const syncEngines = ENGINES.filter(engine => {
    const runtime = config.runtimes?.[engine];
    return runtime && runtime.enabled !== false && runtime.expectedVersion !== 'DISABLED';
  });
  return { syncEngines, creationRoot: config.allowedWorkspaceRoots[0], manualProjects: [], excludedProjects: [], keepLegacyCreationRoots: true };
}
interface ProjectSource { path: string; engines: EngineId[]; created?: boolean }
const sourceTable = 'workspace-origins-v1';
const pathKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const samePath = (a: string, b: string) => relative(a, b) === '';

export class NativeProjects {
  readonly core: Core;
  policy?: ProjectPolicy;
  readonly status = new Map<EngineId, string>();
  readLocal?: (engine: EngineId) => Promise<string[]>;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(core: Core, policy?: ProjectPolicy) { this.core = core; this.policy = policy; }

  private origin(path: string): ProjectSource {
    return this.core.store.get<ProjectSource>(sourceTable, path) ?? { path, engines: [] };
  }
  private excluded(path: string) { return this.policy?.excludedProjects.some(p => samePath(p, path)) ?? false; }
  engines(path: string): EngineId[] | undefined {
    if (this.excluded(path)) return [];
    if (this.core.allowedRoots.some(root => inside(root, path))) return undefined;
    if (!this.policy) return [];
    const source = this.origin(path);
    if (source.created || this.policy.manualProjects.some(p => samePath(path, p))) return undefined;
    return source.engines.filter(engine => this.policy!.syncEngines.includes(engine));
  }
  hasRoot(path: string) {
    if (this.core.allowedRoots.includes(path)) return true;
    if (!this.policy || this.excluded(path)) return false;
    const source = this.origin(path);
    return !!source.created || this.policy.manualProjects.some(p => samePath(p,path)) || source.engines.some(engine => this.policy!.syncEngines.includes(engine));
  }
  permits(workspace: Workspace, target: string) {
    if (this.excluded(workspace.path) || this.excluded(target)) return false;
    if (this.core.allowedRoots.some(root => inside(root, target))) return true;
    return inside(workspace.path, target) && this.hasRoot(workspace.path);
  }
  index(workspace: Workspace) {
    if (this.policy) this.core.store.put('workspace-path-v1', pathKey(workspace.path), workspace.id);
  }
  get creationRoots() { return this.policy && !this.policy.keepLegacyCreationRoots ? [this.policy.creationRoot] : this.core.allowedRoots; }
  recordCreated(workspace: Workspace) {
    if (!this.policy) return;
    this.index(workspace);
    this.core.store.put(sourceTable, workspace.path, { ...this.origin(workspace.path), created: true });
    this.core.workspaceIdentities.bindNew(workspace, workspace.path);
  }
  known() { return this.core.store.list<ProjectSource>(sourceTable).filter(s => s.engines.length); }

  private async register(input: string, byPath: Map<string,Workspace>, engine?: EngineId) {
    if (!isAbsolute(input)) return false;
    const path = await realpath(input);
    if (!samePath(resolve(input), path) || (engine && (samePath(path, parse(path).root) || samePath(path, homedir())))) return false;
    directoryIdentity(path);
    if (this.closed) return false;
    const old = this.origin(path);
    const key = pathKey(path);
    const known = byPath.get(key) || this.core.store.get<Workspace>('workspace', this.core.store.get<string>('workspace-path-v1',key) || '');
    const added = !!engine && !old.engines.includes(engine);
    if (!added && (known || this.excluded(path))) return false;
    this.core.store.transaction(() => {
      if (added) this.core.store.put(sourceTable, path, { ...old, engines: [...old.engines, engine] });
      if (this.excluded(path)) return;
      const w = known ?? { id: randomUUID(), hostId: this.core.hostId, path, name: basename(path) || path, writeRoots: [path] };
      if (!this.core.store.get('workspace-identity-v1', w.id)) this.core.workspaceIdentities.bindNew(w, path);
      else this.core.workspaceIdentities.verify(w.id);
      if (!known) this.core.store.put('workspace', w.id, w);
      byPath.set(key,w);
    });
    return added || !known;
  }
  async refresh() {
    if (!this.policy || this.closed) return;
    if (!this.pending) this.pending = this.run(this.policy).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async run(policy: ProjectPolicy) {
    const byPath = new Map(this.core.store.list<Workspace>('workspace').map(w=>[pathKey(w.path),w]));
    let changed = false;
    for (const path of policy.manualProjects) {
      try { if (await this.register(path,byPath)) changed = true; } catch { /* A disconnected volume can return later. */ }
    }
    if (changed && !this.closed) this.core.emit('catalog.changed');
    await Promise.all(policy.syncEngines.map(async engine => {
      let engineChanged = false;
      const paths = new Set<string>();
      const local = await this.readLocal?.(engine).catch(() => []);
      for (const path of local ?? []) {
        if (this.closed || this.policy !== policy) return;
        if (!isAbsolute(path)) continue;
        paths.add(resolve(path));
        try { if (await this.register(path, byPath, engine)) engineChanged = true; } catch { /* Offline or replaced directory. */ }
      }
      const localPaths = new Set(paths);
      try {
        const provider = this.core.external.providers.get(engine);
        if (!provider?.projectDirectories) throw new Error('此运行时暂不提供项目列表');
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          if (this.closed || this.policy !== policy) return;
          const page = await provider.projectDirectories(cursor);
          for (const path of page.paths) if (typeof path === 'string' && isAbsolute(path)) paths.add(resolve(path));
          cursor = page.cursor;
          if ((cursor && (cursors.has(cursor) || cursors.size >= 500)) || paths.size > 20000) throw new Error('原生项目列表分页不完整');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        for (const path of paths) {
          if (this.closed || this.policy !== policy) return;
          if (localPaths.has(path)) continue;
          try { if (await this.register(path, byPath, engine)) engineChanged = true; } catch { /* Unavailable or replaced directories cannot be granted. */ }
        }
        if (this.closed || this.policy !== policy) return;
        const currentPaths = new Set([...paths].map(pathKey));
        for (const previous of this.known()) {
          if (previous.engines.includes(engine) && !currentPaths.has(pathKey(previous.path))) {
            this.core.store.put(sourceTable, previous.path, { ...previous, engines: previous.engines.filter(id => id !== engine) });
            engineChanged = true;
          }
        }
        this.status.set(engine, '已同步');
      } catch (error) {
        const detail = error instanceof Error ? error.message : '平台暂不可用';
        this.status.set(engine, localPaths.size ? '已读取本机项目记录。' + detail : detail);
      }
      if (engineChanged && !this.closed) this.core.emit('catalog.changed');
    }));
  }
  async configure(policy: ProjectPolicy) {
    this.policy = policy;
    this.core.emit('catalog.changed');
    await this.pending;
    this.start();
    await this.refresh();
  }
  start() {
    if (!this.policy || this.timer) return;
    const tick = () => { void this.refresh().catch(() => {}); };
    tick(); this.timer = setInterval(tick, 60000); this.timer.unref();
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.pending?.catch(() => {}); }
}

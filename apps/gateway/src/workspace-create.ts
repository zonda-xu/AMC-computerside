import { mkdir, lstat, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Core } from './core.ts';
import type { Workspace } from '../../../packages/protocol/src/types.ts';
import { digest } from './store.ts';
import { canonical, inside, overlaps } from './files.ts';
import { requireValue, stable } from '../../../packages/protocol/src/validation.ts';

interface Identity { dev: string; ino: string; birth: string }
interface Operation {
  hash: string; root: string; target: string; name: string; parent: Identity;
  stage: 'prepared' | 'created' | 'done' | 'failed' | 'needs_review';
  child?: Identity; workspaceId?: string; detail?: string;
}
async function identity(path: string): Promise<Identity> {
  const s = await lstat(path, { bigint: true });
  requireValue(s.isDirectory() && !s.isSymbolicLink(), 'directory_changed', 'Directory must not be a symlink or junction', 409);
  return { dev: String(s.dev), ino: String(s.ino), birth: String(s.birthtimeNs) };
}
function same(a: Identity, b: Identity): boolean { return stable(a) === stable(b); }
export function directoryName(value: string): string {
  requireValue(value.length > 0 && value.length <= 100 && value !== '.' && value !== '..' &&
    !/[\\/\x00-\x1f\x7f:<>"|?*]/.test(value) && !/[. ]$/.test(value) &&
    !/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])[ ]*(?:\.|$)/i.test(value), 'directory_name_invalid', 'Use a single portable directory name');
  return value;
}
export class WorkspaceCreator {
  private tails = new Map<string, Promise<void>>();
  core: Core;
  constructor(core: Core) { this.core = core; }
  rootId(root: string): string { return digest(this.core.hostId + '\0' + root); }
  status(device: string, requestId: string) {
    const op = this.core.store.get<Operation>('workspace-create-v1', stable([device, requestId]));
    requireValue(op, 'operation_missing', 'Directory creation operation not found', 404);
    requireValue(this.core.allowedRoots.includes(op.root), 'root_not_granted', 'Root authorization was revoked', 403);
    return { stage: op.stage, detail: op.detail || '', workspaceId: op.workspaceId };
  }
  async roots() {
    return Promise.all(this.core.allowedRoots.map(async root => {
      let reason = '';
      try {
        requireValue(await canonical(root) === root, 'root_changed', 'Authorized root identity changed');
        await identity(root);
        if (this.core.store.list<Workspace>('workspace').some(w => w.writeRoots.some(p => inside(p, root)))) reason = 'An existing parent workspace covers this root';
      } catch { reason = 'Authorized root is unavailable or changed'; }
      return { rootId: this.rootId(root), name: basename(root), canCreate: !reason, reason };
    }));
  }
  async create(device: string, requestId: string, rootId: string, leaf: string, name: string): Promise<Workspace> {
    directoryName(leaf);
    const root = this.core.allowedRoots.find(p => this.rootId(p) === rootId);
    requireValue(root, 'root_not_granted', 'Unknown authorized root', 403);
    const previous = this.tails.get(root) || Promise.resolve();
    let release: () => void = () => {};
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(root, tail);
    await previous;
    try { return await this.perform(device, requestId, root, leaf, name); }
    finally { release(); if (this.tails.get(root) === tail) this.tails.delete(root); }
  }
  private async perform(device: string, requestId: string, root: string, leaf: string, name: string): Promise<Workspace> {
    const key = stable([device, requestId]);
    const hash = digest(stable({ root, leaf, name }));
    let op = this.core.store.get<Operation>('workspace-create-v1', key);
    if (op) {
      requireValue(op.hash === hash, 'idempotency_conflict', 'Request ID already has different contents', 409);
      if (op.stage === 'done' && op.workspaceId) return this.core.workspace(op.workspaceId);
      if (op.stage === 'prepared') { op.stage = 'needs_review'; this.core.store.put('workspace-create-v1', key, op); }
      requireValue(op.stage === 'created', op.stage === 'failed' ? 'creation_failed' : 'needs_review', op.detail || 'Directory ownership cannot be proven; host review required', 409);
    } else {
      requireValue(await canonical(root) === root, 'root_changed', 'Authorized root changed', 409);
      const parent = await identity(root);
      const target = join(root, leaf);
      for (const w of this.core.store.list<Workspace>('workspace')) requireValue(!w.writeRoots.some(p => overlaps(p, target)), 'overlapping_project', 'Managed project roots overlap', 409);
      op = { hash, root, target, name, parent, stage: 'prepared' };
      this.core.store.put('workspace-create-v1', key, op);
      try { await mkdir(target, { mode: 0o700 }); }
      catch (e) { op.stage = 'failed'; op.detail = e instanceof Error ? e.message : 'Directory creation failed'; this.core.store.put('workspace-create-v1', key, op); throw e; }
      try {
        requireValue(await realpath(root) === root && same(parent, await identity(root)) && await realpath(target) === target, 'directory_changed', 'Parent or target changed during creation', 409);
        op.child = await identity(target); op.stage = 'created'; this.core.store.put('workspace-create-v1', key, op);
      } catch (e) { op.stage = 'needs_review'; this.core.store.put('workspace-create-v1', key, op); throw e; }
    }
    requireValue(op.child && same(op.parent, await identity(root)) && same(op.child, await identity(op.target)) && await realpath(op.target) === op.target && await realpath(root) === root, 'needs_review', 'Created directory identity changed; host review required', 409);
    for (const w of this.core.store.list<Workspace>('workspace')) requireValue(!w.writeRoots.some(p => overlaps(p, op.target)), 'overlapping_project', 'Managed project roots overlap', 409);
    const w: Workspace = { id: randomUUID(), hostId: this.core.hostId, name, path: op.target, writeRoots: [op.target] };
    op.stage = 'done'; op.workspaceId = w.id;
    this.core.store.transaction(() => { this.core.store.put('workspace', w.id, w); this.core.store.put('workspace-create-v1', key, op); });
    this.core.emit('catalog.changed');
    return w;
  }
}

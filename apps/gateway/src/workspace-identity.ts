import { lstatSync, realpathSync } from 'node:fs';
import type { Core } from './core.ts';
import type { Workspace } from '../../../packages/protocol/src/types.ts';
import { requireValue } from '../../../packages/protocol/src/validation.ts';
import { inside } from './files.ts';

export interface DirectoryIdentity { path: string; dev: string; ino: string; birthtime: string }
export interface WorkspaceIdentity { workspaceId: string; root: DirectoryIdentity; directory: DirectoryIdentity }
export function directoryIdentity(path: string): DirectoryIdentity {
  const stat = lstatSync(path, { bigint: true });
  requireValue(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path, 'workspace_changed', 'Directory identity changed');
  return { path, dev: String(stat.dev), ino: String(stat.ino), birthtime: String(stat.birthtimeNs) };
}
export function verifyDirectory(identity: DirectoryIdentity) {
  const current = directoryIdentity(identity.path);
  requireValue(current.dev === identity.dev && current.ino === identity.ino && current.birthtime === identity.birthtime, 'workspace_changed', 'Directory identity changed');
}
export class WorkspaceIdentities {
  private core: Core;
  constructor(core: Core) { this.core = core; }
  confirmRoot(path: string) {
    requireValue(this.core.projects.hasRoot(path), 'root_not_granted', 'Authorized root was revoked');
    this.core.store.put('automation-root-identity-v1', path, directoryIdentity(path));
  }
  authorizeRoot(path: string) {
    requireValue(this.core.projects.hasRoot(path), 'root_not_granted', 'Authorized root was revoked');
    const previous = this.core.store.get<DirectoryIdentity>('automation-root-identity-v1', path);
    if (previous) { verifyDirectory(previous); return previous; }
    const identity = directoryIdentity(path);
    this.core.store.put('automation-root-identity-v1', path, identity); return identity;
  }
  verify(workspaceId: string, automatic = false) {
    const workspace = this.core.store.get<Workspace>('workspace', workspaceId);
    requireValue(workspace, 'workspace_missing', 'Project not found');
    requireValue([workspace.path, ...workspace.writeRoots].every(path => this.core.projects.permits(workspace, path)), 'root_not_granted', 'Authorized root was revoked');
    const identity = this.core.store.get<WorkspaceIdentity>('workspace-identity-v1', workspaceId);
    requireValue(identity || !automatic, 'workspace_confirmation_required', 'Explicit host confirmation is required for automatic access');
    if (!identity) return;
    requireValue(identity.workspaceId === workspaceId && identity.directory.path === workspace.path && this.core.projects.hasRoot(identity.root.path), 'workspace_changed', 'Project authorization identity changed');
    const root = this.core.store.get<DirectoryIdentity>('automation-root-identity-v1', identity.root.path);
    requireValue(root && JSON.stringify(root) === JSON.stringify(identity.root), 'workspace_changed', 'Authorized root identity changed');
    verifyDirectory(identity.root); verifyDirectory(identity.directory);
  }
  bindNew(workspace: Workspace, rootPath: string) {
    const root = this.authorizeRoot(rootPath);
    requireValue(inside(rootPath, workspace.path), 'root_not_granted', 'Project is outside authorized root');
    const identity: WorkspaceIdentity = { workspaceId: workspace.id, root, directory: directoryIdentity(workspace.path) };
    this.core.store.put('workspace-identity-v1', workspace.id, identity);
  }
  confirm(workspaceId: string, rootPath: string) {
    const workspace = this.core.store.get<Workspace>('workspace', workspaceId);
    requireValue(workspace, 'workspace_missing', 'Project not found');
    this.core.store.transaction(() => { this.bindNew(workspace, rootPath); this.verify(workspaceId, true); });
  }
}

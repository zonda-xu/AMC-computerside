import { digest } from './store.ts';
import type { Core } from './core.ts';
import { ACTIVE, type Session } from '../../../packages/protocol/src/types.ts';
import { requireValue, string } from '../../../packages/protocol/src/validation.ts';

export type LibraryAction = 'pin' | 'unpin' | 'rename' | 'archive' | 'restore' | 'delete';
export interface LibraryChange { action: LibraryAction; revision: number; title?: string; confirmNativeId?: string }

export function catalogEntry(s: Session) {
  return { id: s.id, title: s.title, ref: s.ref, state: s.state, updatedAt: s.updatedAt,
    archived: !!s.archived, pinned: !!s.pinned, deletionPending: !!s.deletionPending, revision: s.catalogRevision ?? 0 };
}

function canClose(core: Core, s: Session) {
  // A read-only history projection has no owned terminal. Its unknown run
  // state must never be interpreted as proof that a native writer is idle.
  const observingOnly = s.binding?.state === 'unbound';
  requireValue((observingOnly || !ACTIVE.includes(s.state)) && !core.store.pendingCommands(s.id).length
    && !s.interactions.some(i => i.status === 'pending' || i.status === 'responding'),
  'session_busy', '会话仍在制作、等待审批或等待回执，请先处理当前轮', 409);
}

export async function editCatalog(core: Core, id: string, change: LibraryChange) {
  const removed = core.store.get<{nativeHash: string; workspaceId: string; revision: number}>('deleted-session', id);
  if (removed && change.action === 'delete' && typeof change.confirmNativeId === 'string' && digest(change.confirmNativeId) === removed.nativeHash && change.revision === removed.revision) {
    core.workspace(removed.workspaceId); return { id, deleted: true };
  }
  const s = core.session(id);
  core.workspace(s.ref.workspaceId);
  requireValue(Number.isSafeInteger(change.revision) && change.revision === (s.catalogRevision ?? 0),
    'catalog_changed', '会话已被另一端更新，请刷新后再操作', 409);
  requireValue(!s.deletionPending || change.action === 'delete', 'delete_pending', '删除尚未完成，只能重试删除', 409);
  const adapter = core.adapters.get(s.ref.engineId);
  switch (change.action) {
    case 'pin': case 'unpin': s.pinned = change.action === 'pin'; break;
    case 'rename': {
      const title = string(change.title, 'title', 160).trim();
      requireValue(title.length > 0 && !/[\x00-\x1f]/.test(title), 'invalid_title', '请输入有效的会话名称');
      s.title = title; break;
    }
    case 'archive':
      canClose(core, s);
      if (!s.archived) await adapter?.releaseSession?.(s);
      s.archived = true; break;
    case 'restore': s.archived = false; break;
    case 'delete': {
      requireValue(s.archived && change.confirmNativeId === s.ref.nativeSessionId,
        'confirmation_required', '请确认永久删除此归档会话', 409);
      canClose(core, s);
      requireValue(adapter?.prepareDelete, 'native_delete_unavailable', '当前平台未提供可核验的原生删除能力', 409);
      // Validate the native target first. An offline provider or an active
      // third-party terminal must not make an otherwise restorable item stuck.
      const remove = await adapter.prepareDelete(s);
      const latest = core.session(id); core.workspace(latest.ref.workspaceId); canClose(core, latest);
      if (!latest.deletionPending) {
        latest.deletionPending = true; core.store.put('session', id, latest); core.emit('catalog.changed');
      }
      await remove();
      core.store.eraseSession(latest);
      core.emit('catalog.changed');
      return { id, deleted: true };
    }
    default: throw new Error('未知会话操作');
  }
  // Native callbacks can update the transcript while an idle handle closes.
  const latest = core.session(id);
  if (change.action === 'archive') canClose(core, latest);
  latest.pinned = s.pinned; latest.archived = s.archived; latest.title = s.title;
  latest.catalogRevision = (latest.catalogRevision ?? 0) + 1;
  core.store.put('session', id, latest); core.emit('catalog.changed');
  return catalogEntry(latest);
}

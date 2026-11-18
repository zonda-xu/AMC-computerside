import { codexWorkspaceFilter, sameWorkspacePath } from '../common/workspace-path.ts';
import type { WebSocketRpc } from '../common/ws-rpc.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { nativeCommand } from '../common/command.ts';
import { requireValue } from '../../protocol/src/validation.ts';
import type { CodexThreadSnapshot } from './index.ts';

type MethodSchema = { oneOf?: Array<{ properties?: { method?: { enum?: string[]; const?: string } } }> };
export interface CodexMethods { requests: Set<string>; callbacks: Set<string>; notifications: Set<string> }

// The CLI can describe even mutating methods without creating threads or sending a turn.
export async function readCodexMethods(command: string, env: NodeJS.ProcessEnv): Promise<CodexMethods | undefined> {
  const native = nativeCommand(command);
  const folder = await mkdtemp(join(tmpdir(), 'amc-codex-protocol-'));
  try {
    await promisify(execFile)(native.command, [...native.args, 'app-server', 'generate-json-schema', '--experimental', '--out', folder],
      { env, windowsHide:true, timeout:10000, maxBuffer:131072 });
    const [requests, callbacks, notifications] = await Promise.all(['ClientRequest', 'ServerRequest', 'ServerNotification'].map(async name => {
      const schema: MethodSchema = JSON.parse(await readFile(join(folder, name + '.json'), 'utf8'));
      const methods = schema.oneOf?.flatMap(item => item.properties?.method?.enum ?? (item.properties?.method?.const ? [item.properties.method.const] : []));
      if (!methods?.length || !methods.every(method => typeof method === 'string')) throw new Error('Unrecognized Codex method schema');
      return new Set(methods);
    }));
    if (!requests.has('initialize')) return undefined;
    return { requests, callbacks, notifications };
  } catch { return undefined; }
  finally { await rm(folder, { recursive:true, force:true }); }
}

export function codexControls(methods?: CodexMethods, unavailable?: ReadonlySet<string>) {
  const request = (name: string) => !unavailable?.has(name) && (!methods || methods.requests.has(name));
  const notification = (name: string) => !methods || methods.notifications.has(name);
  const callback = (name: string) => !methods || methods.callbacks.has(name);
  const observe = notification('turn/completed') && notification('item/completed');
  const read = request('thread/read');
  const resume = read && request('thread/resume');
  return {
    create: request('thread/start'), submit: read && request('turn/start') && observe, observe,
    approve: ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].some(callback),
    answer: callback('item/tool/requestUserInput'), cancel: request('turn/interrupt') && notification('turn/completed'),
    resume, attach: resume && observe, configure: read && request('thread/settings/update')
  };
}

export async function initializeCodex(rpc: WebSocketRpc, expectedHome?: string) {
  const response = await rpc.request<{ userAgent?: string; codexHome?: string }>('initialize', {
    clientInfo: { name: 'ai_maid_cafe', title: 'AI Maid Café', version: '1.0.1' },
    capabilities: { experimentalApi: true }
  }, 5000);
  if (typeof response?.userAgent !== 'string' || !response.userAgent.trim()) {
    throw new Error('Codex initialize 未返回 app-server 标识（userAgent）');
  }
  if (expectedHome && typeof response.codexHome === 'string') {
    const [configured, running] = await Promise.all([expectedHome, response.codexHome].map(path => realpath(path).catch(() => resolve(path))));
    if (relative(configured, running)) throw new Error('Codex 共享运行时使用的会话目录与主机配置不同');
  }
  rpc.notify('initialized');
}

export interface ListedThread { id: string; cwd: string; preview?: string; name?: string }
export async function listCodexThreads(rpc: WebSocketRpc, limit: number, cwd?: string, cursor?: string) {
  const filter = cwd ? codexWorkspaceFilter(cwd) : undefined;
  const request = (workspaces?: string | string[]) => rpc.request<{ data: ListedThread[]; nextCursor?: string | null }>('thread/list',
    { limit, currentAccountOnly: true, ...(workspaces ? { cwd: workspaces } : {}), ...(cursor ? { cursor } : {}) });
  const page = await request(filter).catch(error => {
    if (!Array.isArray(filter) || error.code !== -32602) throw error;
    // Older runtimes only accept a single spelling. Page the current account
    // and enforce the same exact project identity on the returned rows.
    return request();
  });
  if (!Array.isArray(page?.data) || page.data.length > limit ||
      page.data.some(thread => typeof thread?.id !== 'string' || !thread.id || typeof thread.cwd !== 'string') ||
      (page.nextCursor != null && typeof page.nextCursor !== 'string')) {
    throw new Error('Codex thread/list 返回的会话列表格式无效');
  }
  return cwd ? { ...page, data: page.data.filter(thread => sameWorkspacePath(cwd, thread.cwd)) } : page;
}

export async function readCodexHistoryPage(rpc: WebSocketRpc, threadId: string, cwd: string, cursor?: string) {
  const read = async (includeTurns: boolean) => {
    const result = await rpc.request<CodexThreadSnapshot>('thread/read', { threadId, includeTurns });
    requireValue(result?.thread?.id === threadId && sameWorkspacePath(result.thread.cwd, cwd), 'source_changed', 'Codex native thread cwd or identity changed for the authorized session', 409);
    return result;
  };
  const metadata = await read(false);
  if (metadata.thread.historyMode === 'paginated') {
    const page = await rpc.request<{ data: CodexThreadSnapshot['thread']['turns']; nextCursor?: string }>('thread/turns/list',
      { threadId, limit: 50, itemsView:'full', sortDirection:'asc', ...(cursor ? { cursor } : {}) });
    requireValue(Array.isArray(page?.data) && page.data.length <= 50 && page.data.every(turn => turn && Array.isArray(turn.items) && (!turn.itemsView || turn.itemsView === 'full')) &&
      (page.nextCursor == null || typeof page.nextCursor === 'string' && page.nextCursor !== cursor), 'external_format', 'Codex paginated history is incomplete');
    metadata.thread.turns = page.data;
    return { snapshot: metadata, cursor: page.nextCursor || undefined };
  }
  requireValue(cursor === undefined, 'external_cursor', 'Codex legacy history does not accept a turn-page cursor', 409);
  const snapshot = await read(true);
  requireValue(snapshot.thread.historyMode !== 'paginated' && Array.isArray(snapshot.thread.turns) && snapshot.thread.turns.length <= 2000 &&
    snapshot.thread.turns.every(turn => turn && Array.isArray(turn.items) && (!turn.itemsView || turn.itemsView === 'full')),
    'external_truncated', 'Codex thread/read history is incomplete or exceeds budget');
  return { snapshot, cursor: undefined };
}

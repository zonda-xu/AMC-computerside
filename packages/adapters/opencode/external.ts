import type { ExternalMessage, ExternalProfile } from '../../protocol/src/types.ts';
import type { ExternalSessionProvider, DiscoveryPage } from '../common/external.ts';
import { closedProfile } from '../common/external.ts';
import { requireValue } from '../../protocol/src/validation.ts';
import { OpenCodeAdapter } from './index.ts';

/** Read-only discovery of the same registered v2 service used for control. */
export class OpenCodeExternalProvider implements ExternalSessionProvider {
  engineId = 'opencode' as const;
  readonly adapter: OpenCodeAdapter;
  constructor(adapter: OpenCodeAdapter) { this.adapter = adapter; }
  async profile(): Promise<ExternalProfile> {
    const runtime = await this.adapter.probe();
    const p = closedProfile(this.engineId, runtime.version, 'A history import requires explicit attachment to the registered native service');
    if (runtime.connectionState !== 'attached' || !runtime.nativeIdentity) return p;
    p.profile = 'opencode-v2-2.3.0';
    p.namespace = `${this.adapter.context.runtimeInstanceId}:${runtime.nativeIdentity}`;
    p.coverage = 'Native user and assistant text and pending requests; live tools via SSE only. Persisted tool history schema is unavailable in the local 2.3.0 contract, so missed tool records cannot be restored';
    p.syncMode = 'manual-refresh';
    p.discover = { state: 'supported', reason: 'Registered v2 service /api/session filtered by authorized directory' };
    p.history = { state: 'supported', reason: 'Read-only native message pagination with session/workspace identity checks' };
    p.observe = { state: 'supported', reason: 'Manual persisted history refresh; runtime control requires explicit attachment' };
    return p;
  }
  async projectDirectories(cursor?: string) {
    await this.adapter.connection();
    const paths = new Set<string>();
    if (!cursor && this.adapter.projectListRoute) {
      try {
        const result = await this.adapter.http(this.adapter.projectListRoute);
        const projects = Array.isArray(result) ? result : result.data;
        requireValue(Array.isArray(projects), 'external_format', 'OpenCode 项目列表格式无效');
        for (const p of projects) {
          for (const path of [p.canonical, p.worktree, p.directory, ...(Array.isArray(p.sandboxes) ? p.sandboxes : [])]) {
            if (typeof path === 'string' && path) paths.add(path);
          }
        }
      } catch (error) {
        if (!/HTTP (404|405|501)$/.test(String(error))) throw error;
      }
    }
    const query = new URLSearchParams({ limit:'100' });
    if (cursor) query.set('cursor',cursor);
    const page = await this.adapter.http('/api/session?' + query);
    requireValue(Array.isArray(page.data) && page.data.length <= 100 && (page.cursor?.next == null || typeof page.cursor.next === 'string'), 'external_format', 'OpenCode 会话目录列表格式无效');
    for (const row of page.data) if (typeof row.location?.directory === 'string') paths.add(row.location.directory);
    return { paths: [...paths], cursor: page.cursor?.next || undefined };
  }
  async discover(cwd: string, cursor?: string): Promise<DiscoveryPage> {
    requireValue((await this.profile()).discover.state === 'supported', 'external_unverified', 'OpenCode registered service is unavailable', 409);
    const query = new URLSearchParams({ directory: cwd, limit: '50' });
    if (cursor) query.set('cursor', cursor);
    const r = await this.adapter.http(`/api/session?${query}`);
    requireValue(Array.isArray(r.data) && r.data.length <= 50, 'external_format', 'Invalid OpenCode session page');
    requireValue(r.cursor?.next == null || typeof r.cursor.next === 'string', 'external_format', 'Invalid native pagination cursor');
    for (const info of r.data) requireValue(typeof info.id === 'string' && info.id && typeof info.location?.directory === 'string', 'external_format', 'Missing native session identity');
    return { items: r.data.filter((info: any) => info.location.directory === cwd).map((info: any) => ({ nativeId: info.id, cwd: info.location.directory, title: info.title || 'OpenCode' })), cursor: r.cursor?.next || undefined };
  }
  async history(cwd: string, nativeId: string, cursor?: string) {
    requireValue((await this.profile()).history.state === 'supported', 'external_unverified', 'OpenCode registered service is unavailable', 409);
    const identity = this.adapter.endpoint?.identity || this.adapter.endpoint?.url;
    const path = this.adapter.path(nativeId);
    const before = (await this.adapter.http(path)).data;
    requireValue(before?.id === nativeId && before.location?.directory === cwd, 'source_changed', 'OpenCode source identity or workspace changed', 409);
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor); else query.set('order', 'asc');
    const page = await this.adapter.http(`${path}/message?${query}`);
    requireValue(Array.isArray(page.data) && page.data.length <= 100 && (page.cursor?.next == null || typeof page.cursor.next === 'string'), 'external_format', 'Invalid OpenCode message page');
    const items: ExternalMessage[] = [];
    for (const message of page.data) {
      requireValue(typeof message.id === 'string' && message.id && message.sessionID === nativeId, 'source_changed', 'OpenCode history identity mismatch', 409);
      if (['user', 'assistant'].includes(message.type) && typeof message.payload?.text === 'string') items.push({ nativeEventId: message.id, role: message.type, text: message.payload.text });
    }
    const after = (await this.adapter.http(path)).data;
    requireValue(after?.id === nativeId && after.location?.directory === cwd && identity === (this.adapter.endpoint?.identity || this.adapter.endpoint?.url), 'source_changed', 'OpenCode service or source changed during history read', 409);
    return { items, cursor: page.cursor?.next || undefined };
  }
}

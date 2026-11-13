import type { ExternalPage, ExternalProfile, ExternalMessage } from '../../protocol/src/types.ts';
import type { ExternalSessionProvider, DiscoveryPage } from '../common/external.ts';
import { closedProfile } from '../common/external.ts';
import { CodexAdapter } from './index.ts';
import { requireValue } from '../../protocol/src/validation.ts';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

interface Thread { id: string; cwd: string; preview: string; name?: string }
interface Threads { data: Thread[]; nextCursor?: string }
interface Content { type: string; text?: string }
interface Item { type: string; id: string; text?: string; content?: Content[]; summary?: string[] }
interface Turn { id: string; items: Item[]; itemsView: string }
interface Turns { data: Turn[]; nextCursor?: string }
interface ThreadRead { thread: Thread }
export class CodexExternalProvider implements ExternalSessionProvider {
  engineId: 'codex' = 'codex';
  adapter: CodexAdapter;
  constructor(adapter: CodexAdapter) { this.adapter = adapter; }
  async profile(): Promise<ExternalProfile> {
    const runtime = await this.adapter.probe();
    const p = closedProfile(this.engineId, runtime.version, 'No verified exclusive writer termination evidence; create a separate gateway-managed session');
    const supported = runtime.version === 'codex-cli 0.167.0-alpha.4.1' || runtime.version === 'codex-cli 0.167.1';
    if (!runtime.installed || !supported || this.adapter.config.expectedVersion !== runtime.version) {
      const reason = 'Codex external history requires an enabled installed runtime, exact expectedVersion, and a verified 0.167.0-alpha.4.1 or 0.167.1 protocol profile';
      p.discover = { state: 'unverified', reason }; p.history = p.discover; p.observe = p.discover;
      return p;
    }
    const home = resolve(this.adapter.env.CODEX_HOME || resolve(homedir(), '.codex'));
    const source = createHash('sha256').update(home + '\0' + this.adapter.config.command).digest('hex');
    p.profile = 'codex-app-server-' + runtime.version.slice('codex-cli '.length); p.namespace = this.adapter.context.runtimeInstanceId + ':' + source;
    p.coverage = 'user text, assistant text, reasoning summaries; no attachments, tools or approvals'; p.syncMode = 'manual-refresh';
    p.discover = { state: 'supported', reason: 'Native thread/list with cwd and opaque pagination; exact release protocol metadata, alpha.4.1 source d2c035639366e0bf2c316aa2065c24aabc12bcdc' };
    p.history = { state: 'supported', reason: 'Native thread/read metadata and paginated thread/turns/list; no resume or turn/start' };
    p.observe = { state: 'supported', reason: 'Explicit manual history refresh, not live process attachment' };
    return p;
  }
  async discover(cwd: string, cursor?: string): Promise<DiscoveryPage> {
    requireValue((await this.profile()).discover.state === 'supported', 'external_unverified', 'Codex version does not match the verified profile', 409);
    const rpc = await this.adapter.connection(cwd);
    const r = await rpc.request<Threads>('thread/list', { cwd, cursor, limit: 50, useStateDbOnly: true });
    requireValue(Array.isArray(r.data) && r.data.length <= 50 && (r.nextCursor == null || typeof r.nextCursor === 'string') && r.data.every(t => typeof t.id === 'string' && !!t.id && typeof t.cwd === 'string'), 'external_format', 'Invalid Codex discovery page');
    return { items: r.data.map(t => ({ nativeId: t.id, cwd: t.cwd, title: t.name || t.preview || 'Codex' })), cursor: r.nextCursor || undefined };
  }
  async history(cwd: string, nativeId: string, cursor?: string): Promise<ExternalPage> {
    requireValue((await this.profile()).history.state === 'supported', 'external_unverified', 'Codex history profile unavailable', 409);
    const rpc = await this.adapter.connection(cwd);
    const read = await rpc.request<ThreadRead>('thread/read', { threadId: nativeId, includeTurns: false });
    requireValue(read.thread.id === nativeId && read.thread.cwd === cwd, 'source_changed', 'Codex source project identity changed', 409);
    const r = await rpc.request<Turns>('thread/turns/list', { threadId: nativeId, cursor, limit: 25, sortDirection: 'asc', itemsView: 'full' });
    requireValue(Array.isArray(r.data) && r.data.length <= 25 && (r.nextCursor == null || typeof r.nextCursor === 'string'), 'external_format', 'Invalid Codex history page');
    const items: ExternalMessage[] = [];
    for (const turn of r.data) {
      requireValue(typeof turn.id === 'string' && !!turn.id && turn.itemsView === 'full' && Array.isArray(turn.items) && turn.items.length <= 2000, 'external_truncated', 'Codex history page is incomplete or exceeds budget');
      for (const i of turn.items) {
        requireValue(typeof i.id === 'string' && !!i.id, 'external_format', 'Codex item identity is missing');
        const key = turn.id + ':' + i.id;
        if (i.type === 'agentMessage' && typeof i.text === 'string') items.push({ nativeEventId: key, role: 'assistant', text: i.text });
        if (i.type === 'userMessage' && Array.isArray(i.content)) items.push({ nativeEventId: key, role: 'user', text: i.content.filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') });
        if (i.type === 'reasoning' && Array.isArray(i.summary)) {
          requireValue(i.summary.every(text => typeof text === 'string'), 'external_format', 'Malformed Codex reasoning summary');
          items.push({ nativeEventId: key, role: 'reasoning', text: i.summary.join('\n') });
        }
      }
    }
    return { items, cursor: r.nextCursor || undefined };
  }
}

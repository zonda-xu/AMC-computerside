import type { ExternalPage, ExternalProfile, ExternalMessage, ExternalTool } from '../../protocol/src/types.ts';
import type { ExternalSessionProvider, DiscoveryPage } from '../common/external.ts';
import { closedProfile } from '../common/external.ts';
import { CodexAdapter } from './index.ts';
import { requireValue } from '../../protocol/src/validation.ts';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { listCodexThreads, readCodexHistoryPage } from './protocol.ts';
import { compatibilityProfile } from '../../protocol/src/compatibility.ts';

interface Content { type: string; text?: string }
interface Item { type: string; id: string; text?: string; content?: Content[]; summary?: string[]; command?:string; tool?:string; status?:string; aggregatedOutput?:string }
interface Turn { id: string; items: Item[] }
export class CodexExternalProvider implements ExternalSessionProvider {
  engineId: 'codex' = 'codex';
  adapter: CodexAdapter;
  constructor(adapter: CodexAdapter) { this.adapter = adapter; }
  async profile(): Promise<ExternalProfile> {
    const p = closedProfile(this.engineId, '', 'Control requires a separately verified attachment to the registered app-server');
    try {
      const rpc = await this.adapter.connection('');
      const access = await this.adapter.historyAccess(rpc);
      p.discover = access.discover; p.history = access.history; p.observe = access.history;
    } catch (error) {
      p.version = this.adapter.config.registeredVersion || this.adapter.observedVersion;
      p.discover = { state: 'unverified', reason: (error as Error).message }; p.history = p.discover; p.observe = p.discover;
      return p;
    }
    p.version = this.adapter.config.registeredVersion || this.adapter.observedVersion;
    const home = resolve(this.adapter.env.CODEX_HOME || resolve(homedir(), '.codex'));
    const source = createHash('sha256').update(home + '\0' + this.adapter.config.command).digest('hex');
    // Persisted source keys identify the adapter contract across CLI upgrades.
    p.profile = compatibilityProfile('codex').id; p.namespace = this.adapter.context.runtimeInstanceId + ':' + source;
    p.coverage = 'user and assistant text, reasoning summaries and recorded tool calls'; p.syncMode = 'manual-refresh';
    return p;
  }
  async projectDirectories(cursor?: string) {
    const rpc = await this.adapter.connection('');
    const page = await listCodexThreads(rpc, 100, undefined, cursor);
    return { paths: page.data.map(thread => thread.cwd), cursor: page.nextCursor || undefined };
  }
  async discover(cwd: string, cursor?: string): Promise<DiscoveryPage> {
    const profile = await this.profile();
    requireValue(profile.discover.state === 'supported', 'external_unverified', profile.discover.reason, 409);
    const rpc = await this.adapter.connection(cwd);
    const r = await listCodexThreads(rpc, 50, cwd, cursor);
    return { items: r.data.map(t => ({ nativeId: t.id, cwd: t.cwd, title: t.name || t.preview || 'Codex' })), cursor: r.nextCursor || undefined };
  }
  async history(cwd: string, nativeId: string, cursor?: string): Promise<ExternalPage> {
    const profile = await this.profile();
    requireValue(profile.history.state === 'supported', 'external_unverified', profile.history.reason, 409);
    const rpc = await this.adapter.connection(cwd);
    const page = await readCodexHistoryPage(rpc, nativeId, cwd, cursor);
    const items: ExternalMessage[] = []; const tools:ExternalTool[]=[];
    for (const turn of page.snapshot.thread.turns as Turn[]) {
      requireValue(typeof turn.id === 'string' && !!turn.id && Array.isArray(turn.items) && turn.items.length <= 2000, 'external_truncated', 'Codex history is incomplete or exceeds budget');
      for (const i of turn.items) {
        requireValue(typeof i.id === 'string' && !!i.id, 'external_format', 'Codex item identity is missing');
        const key = turn.id + ':' + i.id;
        if (['commandExecution','fileChange','mcpToolCall','webSearch'].includes(i.type)) {
          tools.push({id:i.id,title:(i.tool || i.type).slice(0,500),detail:(i.command || i.aggregatedOutput || '').slice(0,8192),
            status:i.status==='completed'?'completed':['failed','declined'].includes(i.status||'')?'failed':i.status==='inProgress'?'running':'uncertain'});
        }
        if (i.type === 'agentMessage' && typeof i.text === 'string') items.push({ nativeEventId: key, role: 'assistant', text: i.text });
        if (i.type === 'userMessage' && Array.isArray(i.content)) items.push({ nativeEventId: key, role: 'user', text: i.content.filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') });
        if (i.type === 'reasoning' && Array.isArray(i.summary)) {
          requireValue(i.summary.every(text => typeof text === 'string'), 'external_format', 'Malformed Codex reasoning summary');
          items.push({ nativeEventId: key, role: 'reasoning', text: i.summary.join('\n') });
        }
      }
    }
    return { items, ...(tools.length ? {tools} : {}), ...(page.cursor ? {cursor:page.cursor} : {}) };
  }
}

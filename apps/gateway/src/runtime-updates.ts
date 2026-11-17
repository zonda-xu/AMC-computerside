import { isIP } from 'node:net';

export type RuntimeUpdateComponent = 'codex' | 'claudeAgentSdk' | 'claudeCode' | 'opencodeClient' | 'opencodeCli' | 'dsh';

export interface RuntimeUpdateConfig {
  enabled?: boolean;
  intervalSeconds?: number;
  sources?: Partial<Record<RuntimeUpdateComponent, string>>;
  allowedHosts?: string[];
  ttlSeconds?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface RuntimeUpdateClock {
  now(): number;
  schedule(callback: () => void, milliseconds: number): () => void;
}

export interface RuntimeUpdateDependencies {
  fetch?: typeof fetch;
  clock?: RuntimeUpdateClock;
}

export interface RuntimeUpdateEntry {
  component: RuntimeUpdateComponent;
  source: string | null;
  evidence: 'package-metadata';
  nativeVerified: false;
  state: 'unconfigured' | 'unchecked' | 'available' | 'error';
  latestVersion: string | null;
  checkedAt: number | null;
  fetchedAt: number | null;
  stale: boolean;
  error: string | null;
}

export interface RuntimeUpdateStatus {
  enabled: boolean;
  running: boolean;
  checking: boolean;
  components: RuntimeUpdateEntry[];
}

interface CachedEntry {
  view: RuntimeUpdateEntry;
  etag: string | null;
}

interface PackageMetadata {
  version?: string;
}

interface MetadataResult {
  version: string;
  etag: string | null;
}

const defaults: Record<RuntimeUpdateComponent, string | null> = {
  codex: 'https://registry.npmjs.org/@openai/codex/latest',
  claudeAgentSdk: 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest',
  claudeCode: 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest',
  opencodeClient: 'https://registry.npmjs.org/@opencode/client/latest',
  opencodeCli: 'https://registry.npmjs.org/@opencode/cli/latest',
  dsh: null,
};

const systemClock: RuntimeUpdateClock = {
  now: () => Date.now(),
  schedule(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

export class RuntimeUpdateMonitor {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly allowedHosts: Set<string>;
  private readonly fetcher: typeof fetch;
  private readonly clock: RuntimeUpdateClock;
  private readonly entries: CachedEntry[];
  private readonly controllers = new Set<AbortController>();
  private running = false;
  private stopped = false;
  private generation = 0;
  private cancelTimer?: () => void;
  private inFlight?: Promise<RuntimeUpdateStatus>;

  constructor(config: RuntimeUpdateConfig = {}, dependencies: RuntimeUpdateDependencies = {}) {
    this.enabled = config.enabled === true;
    this.intervalMs = bounded(config.intervalSeconds, 3600, 60, 86400) * 1000;
    this.ttlMs = bounded(config.ttlSeconds, 3600, 1, 86400) * 1000;
    this.timeoutMs = bounded(config.timeoutMs, 5000, 100, 30000);
    this.maxResponseBytes = bounded(config.maxResponseBytes, 262144, 64, 1048576);
    this.allowedHosts = new Set(['registry.npmjs.org', ...(config.allowedHosts ?? []).map(host => host.toLowerCase())]);
    this.fetcher = dependencies.fetch ?? fetch;
    this.clock = dependencies.clock ?? systemClock;
    this.entries = [];
    for (const component of Object.keys(defaults)) {
      if (!this.isComponent(component)) continue;
      const source = config.sources?.[component] ?? defaults[component];
      this.entries.push({
        view: {
          component, source, evidence: 'package-metadata', nativeVerified: false,
          state: source ? 'unchecked' : 'unconfigured', latestVersion: null,
          checkedAt: null, fetchedAt: null, stale: false, error: null,
        },
        etag: null,
      });
    }
  }

  start(): void {
    if (!this.enabled || this.running) return;
    this.stopped = false;
    this.running = true;
    const generation = this.generation;
    if (this.inFlight) {
      void this.inFlight.then(() => {
        if (this.running && generation === this.generation) this.poll(generation);
      });
    } else {
      this.poll(generation);
    }
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    this.generation++;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    for (const controller of this.controllers) controller.abort();
  }

  status(): RuntimeUpdateStatus {
    const now = this.clock.now();
    return {
      enabled: this.enabled, running: this.running, checking: this.inFlight !== undefined,
      components: this.entries.map(({ view }) => ({
        ...view,
        stale: view.latestVersion !== null && (view.error !== null || view.fetchedAt === null || now - view.fetchedAt >= this.ttlMs),
      })),
    };
  }

  check(): Promise<RuntimeUpdateStatus> {
    if (this.inFlight) return this.inFlight;
    if (!this.enabled || this.stopped) return Promise.resolve(this.status());
    const generation = this.generation;
    const task = this.perform(generation).then(() => {
      this.inFlight = undefined;
      return this.status();
    });
    this.inFlight = task;
    return task;
  }

  private isComponent(value: string): value is RuntimeUpdateComponent {
    return value === 'codex' || value === 'claudeAgentSdk' || value === 'claudeCode' ||
      value === 'opencodeClient' || value === 'opencodeCli' || value === 'dsh';
  }

  private poll(generation: number): void {
    void this.check().then(() => {
      if (!this.running || generation !== this.generation) return;
      this.cancelTimer = this.clock.schedule(() => this.poll(generation), this.intervalMs);
    });
  }

  private validateSource(source: string): URL {
    const url = new URL(source);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      isIP(host.replace(/^\[|\]$/g, '')) !== 0 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(host) || !this.allowedHosts.has(host)) {
      throw new Error('Source must use an allowed public HTTPS host without credentials, ports, or fragments');
    }
    return url;
  }

  private async perform(generation: number): Promise<void> {
    await Promise.all(this.entries.map(async entry => {
      const view = entry.view;
      if (!view.source || (view.error === null && view.fetchedAt !== null && this.clock.now() - view.fetchedAt < this.ttlMs)) return;
      try {
        const url = this.validateSource(view.source);
        const result = await this.request(url, entry);
        if (this.stopped || generation !== this.generation) return;
        view.latestVersion = result.version;
        view.fetchedAt = this.clock.now();
        view.checkedAt = view.fetchedAt;
        view.state = 'available';
        view.error = null;
        entry.etag = result.etag;
      } catch (error) {
        if (this.stopped || generation !== this.generation) return;
        view.checkedAt = this.clock.now();
        view.state = 'error';
        view.error = error instanceof Error ? error.message.slice(0, 300) : 'Metadata request failed';
      }
    }));
  }

  private async request(url: URL, entry: CachedEntry): Promise<MetadataResult> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Metadata request cancelled or timed out')), { once: true });
    });
    const cancelTimeout = this.clock.schedule(() => controller.abort(), this.timeoutMs);
    try {
      return await Promise.race([this.readMetadata(url, entry, controller.signal), aborted]);
    } finally {
      cancelTimeout();
      this.controllers.delete(controller);
    }
  }

  private async readMetadata(url: URL, entry: CachedEntry, signal: AbortSignal): Promise<MetadataResult> {
    const headers = new Headers({ Accept: 'application/json' });
    if (entry.etag) headers.set('If-None-Match', entry.etag);
    const response = await this.fetcher(url, { method: 'GET', headers, redirect: 'error', credentials: 'omit', signal });
    if (signal.aborted || response.redirected || (response.url && response.url !== url.href)) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Cancelled or redirected metadata response');
    }
    if (response.status === 304 && entry.etag !== null && entry.view.latestVersion !== null) {
      void response.body?.cancel().catch(() => {});
      return { version: entry.view.latestVersion, etag: entry.etag };
    }
    if (response.status !== 200 || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Unexpected metadata HTTP status ${response.status}`);
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > this.maxResponseBytes)) {
      void response.body.cancel().catch(() => {});
      throw new Error('Metadata response exceeds size limit');
    }
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    let text = '';
    let size = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      while (true) {
        const chunk = await reader.read();
        if (signal.aborted) throw new Error('Metadata request cancelled or timed out');
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > this.maxResponseBytes) throw new Error('Metadata response exceeds size limit');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      signal.removeEventListener('abort', cancel);
      cancel();
      reader.releaseLock();
    }
    const metadata: PackageMetadata | null = JSON.parse(text);
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata) ||
      typeof metadata.version !== 'string' || metadata.version.length > 128 ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(metadata.version)) {
      throw new Error('Metadata has no valid package version');
    }
    const etag = response.headers.get('etag');
    return { version: metadata.version, etag: etag && etag.length <= 1024 ? etag : null };
  }
}

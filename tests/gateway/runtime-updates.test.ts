import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RuntimeUpdateMonitor } from '../../apps/gateway/src/runtime-updates.ts';
import type { RuntimeUpdateClock, RuntimeUpdateComponent, RuntimeUpdateStatus } from '../../apps/gateway/src/runtime-updates.ts';

interface Scheduled {
  at: number;
  callback: () => void;
}

class Clock implements RuntimeUpdateClock {
  time = 0;
  jobs = new Set<Scheduled>();
  now(): number { return this.time; }
  schedule(callback: () => void, milliseconds: number): () => void {
    const job = { at: this.time + milliseconds, callback };
    this.jobs.add(job);
    return () => { this.jobs.delete(job); };
  }
  advance(milliseconds: number): void {
    this.time += milliseconds;
    for (const job of this.jobs) {
      if (job.at <= this.time) { this.jobs.delete(job); job.callback(); }
    }
  }
}

function component(status: RuntimeUpdateStatus, name: RuntimeUpdateComponent = 'codex') {
  const entry = status.components.find(value => value.component === name);
  assert.ok(entry);
  return entry;
}

function metadata(version = '1.2.3'): Response {
  return Response.json({ version }, { headers: { etag: '"v1"' } });
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test('disabled by default and explicitly disabled never fetch, even on start/check', async () => {
  for (const config of [{}, { enabled: false }]) {
    const monitor = new RuntimeUpdateMonitor(config, { fetch: async () => { throw new Error('Unexpected network'); } });
    monitor.start();
    assert.equal((await monitor.check()).enabled, false);
    assert.equal(monitor.status().running, false);
    assert.equal(component(monitor.status()).state, 'unchecked');
    monitor.stop();
  }
});

test('official defaults are read-only metadata, not native readiness, and DSH is unconfigured', async () => {
  const urls: string[] = [];
  const monitor = new RuntimeUpdateMonitor({ enabled: true }, {
    fetch: async (input, init) => {
      urls.push(String(input));
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.body, undefined);
      return metadata();
    },
  });
  const status = await monitor.check();
  assert.deepEqual(urls, [
    'https://registry.npmjs.org/@openai/codex/latest',
    'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest',
    'https://registry.npmjs.org/@anthropic-ai/claude-code/latest',
    'https://registry.npmjs.org/@opencode/client/latest',
    'https://registry.npmjs.org/@opencode/cli/latest',
  ]);
  for (const entry of status.components.slice(0, 5)) {
    assert.equal(entry.latestVersion, '1.2.3');
    assert.equal(entry.evidence, 'package-metadata');
    assert.equal(entry.nativeVerified, false);
    assert.equal(entry.state, 'available');
    assert.equal('installedVersion' in entry, false);
    assert.equal('ready' in entry, false);
  }
  assert.equal(component(status, 'dsh').state, 'unconfigured');
  assert.deepEqual(JSON.parse(JSON.stringify(status)), status);
  component(status).latestVersion = 'modified';
  assert.equal(component(monitor.status()).latestVersion, '1.2.3');
  monitor.stop();
});

test('TTL, ETag 304, offline failure and recovery retain cached version honestly', async () => {
  const clock = new Clock();
  let calls = 0;
  let mode = 'first';
  const monitor = new RuntimeUpdateMonitor({ enabled: true, ttlSeconds: 1 }, {
    clock,
    fetch: async (input, init) => {
      calls++;
      if (mode === 'offline') throw new Error('offline');
      if (mode === 'cached') {
        assert.equal(new Headers(init?.headers).get('if-none-match'), '"v1"');
        return new Response(null, { status: 304 });
      }
      return metadata(mode === 'recovered' ? '2.0.0' : '1.2.3');
    },
  });
  await monitor.check();
  await monitor.check();
  assert.equal(calls, 5);
  clock.advance(1000);
  assert.equal(component(monitor.status()).stale, true);
  mode = 'cached';
  assert.equal(component(await monitor.check()).stale, false);
  assert.equal(component(monitor.status()).fetchedAt, 1000);
  clock.advance(1000);
  mode = 'offline';
  const failed = component(await monitor.check());
  assert.equal(failed.latestVersion, '1.2.3');
  assert.equal(failed.fetchedAt, 1000);
  assert.equal(failed.checkedAt, 2000);
  assert.equal(failed.state, 'error');
  assert.equal(failed.stale, true);
  assert.match(failed.error ?? '', /offline/);
  mode = 'recovered';
  const recovered = component(await monitor.check());
  assert.equal(recovered.latestVersion, '2.0.0');
  assert.equal(recovered.error, null);
  assert.equal(recovered.stale, false);
  monitor.stop();
});

test('custom DSH requires explicit allowed host and dangerous URLs never reach fetch', async () => {
  const rejected = [
    'http://registry.npmjs.org/pkg/latest', 'https://user:secret@registry.npmjs.org/pkg/latest',
    'https://untrusted.example.com/latest', 'https://localhost/latest', 'https://foo.localhost/latest',
    'https://127.0.0.1/latest', 'https://2130706433/latest', 'https://10.0.0.1/latest',
    'https://192.168.0.1/latest', 'https://169.254.169.254/latest', 'https://[::1]/latest',
    'https://[::ffff:127.0.0.1]/latest', 'https://service.internal/latest', 'https://service.local/latest',
    'https://registry.npmjs.org:8443/latest', 'https://registry.npmjs.org/latest#fragment',
  ];
  for (const source of rejected) {
    let reached = false;
    const monitor = new RuntimeUpdateMonitor({
      enabled: true, sources: { dsh: source },
      allowedHosts: ['localhost', 'foo.localhost', '127.0.0.1', '10.0.0.1', '192.168.0.1', '169.254.169.254', '::1', 'service.internal', 'service.local'],
    }, { fetch: async input => { if (String(input) === source) reached = true; return metadata(); } });
    assert.equal(component(await monitor.check(), 'dsh').state, 'error', source);
    assert.equal(reached, false, source);
    monitor.stop();
  }
  const monitor = new RuntimeUpdateMonitor({ enabled: true, sources: { dsh: 'https://updates.example.com/dsh' }, allowedHosts: ['updates.example.com'] }, { fetch: async () => metadata() });
  assert.equal(component(await monitor.check(), 'dsh').latestVersion, '1.2.3');
  monitor.stop();
});

test('bounded timeout settles even when injected fetch ignores abort', async () => {
  const clock = new Clock();
  const signals: AbortSignal[] = [];
  const monitor = new RuntimeUpdateMonitor({ enabled: true, timeoutMs: 100 }, {
    clock, fetch: (input, init) => {
      assert.ok(init?.signal);
      signals.push(init.signal);
      return new Promise<Response>(() => {});
    },
  });
  const pending = monitor.check();
  clock.advance(100);
  assert.match(component(await pending).error ?? '', /timed out/);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(clock.jobs.size, 0);
  monitor.stop();
});

test('size limits cover content-length and streamed bodies; redirects and invalid metadata are rejected', async () => {
  const cases: Array<() => Response> = [
    () => new Response('{}', { headers: { 'content-length': '1000000' } }),
    () => new Response('x'.repeat(65)),
    () => new Response(null, { status: 302, headers: { location: 'https://localhost/' } }),
    () => new Response(null, { status: 304 }),
    () => new Response('not json'),
    () => Response.json({ version: 123 }),
    () => Response.json({ ready: true }),
    () => Response.json(null),
    () => Response.json(['1.2.3']),
    () => Response.json({ version: 'install this' }),
    () => new Response(null, { status: 503 }),
    () => {
      const response = metadata();
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    },
    () => {
      const response = metadata();
      Object.defineProperty(response, 'url', { value: 'https://untrusted.example.com/latest' });
      return response;
    },
  ];
  for (const makeResponse of cases) {
    const monitor = new RuntimeUpdateMonitor({ enabled: true, maxResponseBytes: 64 }, { fetch: async () => makeResponse() });
    const entry = component(await monitor.check());
    assert.equal(entry.state, 'error');
    assert.equal(entry.latestVersion, null);
    assert.ok(entry.error);
    monitor.stop();
  }
});

test('timeout also bounds a stalled response body and cancels its stream', async () => {
  const clock = new Clock();
  let cancelled = 0;
  const monitor = new RuntimeUpdateMonitor({ enabled: true, timeoutMs: 100 }, {
    clock,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } })),
  });
  const pending = monitor.check();
  await flush();
  clock.advance(100);
  assert.equal(component(await pending).state, 'error');
  await flush();
  assert.equal(cancelled, 5);
  monitor.stop();
});

test('streamed size limit stops reading and cancels before the body ends', async () => {
  let cancelled = 0;
  const monitor = new RuntimeUpdateMonitor({ enabled: true, maxResponseBytes: 64 }, {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65)); },
      cancel() { cancelled++; },
    })),
  });
  assert.match(component(await monitor.check()).error ?? '', /size limit/);
  assert.equal(cancelled, 5);
  monitor.stop();
});

test('a fetch rejection for redirects is reported without retrying or following', async () => {
  let calls = 0;
  const monitor = new RuntimeUpdateMonitor({ enabled: true }, {
    fetch: async (input, init) => {
      calls++;
      assert.equal(init?.redirect, 'error');
      throw new TypeError('redirect rejected');
    },
  });
  assert.match(component(await monitor.check()).error ?? '', /redirect rejected/);
  assert.equal(calls, 5);
  monitor.stop();
});

test('singleflight, stop cancellation, late responses, and interval retries never overlap', async () => {
  const clock = new Clock();
  let calls = 0;
  const completions: Array<(response: Response) => void> = [];
  const signals: AbortSignal[] = [];
  const monitor = new RuntimeUpdateMonitor({ enabled: true, intervalSeconds: 0, ttlSeconds: 1 }, {
    clock,
    fetch: (input, init) => {
      calls++;
      assert.ok(init?.signal);
      signals.push(init.signal);
      return new Promise<Response>(resolve => { completions.push(resolve); });
    },
  });
  monitor.start();
  const first = monitor.check();
  assert.equal(first, monitor.check());
  monitor.start();
  assert.equal(calls, 5);
  assert.equal(monitor.status().checking, true);
  monitor.stop();
  const stopped = await first;
  assert.equal(stopped.checking, false);
  assert.ok(signals.every(signal => signal.aborted));
  for (const complete of completions.splice(0)) complete(metadata('9.9.9'));
  await flush();
  assert.deepEqual(monitor.status(), stopped);
  await monitor.check();
  assert.equal(calls, 5);
  clock.advance(86400000);
  assert.equal(calls, 5);
  monitor.start();
  assert.equal(calls, 10);
  for (const complete of completions.splice(0)) complete(new Response(null, { status: 503 }));
  await monitor.check();
  await flush();
  clock.advance(59999);
  assert.equal(calls, 10);
  clock.advance(1);
  assert.equal(calls, 15);
  monitor.stop();
  await flush();
  assert.equal(clock.jobs.size, 0);
});

test('immediate restart waits for cancellation and ignores responses from the old generation', async () => {
  const clock = new Clock();
  let calls = 0;
  const oldResponses: Array<(response: Response) => void> = [];
  const monitor = new RuntimeUpdateMonitor({ enabled: true }, {
    clock,
    fetch: () => {
      calls++;
      if (calls <= 5) return new Promise<Response>(resolve => { oldResponses.push(resolve); });
      return Promise.resolve(metadata('2.0.0'));
    },
  });
  monitor.start();
  monitor.stop();
  monitor.start();
  assert.equal(calls, 5);
  await flush();
  assert.equal(calls, 10);
  assert.equal(component(monitor.status()).latestVersion, '2.0.0');
  for (const resolve of oldResponses) resolve(metadata('9.9.9'));
  await flush();
  assert.equal(component(monitor.status()).latestVersion, '2.0.0');
  monitor.stop();
  assert.equal(clock.jobs.size, 0);
});

test('monitor has no process, install, filesystem-write or runtime-control dependencies', async () => {
  const source = await readFile(new URL('../../apps/gateway/src/runtime-updates.ts', import.meta.url), 'utf8');
  const imports = source.match(/^import .*$/gm);
  assert.deepEqual(imports, ["import { isIP } from 'node:net';"]);
  assert.doesNotMatch(source, /\b(?:process|require|eval|spawn|exec|fork|writeFile|install|kill)\s*[.(]/);
  assert.doesNotMatch(source, /\bimport\s*\(/);
});

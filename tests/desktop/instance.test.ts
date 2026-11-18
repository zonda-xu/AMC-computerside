import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { AssistantLock } from '../../apps/desktop/src/instance.ts';

const main = fileURLToPath(new URL('../../apps/desktop/src/main.ts', import.meta.url));
async function waitFor<T>(read: () => T | Promise<T>, check: (value: T) => boolean) {
  const deadline = Date.now() + 18000;
  do {
    const value = await read();
    if (check(value)) return value;
    await delay(60);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for assistant transition');
}

async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amc-start-test-')));
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {
    await Promise.all(cleanups.map(clean => clean()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function launch(args = [main, '--terminal-prompt']) {
    const child = spawn(process.execPath, args, { env: { ...process.env, AMC_DESKTOP_HOME: root, AMC_NO_BROWSER: '1' }, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let log = '';
    child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
    const done = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    cleanups.push(async () => { if (child.exitCode === null && !child.signalCode) child.kill(); await done; });
    return { child, done, has: (value: string) => log.includes(value), prompt: () => waitFor(() => log.includes('[y/N]'), Boolean) };
  }
  async function record(pid?: number) {
    return await waitFor<AssistantLock | undefined>(async () => {
      try { return JSON.parse(await readFile(join(root, 'desktop.lock'), 'utf8')); } catch { return; }
    }, r => !!r?.url && (!pid || r.pid === pid)) as AssistantLock;
  }
  return { root, launch, record };
}
async function request(owner: AssistantLock, route: string, method = 'GET', token = new URL(owner.url).hash.slice(7)) {
  return fetch(new URL(owner.url).origin + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: method === 'POST' ? '{}' : undefined, signal: AbortSignal.timeout(4000) });
}

test('duplicate launches prompt once, cancellation preserves the original, confirmation transfers the profile', { timeout: 50000 }, async t => {
  const f = await setup(t);
  const old = f.launch(), original = await f.record(old.child.pid);
  assert.equal((await request(original, '/v2/instance/close', 'POST', 'invalid')).status, 401);
  const keep = f.launch();
  await keep.prompt();
  const other = f.launch();
  assert.equal(await other.done, 1);
  assert.ok(other.has('另一个启动窗口'));
  keep.child.stdin.end('\n');
  assert.equal(await keep.done, 0);
  assert.deepEqual(await f.record(), original);
  assert.equal((await (await request(original, '/v2/instance')).json()).pid, original.pid);
  const take = f.launch();
  await take.prompt(); take.child.stdin.end('y\n');
  const current = await f.record(take.child.pid);
  assert.equal(await old.done, 0);
  assert.notEqual(current.url, original.url);
  assert.equal((await request(current, '/v2/state')).status, 200);
  assert.equal((await request(current, '/v2/instance/close', 'POST')).status, 200);
  assert.equal(await take.done, 0);
  await assert.rejects(readFile(join(f.root, 'desktop.lock')), { code: 'ENOENT' });
});

test('legacy two-field locks require consent and only the authenticated socket owner is stopped', { timeout: 50000 }, async t => {
  const f = await setup(t);
  const legacy = f.launch(['--input-type=module','-e', [
    "import {createServer} from 'node:http'; import {writeFile,writeFileSync} from 'node:fs'; import {join} from 'node:path';",
    "const root=process.env.AMC_DESKTOP_HOME, token='legacy-fixture-token-for-amc';",
    "const server=createServer((req,res)=>{ if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return;}",
    "if(req.url==='/v2/state'){res.end(JSON.stringify({root,protocolVersion:2,running:false}));return;}",
    "if(req.url==='/v2/stop'){writeFileSync(join(root,'legacy-stopped'),'yes');res.end(JSON.stringify({running:false}));return;}res.writeHead(400).end('{}');});",
    "server.listen(0,'127.0.0.1',()=>{const url='http://127.0.0.1:'+server.address().port+'/#token='+token; writeFile(join(root,'desktop.lock'),JSON.stringify({pid:process.pid,url}),()=>{});});"
  ].join('\n')]);
  const original = await f.record(legacy.child.pid);
  const cancel = f.launch(); await cancel.prompt(); cancel.child.stdin.end('n\n');
  assert.equal(await cancel.done, 0);
  assert.equal((await request(original, '/v2/state')).status, 200);
  await assert.rejects(readFile(join(f.root, 'legacy-stopped')), { code: 'ENOENT' });
  const next = f.launch(); await next.prompt(); next.child.stdin.end('y\n');
  await f.record(next.child.pid); await legacy.done;
  assert.equal(await readFile(join(f.root, 'legacy-stopped'), 'utf8'), 'yes');
});

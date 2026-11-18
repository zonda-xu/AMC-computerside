import { open, readFile, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { isPackagedAssistant, ownsListener } from './instance-owner.ts';
import { confirmReplacement } from './instance-prompt.ts';

export interface AssistantLock { pid: number; url: string }
interface InstanceState { modern: boolean; running: boolean }
const advertisedUrl = /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/#token=[A-Za-z0-9_-]{16,128}$/;
const changed = '确认期间助手发生了变化，请重新启动以选择当前助手。';

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

async function current(path: string): Promise<AssistantLock | undefined> {
  // v1.0.1 creates the file just before its loopback server starts listening.
  for (let attempt = 0; attempt < 20; attempt++) {
    let raw: string;
    try { raw = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const value = JSON.parse(raw);
      if (Number.isSafeInteger(value.pid) && value.pid > 0 && advertisedUrl.test(value.url) && new URL(value.url).port) return value;
    } catch { /* The first writer may still be publishing its address. */ }
    await delay(100);
  }
  throw new Error('旧助手的启动记录不完整，无法确认进程身份。请先退出旧助手，再启动当前版本。');
}

function same(a: AssistantLock, b: AssistantLock) { return a.pid === b.pid && a.url === b.url; }

export async function releaseAssistant(root: string, record: AssistantLock) {
  const path = join(root, 'desktop.lock');
  const latest = await current(path);
  if (latest && same(latest, record)) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

async function call(record: AssistantLock, route: string, method = 'GET', timeout = 3500) {
  const url = new URL(record.url);
  const response = await fetch(url.origin + route, {
    method, headers: { Authorization: 'Bearer ' + url.hash.slice(7), 'Content-Type': 'application/json' },
    body: method === 'POST' ? '{}' : undefined, redirect: 'error', signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error('管理接口未确认请求');
  return response.json();
}

async function inspect(record: AssistantLock, root: string): Promise<InstanceState | undefined> {
  const modern = await call(record, '/v2/instance').catch(() => undefined);
  if (modern?.application === 'amc-desktop' && modern.pid === record.pid && typeof modern.running === 'boolean') return { modern: true, running: modern.running };
  const old = await call(record, '/v2/state', 'GET', 5000).catch(() => undefined);
  if (old?.protocolVersion === 2 && typeof old.running === 'boolean' && typeof old.root === 'string' && await realpath(old.root).catch(() => '') === await realpath(root)) {
    return { modern: false, running: old.running };
  }
}

async function waitForExit(pid: number, timeout: number) {
  const deadline = Date.now() + timeout;
  while (alive(pid) && Date.now() < deadline) await delay(100);
  return !alive(pid);
}

async function replacePrevious(root: string, previous: AssistantLock, before: InstanceState | undefined) {
  const path = join(root, 'desktop.lock');
  const matches = async () => { const latest = await current(path); return !!latest && same(latest, previous); };
  if (!alive(previous.pid)) return false;
  if (!await matches()) throw new Error(changed);
  const state = await inspect(previous, root) ?? before;
  const port = Number(new URL(previous.url).port);
  if (state?.modern) {
    const reply = await call(previous, '/v2/instance/close', 'POST', 6500).catch(() => undefined);
    if (reply?.closing && await waitForExit(previous.pid, 8500)) return reply.running === true;
  }
  if (!alive(previous.pid)) return state?.running === true;
  if (!await matches() || !await ownsListener(previous.pid, port) || (!state && !await isPackagedAssistant(previous.pid))) {
    throw new Error('无法核实旧助手进程与本机管理端口的归属，请退出原启动窗口后重试。');
  }
  // Legacy Windows has no graceful OS signal. Stop its managed gateway first.
  // A frozen assistant's gateway also handles IPC disconnect on parent exit.
  if (!state?.modern) await call(previous, '/v2/stop', 'POST', 6500).catch(() => undefined);
  if (!alive(previous.pid)) return state?.running === true;
  if (!await matches() || !await ownsListener(previous.pid, port)) throw new Error(changed);
  try { process.kill(previous.pid, 'SIGTERM'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  if (!await waitForExit(previous.pid, 5500)) {
    if (!await matches() || !await ownsListener(previous.pid, port)) throw new Error('旧助手仍在退出。请稍候再启动。');
    process.kill(previous.pid, 'SIGKILL');
    if (!await waitForExit(previous.pid, 4000)) throw new Error('旧助手尚未退出，当前助手未接管。');
  }
  return state?.running === true;
}

export async function claimAssistant(root: string, record: AssistantLock, ask = confirmReplacement) {
  // A separate, OS-released SQLite lock serializes launches without holding the
  // session database or blocking the old assistant while the dialog is open.
  const guard = new DatabaseSync(join(root, 'desktop-start.sqlite'));
  const path = join(root, 'desktop.lock');
  try {
    try { guard.exec('BEGIN IMMEDIATE'); }
    catch (error) {
      if ((error as {errcode?:number}).errcode === 5) throw new Error('另一个启动窗口正在处理助手切换，请先完成该窗口的选择。');
      throw error;
    }
    const old = await current(path);
    let restartGateway = false;
    if (old) {
      if (old.pid !== process.pid && alive(old.pid)) {
        const state = await inspect(old, root);
        // A recycled PID without the advertised listener is a stale record.
        const stillPresent = state || await ownsListener(old.pid, Number(new URL(old.url).port)) !== false;
        if (stillPresent) {
          if (!await ask(state?.running)) return { acquired: false, restartGateway: false };
          restartGateway = await replacePrevious(root, old, state);
        }
      }
      await releaseAssistant(root, old);
    }
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record)); } finally { await file.close(); }
    return { acquired: true, restartGateway };
  } finally { guard.close(); }
}

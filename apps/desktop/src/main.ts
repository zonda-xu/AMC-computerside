import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawn } from 'node:child_process';
import { DesktopService } from './service.ts';

function openBrowser(url: string) {
  const command = platform() === 'win32' ? 'rundll32.exe' : platform() === 'darwin' ? 'open' : 'xdg-open';
  const args = platform() === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
  child.on('error', () => console.log('浏览器未自动打开，请复制上方本机地址。')); child.unref();
}
const root = resolve(process.env.AMC_DESKTOP_HOME || join(homedir(), '.ai-maid-cafe', 'desktop'));
await mkdir(root, { recursive: true, mode: 0o700 });
const lockPath = join(root, 'desktop.lock');
try {
  const old = JSON.parse(await readFile(lockPath, 'utf8'));
  let alive = true; try { process.kill(old.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
  if (alive) {
    if (typeof old.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+$/.test(old.url)) { console.log(old.url); if (!process.env.AMC_NO_BROWSER) openBrowser(old.url); process.exit(0); }
    throw new Error('另一份向导正在启动，请稍后重试。');
  }
  await unlink(lockPath);
} catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const lock = await open(lockPath, 'wx', 0o600);
const service = new DesktopService(root), server = service.server();
await new Promise<void>((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveReady); });
const address = server.address(); if (!address || typeof address === 'string') throw new Error('无法打开本机向导。');
service.authority = `127.0.0.1:${address.port}`;
const url = `http://${service.authority}/#token=${service.token}`;
await lock.writeFile(JSON.stringify({ pid: process.pid, url })); await lock.close();
console.log(`AI Maid Café · 电脑连接助手\n${url}\n保留此窗口以维持连接。关闭浏览器页面不会停止网关；Ctrl+C 退出助手。`);
if (!process.env.AMC_NO_BROWSER) openBrowser(url);
let closing = false;
async function close() { if (closing) return; closing = true; await service.stop(); server.close(); await unlink(lockPath).catch(() => {}); process.exit(0); }
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());

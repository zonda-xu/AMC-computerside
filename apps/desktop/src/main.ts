import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawn } from 'node:child_process';
import { DesktopService } from './service.ts';
import { claimAssistant, releaseAssistant, type AssistantLock } from './instance.ts';

function openBrowser(url: string) {
  const command = platform() === 'win32' ? 'rundll32.exe' : platform() === 'darwin' ? 'open' : 'xdg-open';
  const args = platform() === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
  const fallback = () => console.log('浏览器未自动打开，请复制上方本机地址。');
  child.once('error', fallback);
  child.once('exit', code => { if (code) fallback(); });
  child.unref();
}

async function start() {
  const root = resolve(process.env.AMC_DESKTOP_HOME || join(homedir(), '.ai-maid-cafe', 'desktop'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const service = new DesktopService(root);
  let record: AssistantLock | undefined;
  let acquired = false;
  let closing = false;
  const server = service.server(() => void quit());
  async function quit() {
    if (closing) return;
    closing = true;
    // Flush the shutdown reply and let Node drain its HTTP handles on Windows.
    const deadline = setTimeout(() => process.exit(0), 7500);
    deadline.unref();
    try {
      await service.stop();
      if (acquired && record) await releaseAssistant(root, record);
    } finally { server.close(); server.closeIdleConnections(); }
  }
  try {
    await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法打开本机向导。');
    service.authority = '127.0.0.1:' + address.port;
    record = { pid: process.pid, url: 'http://' + service.authority + '/#token=' + service.token };
    const result = await claimAssistant(root, record);
    acquired = result.acquired;
    if (!acquired) { console.log('已保留旧助手，退出本次启动。'); return; }
    process.once('SIGINT', () => void quit()); process.once('SIGTERM', () => void quit());
    if (result.restartGateway) {
      try { await service.start(); }
      catch (error) { service.lastError = (error as Error).message; console.error('新助手已启动，恢复手机网关失败：' + service.lastError); }
    }
    console.log('AI Maid Café · 电脑连接助手\n' + record.url + '\n保留此窗口以维持连接。按 Ctrl+C 退出助手。');
    if (!process.env.AMC_NO_BROWSER) openBrowser(record.url);
  } finally { if (!acquired) server.close(); }
}
await start();

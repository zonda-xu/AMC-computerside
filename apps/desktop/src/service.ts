import { createServer, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import QRCode from 'qrcode';
import { Store, digest } from '../../gateway/src/store.ts';
import { addresses, commands, engines, hostDefaults, opensslCommand, readConfig, saveHost, system, validHostname, type HostConfig, type SetupInput } from './host.ts';
import { probeRuntime } from './host.ts';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
async function body(req: IncomingMessage) {
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { length += chunk.length; if (length > 65536) throw new Error('请求内容过大。'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
export function verifyEndpoint(config: HostConfig, endpoint = config.publicEndpoint) {
  return new Promise<{ ok: boolean; detail: string }>(async resolveResult => {
    try {
      const ca = await readFile(config.caFile);
      const request = httpsRequest(new URL('/v1/hello', endpoint), { ca, timeout: 6000 }, response => {
        let data = ''; response.setEncoding('utf8');
        response.on('data', chunk => { data += chunk; if (data.length > 32768) request.destroy(new Error('响应过大')); });
        response.on('end', () => {
          try { const value = JSON.parse(data); const ok = response.statusCode === 200 && value.hostId === config.hostId && value.data?.hostId === config.hostId;
            resolveResult({ ok, detail: ok ? 'TLS 证书和主机身份校验通过。' : '入口返回了其他主机或无效响应，请检查端口映射。' });
          } catch { resolveResult({ ok: false, detail: '入口没有返回有效的网关信息。' }); }
        });
      });
      request.on('timeout', () => request.destroy(new Error('连接超时')));
      request.on('error', error => resolveResult({ ok: false, detail: `${error.message}。请检查网络、防火墙与中转服务。` }));
      request.end();
    } catch (error) { resolveResult({ ok: false, detail: (error as Error).message }); }
  });
}
export function networkFiles(publicHost: string, secret: string) {
  if (!validHostname(publicHost) || !/^[A-Za-z0-9_-]{43,}$/.test(secret) || secret.length > 256) throw new Error('请填写有效域名与至少 43 位的独立网络密钥（仅字母、数字、下划线和短横线）。');
  const identity = `[network_identity]\nnetwork_name = "agent-console-mesh"\nnetwork_secret = "${secret}"\n`;
  return {
    host: `instance_name = "agent-console-${system.name.toLowerCase()}"\nipv4 = "${system.address}"\ndhcp = false\nlisteners = []\n\n[[peer]]\nuri = "tcp://${publicHost}:12080"\n\n${identity}\n[flags]\nprivate_mode = true\n`,
    relay: `instance_name = "agent-console-easytier-relay"\nlisteners = ["tcp://0.0.0.0:12080"]\n\n${identity}\n[flags]\nno_tun = true\nprivate_mode = true\n\n` + [['10.89.90.3', 18541], ['10.89.90.4', 18542], ['10.89.90.2', 18543]].map(([ip, port]) => `[[port_forward]]\nbind_addr = "0.0.0.0:${port}"\ndst_addr = "${ip}:8899"\nproto = "tcp"\n`).join('\n')
  };
}
export class DesktopService {
  root: string; token = randomBytes(32).toString('base64url'); child?: ChildProcess;
  ready = false; busy = false; lastError = ''; gatewayLog = ''; authority = '';
  pairingHash = '';
  constructor(root: string) { this.root = resolve(root); }
  async config() { return readConfig(this.root); }
  async state() {
    const config = await this.config();
    let devices: unknown[] = [], pairingUsed = false;
    if (config) { const store = new Store(join(config.dataDir, 'console.sqlite')); try { devices = store.devices(); pairingUsed = !!store.db.prepare('SELECT used FROM tickets WHERE hash=? AND used=1').get(this.pairingHash); } finally { store.close(); } }
    return { ...hostDefaults(), home: homedir(), root: this.root, running: this.ready, busy: this.busy, error: this.lastError, devices, pairingUsed,
      config: config ? { name: config.name, hostId: config.hostId, address: config.listen, endpoint: config.publicEndpoint,
        workspace: config.allowedWorkspaceRoots[0], runtimes: config.runtimes,
        fingerprint: new X509Certificate(await readFile(config.caFile)).fingerprint256 } : null };
  }
  async exclusive<T>(fn: () => Promise<T>) {
    if (this.busy) throw new Error('另一个操作正在进行，请稍后重试。');
    this.busy = true; try { return await fn(); } finally { this.busy = false; }
  }
  async save(input: SetupInput) {
    return this.exclusive(async () => {
      if (this.child) throw new Error('请先停止网关，再修改配置。停止会断开手机，请先处理正在进行的任务。');
      await saveHost(this.root, input); return this.state();
    });
  }
  async start() {
    return this.exclusive(async () => {
      if (this.ready) return { running: true };
      if (!await this.config()) throw new Error('请先保存电脑配置。');
      this.lastError = ''; this.gatewayLog = '';
      const child = spawn(process.execPath, [fileURLToPath(new URL('../../gateway/src/main.ts', import.meta.url)), join(this.root, 'host.config.json')], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: process.env
      });
      this.child = child;
      child.stdout?.resume();
      child.stderr?.on('data', data => { this.gatewayLog = (this.gatewayLog + data.toString()).slice(-4000); });
      child.on('exit', code => {
        if (this.child === child) { this.ready = false; this.child = undefined;
          if (code) this.lastError = '网关退出。请检查 IP、8899 / 8898 端口占用，或是否有另一份网关正在运行。'; }
      });
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('网关启动超时，请检查本机网络。')); }, 15000);
        child.once('error', () => { clearTimeout(timer); reject(new Error('无法启动网关进程。')); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error(this.lastError || '网关启动失败。请检查 IP 和端口占用。')); });
        child.on('message', message => { if ((message as { type?: string }).type === 'ready') { clearTimeout(timer); this.ready = true; resolveReady(); } });
      });
      return { running: this.ready };
    });
  }
  async stop() {
    const child = this.child; if (!child) return;
    await new Promise<void>(resolveStopped => {
      const timer = setTimeout(() => { child.kill(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolveStopped(); });
      if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
    });
  }
  async pair() {
    if (!this.ready) throw new Error('请先启动网关，再生成二维码。');
    const config = (await this.config())!;
    const caPem = await readFile(config.caFile, 'utf8');
    const store = new Store(join(config.dataDir, 'console.sqlite'));
    try {
      // Refresh invalidates every unredeemed QR from this host.
      store.db.prepare('DELETE FROM tickets WHERE used=0').run();
      const { token, expiresAt } = store.ticket();
      this.pairingHash = digest(token);
      const ticket = { type: 'ai-maid-cafe/pair', protocolVersion: 1, hostId: config.hostId, name: config.name, os: config.os,
        endpoint: config.publicEndpoint, caPem, ticket: token, expiresAt };
      return { ticket, qr: await QRCode.toDataURL(JSON.stringify(ticket), { errorCorrectionLevel: 'L', width: 1000, margin: 4 }) };
    } finally { store.close(); }
  }
  async revoke(id: string) {
    const config = await this.config(); if (!config) throw new Error('尚未配置电脑。');
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('设备标识无效。');
    const store = new Store(join(config.dataDir, 'console.sqlite'));
    try { store.revoke(id); } finally { store.close(); }
    this.child?.send({ type: 'revoke', id });
    return { revoked: true };
  }
  async api(path: string, method: string, input: any) {
    if (path === '/api/state' && method === 'GET') return this.state();
    if (method !== 'POST') throw new Error('不支持的请求。');
    switch (path) {
      case '/api/check': {
        let openssl = ''; try { openssl = await opensslCommand(); } catch { /* Return an actionable missing dependency. */ }
        return { node: process.versions.node, openssl, addresses: addresses(), commands };
      }
      case '/api/probe': return probeRuntime(input.engine, input.command);
      case '/api/save': return this.save(input);
      case '/api/start': return this.start();
      case '/api/stop': return this.exclusive(async () => { await this.stop(); return { running: false }; });
      case '/api/pair': return this.pair();
      case '/api/revoke': return this.revoke(input.id);
      case '/api/verify': { const config = await this.config(); if (!config || !this.ready) throw new Error('请先启动网关。'); return verifyEndpoint(config); }
      case '/api/network': return networkFiles(input.publicHost, input.secret || randomBytes(32).toString('base64url'));
      case '/api/folders': {
        const path = resolve(typeof input.path === 'string' ? input.path : homedir());
        if (!(await stat(path)).isDirectory()) throw new Error('该路径不是目录。');
        const entries = await readdir(path, { withFileTypes: true });
        return { path, parent: dirname(path), entries: entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => ({ name: e.name, path: join(path, e.name) })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 500) };
      }
      default: throw new Error('接口不存在。');
    }
  }
  server() {
    return createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      if (req.headers.host !== this.authority || (req.headers.origin && req.headers.origin !== `http://${this.authority}`)) { res.writeHead(403).end(); return; }
      const path = new URL(req.url || '/', `http://${this.authority}`).pathname;
      if (path.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (req.headers.authorization !== `Bearer ${this.token}`) { res.writeHead(401).end(JSON.stringify({ error: '请从本机启动入口重新打开向导。' })); return; }
        try {
          if (req.method !== 'GET' && req.headers['content-type'] !== 'application/json') throw new Error('仅接受 JSON 请求。');
          const result = await this.api(path, req.method || '', req.method === 'POST' ? await body(req) : {});
          res.end(JSON.stringify(result));
        } catch (error) { res.writeHead(400).end(JSON.stringify({ error: (error as Error).message })); }
        return;
      }
      const assets: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const asset = assets[path]; if (!asset || req.method !== 'GET') { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', asset[1] + '; charset=utf-8');
      try { res.end(await readFile(join(publicDir, asset[0]))); } catch { res.writeHead(500).end('界面文件缺失，请重新解压完整电脑端分发包。'); }
    });
  }
}

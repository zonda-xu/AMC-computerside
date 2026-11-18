import { spawn } from 'node:child_process';
import { devEcoEndpoint, isDevEco } from '../../../packages/adapters/opencode/deveco-service.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createServer } from 'node:net';
import { nativeCommand, readCliVersion } from '../../../packages/adapters/common/command.ts';
import { nativeEnvironment } from '../../../packages/adapters/common/rpc.ts';
import { checkRuntimePolicy, type RuntimeConfig } from '../../../packages/adapters/common/base.ts';
import { loadNativeModule } from '../../../packages/adapters/common/native-module.ts';
import { WebSocketRpc } from '../../../packages/adapters/common/ws-rpc.ts';
import { initializeCodex } from '../../../packages/adapters/codex/protocol.ts';

export const codexEndpoint = 'ws://127.0.0.1:8897';
// Reference releases for consumers of the desktop API. Connection decisions use the native protocol.
export const runtimeVersions = { codex: 'codex-cli 0.169.0', opencode: '2.3.0', claudeSDK: '0.3.325', claudeCLI: '2.1.325' };
export type ManagedEngine = 'codex' | 'opencode';
export interface ManagedRuntimeConfig extends RuntimeConfig { serviceRegistrationFile?: string }
export interface RuntimeRegistration {
  engine: ManagedEngine; runtimeInstanceId: string; generation: number; endpoint: string;
  version: string; pid?: number; identity: string; launchScope?: string;
}
export interface RuntimeStatus {
  engine: ManagedEngine; state: 'connected' | 'unavailable' | 'disabled';
  runtimeInstanceId?: string; generation?: number; endpoint?: string; version?: string; detail: string;
}
export interface ServiceEndpoint { url: string; [key: string]: unknown }
export interface OpenCodeService {
  discover(): Promise<ServiceEndpoint | undefined>;
  ensure(): Promise<ServiceEndpoint>;
  headers(endpoint: ServiceEndpoint): Record<string, string>;
}
export interface RuntimeHooks {
  service?: () => Promise<OpenCodeService>;
  version?: (engine: ManagedEngine, config: ManagedRuntimeConfig) => Promise<string>;
  codexHandshake?: (endpoint: string, expectedHome?: string) => Promise<void>;
  launchCodex?: (config: ManagedRuntimeConfig) => Promise<number>;
}
function localEndpoint(value: string, protocol: 'http:' | 'ws:') {
  const url = new URL(value);
  if (url.protocol !== protocol || url.hostname !== '127.0.0.1' || url.username || url.password || url.hash || url.search || url.pathname !== '/') throw new Error('Runtime endpoint must be a loopback service root');
  return value;
}
async function version(engine: ManagedEngine, config: ManagedRuntimeConfig) {
  try { return await readCliVersion(engine, nativeCommand(config.command), nativeEnvironment(engine, config.env)); }
  catch (error) {
    if (engine === 'opencode' && config.compatibilityMode !== 'pinned') return 'unknown';
    throw error;
  }
}
export async function codexHandshake(endpoint: string, expectedHome?: string): Promise<void> {
  const rpc = new WebSocketRpc(localEndpoint(endpoint, 'ws:'));
  try { await initializeCodex(rpc, expectedHome); } finally { rpc.close(); }
}
function codexLaunchScope(config: ManagedRuntimeConfig) {
  const env = nativeEnvironment('codex', config.env);
  return createHash('sha256').update(JSON.stringify([config.command.trim(), env.CODEX_HOME || '', env.USERPROFILE || env.HOME || ''])).digest('hex');
}
function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid registered runtime PID');
  try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function launchCodex(config: ManagedRuntimeConfig) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', () => reject(new Error('Codex port 127.0.0.1:8897 is occupied; no process was replaced'))); server.listen(8897, '127.0.0.1', resolve); });
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const native = nativeCommand(config.command);
  const child = spawn(native.command, [...native.args, 'app-server', '--listen', codexEndpoint], { env: nativeEnvironment('codex', config.env), detached: true, windowsHide: true, stdio: 'ignore' });
  const pid = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('spawn', () => resolve(child.pid!)); });
  child.unref();
  return pid;
}
export class RuntimeManager {
  readonly root: string;
  readonly hooks: RuntimeHooks;
  constructor(root: string, hooks: RuntimeHooks = {}) { this.root = root; this.hooks = hooks; }
  private async service(config: ManagedRuntimeConfig) {
    if (this.hooks.service) return this.hooks.service();
    const module = await loadNativeModule(config.serviceModule || '@opencode/client/service', '@opencode/client');
    const service = module.Service as OpenCodeService;
    if (typeof service?.discover !== 'function' || typeof service.headers !== 'function') throw new Error('OpenCode client 缺少 Service.discover 或 Service.headers');
    return service;
  }
  async registration(engine: ManagedEngine): Promise<RuntimeRegistration | undefined> {
    try {
      const record = JSON.parse(await readFile(join(this.root, `${engine}.runtime.json`), 'utf8')) as RuntimeRegistration;
      if (record.engine !== engine || !record.runtimeInstanceId || !Number.isSafeInteger(record.generation) || record.generation < 1 || !record.identity || !record.version) throw new Error('Invalid runtime registration');
      localEndpoint(record.endpoint, engine === 'codex' ? 'ws:' : 'http:');
      if (engine === 'codex' && (record.endpoint !== codexEndpoint || !record.pid)) throw new Error('Invalid shared Codex registration');
      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  private async connection(engine: ManagedEngine, config: ManagedRuntimeConfig) {
    if (config.enabled === false) throw new Error('Runtime disabled');
    const previous = await this.registration(engine);
    if (engine === 'codex') {
      if (!previous || !alive(previous.pid!)) throw new Error('Registered shared Codex runtime is unavailable; use explicit host startup');
      checkRuntimePolicy(config, previous.version);
      if (previous.launchScope && previous.launchScope !== codexLaunchScope(config)) throw new Error('Codex 已登记进程的启动程序或会话目录与所选配置不同');
      await (this.hooks.codexHandshake || codexHandshake)(previous.endpoint, nativeEnvironment(engine, config.env).CODEX_HOME);
      return { version: previous.version, endpoint: previous.endpoint, identity: previous.identity, pid: previous.pid, headers: {} as Record<string, string> };
    }
    const actualVersion = await (this.hooks.version || version)(engine, config);
    checkRuntimePolicy(config, actualVersion);
    if(engine==='opencode'&&isDevEco(config.command)){
      const peer=await devEcoEndpoint(this.root,config);
      return {version:actualVersion,endpoint:peer.url,identity:peer.identity,pid:peer.pid,headers:peer.headers};
    }
    const service = await this.service(config);
    const endpoint = await service.discover();
    if (!endpoint) throw new Error('OpenCode discovery returned no compatible service; registration/PID must be inspected before explicit startup');
    localEndpoint(endpoint.url, 'http:');
    const headers = service.headers(endpoint);
    const identity = createHash('sha256').update(JSON.stringify([endpoint.url, endpoint.pid ?? null, Object.entries(headers).sort()])).digest('hex');
    return { version: actualVersion, endpoint: endpoint.url, identity, headers };
  }
  async probe(engine: ManagedEngine, config: ManagedRuntimeConfig): Promise<RuntimeStatus> {
    if (config.enabled === false) return { engine, state: 'disabled', detail: 'Runtime disabled' };
    try {
      const connection = await this.connection(engine, config), previous = await this.registration(engine);
      const same = previous?.identity === connection.identity;
      return { engine, state: same ? 'connected' : 'unavailable', endpoint: connection.endpoint, version: connection.version, ...(same ? { runtimeInstanceId: previous.runtimeInstanceId, generation: previous.generation } : {}), detail: same ? 'Connected to registered native runtime; authentication/model readiness remains adapter-verified' : 'Discovered service is not registered; explicit host registration required' };
    } catch (error) { return { engine, state: 'unavailable', detail: (error as Error).message }; }
  }
  async start(engine: ManagedEngine, config: ManagedRuntimeConfig): Promise<RuntimeRegistration> {
    if (config.enabled === false) throw new Error('Runtime disabled');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lockPath = join(this.root, `${engine}.runtime.lock`), lock = await open(lockPath, 'wx', 0o600);
    try {
      const previous = await this.registration(engine);
      if (engine === 'codex' && previous && alive(previous.pid!)) {
        await this.connection(engine, config);
        return previous;
      }
      const actual = await (this.hooks.version || version)(engine, config);
      checkRuntimePolicy(config, actual);
      if (engine === 'codex') {
        const pid = await (this.hooks.launchCodex || launchCodex)(config);
        await this.persist({ engine, runtimeInstanceId: randomUUID(), generation: (previous?.generation || 0) + 1, endpoint: codexEndpoint, version: actual, pid, identity: randomUUID(), launchScope:codexLaunchScope(config) });
        let error: unknown;
        for (let attempt = 0; attempt < 20; attempt++) {
          try { await (this.hooks.codexHandshake || codexHandshake)(codexEndpoint); error = undefined; break; } catch (failure) { error = failure; await new Promise(resolve => setTimeout(resolve, 100)); }
        }
        if (error) throw new Error(`Codex PID ${pid} 共享接口握手失败（${(error as Error).message}）。请检查 app-server --listen 是否可用。`);
      }
      if(engine==='opencode'&&isDevEco(config.command))await devEcoEndpoint(this.root,config,true);
      else if (engine === 'opencode') {
        const service = await this.service(config);
        if (!await service.discover()) {
          if (previous) throw new Error('Previously registered OpenCode runtime is unavailable; inspect its PID/version, no replacement permitted');
          if (!config.serviceRegistrationFile || !isAbsolute(config.serviceRegistrationFile)) throw new Error('OpenCode registration location is required before ensure; absence of discovery is not proof of absence');
          try { await readFile(config.serviceRegistrationFile); throw new Error('OpenCode registration exists but discovery failed; inspect its PID/version, no replacement permitted'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (config.command !== 'opencode') throw new Error('Service.ensure starts the default opencode executable; start the configured custom service before registration');
          if (typeof service.ensure !== 'function') throw new Error('OpenCode client 缺少 Service.ensure，请先启动官方服务再登记');
          await service.ensure();
        }
      }
      const connection = await this.connection(engine, config);
      const current = await this.registration(engine);
      const devEco=engine==='opencode'&&isDevEco(config.command);
      const same=current?.identity===connection.identity;
      if(same && (!devEco || current.endpoint===connection.endpoint && current.version===actual && current.pid===connection.pid))return current;
      const record: RuntimeRegistration = { engine, runtimeInstanceId: same?current!.runtimeInstanceId:randomUUID(), generation: (current?.generation || 0) + 1, endpoint: connection.endpoint, version: actual, identity: connection.identity, ...(devEco?{pid:connection.pid}:{}) };
      await this.persist(record);
      return record;
    } finally { await lock.close(); await unlink(lockPath); }
  }
  async connect(engine: ManagedEngine, config: ManagedRuntimeConfig) {
    const connection = await this.connection(engine, config), record = await this.registration(engine);
    if (!record || record.identity !== connection.identity) throw new Error('Runtime identity changed; explicit host registration required');
    return { ...record, version: connection.version, headers: connection.headers };
  }
  private async persist(record: RuntimeRegistration) {
    const temporary = join(this.root, `${record.engine}-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(this.root, `${record.engine}.runtime.json`));
  }
}

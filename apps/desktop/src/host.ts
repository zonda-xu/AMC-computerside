import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { hostname, homedir, networkInterfaces, platform } from 'node:os';
import { isIP } from 'node:net';
import { nativeCommand, readCliVersion, supportsCodexListen } from '../../../packages/adapters/common/command.ts';
import { checkRuntimePolicy } from '../../../packages/adapters/common/base.ts';
import { isDevEco } from '../../../packages/adapters/opencode/deveco-service.ts';
import { nativeEnvironment } from '../../../packages/adapters/common/rpc.ts';
import type { EngineId } from '../../../packages/protocol/src/types.ts';
import type { ProjectPolicy } from '../../gateway/src/native-projects.ts';
import { automationSettings, type AutomationConfig } from '../../gateway/src/automation.ts';
import { codexEndpoint, type ManagedRuntimeConfig } from './runtime.ts';
import type { HuaweiPushConfig } from '../../gateway/src/huawei-push.ts';
import type { RuntimeUpdateConfig } from '../../gateway/src/runtime-updates.ts';

export const engines: EngineId[] = ['codex', 'claude-code', 'opencode', 'deepseek-harness'];
export const commands = { codex: 'codex', 'claude-code': 'claude', opencode: 'opencode', 'deepseek-harness': 'dsh' };
export const systems = {
  win32: { name: 'Windows', address: '10.89.90.2', publicPort: 18543 },
  darwin: { name: 'macOS', address: '10.89.90.3', publicPort: 18541 },
  linux: { name: 'Linux', address: '10.89.90.4', publicPort: 18542 }
};
export const system = systems[platform() as keyof typeof systems] || systems.linux;
export interface HostConfig {
  hostId: string; name: string; os: string; listen: string; port: number; publicEndpoint: string;
  dataDir: string; caFile: string; certFile: string; keyFile: string;
  projectPolicy?: ProjectPolicy;
  allowedWorkspaceRoots: string[]; runtimes: Record<EngineId, ManagedRuntimeConfig>;
  automation?: AutomationConfig;
  push?: HuaweiPushConfig;
  runtimeUpdates?: RuntimeUpdateConfig;
}
export interface SetupInput {
  name: string; mode: 'lan' | 'relay'; address: string; publicHost?: string;
  workspace?: string; projectPolicy?: ProjectPolicy; runtimes: Partial<Record<EngineId, { command: string; enabled: boolean }>>;
  automation?: AutomationConfig;
}
const run = promisify(execFile);
export function addresses() {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries || []).filter(a => a.family === 'IPv4' && !a.internal && privateIPv4(a.address))
      .map(a => ({ name, address: a.address })));
}
export function privateIPv4(value: string) {
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function validHostname(value: string) {
  return value.length <= 253 && !isIP(value) && value.split('.').every(s => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(s));
}
export async function opensslCommand() {
  const candidates = ['openssl', ...(platform() === 'win32' ? [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenSSL-Win64', 'bin', 'openssl.exe')
  ] : ['/opt/homebrew/bin/openssl', '/opt/homebrew/opt/openssl@3/bin/openssl', '/usr/local/opt/openssl@3/bin/openssl', '/usr/local/bin/openssl', '/usr/bin/openssl'])];
  for (const command of candidates) {
    try { await run(command, ['version'], { timeout: 5000, windowsHide: true }); return command; } catch { /* Try the next local installation. */ }
  }
  throw new Error('未找到 OpenSSL。请按“准备环境”的系统说明安装，再重新检测。');
}
export async function probeRuntime(engine: EngineId, command: string) {
  if (!engines.includes(engine) || typeof command !== 'string' || !command.trim() || command.length > 4096 || /[\r\n\0]/.test(command)) throw new Error('请选择有效的 AI 程序路径。');
  try {
    let native = nativeCommand(command.trim());
    const environment = nativeEnvironment(engine);
    // The official Windows desktop bundle exposes its CLI through Electron's
    // Node mode; launching the GUI with --version does not probe that runtime.
    if (engine === 'deepseek-harness' && platform() === 'win32' && basename(command.trim()).toLowerCase() === 'deepseek harness.exe') {
      const resources = join(dirname(command.trim()), 'resources');
      await access(join(resources, 'app.asar'));
      await access(join(resources, 'runtime', 'cli', 'bin', 'dsh.cmd'));
      native = { command: command.trim(), args: ['--expose-internals', join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')] };
      environment.ELECTRON_RUN_AS_NODE = '1';
    }
    const version = await readCliVersion(engine, native, environment);
    let detail = '已读取版本；请先在电脑完成官方登录，手机首次任务仍需验证。';
    if (engine === 'codex') detail = await supportsCodexListen(native, environment).catch(() => false)
      ? '已检测到 app-server --listen。保存后可启动或登记共享运行时，助手将验证实际连接。'
      : '该程序的帮助未列出 app-server --listen。启动共享运行时可检查实际握手结果。';
    if (engine === 'opencode') detail = isDevEco(command)
      ? '已找到 DevEco Code。启动运行时后，可在手机 OpenCode 分区查看本机项目的会话并继续点单。'
      : '已找到程序。登记时将发现本机服务，连接后检查会话接口与事件流。';
    if (engine === 'deepseek-harness') detail = 'CLI 版本不代表控制能力；以同宿主 bridge/controller 握手及实际能力为准。';
    return { engine, command: command.trim(), installed: true, version, detail };
  } catch {
    return { engine, command: command.trim(), installed: false, version: '', detail: '无法运行此程序的 --version。请检查安装、路径或执行权限，再重新检测。' };
  }
}
export async function readConfig(root: string): Promise<HostConfig | undefined> {
  try { return JSON.parse(await readFile(join(root, 'host.config.json'), 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
}
export const defaultCreationRoot = () => join(homedir(), 'AMC Projects');
export async function normalizePolicy(input: ProjectPolicy, runtimes: SetupInput['runtimes'], previous?: ProjectPolicy): Promise<ProjectPolicy> {
  if (!input || !Array.isArray(input.syncEngines) || input.syncEngines.some(id => !engines.includes(id))) throw new Error('请选择有效的同步平台。');
  function paths(value: unknown) {
    if (!Array.isArray(value) || value.length > 2048 || !value.every(p => typeof p === 'string' && p.length <= 4096 && isAbsolute(p))) throw new Error('项目应使用电脑上的绝对目录路径。');
    return [...new Set(value as string[])];
  }
  const destination = input.creationRoot || defaultCreationRoot();
  if (!isAbsolute(destination)) throw new Error('新项目保存位置需要绝对路径。');
  const manualProjects = await Promise.all(paths(input.manualProjects).map(async p => {
    if (previous?.manualProjects.includes(p)) return p;
    if (!(await stat(p)).isDirectory()) throw new Error('选择的项目不是目录。');
    return realpath(p);
  }));
  const excludedProjects = paths(input.excludedProjects);
  if (destination === defaultCreationRoot()) await mkdir(destination, {recursive:true,mode:0o700});
  if (!(await stat(destination)).isDirectory()) throw new Error('请选择有效的新项目保存位置。');
  return { creationRoot:await realpath(destination), manualProjects:[...new Set(manualProjects)], excludedProjects,
    syncEngines:[...new Set(input.syncEngines.filter(id => runtimes[id]?.enabled))] };
}
export async function validateInput(input: SetupInput, available = addresses()) {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw new Error('电脑名称需为 1–100 个字符。');
  if (!['lan', 'relay'].includes(input.mode)) throw new Error('请选择连接方式。');
  if (!privateIPv4(input.address) || !available.some(a => a.address === input.address)) throw new Error('此 IP 尚未出现在本机网卡上。请连接 Wi-Fi 或启动 EasyTier 后重新检测。');
  if (input.mode === 'relay' && (input.address !== system.address || !validHostname(input.publicHost || ''))) throw new Error(`中转模式需要本机 ${system.address} 地址和有效的中转域名（不含 https:// 或端口）。`);
  if (!input.projectPolicy && (typeof input.workspace !== 'string' || !isAbsolute(input.workspace) || !(await stat(input.workspace)).isDirectory())) throw new Error('请选择已存在的项目目录，并使用绝对路径。');
  if (!input.runtimes || !engines.some(id => input.runtimes[id]?.enabled)) throw new Error('至少启用一个已经安装并登录的 AI 程序。');
  return input.projectPolicy ? undefined : realpath(input.workspace!);
}
export async function saveHost(root: string, input: SetupInput) {
  const workspace = await validateInput(input);
  if (input.automation !== undefined) automationSettings(input.automation);
  const ssl = await opensslCommand();
  const previous = await readConfig(root);
  const projectPolicy = input.projectPolicy ? await normalizePolicy(input.projectPolicy,input.runtimes,previous?.projectPolicy) : previous?.projectPolicy;
  const enabled = await Promise.all(engines.filter(id => input.runtimes[id]?.enabled).map(async id => {
    const result = await probeRuntime(id, input.runtimes[id]!.command);
    if (!result.installed) throw new Error(`${id}：${result.detail}`);
    const prior = previous?.runtimes[id];
    if (prior?.compatibilityMode === 'pinned') checkRuntimePolicy({ ...prior, enabled: true }, result.version);
    return result;
  }));
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Each save creates a fresh certificate directory; failed saves never replace the active identity.
  const versionDir = join(root, 'certificates', randomUUID());
  await mkdir(versionDir, { recursive: true, mode: 0o700 });
  const hostId = previous?.hostId || randomUUID();
  const caFile = previous?.caFile || join(versionDir, 'host-ca.pem');
  const caKey = previous ? join(previous.caFile, '..', 'host-ca.key') : join(versionDir, 'host-ca.key');
  const certFile = join(versionDir, 'gateway.pem'), keyFile = join(versionDir, 'gateway.key');
  const sslRun = (args: string[]) => run(ssl, args, { timeout: 30000, windowsHide: true });
  if (!previous) await sslRun(['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes', '-days', '3650', '-keyout', caKey, '-out', caFile, '-subj', `/CN=AI-Maid-Cafe-${hostId}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  const target = input.mode === 'relay' ? input.publicHost! : input.address;
  const csr = join(versionDir, 'gateway.csr'), ext = join(versionDir, 'server.ext');
  await sslRun(['req', '-newkey', 'rsa:3072', '-nodes', '-keyout', keyFile, '-out', csr, '-subj', `/CN=${target}`]);
  await writeFile(ext, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${input.address}${input.mode === 'relay' ? `,DNS:${target}` : ''}\n`, { mode: 0o600 });
  await sslRun(['x509', '-req', '-in', csr, '-CA', caFile, '-CAkey', caKey, '-set_serial', '0x' + randomBytes(16).toString('hex'), '-out', certFile, '-days', '365', '-sha256', '-extfile', ext]);
  await chmod(caKey, 0o600); await chmod(keyFile, 0o600);
  const bridgeTokenFile = previous?.runtimes['deepseek-harness'].bridgeTokenFile || join(root, 'dsh-bridge.secret');
  try { await access(bridgeTokenFile); } catch { await writeFile(bridgeTokenFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
  const runtimes = Object.fromEntries(engines.map(id => {
    const result = enabled.find(r => r.engine === id);
    const prior = previous?.runtimes[id];
    return [id, { ...prior, command: result?.command || prior?.command || commands[id], compatibilityMode: prior?.compatibilityMode ?? 'latest-compatible',
      expectedVersion: prior?.compatibilityMode === 'pinned' ? prior.expectedVersion : result?.version || prior?.expectedVersion || 'DISABLED', enabled: !!result,
      models: previous?.runtimes[id]?.models || [], ...(id === 'codex' ? { endpoint: codexEndpoint } : {}), ...(id === 'deepseek-harness' ? { bridgeTokenFile } : {}) }];
  })) as Record<EngineId, ManagedRuntimeConfig>;
  const config: HostConfig = { ...previous, hostId, name: input.name.trim(), os: platform(), listen: input.address, port: 8899,
    publicEndpoint: `https://${target}:${input.mode === 'relay' ? system.publicPort : 8899}`, dataDir: previous?.dataDir ?? root,
    caFile, certFile, keyFile, allowedWorkspaceRoots: workspace ? [workspace] : previous?.allowedWorkspaceRoots ?? [], projectPolicy, runtimes, automation: automationSettings(input.automation ?? previous?.automation),runtimeUpdates:previous?.runtimeUpdates??{enabled:true} };
  await writeConfig(root, config);
  return config;
}
export async function writeConfig(root:string, config:HostConfig) {
  const temporary = join(root, `config-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(root, 'host.config.json'));
}
export function hostDefaults() { return { name: hostname(), system, platform: platform(), addresses: addresses() }; }

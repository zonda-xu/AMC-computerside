import { cp, mkdir, readFile, readdir, writeFile, chmod, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { inspectDependencyClosure, inspectOfflineReadiness } from './check-offline-readiness.mjs';

export async function packageDesktop(options = {}) {
const project = resolve(options.project ?? fileURLToPath(new URL('../', import.meta.url)));
const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(options.out ?? join(project, 'dist', 'desktop', stamp));
const platforms = options.platforms ?? [['Windows', 'Start-Windows.cmd', 'win32'], ['macOS', 'Start-macOS.command', 'darwin'], ['Linux', 'Start-Linux.sh', 'linux']];
const reports = new Map();
for (const [os, , platform] of platforms) {
  const report = options.offline ? await inspectOfflineReadiness(project, { platform, arch: options.arch ?? process.arch }) : await inspectDependencyClosure(project, { platform, arch: options.arch ?? process.arch });
  if (!report.ready) throw new Error(`BLOCKED ${os}: ${JSON.stringify(report.checks.filter(check => check.status !== 'ready'))}`);
  reports.set(os, report.closure ?? report);
}
await mkdir(dirname(out), { recursive: true });
await mkdir(out);
// Zip writer records Unix permissions so macOS/Linux launchers remain executable.
const table = Array.from({ length: 256 }, (_, i) => { let value = i; for (let n = 0; n < 8; n++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
async function files(root, prefix = '') {
  const result = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + item.name : item.name;
    if (item.isSymbolicLink()) throw new Error('Do not package symbolic links: ' + relative);
    if (item.isDirectory()) result.push(...await files(root, relative)); else result.push(relative);
  }
  return result.sort();
}
async function zip(root, target, packageName, executable) {
  const chunks = [], central = []; let offset = 0;
  for (const file of await files(root)) {
    const name = Buffer.from(packageName + '/' + file), bytes = await readFile(join(root, file)), compressed = deflateRawSync(bytes), crc = crc32(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    const mode = file === executable || (await stat(join(root, file))).mode & 0o111 ? 0o100755 : 0o100644;
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(33, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE((mode * 65536) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    chunks.push(local, name, compressed); central.push(entry, name); offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...chunks, directory, end]); await writeFile(target, bytes);
  return { name: target.split(/[\\/]/).at(-1), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const artifacts = [];
for (const [os, launcher] of platforms) {
  const closure = reports.get(os);
  const name = `AI-Maid-Cafe-${os}`, folder = join(out, name); await mkdir(folder);
  // Explicit allowlist: no HarmonyOS, artwork, user config, keys, database or build caches.
  for (const source of ['apps/desktop/src', 'apps/desktop/public', 'apps/gateway/src', 'packages/adapters', 'packages/protocol', 'plugins/dsh-bridge']) {
    await mkdir(dirname(join(folder, source)), { recursive: true }); await cp(join(project, source), join(folder, source), { recursive: true });
  }
  for (const dependency of closure.inventory) {
    const source = join(project, dependency.path), target = join(folder, dependency.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, filter: path => path === source || !path.slice(source.length + 1).split(/[\\/]/).includes('node_modules') });
  }
  await cp(join(project, 'package-lock.json'), join(folder, 'package-lock.json'));
  await mkdir(join(folder, 'scripts'));
  await cp(join(project, 'scripts/check-offline-readiness.mjs'), join(folder, 'scripts/check-offline-readiness.mjs'));
  await cp(join(project, 'apps/desktop/launchers', launcher), join(folder, launcher));
  await cp(join(project, 'apps/desktop/launchers/launch.mjs'), join(folder, 'launch.mjs'));
  if (os !== 'Windows') await chmod(join(folder, launcher), 0o755);
  await writeFile(join(folder, '使用说明.md'), '# 电脑连接助手\n\n参见 [使用说明](docs/DESKTOP_GUIDE.md) 与 [四平台离线部署](docs/FOUR_PLATFORM_OFFLINE.md)。\n');
  await mkdir(join(folder, 'docs'));
  for (const doc of ['DESKTOP_GUIDE.md', 'automatic-sync-and-push.md', 'workspace-identity-confirmation.md', 'HOST_SETUP.md', 'DSH_INTEGRATION_2026-11-17.md', 'FOUR_PLATFORM_OFFLINE.md', 'HARMONY_PUSH_V3.md', 'FOUR_PLATFORM_IMPLEMENTATION_REPORT_2026-11-16.md']) await cp(join(project, 'docs', doc), join(folder, 'docs', doc));
  await cp(join(project, 'AI_Maid_Cafe_Four_Platform_Offline_Development_Plan_2026-11-16.md'), join(folder, 'AI_Maid_Cafe_Four_Platform_Offline_Development_Plan_2026-11-16.md'));
  await cp(join(project, 'apps/desktop/RUNTIME_HANDOFF.md'), join(folder, 'docs/RUNTIME_HANDOFF.md'));
  await cp(join(project, 'apps/desktop/RUNTIME_HANDOFF.md'), join(folder, 'apps/desktop/RUNTIME_HANDOFF.md'));
  await mkdir(join(folder, 'tests/fixtures'), { recursive: true });
  await cp(join(project, 'tests/fixtures/four-platform'), join(folder, 'tests/fixtures/four-platform'), { recursive: true });
  await mkdir(join(folder, 'tests/e2e'), { recursive: true });
  await cp(join(project, 'tests/e2e/FOUR_PLATFORM_ACCEPTANCE.md'), join(folder, 'tests/e2e/FOUR_PLATFORM_ACCEPTANCE.md'));
  await writeFile(join(folder, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: 'module', engines: manifest.engines, scripts: { start: 'node launch.mjs', pair: 'node apps/gateway/src/pair-cli.ts', gateway: 'node apps/gateway/src/main.ts', 'check:offline': 'node scripts/check-offline-readiness.mjs' }, dependencies: manifest.dependencies }, null, 2));
  await writeFile(join(folder, 'START-HERE.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${os} · 电脑连接助手</title><style>body{font:16px/1.8 system-ui,sans-serif;color:#1c2941;background:#f1f4fa;max-width:760px;margin:60px auto;padding:24px}h1{font-size:30px}li{margin:18px 0}code{overflow-wrap:anywhere}a{color:#2c57a8}</style><h1>${os} 电脑连接助手</h1><p>本包仅包含电脑端工具。不需要复制 HarmonyOS 项目，也不需要运行 npm install。</p><ol><li>解压整个文件夹。不要直接在压缩包内运行。</li><li>安装 <a href="https://nodejs.org/en/download/archive/v24.18.0">Node.js 24.13+（24.x）</a> 和 OpenSSL。Windows 可安装 Git for Windows；macOS 可使用 Homebrew；Linux 使用发行版软件包。</li><li>${os === 'Windows' ? '双击' : os === 'macOS' ? '打开' : '在文件管理器选择“在终端运行”，或执行'} <code>${launcher}</code>。${os !== 'Windows' ? `若提示权限不足，在该文件夹的终端执行 <code>chmod +x ${launcher}</code>，再运行 <code>./${launcher}</code>。` : ''}</li><li>已有助手运行时，请在弹窗选择关闭旧助手并启动当前版本，或保留旧助手并退出。浏览器会在当前版本启动后打开本机向导。安装好 AI 程序并完成官方登录后，在向导中选择项目目录。</li><li>在手机 AI Maid Café 的“添加主机”中扫描二维码。保留助手启动窗口，让手机持续访问电脑。</li></ol><p>如果浏览器没有自动打开，请复制启动窗口显示的 127.0.0.1 地址。此地址仅用于本机管理，请勿分享。配对二维码由向导生成。</p><p>数据保存在当前用户目录的 <code>.ai-maid-cafe/desktop</code>，再次启动会沿用同一电脑身份。远程中转步骤和排查说明见包内“使用说明.md”。</p><p>本包依赖 Node.js 与 OpenSSL 的本机安装，支持系统上对应的 x64 / ARM64 Node.js。未经本机运行验收的系统不应视作已验证。</p></html>`);
  const inventory = await files(folder);
  if (inventory.some(path => !path.startsWith('node_modules/') && /(?:^|\/)(?:harmony|assets|data|output|\.git)(?:\/|$)|\.(?:pem|key|sqlite|secret)$|host\.config\.json/.test(path))) throw new Error('Sensitive or non-host file entered package');
  const fileInventory = await Promise.all(inventory.map(async path => { const bytes = await readFile(join(folder, path)); return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }));
  await writeFile(join(folder, 'distribution-manifest.json'), JSON.stringify({ mode: options.offline ? 'four-platform-offline' : 'base-management', nativeControlVerified: false, runtimeBundled: false, platform: closure.platform, arch: closure.arch, dependencies: closure.inventory, skipped: closure.skipped, files: fileInventory }, null, 2));
  artifacts.push({ ...await zip(folder, join(out, name + '.zip'), name, launcher), platform: closure.platform, arch: closure.arch, dependencies: closure.inventory });
}
await writeFile(join(out, 'SHA256SUMS.txt'), artifacts.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n');
await writeFile(join(out, 'manifest.json'), JSON.stringify({ mode: options.offline ? 'four-platform-offline' : 'base-management', version: manifest.version, protocolVersion: 2, createdAt: new Date().toISOString(), runtimeBundled: false, nativeControlVerified: false, targetNativeDependencies: { codex: '0.169.0', claudeAgentSdk: '0.3.325', claudeCode: '2.1.325', opencodeClient: '2.3.0', opencodeCli: '2.3.0', dshController: '0.2.1-rc.5' }, artifacts }, null, 2));
return { out, artifacts };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  let out, offline = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--offline') offline = true;
    else if (args[i] === '--out' && args[i + 1]) out = args[++i];
    else throw new Error('Usage: node scripts/package-desktop.mjs [--offline] [--out directory]');
  }
  console.log(JSON.stringify(await packageDesktop({ offline, out }), null, 2));
}

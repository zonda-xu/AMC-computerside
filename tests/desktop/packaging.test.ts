import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inspectDependencyClosure } from '../../scripts/check-offline-readiness.mjs';
import { packageDesktop } from '../../scripts/package-desktop.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const integrity = 'sha512-' + 'A'.repeat(86) + '==';
async function json(path: string, value: unknown) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amc-package-'));
  const packages: Record<string, any> = {};
  async function pkg(path: string, name: string, version: string, extra: object = {}, installed = true) {
    packages[path] = { version, integrity, ...extra };
    if (installed) await json(join(root, path, 'package.json'), { name, version, ...extra });
  }
  await json(join(root, 'package.json'), { name: 'fixture', version: '0.0.0', type: 'module', dependencies: { parent: '1.0.0', shared: '1.0.0' } });
  await pkg('node_modules/parent', 'parent', '1.0.0', { dependencies: { shared: '^2.0.0' }, peerDependencies: { peer: '^3.0.0' }, optionalDependencies: { 'native-win': '1.0.0', 'native-linux': '1.0.0' } });
  await pkg('node_modules/shared', 'shared', '1.0.0');
  await pkg('node_modules/parent/node_modules/shared', 'shared', '2.0.0');
  await pkg('node_modules/peer', 'peer', '3.0.0');
  await pkg('node_modules/native-win', 'native-win', '1.0.0', { os: ['win32'], cpu: ['x64'] });
  await pkg('node_modules/native-linux', 'native-linux', '1.0.0', { os: ['linux'], cpu: ['x64'] }, false);
  const saveLock = () => json(join(root, 'package-lock.json'), { lockfileVersion: 3, packages });
  await saveLock();
  return { root, packages, pkg, saveLock, close: () => rm(root, { recursive: true, force: true }) };
}

async function copySources(root: string) {
  for (const source of ['apps/desktop/src', 'apps/desktop/public', 'apps/desktop/launchers', 'apps/gateway/src', 'packages/adapters', 'packages/protocol', 'plugins/dsh-bridge', 'docs', 'tests/fixtures/four-platform']) {
    await mkdir(dirname(join(root, source)), { recursive: true });
    await cp(join(project, source), join(root, source), { recursive: true });
  }
  for (const source of ['apps/desktop/RUNTIME_HANDOFF.md', 'tests/e2e/FOUR_PLATFORM_ACCEPTANCE.md', 'scripts/check-offline-readiness.mjs', 'AI_Maid_Cafe_Four_Platform_Offline_Development_Plan_2026-11-16.md']) {
    await mkdir(dirname(join(root, source)), { recursive: true }); await cp(join(project, source), join(root, source));
  }
}

test('closure preserves nested versions and peers, filters foreign optional packages and blocks missing target packages', async () => {
  const f = await fixture();
  try {
    const report = await inspectDependencyClosure(f.root, { platform: 'win32', arch: 'x64' });
    assert.equal(report.ready, true, JSON.stringify(report.checks));
    assert.deepEqual(report.inventory.filter(item => item.name === 'shared').map(item => item.version).sort(), ['1.0.0', '2.0.0']);
    assert.ok(report.inventory.some(item => item.name === 'peer'));
    assert.ok(report.inventory.some(item => item.name === 'native-win'));
    assert.ok(!report.inventory.some(item => item.name === 'native-linux'));
    assert.equal((await inspectDependencyClosure(f.root, { platform: 'linux', arch: 'x64' })).ready, false);
    await rm(join(f.root, 'node_modules/peer'), { recursive: true });
    assert.equal((await inspectDependencyClosure(f.root, { platform: 'win32', arch: 'x64' })).ready, false);
  } finally { await f.close(); }
});

test('closure rejects lock mismatch, absent lock entries and incompatible installed peers', async () => {
  const f = await fixture();
  try {
    await f.pkg('node_modules/peer', 'peer', '2.0.0'); await f.saveLock();
    assert.equal((await inspectDependencyClosure(f.root, { platform: 'win32', arch: 'x64' })).ready, false);
    await f.pkg('node_modules/peer', 'peer', '3.0.0');
    f.packages['node_modules/parent/node_modules/shared'].version = '2.1.0'; await f.saveLock();
    assert.equal((await inspectDependencyClosure(f.root, { platform: 'win32', arch: 'x64' })).ready, false);
    delete f.packages['node_modules/parent/node_modules/shared']; await f.saveLock();
    assert.equal((await inspectDependencyClosure(f.root, { platform: 'win32', arch: 'x64' })).ready, false);
  } finally { await f.close(); }
});

test('offline package fails before output creation when real target SDK locks and installs are absent', async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.root, 'package-lock.json'), 'utf8'), out = join(f.root, 'isolated-output');
    await assert.rejects(packageDesktop({ project: f.root, out, offline: true }), /BLOCKED.*claude-agent-sdk/);
    await assert.rejects(access(out));
    assert.equal(await readFile(join(f.root, 'package-lock.json'), 'utf8'), before);
  } finally { await f.close(); }
});

test('isolated base distribution retains closure layout, exact lock, file hashes and runnable offline check', async () => {
  const f = await fixture();
  try {
    await copySources(f.root);
    await json(join(f.root, 'node_modules/parent/assets/runtime.json'), { required: true });
    await json(join(f.root, 'node_modules/parent/node_modules/unreferenced/package.json'), { name: 'unreferenced', version: '9.0.0' });
    const result = await packageDesktop({ project: f.root, out: join(f.root, 'isolated-output'), platforms: [['Windows', 'Start-Windows.cmd', 'win32']], arch: 'x64' });
    const folder = join(result.out, 'AI-Maid-Cafe-Windows');
    assert.equal(JSON.parse(await readFile(join(folder, 'node_modules/parent/node_modules/shared/package.json'), 'utf8')).version, '2.0.0');
    assert.equal(JSON.parse(await readFile(join(folder, 'node_modules/parent/assets/runtime.json'), 'utf8')).required, true);
    await assert.rejects(access(join(folder, 'node_modules/parent/node_modules/unreferenced/package.json')));
    assert.equal(await readFile(join(folder, 'package-lock.json'), 'utf8'), await readFile(join(f.root, 'package-lock.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(join(folder, 'distribution-manifest.json'), 'utf8'));
    assert.equal(manifest.mode, 'base-management'); assert.equal(manifest.nativeControlVerified, false);
    assert.ok(manifest.files.every((file: { sha256: string }) => /^[a-f0-9]{64}$/.test(file.sha256)));
    for (const file of manifest.files) assert.equal(createHash('sha256').update(await readFile(join(folder, file.path))).digest('hex'), file.sha256);
    assert.equal(createHash('sha256').update(await readFile(join(result.out, result.artifacts[0].name))).digest('hex'), result.artifacts[0].sha256);
    assert.equal((await inspectDependencyClosure(folder, { platform: 'win32', arch: 'x64' })).ready, true);
    const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['check:offline'], 'node scripts/check-offline-readiness.mjs');
    await assert.rejects(promisify(execFile)(process.execPath, ['scripts/check-offline-readiness.mjs', '--json'], { cwd: folder }), (error: any) => { assert.equal(error.code, 1); assert.equal(JSON.parse(error.stdout).ready, false); return true; });
    for (const doc of ['使用说明.md', 'docs/DESKTOP_GUIDE.md', 'docs/FOUR_PLATFORM_OFFLINE.md', 'docs/HOST_SETUP.md']) {
      const content = await readFile(join(folder, doc), 'utf8');
      for (const match of content.matchAll(/\]\(([^)]+)\)/g)) if (!/^(?:https?:|#)/.test(match[1])) await access(join(dirname(join(folder, doc)), match[1]));
    }
    await assert.rejects(packageDesktop({ project: f.root, out: result.out, platforms: [['Windows', 'Start-Windows.cmd', 'win32']], arch: 'x64' }), /EEXIST/);
  } finally { await f.close(); }
});

test('synthetic complete offline distribution passes its own relocated check without claiming native verification', async () => {
  const f = await fixture();
  try {
    const targets = [
      ['@anthropic-ai/claude-agent-sdk', '0.3.325', 'sha512-MhSm2Fhk3DA/hhjdCKXDZWlnykpPWJjX42SogllAHMplY9ZKT+Ltb8QPtQxpe225Imfs4A8IKaNE4biivA+fHg=='],
      ['@opencode/client', '2.3.0', 'sha512-xu74XGiYIqLZ2FzIrtjaR5UNWWXY3fRln0WLgZoQTR/wWMgG+T9XGQQGCl8ry8jnCFsJVokiHemBqft9oMzC1A=='],
      ['@opencode/cli', '2.3.0', 'sha512-Q5RV8jLJ4O8bY2O8X2hkBOkgPf6+nDB9MEkz/Q/Cc4Ojd2SwUFFzEd1LzgNGKiXiS7g/9+/X4eqhrxY60fLMOQ==']
    ];
    for (const [name, version, digest] of targets) await f.pkg(`node_modules/${name}`, name, version, { integrity: digest });
    for (const [name, version] of [['@anthropic-ai/sdk', '0.93.0'], ['@modelcontextprotocol/sdk', '1.29.0'], ['zod', '4.0.0']]) await f.pkg(`node_modules/${name}`, name, version);
    f.packages['node_modules/@anthropic-ai/claude-agent-sdk'].peerDependencies = { '@anthropic-ai/sdk': '>=0.93.0', '@modelcontextprotocol/sdk': '^1.29.0', zod: '^4.0.0' };
    await f.saveLock();
    await copySources(f.root);
    const result = await packageDesktop({ project: f.root, out: join(f.root, 'isolated-offline'), offline: true, platforms: [['Windows', 'Start-Windows.cmd', 'win32']], arch: 'x64' });
    const folder = join(result.out, 'AI-Maid-Cafe-Windows');
    const moved = join(f.root, 'relocated'); await cp(folder, moved, { recursive: true });
    await rm(folder, { recursive: true });
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/check-offline-readiness.mjs', '--json'], { cwd: moved });
    const report = JSON.parse(stdout);
    assert.equal(report.ready, true); assert.equal(report.nativeVerified, false);
    const manifest = JSON.parse(await readFile(join(moved, 'distribution-manifest.json'), 'utf8'));
    assert.equal(manifest.mode, 'four-platform-offline'); assert.equal(manifest.nativeControlVerified, false);
    for (const [name, version] of targets) assert.ok(manifest.dependencies.some((pkg: { name: string; version: string }) => pkg.name === name && pkg.version === version));
  } finally { await f.close(); }
});

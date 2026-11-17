import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectOfflineReadiness } from '../../scripts/check-offline-readiness.mjs';

const targets = [
  { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.325', integrity: 'sha512-MhSm2Fhk3DA/hhjdCKXDZWlnykpPWJjX42SogllAHMplY9ZKT+Ltb8QPtQxpe225Imfs4A8IKaNE4biivA+fHg==' },
  { name: '@opencode/client', version: '2.3.0', integrity: 'sha512-xu74XGiYIqLZ2FzIrtjaR5UNWWXY3fRln0WLgZoQTR/wWMgG+T9XGQQGCl8ry8jnCFsJVokiHemBqft9oMzC1A==' },
  { name: '@opencode/cli', version: '2.3.0', integrity: 'sha512-Q5RV8jLJ4O8bY2O8X2hkBOkgPf6+nDB9MEkz/Q/Cc4Ojd2SwUFFzEd1LzgNGKiXiS7g/9+/X4eqhrxY60fLMOQ==' }
];
const peers = [
  { name: '@anthropic-ai/sdk', version: '0.93.0' },
  { name: '@modelcontextprotocol/sdk', version: '1.29.0' },
  { name: 'zod', version: '4.0.0' }
];

async function save(path: string, value: object) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function fixture(root: string) {
  const packages = Object.fromEntries([...targets, ...peers.map(peer => ({ ...peer, integrity: targets[0].integrity }))].map(pkg => [`node_modules/${pkg.name}`, { version: pkg.version, integrity: pkg.integrity }]));
  await save(join(root, 'package-lock.json'), { lockfileVersion: 3, packages });
  for (const pkg of [...targets, ...peers]) await save(join(root, 'node_modules', pkg.name, 'package.json'), { name: pkg.name, version: pkg.version });
  return packages;
}

test('missing lock and installed packages are reported independently', async t => {
  const root = await mkdtemp(join(tmpdir(), 'offline-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await inspectOfflineReadiness(root, { nodeVersion: '24.13.0' });
  assert.equal(report.ready, false);
  assert.equal(report.checks.find(check => check.id === 'lockfile')?.status, 'missing');
  for (const target of targets) {
    for (const suffix of ['lock.version', 'lock.integrity', 'manifest', 'installed.version']) {
      assert.equal(report.checks.find(check => check.id === `${target.name}.${suffix}`)?.status, 'missing');
    }
  }
  assert.equal(report.checks.filter(check => check.id.includes('.peer.') && check.id.endsWith('.lock.version')).length, 3);
});

test('valid synthetic lock and manifests establish dependency readiness only and remain unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'offline-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const lockBefore = await readFile(join(root, 'package-lock.json'), 'utf8');
  const report = await inspectOfflineReadiness(root, { nodeVersion: '24.18.0' });
  assert.equal(report.ready, true, JSON.stringify(report.checks.filter(check => check.status !== 'ready')));
  assert.equal(report.nativeVerified, false);
  assert.match(report.provenance, /dependency-readiness/);
  assert.match(report.limitations, /No archive or installed-file hashing/);
  assert.equal(await readFile(join(root, 'package-lock.json'), 'utf8'), lockBefore);
});

test('version and plan integrity mismatches do not hide missing installed packages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'offline-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packages = await fixture(root);
  packages['node_modules/@opencode/client'].version = '2.2.0';
  packages['node_modules/@opencode/client'].integrity = 'sha512-wrong';
  await save(join(root, 'package-lock.json'), { lockfileVersion: 3, packages });
  await rm(join(root, 'node_modules/@opencode/client/package.json'));
  await save(join(root, 'node_modules/@opencode/cli/package.json'), { name: '@opencode/cli', version: '2.2.0' });
  const report = await inspectOfflineReadiness(root, { nodeVersion: '24.13.0' });
  assert.equal(report.ready, false);
  for (const suffix of ['lock.version', 'lock.integrity']) assert.equal(report.checks.find(check => check.id === `@opencode/client.${suffix}`)?.status, 'mismatch');
  assert.equal(report.checks.find(check => check.id === '@opencode/client.manifest')?.status, 'missing');
  assert.equal(report.checks.find(check => check.id === '@opencode/cli.installed.version')?.status, 'mismatch');
});

test('peers require exact locked compatible versions and matching installed manifests', async t => {
  const root = await mkdtemp(join(tmpdir(), 'offline-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packages = await fixture(root);
  packages['node_modules/@anthropic-ai/sdk'].version = '>=0.93.0';
  packages['node_modules/@modelcontextprotocol/sdk'].version = '2.0.0';
  await save(join(root, 'package-lock.json'), { lockfileVersion: 3, packages });
  await save(join(root, 'node_modules/zod/package.json'), { name: 'zod', version: '4.1.0' });
  const report = await inspectOfflineReadiness(root, { nodeVersion: '24.13.0' });
  assert.equal(report.ready, false);
  for (const name of ['@anthropic-ai/sdk', '@modelcontextprotocol/sdk']) {
    assert.equal(report.checks.find(check => check.id === `@anthropic-ai/claude-agent-sdk.peer.${name}.lock.version`)?.status, 'mismatch');
  }
  assert.equal(report.checks.find(check => check.id === '@anthropic-ai/claude-agent-sdk.peer.zod.installed.version')?.status, 'mismatch');
});

test('Node lower and upper bounds block unsupported runtimes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'offline-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  for (const nodeVersion of ['24.12.9', '25.0.0', '24.13.0-rc.1']) {
    const report = await inspectOfflineReadiness(root, { nodeVersion });
    assert.equal(report.ready, false);
    assert.equal(report.checks.find(check => check.id === 'node.version')?.status, 'mismatch');
  }
});

test('nested installed peer is compared to its own lock entry rather than a hoisted version', async t => {
  const root = await mkdtemp(join(tmpdir(), 'offline-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packages = await fixture(root);
  const key = 'node_modules/@anthropic-ai/claude-agent-sdk/node_modules/zod';
  packages[key] = { version: '4.2.0', integrity: targets[0].integrity };
  await save(join(root, key, 'package.json'), { name: 'zod', version: '4.2.0' });
  await save(join(root, 'node_modules/zod/package.json'), { name: 'zod', version: '3.0.0' });
  await save(join(root, 'package-lock.json'), { lockfileVersion: 3, packages });
  assert.equal((await inspectOfflineReadiness(root, { nodeVersion: '24.13.0' })).ready, true);
  packages[key] = { version: '4.1.0', integrity: targets[0].integrity };
  await save(join(root, 'package-lock.json'), { lockfileVersion: 3, packages });
  const report = await inspectOfflineReadiness(root, { nodeVersion: '24.13.0' });
  assert.equal(report.ready, false);
  assert.equal(report.checks.find(check => check.id === '@anthropic-ai/claude-agent-sdk.peer.zod.installed.version')?.status, 'mismatch');
});

test('missing peer manifest and missing peer integrity are separate blockers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'offline-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packages = await fixture(root);
  await save(join(root, 'package-lock.json'), { lockfileVersion: 3, packages: { ...packages, 'node_modules/zod': { version: '4.0.0' } } });
  await rm(join(root, 'node_modules/zod/package.json'));
  const report = await inspectOfflineReadiness(root, { nodeVersion: '24.13.0' });
  assert.equal(report.ready, false);
  const prefix = '@anthropic-ai/claude-agent-sdk.peer.zod';
  assert.equal(report.checks.find(check => check.id === `${prefix}.lock.version`)?.status, 'ready');
  assert.equal(report.checks.find(check => check.id === `${prefix}.lock.integrity`)?.status, 'missing');
  assert.equal(report.checks.find(check => check.id === `${prefix}.manifest`)?.status, 'missing');
});

test('scope-level peer shadows the root installation and must satisfy its own lock and range', async t => {
  const root = await mkdtemp(join(tmpdir(), 'offline-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packages = await fixture(root);
  const key = 'node_modules/@anthropic-ai/node_modules/zod';
  packages[key] = { version: '3.0.0', integrity: targets[0].integrity };
  await save(join(root, key, 'package.json'), { name: 'zod', version: '3.0.0' });
  await save(join(root, 'package-lock.json'), { lockfileVersion: 3, packages });
  const blocked = await inspectOfflineReadiness(root, { nodeVersion: '24.13.0' });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.checks.find(check => check.id === '@anthropic-ai/claude-agent-sdk.peer.zod.lock.version')?.status, 'mismatch');
  packages[key] = { version: '4.2.0', integrity: targets[0].integrity };
  await save(join(root, key, 'package.json'), { name: 'zod', version: '4.2.0' });
  await save(join(root, 'package-lock.json'), { lockfileVersion: 3, packages });
  assert.equal((await inspectOfflineReadiness(root, { nodeVersion: '24.13.0' })).ready, true);
});

test('malformed JSON blocks readiness without exposing file contents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'offline-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package-lock.json'), 'private-content-not-json');
  const report = await inspectOfflineReadiness(root, { nodeVersion: '24.13.0' });
  assert.equal(report.ready, false);
  assert.equal(report.checks.find(check => check.id === 'lockfile')?.status, 'invalid');
  assert.equal(JSON.stringify(report).includes('private-content'), false);
});

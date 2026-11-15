import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../helpers.ts';
import { automationSettings } from '../../apps/gateway/src/automation.ts';
import { WorkspaceDiscovery } from '../../apps/gateway/src/workspace-discovery.ts';
import type { Workspace } from '../../packages/protocol/src/types.ts';

test('automation is opt-in and validates intervals and exclusions', () => {
  assert.deepEqual(automationSettings(), { enabled: false, scanIntervalSeconds: 60, syncIntervalSeconds: 15, excludedDirectoryNames: [] });
  for (const n of [0, -1, NaN, Infinity, 1.2, 86401]) assert.throws(() => automationSettings({ scanIntervalSeconds: n }), /Invalid/);
  assert.throws(() => automationSettings({ enabled: 'true' as unknown as boolean }), /Invalid/);
  assert.throws(() => automationSettings({ excludedDirectoryNames: ['../escape'] }), /Invalid/);
});

test('ensure preserves identity and grants under concurrent registration without weakening manual overlap errors', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => f.core.ensureWorkspace(f.w.path, 'Do not rename')));
    for (const w of results) assert.deepEqual(w, f.w);
    await assert.rejects(() => f.core.registerWorkspace(f.w.path, 'Duplicate'), /overlap/);
    await assert.rejects(() => f.core.ensureWorkspace(f.root, 'Parent'), /overlap/);
    const child = join(f.w.path, 'child'); await mkdir(child);
    await assert.rejects(() => f.core.ensureWorkspace(child, 'Child'), /overlap/);
    const path = join(f.root, 'new'); await mkdir(path);
    const ensured = await Promise.all(Array.from({ length: 10 }, () => f.core.ensureWorkspace(path, 'New')));
    assert.equal(new Set(ensured.map(w => w.id)).size, 1); assert.deepEqual(ensured[0].writeRoots, [path]);
    await assert.rejects(() => f.core.ensureWorkspace(path, 'Revoked', async () => { f.core.allowedRoots = []; }), /outside/);
  } finally { await f.close(); }
});

test('discovery only registers marked real first-level projects, merges catalog events and stays idempotent', async () => {
  const f = await fixture(); const scan = new WorkspaceDiscovery(f.core, automationSettings({ enabled: true, excludedDirectoryNames: ['skip-me'] }));
  try {
    for (const name of ['project', 'git-file', '.hidden', 'node_modules', 'vendor', 'dist', 'build', 'target', 'cache', 'skip-me', 'container']) {
      const path = join(f.root, name); await mkdir(path); if (name !== 'container') await writeFile(join(path, name === 'git-file' ? '.git' : 'package.json'), 'not parsed');
    }
    await mkdir(join(f.root, 'container', 'nested')); await writeFile(join(f.root, 'container', 'nested', 'go.mod'), 'not parsed');
    await writeFile(join(f.root, 'package.json'), 'root is not a project');
    await symlink(join(f.root, 'project'), join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    let events = 0; f.core.on('catalog.changed', () => events++);
    const pending = scan.scan(); assert.equal(scan.scan(), pending);
    const first = await pending; assert.equal(first.state, 'complete'); assert.equal(first.added, 2); assert.equal(events, 1);
    const projects = f.store.list<Workspace>('workspace'); assert.equal(projects.length, 4);
    assert.ok(projects.some(w => w.name === 'project')); assert.ok(projects.some(w => w.name === 'git-file'));
    assert.equal((await scan.scan()).added, 0); assert.equal(events, 1);
    await rename(join(f.root, 'project'), join(f.root, '.offline'));
    await scan.scan(); assert.equal(f.store.list('workspace').length, 4);
  } finally { await scan.close(); await f.close(); }
});

test('discovery rejects linked markers, overlaps, replaced roots, exhausted budgets and disabled scheduling', async () => {
  const f = await fixture(); const scan = new WorkspaceDiscovery(f.core, automationSettings({ enabled: true }));
  try {
    await writeFile(join(f.w.path, 'package.json'), 'marker');
    await mkdir(join(f.w.path, 'nested')); await writeFile(join(f.w.path, 'nested', 'go.mod'), 'marker');
    const linked = join(f.root, 'linked-marker'); await mkdir(linked);
    await symlink(f.w.path, join(linked, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await scan.scan()).added, 0);
    scan.maxDirectories = 1; assert.equal((await scan.scan()).state, 'partial');
    scan.maxDirectories = 1000; scan.budgetMs = 0; assert.equal((await scan.scan()).state, 'partial');
    scan.budgetMs = 10000;
    const original = f.core.ensureWorkspace.bind(f.core); let replaced = false;
    f.core.ensureWorkspace = async (path, name, validate, notify) => {
      if (!replaced) { replaced = true; await rename(f.root, f.root + '-moved'); await mkdir(f.root); }
      return original(path, name, validate, notify);
    };
    assert.equal((await scan.scan()).state, 'partial'); assert.equal(f.store.list('workspace').length, 2);
    const disabled = new WorkspaceDiscovery(f.core, automationSettings()); disabled.start(); assert.equal((await disabled.scan()).state, 'idle'); await disabled.close();
  } finally { await scan.close(); await f.close(); }
});

test('discovery timer contains storage and asynchronous listener failures with visible safe status', async () => {
  const f = await fixture(); const scan = new WorkspaceDiscovery(f.core, automationSettings({ enabled: true }));
  try {
    const list = f.store.list.bind(f.store); let failed = false;
    f.store.list = kind => { if (!failed) { failed = true; throw new Error('private database failure'); } return list(kind); };
    scan.start(); await delay(30);
    assert.equal(scan.status.state, 'partial'); assert.deepEqual(scan.status.errors, ['discovery_failed']);
    f.core.on('automation.discovery', async () => { throw new Error('private listener failure'); });
    await scan.scan(); await delay(5);
    assert.equal(scan.status.state, 'partial'); assert.deepEqual(scan.status.errors, ['discovery_listener_failed']);
    await scan.close(); await delay(30); assert.equal(scan.status.state, 'stopped');
  } finally { await scan.close(); await f.close(); }
});

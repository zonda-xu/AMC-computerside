import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from '../helpers.ts';
import { Core } from '../../apps/gateway/src/core.ts';
import { WorkspaceDiscovery } from '../../apps/gateway/src/workspace-discovery.ts';
import { ExternalSync } from '../../apps/gateway/src/external-sync.ts';
import { automationSettings } from '../../apps/gateway/src/automation.ts';
import type { Workspace } from '../../packages/protocol/src/types.ts';

test('legacy manual access stays compatible but automation requires explicit host confirmation', async () => {
  const f = await fixture();
  const scan = new WorkspaceDiscovery(f.core, automationSettings({ enabled: true }));
  const sync = new ExternalSync(f.core, automationSettings({ enabled: true }), { codex: { command: 'fixture', expectedVersion: 'fixture' } });
  try {
    assert.deepEqual(f.core.workspace(f.w.id), f.w);
    assert.throws(() => f.core.workspaceIdentities.verify(f.w.id, true), /confirmation/);
    await writeFile(join(f.w.path, 'package.json'), '{}');
    assert.equal((await scan.scan()).state, 'partial');
    assert.equal(f.store.get('workspace-identity-v1', f.w.id), undefined);
    await sync.runOnce(); assert.equal(sync.statuses.get(f.w.id + ':codex')?.error, 'workspace_confirmation_required');
    f.core.workspaceIdentities.confirm(f.w.id, f.root);
    f.core.workspaceIdentities.verify(f.w.id, true);
    assert.equal((await scan.scan()).state, 'complete');
    f.core.allowedRoots = []; assert.throws(() => f.core.workspaceIdentities.verify(f.w.id, true), /revoked/);
    assert.equal(f.core.session(f.s.id).id, f.s.id);
  } finally { await sync.close(); await scan.close(); await f.close(); }
});

test('automatically registered identities reject same-path replacement across rounds and restart', async () => {
  const f = await fixture(); const settings = automationSettings({ enabled: true });
  const scan = new WorkspaceDiscovery(f.core, settings);
  try {
    const path = join(f.root, 'automatic'); await mkdir(path); await writeFile(join(path, 'package.json'), '{}');
    assert.equal((await scan.scan()).added, 1);
    const workspace = f.store.list<Workspace>('workspace').find(w => w.path === path)!;
    f.core.workspaceIdentities.verify(workspace.id, true);
    await rename(path, join(f.root, '.old')); await mkdir(path); await writeFile(join(path, 'package.json'), '{}');
    assert.equal((await scan.scan()).state, 'partial'); assert.equal(f.store.list('workspace').length, 3);
    assert.throws(() => f.core.workspace(workspace.id), /identity changed/);
    const restarted = new Core(f.store, f.core.hostId, [f.root]);
    assert.throws(() => restarted.workspaceIdentities.verify(workspace.id, true), /identity changed/);
    f.core.workspaceIdentities.confirm(workspace.id, f.root); restarted.workspaceIdentities.verify(workspace.id, true);
  } finally { await scan.close(); await f.close(); }
});

test('persisted root identity rejects replacement before scanning or synchronizing children', async () => {
  const f = await fixture(); const settings = automationSettings({ enabled: true }); const scan = new WorkspaceDiscovery(f.core, settings);
  try {
    f.core.workspaceIdentities.confirm(f.w.id, f.root); await scan.scan();
    await rename(f.root, join(f.dir, 'old-root')); await mkdir(f.root); await mkdir(f.w.path);
    await mkdir(join(f.root, 'unrelated')); await writeFile(join(f.root, 'unrelated', 'go.mod'), 'module test');
    const restarted = new Core(f.store, f.core.hostId, [f.root]); const next = new WorkspaceDiscovery(restarted, settings);
    try { assert.equal((await next.scan()).state, 'partial'); assert.equal(f.store.list('workspace').length, 2); }
    finally { await next.close(); }
    assert.throws(() => restarted.workspaceIdentities.verify(f.w.id, true), /identity changed/);
    restarted.workspaceIdentities.confirmRoot(f.root);
    assert.throws(() => restarted.workspaceIdentities.verify(f.w.id, true), /identity changed/);
    restarted.workspaceIdentities.confirm(f.w.id, f.root); restarted.workspaceIdentities.verify(f.w.id, true);
  } finally { await scan.close(); await f.close(); }
});

test('host confirmation CLI requires an exact path and exclusive gateway lock', async () => {
  const f = await fixture();
  try {
    const config = join(f.dir, 'host.json');
    await writeFile(config, JSON.stringify({ hostId: f.core.hostId, dataDir: f.dir, allowedWorkspaceRoots: [f.root] }));
    const args = [resolve('apps/gateway/src/confirm-workspace-identity.ts'), '--config', config, '--root', f.root, '--workspace', f.w.id, '--confirm-path'];
    const run = (path: string) => promisify(execFile)(process.execPath, [...args, path], { env: { ...process.env, AMC_STATE_DIR: f.dir } });
    await assert.rejects(() => run(f.wb.path), /exact stored workspace path/);
    assert.equal(f.store.get('workspace-identity-v1', f.w.id), undefined);
    await writeFile(join(f.dir, 'gateway.lock'), JSON.stringify({ pid: process.pid }));
    await assert.rejects(() => run(f.w.path), /EEXIST/);
    await unlink(join(f.dir, 'gateway.lock'));
    await run(f.w.path); f.core.workspaceIdentities.verify(f.w.id, true);
    assert.deepEqual(f.core.workspace(f.w.id), f.w); assert.equal(f.core.session(f.s.id).id, f.s.id);
  } finally { await f.close(); }
});

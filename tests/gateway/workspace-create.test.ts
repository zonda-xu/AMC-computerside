import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers.ts';
import { directoryName } from '../../apps/gateway/src/workspace-create.ts';
import { stable } from '../../packages/protocol/src/validation.ts';
import { Core } from '../../apps/gateway/src/core.ts';

test('one-level directory names reject traversal, Windows aliases and ambiguous paths', () => {
  for (const name of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a:b', 'CON', 'con.txt', 'CON .txt', 'COM1', 'COM\u00b9', 'CONIN$', 'lpt9.log', 'NUL', 'x.', 'x ', 'x\0y', 'x\ny', 'a?b', 'x'.repeat(101)]) assert.throws(() => directoryName(name));
  for (const name of ['project', 'new-project', 'COM10', 'hello world']) assert.equal(directoryName(name), name);
});
test('directory creation registers once, recovers a lost response and conflicts on changed arguments', async () => {
  const f = await fixture();
  try {
    const rootId = f.core.workspaceCreator.rootId(f.root);
    const a = await f.core.workspaceCreator.create('device', 'create-dir', rootId, 'new', 'New');
    assert.equal(a.path, join(f.root, 'new'));
    const restarted = new Core(f.store, f.core.hostId, [f.root]);
    assert.equal((await restarted.workspaceCreator.create('device', 'create-dir', rootId, 'new', 'New')).id, a.id);
    await assert.rejects(() => restarted.workspaceCreator.create('device', 'create-dir', rootId, 'different', 'New'), /different contents/);
    assert.deepEqual((await readdir(f.root)).sort(), ['a', 'b', 'new']);
  } finally { await f.close(); }
});
test('directory creation never adopts an existing directory, foreign root or overlapping project', async () => {
  const f = await fixture();
  try {
    const rootId = f.core.workspaceCreator.rootId(f.root);
    await assert.rejects(() => f.core.workspaceCreator.create('device', 'foreign', 'bad', 'x', 'X'));
    await assert.rejects(() => f.core.workspaceCreator.create('device', 'existing', rootId, 'a', 'A'));
    await mkdir(join(f.root, 'existing'));
    await assert.rejects(() => f.core.workspaceCreator.create('device', 'exists', rootId, 'existing', 'Existing'));
    await assert.rejects(() => f.core.workspaceCreator.create('device', 'exists', rootId, 'existing', 'Existing'), /already exists|EEXIST/);
    const child = new Core(f.store, f.core.hostId, [f.w.path]);
    assert.equal((await child.workspaceCreator.roots())[0].canCreate, false);
    await assert.rejects(() => child.workspaceCreator.create('device', 'nested', child.workspaceCreator.rootId(f.w.path), 'new', 'New'), /overlap/);
    assert.deepEqual(await readdir(f.w.path), []);
  } finally { await f.close(); }
});
test('concurrent same-root requests serialize without overwrite or duplicate registration', async () => {
  const f = await fixture();
  try {
    const rootId = f.core.workspaceCreator.rootId(f.root);
    const results = await Promise.allSettled(['one', 'two'].map(id => f.core.workspaceCreator.create('device', id, rootId, 'concurrent', 'Concurrent')));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(f.store.list('workspace').length, 3);
  } finally { await f.close(); }
});
test('crash between mkdir and durable ownership proof requires review and never deletes the directory', async () => {
  const f = await fixture();
  try {
    const rootId = f.core.workspaceCreator.rootId(f.root);
    const put = f.store.put.bind(f.store);
    let injected = false;
    f.store.put = (kind, id, value) => { if (kind === 'workspace-create-v1' && !injected && JSON.stringify(value).includes('"stage":"created"')) { injected = true; throw new Error('injected ownership persistence failure'); } put(kind, id, value); };
    await assert.rejects(() => f.core.workspaceCreator.create('device', 'crash', rootId, 'orphan', 'Orphan'));
    f.store.put = put;
    await assert.rejects(() => f.core.workspaceCreator.create('device', 'crash', rootId, 'orphan', 'Orphan'), /review|proven/);
    assert.ok((await readdir(f.root)).includes('orphan'));
    assert.equal(f.store.list('workspace').length, 2);
  } finally { await f.close(); }
});
test('failure after ownership proof resumes registration with the original identity', async () => {
  const f = await fixture();
  try {
    const rootId = f.core.workspaceCreator.rootId(f.root);
    const put = f.store.put.bind(f.store); let fail = true;
    f.store.put = (kind, id, value) => { if (kind === 'workspace' && fail) { fail = false; throw new Error('injected registration failure'); } put(kind, id, value); };
    await assert.rejects(() => f.core.workspaceCreator.create('device', 'recover', rootId, 'recover', 'Recover'));
    f.store.put = put;
    assert.equal((await f.core.workspaceCreator.create('device', 'recover', rootId, 'recover', 'Recover')).path, join(f.root, 'recover'));
    assert.equal(f.store.list('workspace').length, 3);
  } finally { await f.close(); }
});
test('unknown prepared operations cannot claim directories even when the target exists', async () => {
  const f = await fixture();
  try {
    const rootId = f.core.workspaceCreator.rootId(f.root);
    await f.core.workspaceCreator.create('device', 'prepared', rootId, 'orphan', 'Orphan');
    const key = stable(['device', 'prepared']);
    const op = f.store.get<Record<string, string>>('workspace-create-v1', key);
    assert.ok(op); op.stage = 'prepared'; f.store.put('workspace-create-v1', key, op);
    await assert.rejects(() => f.core.workspaceCreator.create('device', 'prepared', rootId, 'orphan', 'Orphan'), /review|proven/);
    assert.equal(f.store.get<Record<string, string>>('workspace-create-v1', key)?.stage, 'needs_review');
  } finally { await f.close(); }
});
test('replaced authorized roots and junction targets are rejected without registration', async () => {
  const f = await fixture();
  try {
    const alias = join(f.dir, 'alias'); await symlink(f.root, alias, 'junction');
    const other = new Core(f.store, f.core.hostId, [alias]);
    await assert.rejects(() => other.workspaceCreator.create('device', 'alias', other.workspaceCreator.rootId(alias), 'x', 'X'));
    await rename(alias, join(f.dir, 'alias-old'));
    assert.equal(f.store.list('workspace').length, 2);
  } finally { await f.close(); }
});

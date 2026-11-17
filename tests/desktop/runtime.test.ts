import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { codexEndpoint, codexHandshake, RuntimeManager, type ManagedRuntimeConfig, type ServiceEndpoint } from '../../apps/desktop/src/runtime.ts';

const codex: ManagedRuntimeConfig = { command: 'codex', expectedVersion: 'codex-cli 0.169.0', enabled: true };
const opencode: ManagedRuntimeConfig = { command: 'opencode', expectedVersion: '2.3.0', enabled: true };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amc-runtime-'));
  return { root, close: () => rm(root, { recursive: true, force: true }) };
}
test('Codex read probes never launch, explicit start registers one shared runtime and reconnect preserves identity', async () => {
  const f = await fixture(); let launches = 0, handshakes = 0;
  const manager = new RuntimeManager(f.root, { version: async () => codex.expectedVersion, codexHandshake: async () => { handshakes++; }, launchCodex: async () => { launches++; return process.pid; } });
  try {
    assert.equal((await manager.probe('codex', codex)).state, 'unavailable');
    await assert.rejects(manager.connect('codex', codex));
    assert.equal(launches, 0); assert.equal(handshakes, 0);
    const first = await manager.start('codex', codex);
    assert.equal(first.endpoint, codexEndpoint); assert.equal(first.generation, 1); assert.equal(launches, 1);
    assert.deepEqual(await manager.start('codex', codex), first);
    assert.equal((await manager.connect('codex', codex)).runtimeInstanceId, first.runtimeInstanceId);
    assert.equal((await manager.probe('codex', codex)).generation, 1); assert.equal(launches, 1);
    const restartedManager = new RuntimeManager(f.root, manager.hooks);
    assert.deepEqual(await restartedManager.start('codex', codex), first); assert.equal(launches, 1);
  } finally { await f.close(); }
});
test('Codex failed connection retains the registered process and never replaces it', async () => {
  const f = await fixture(); let failed = false, launches = 0;
  const manager = new RuntimeManager(f.root, { version: async () => codex.expectedVersion, codexHandshake: async () => { if (failed) throw new Error('offline'); }, launchCodex: async () => { launches++; return process.pid; } });
  try {
    const first = await manager.start('codex', codex); failed = true;
    assert.equal((await manager.probe('codex', codex)).state, 'unavailable');
    await assert.rejects(manager.start('codex', codex), /offline/);
    assert.deepEqual(await manager.registration('codex'), first); assert.equal(launches, 1);
  } finally { await f.close(); }
});
test('Codex explicit startup refuses an occupied shared port and leaves its listener intact', async () => {
  const f = await fixture(), listener = createServer();
  let owned = false;
  try {
    try {
      await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(8897, '127.0.0.1', resolve); }); owned = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
    const manager = new RuntimeManager(f.root, { version: async () => codex.expectedVersion });
    await assert.rejects(manager.start('codex', codex), /8897 is occupied/);
    assert.equal(await manager.registration('codex'), undefined);
    if (owned) assert.equal(listener.listening, true);
  } finally { if (owned) await new Promise<void>(resolve => listener.close(() => resolve())); await f.close(); }
});
test('OpenCode discover is read-only; explicit registration reuses service and changed identity requires new generation', async () => {
  const f = await fixture(); let ensures = 0;
  let endpoint: ServiceEndpoint | undefined = { url: 'http://127.0.0.1:5555', pid: process.pid, token: 'secret-one' };
  const manager = new RuntimeManager(f.root, { version: async () => '2.3.0', service: async () => ({ discover: async () => endpoint, ensure: async () => { ensures++; throw new Error('must not ensure'); }, headers: value => ({ Authorization: `Bearer ${value.token}` }) }) });
  try {
    assert.equal((await manager.probe('opencode', opencode)).state, 'unavailable');
    assert.equal(ensures, 0);
    const first = await manager.start('opencode', opencode);
    assert.equal((await manager.probe('opencode', opencode)).state, 'connected');
    assert.equal((await manager.connect('opencode', opencode)).headers.Authorization, 'Bearer secret-one');
    assert.deepEqual(await manager.start('opencode', opencode), first); assert.equal(ensures, 0);
    const saved = await readFile(join(f.root, 'opencode.runtime.json'), 'utf8'); assert.ok(!saved.includes('secret-one'));
    assert.ok(!JSON.stringify(await manager.probe('opencode', opencode)).includes('secret-one'));
    endpoint = { ...endpoint, token: 'secret-two' };
    await assert.rejects(manager.connect('opencode', opencode), /identity changed/);
    const next = await manager.start('opencode', opencode);
    assert.equal(next.generation, 2); assert.notEqual(next.runtimeInstanceId, first.runtimeInstanceId); assert.equal(ensures, 0);
    endpoint = undefined;
    assert.equal((await manager.probe('opencode', opencode)).state, 'unavailable');
    await assert.rejects(manager.start('opencode', opencode), /Previously registered/); assert.equal(ensures, 0);
    const file = join(f.root, 'native-service.json'); await writeFile(file, JSON.stringify({ pid: process.pid, version: 'mismatch' }));
    await assert.rejects(manager.start('opencode', { ...opencode, serviceRegistrationFile: file }), /Previously registered/); assert.equal(ensures, 0);
  } finally { await f.close(); }
});
test('OpenCode ensure is restricted to explicit startup after checking absent native registration', async () => {
  const f = await fixture(); let ensures = 0, endpoint: ServiceEndpoint | undefined;
  const manager = new RuntimeManager(f.root, { version: async () => '2.3.0', service: async () => ({ discover: async () => endpoint, ensure: async () => { ensures++; endpoint = { url: 'http://127.0.0.1:5555' }; return endpoint; }, headers: () => ({}) }) });
  const config = { ...opencode, serviceRegistrationFile: join(f.root, 'absent.json') };
  try {
    await manager.probe('opencode', config); assert.equal(ensures, 0);
    const record = await manager.start('opencode', config); assert.equal(ensures, 1);
    assert.equal((await manager.connect('opencode', config)).runtimeInstanceId, record.runtimeInstanceId);
    await manager.start('opencode', config); assert.equal(ensures, 1);
  } finally { await f.close(); }
});
test('OpenCode unknown or mismatched native registration cannot trigger ensure', async () => {
  const f = await fixture(); let ensures = 0;
  const manager = new RuntimeManager(f.root, { version: async () => '2.3.0', service: async () => ({ discover: async () => undefined, ensure: async () => { ensures++; throw new Error('must not ensure'); }, headers: () => ({}) }) });
  try {
    await assert.rejects(manager.start('opencode', opencode), /registration location/);
    const file = join(f.root, 'native-service.json'); await writeFile(file, JSON.stringify({ pid: process.pid, version: 'mismatch' }));
    await assert.rejects(manager.start('opencode', { ...opencode, serviceRegistrationFile: file }), /registration exists/);
    assert.equal(ensures, 0);
  } finally { await f.close(); }
});
test('runtime startup lock prevents concurrent launches and is removed after failure', async () => {
  const f = await fixture(); let launches = 0;
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const manager = new RuntimeManager(f.root, { version: async () => { entered(); await wait; throw new Error('fixture version unavailable'); }, launchCodex: async () => { launches++; return process.pid; } });
  try {
    const first = manager.start('codex', codex); await entry;
    await assert.rejects(manager.start('codex', codex), /EEXIST/);
    release(); await assert.rejects(first, /version unavailable/);
    await assert.rejects(manager.start('codex', codex), /version unavailable/);
    assert.equal(launches, 0);
  } finally { release(); await f.close(); }
});
test('runtime disabled, version mismatch, corrupt registration and non-loopback service all fail closed', async () => {
  const f = await fixture();
  try {
    const manager = new RuntimeManager(f.root);
    assert.equal((await manager.probe('codex', { ...codex, enabled: false })).state, 'disabled');
    await assert.rejects(manager.start('codex', { ...codex, enabled: false }), /disabled/);
    await assert.rejects(manager.connect('codex', { ...codex, enabled: false }), /disabled/);
    assert.equal((await manager.probe('codex', { ...codex, command: process.execPath })).state, 'unavailable');
    await assert.rejects(manager.start('codex', { ...codex, command: process.execPath }), /pinned target/);
    await writeFile(join(f.root, 'codex.runtime.json'), '{}');
    await assert.rejects(manager.registration('codex'), /Invalid/);
    const remote = new RuntimeManager(f.root, { version: async () => '2.3.0', service: async () => ({ discover: async () => ({ url: 'http://example.com:5555' }), ensure: async () => { throw new Error('must not ensure'); }, headers: () => ({}) }) });
    await assert.rejects(remote.start('opencode', opencode), /loopback/);
  } finally { await f.close(); }
});
test('Codex WebSocket handshake sends initialize then initialized without requiring jsonrpc field', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(typeof address === 'object' && address);
  const methods: string[] = [];
  const initialized = new Promise<void>(resolve => server.once('connection', socket => socket.on('message', data => {
    const message = JSON.parse(data.toString()); methods.push(message.method);
    if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'codex-fixture' } }));
    if (message.method === 'initialized') resolve();
  })));
  try {
    await codexHandshake(`ws://127.0.0.1:${address.port}`); await initialized;
    assert.deepEqual(methods, ['initialize', 'initialized']);
  } finally { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

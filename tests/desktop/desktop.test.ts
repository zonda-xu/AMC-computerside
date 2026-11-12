import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { X509Certificate } from 'node:crypto';
import { WebSocket } from 'ws';
import { DesktopService, networkFiles, verifyEndpoint } from '../../apps/desktop/src/service.ts';
import { addresses, privateIPv4, probeRuntime, readConfig, saveHost, system, validHostname, validateInput, type SetupInput } from '../../apps/desktop/src/host.ts';
import { nativeCommand } from '../../packages/adapters/common/command.ts';
import { fixture as gatewayFixture, command } from '../helpers.ts';

async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'amc-desktop-test-'));
  return { root, cleanup: async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); } };
}

test('changing the allowed project directory does not retain old file or execution grants', async () => {
  const f = await gatewayFixture();
  try {
    f.core.allowedRoots = [f.wb.path];
    assert.throws(() => f.core.workspace(f.w.id), /current host-configured/);
    f.core.accept('device', command(f.s)); await f.core.drain();
    assert.equal(f.adapter.submitted, 0);
    assert.ok(f.store.get('session', f.s.id), 'History remains stored');
  } finally { await f.close(); }
});

test('desktop configuration rejects invalid addresses, DNS injection and missing programs', async () => {
  assert.equal(privateIPv4('0.0.0.0'), false); assert.equal(privateIPv4('127.0.0.1'), false); assert.equal(privateIPv4('8.8.8.8'), false);
  assert.equal(privateIPv4('192.168.1.8'), true); assert.equal(privateIPv4('172.16.0.1'), true); assert.equal(privateIPv4('172.32.0.1'), false);
  assert.equal(validHostname('relay.example.com'), true); assert.equal(validHostname('relay.example.com\nDNS:evil'), false); assert.equal(validHostname('bad..example.com'), false);
  assert.throws(() => networkFiles('relay.example.com', 'too-short'));
  assert.throws(() => networkFiles('relay.example.com"\n[evil]', 'x'.repeat(43)));
  const files = networkFiles('relay.example.com', 'x'.repeat(43));
  assert.match(files.host, new RegExp(system.address.replaceAll('.', '\\.'))); assert.match(files.relay, /18541/); assert.match(files.relay, /18542/); assert.match(files.relay, /18543/);
  assert.equal((files.relay.match(/network_secret/g) || []).length, 1);
  const missing = await probeRuntime('codex', join(tmpdir(), 'non-existent-amc-program'));
  assert.equal(missing.installed, false); assert.equal(missing.version, '');
  await assert.rejects(() => probeRuntime('invalid' as 'codex', process.execPath));
  const input: SetupInput = { name: 'Test', mode: 'lan', address: '192.168.1.8', workspace: tmpdir(), runtimes: { codex: { enabled: true, command: process.execPath } } };
  await assert.rejects(() => validateInput(input, []), /IP/);
  await assert.rejects(() => validateInput({ ...input, runtimes: {} }, [{ name: 'test', address: input.address }]), /至少启用/);
  await assert.rejects(() => validateInput({ ...input, workspace: 'relative-path' }, [{ name: 'test', address: input.address }]), /绝对路径/);
});

test('Windows npm shims resolve to JS entry points without invoking a shell', { skip: process.platform !== 'win32' }, async () => {
  const fixture = await temporary();
  try {
    const entry = join(fixture.root, 'cli.mjs'), shim = join(fixture.root, 'agent.cmd');
    await writeFile(entry, 'console.log("fixture")');
    await writeFile(shim, '@ECHO off\n"%_prog%" "%dp0%\\cli.mjs" %*\n');
    assert.deepEqual(nativeCommand(shim), { command: process.execPath, args: [entry] });
    await writeFile(shim, '@echo off\npowershell arbitrary-command');
    assert.throws(() => nativeCommand(shim), /Unsupported/);
  } finally { await fixture.cleanup(); }
});

test('desktop admin rejects unauthenticated, cross-origin and forged Host requests', async () => {
  const fixture = await temporary(), service = new DesktopService(fixture.root), server = service.server();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string'); service.authority = `127.0.0.1:${addr.port}`;
  const call = (path: string, headers: Record<string, string> = {}, method = 'GET') => new Promise<{ status: number; body: string; headers: any }>((resolveResponse, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: addr.port, path, method, headers }, response => { let body = ''; response.on('data', c => body += c); response.on('end', () => resolveResponse({ status: response.statusCode!, body, headers: response.headers })); }); req.on('error', reject); req.end();
  });
  try {
    assert.equal((await call('/api/state')).status, 401);
    assert.equal((await call('/api/state', { Host: 'evil.example' })).status, 403);
    assert.equal((await call('/api/state', { Origin: 'https://evil.example', Authorization: `Bearer ${service.token}` })).status, 403);
    const state = await call('/api/state', { Authorization: `Bearer ${service.token}` }); assert.equal(state.status, 200); assert.equal(JSON.parse(state.body).config, null); assert.ok(!state.body.includes(service.token));
    assert.equal((await call('/api/start', { Authorization: `Bearer ${service.token}` }, 'POST')).status, 400);
    const html = await call('/'); assert.equal(html.status, 200); assert.equal(html.headers['x-frame-options'], 'DENY'); assert.match(html.headers['content-security-policy'], /default-src 'none'/);
    assert.equal((await call('/host.config.json')).status, 404);
    assert.equal((await call('/../src/host.ts')).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await fixture.cleanup(); }
});

test('standalone host preserves identity, runs real TLS pairing, invalidates refreshes and revokes live devices', { timeout: 120000 }, async () => {
  const available = addresses(); assert.ok(available.length, 'Integration test needs a local private IPv4 interface');
  const fixture = await temporary(), root = join(fixture.root, 'private'), workspace = join(fixture.root, 'project'); await mkdir(workspace);
  const oldLockDir = process.env.AMC_STATE_DIR; process.env.AMC_STATE_DIR = join(fixture.root, 'locks');
  const service = new DesktopService(root); const sockets: WebSocket[] = [];
  try {
    // Node is only a version-output fixture; this test never claims a real AI task succeeded.
    const input: SetupInput = { name: 'Desktop integration fixture', mode: 'lan', address: available[0].address, workspace, runtimes: { codex: { command: process.execPath, enabled: true } } };
    const first = await saveHost(root, input); const firstCA = await readFile(first.caFile, 'utf8');
    assert.equal(first.runtimes.codex.expectedVersion, process.version); assert.equal(first.runtimes.opencode.enabled, false);
    const leaf = new X509Certificate(await readFile(first.certFile)); assert.equal(leaf.checkIP(input.address), input.address);
    const second = await saveHost(root, { ...input, name: 'Renamed host' }); assert.equal(second.hostId, first.hostId); assert.equal(await readFile(second.caFile, 'utf8'), firstCA); assert.notEqual(second.certFile, first.certFile);
    await assert.rejects(() => saveHost(root, { ...input, address: '8.8.8.8' })); assert.equal((await readConfig(root))?.name, 'Renamed host');
    await service.start(); assert.equal(service.ready, true);
    await assert.rejects(() => service.save(input), /先停止网关/);
    assert.equal((await verifyEndpoint(second)).ok, true);
    const req = (path: string, body?: unknown, token = '') => new Promise<any>((resolveResponse, reject) => {
      const request = httpsRequest(new URL(path, second.publicEndpoint), { ca: firstCA, method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-AMC-Host': second.hostId, Authorization: 'Bearer ' + token } }, response => { let data = ''; response.on('data', c => data += c); response.on('end', () => resolveResponse({ status: response.statusCode, ...JSON.parse(data) })); }); request.on('error', reject); request.end(body ? JSON.stringify(body) : undefined);
    });
    const old = await service.pair(), pairing = await service.pair(); assert.match(pairing.qr, /^data:image\/png;base64,/);
    assert.equal((await req('/v1/pair', { hostId: second.hostId, ticket: old.ticket.ticket, deviceName: 'Old code' })).status, 403);
    const paired = await req('/v1/pair', { hostId: second.hostId, ticket: pairing.ticket.ticket, deviceName: 'Test phone' }); assert.equal(paired.status, 200);
    assert.equal((await req('/v1/pair', { hostId: second.hostId, ticket: pairing.ticket.ticket, deviceName: 'Replay' })).status, 403);
    assert.equal((await service.state()).pairingUsed, true);
    const ws = new WebSocket(second.publicEndpoint.replace('https:', 'wss:') + '/v1/events', { ca: firstCA, headers: { 'X-AMC-Host': second.hostId, Authorization: 'Bearer ' + paired.data.token } }); sockets.push(ws);
    await new Promise<void>((resolveOpen, reject) => { ws.once('open', () => resolveOpen()); ws.once('error', reject); });
    const closed = new Promise<number>(resolveClose => ws.once('close', code => resolveClose(code)));
    await service.revoke(paired.data.deviceId); assert.equal(await closed, 4001);
    assert.equal((await req('/v1/bootstrap', undefined, paired.data.token)).status, 401);
    await service.stop(); assert.equal(service.ready, false); await service.start(); assert.equal(service.ready, true); await service.stop();
  } finally { for (const socket of sockets) socket.terminate(); await service.stop(); if (oldLockDir === undefined) delete process.env.AMC_STATE_DIR; else process.env.AMC_STATE_DIR = oldLockDir; await fixture.cleanup(); }
});

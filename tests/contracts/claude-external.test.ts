import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../../packages/adapters/claude-code/index.ts';
import { ClaudeExternalProvider } from '../../packages/adapters/claude-code/external.ts';
import { nativeContext } from './fixtures/native-context.ts';

test('Claude official history is workspace scoped, read only, and validates transcript identities', async t => {
  const f = nativeContext('claude-code'); const cwd = await realpath(process.cwd());
  const adapter = new ClaudeCodeAdapter('claude-code', { command: 'unused', expectedVersion: '' }, f.context);
  let messages: any[] = [{ session_id: 'native', uuid: 'm1', type: 'assistant', message: { content: [{ type: 'text', text: 'Historical result' }] } }];
  const sdk = {
    listSessions: async (options: any) => { assert.equal(options.dir, cwd); return [{ sessionId: 'native', cwd, summary: 'Owned project' }, { sessionId: 'outside', cwd: join(cwd, 'tests'), summary: 'Other project' }]; },
    getSessionMessages: async () => messages
  };
  t.mock.method(adapter, 'loadSdk', async () => sdk); t.mock.method(adapter, 'checkVersion', async () => {});
  const provider = new ClaudeExternalProvider(adapter);
  const profile = await provider.profile(); assert.equal(profile.discover.state, 'supported'); assert.notEqual(profile.continueManaged.state, 'supported');
  assert.deepEqual((await provider.discover(cwd)).items.map(s => s.nativeId), ['native']);
  assert.equal((await provider.history(cwd, 'native')).items[0].text, 'Historical result');
  await assert.rejects(provider.history(cwd, 'outside'), /mismatch/);
  messages = [{ session_id: 'foreign', uuid: 'm2', type: 'assistant', message: { content: 'wrong' } }];
  await assert.rejects(provider.history(cwd, 'native'), /identity mismatch/);
  await assert.rejects(provider.discover(cwd, '-1'), /cursor/);
});

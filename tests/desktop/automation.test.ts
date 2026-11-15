import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig, type HostConfig, type SetupInput } from '../../apps/desktop/src/host.ts';
import { automationSettings } from '../../apps/gateway/src/automation.ts';

test('desktop configuration accepts explicit automation consent without activating legacy configs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amc-automation-config-'));
  try {
    assert.equal(await readConfig(root), undefined);
    await writeFile(join(root, 'host.config.json'), JSON.stringify({ hostId: 'fixture', name: 'Legacy fixture' }));
    const legacy = await readConfig(root); assert.equal(automationSettings(legacy?.automation).enabled, false);
    const input: Pick<SetupInput, 'automation'> = { automation: { enabled: true, scanIntervalSeconds: 75, excludedDirectoryNames: ['private-project'] } };
    const config: Pick<HostConfig, 'automation'> = { automation: automationSettings(input.automation) };
    await writeFile(join(root, 'host.config.json'), JSON.stringify({ ...legacy, ...config, push: { enabled: false } }));
    const loaded = await readConfig(root); assert.equal(loaded?.automation?.enabled, true); assert.equal(loaded?.automation?.scanIntervalSeconds, 75);
    assert.deepEqual(loaded?.automation?.excludedDirectoryNames, ['private-project']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

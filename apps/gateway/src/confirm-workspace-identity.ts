import { access, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { Store } from './store.ts';
import { Core } from './core.ts';
import { requireValue } from '../../../packages/protocol/src/validation.ts';
import { directoryIdentity } from './workspace-identity.ts';

const { values } = parseArgs({ options: { config: { type: 'string', default: 'host.config.json' }, root: { type: 'string' }, workspace: { type: 'string' }, 'confirm-path': { type: 'string' }, 'confirm-root': { type: 'boolean', default: false } } });
const config = JSON.parse(await readFile(values.config!, 'utf8')) as { hostId: string; dataDir: string; allowedWorkspaceRoots: string[] };
requireValue(config.hostId && config.dataDir && Array.isArray(config.allowedWorkspaceRoots), 'config_invalid', 'Invalid host configuration');
requireValue(values.root && values['confirm-path'] && (!!values.workspace !== values['confirm-root']), 'confirmation_required', 'Supply --root and --confirm-path, and exactly one of --workspace ID or --confirm-root');
const root = resolve(values.root);
requireValue(config.allowedWorkspaceRoots.some(path => resolve(path) === root), 'root_not_granted', 'Root is not configured');
for (const path of config.allowedWorkspaceRoots) directoryIdentity(resolve(path));
const database = join(config.dataDir, 'console.sqlite'); await access(database);
const lockPath = join(process.env.AMC_STATE_DIR || join(homedir(), '.ai-maid-cafe'), 'gateway.lock');
const lock = await open(lockPath, 'wx', 0o600);
let store: Store | undefined;
try {
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  store = new Store(database);
  const core = new Core(store, config.hostId, config.allowedWorkspaceRoots.map(path => resolve(path)));
  if (values['confirm-root']) {
    requireValue(resolve(values['confirm-path']) === root, 'confirmation_mismatch', 'Confirm the exact root path');
    core.workspaceIdentities.confirmRoot(root);
  } else {
    const workspace = store.get<{ path: string; hostId: string }>('workspace', values.workspace!);
    requireValue(workspace && workspace.hostId === config.hostId && workspace.path === resolve(values['confirm-path']), 'confirmation_mismatch', 'Confirm the exact stored workspace path and host');
    core.workspaceIdentities.confirm(values.workspace!, root);
  }
  console.log('Directory identity explicitly confirmed. Existing sessions and grants were retained.');
} finally { store?.close(); await lock.close(); await unlink(lockPath); }

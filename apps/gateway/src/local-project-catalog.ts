import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RuntimeConfig } from '../../../packages/adapters/common/base.ts';
import { isDevEco } from '../../../packages/adapters/opencode/deveco-service.ts';
import type { EngineId } from '../../../packages/protocol/src/types.ts';

// Read project metadata only. Sessions, tool calls and writes continue to use
// the native runtime and its authenticated session binding.
export async function localProjectDirectories(engine: EngineId, runtime: Pick<RuntimeConfig,'command'|'env'>) {
  const env = { ...process.env, ...runtime.env };
  const home = env.USERPROFILE && process.platform === 'win32' ? env.USERPROFILE : env.HOME || homedir();
  const paths = new Set<string>();
  const add = (value: unknown) => { if (typeof value === 'string' && isAbsolute(value) && paths.size < 20000) paths.add(value); };
  async function json(file: string) {
    try {
      const info = await stat(file);
      if (info.isFile() && info.size <= 32 * 1024 * 1024) return JSON.parse(await readFile(file, 'utf8'));
    } catch { /* Missing or changing optional native index. */ }
  }
  async function directories(file: string, queries: string[]) {
    let db: DatabaseSync | undefined;
    try {
      if (!(await stat(file)).isFile()) return;
      db = new DatabaseSync(file, { readOnly: true });
      for (const query of queries) {
        try { for (const row of db.prepare(query).iterate()) add(row.path); }
        catch { /* Some native versions have only one of the tables. */ }
      }
    } catch { /* The runtime can still supply its own catalogue. */ }
    finally { db?.close(); }
  }
  if (engine === 'codex') {
    const dir = env.CODEX_HOME || join(home, '.codex');
    const state = await json(join(dir, '.codex-global-state.json'));
    for (const key of ['project-order','electron-saved-workspace-roots','active-workspace-roots']) {
      if (Array.isArray(state?.[key])) state[key].forEach(add);
    }
    const files = (await readdir(dir).catch(() => [] as string[])).filter(n => /^state_\d+\.sqlite$/.test(n));
    const latest = files.sort((a,b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
    if (latest) await directories(join(dir, latest), ['SELECT DISTINCT cwd AS path FROM threads WHERE archived=0 LIMIT 20000']);
  } else if (engine === 'deepseek-harness') {
    const store = await json(join(env.DSH_HOME || join(home, '.dsh'), 'storages', 'workspace.json'));
    for (const row of Object.values(store?.tables?.workspaces ?? {}) as {path?:unknown}[]) add(row?.path);
  } else if (engine === 'opencode') {
    const deveco = isDevEco(runtime.command);
    const name = deveco ? 'deveco' : 'opencode';
    const file = (deveco ? env.DEVECO_DB : env.OPENCODE_DB) || join(env.XDG_DATA_HOME || join(home, '.local', 'share'), name, name + '.db');
    if (isAbsolute(file)) await directories(file, [
      'SELECT DISTINCT worktree AS path FROM project LIMIT 20000',
      'SELECT DISTINCT directory AS path FROM session WHERE time_archived IS NULL LIMIT 20000'
    ]);
  } else {
    const dir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    const config = await json(join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'));
    Object.keys(config?.projects ?? {}).forEach(add);
    const projects = join(dir, 'projects');
    const entries = await readdir(projects, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const index = await json(join(projects, entry.name, 'sessions-index.json'));
      add(index?.originalPath);
      if (Array.isArray(index?.entries)) for (const session of index.entries) add(session?.projectPath);
    }
  }
  return [...paths];
}

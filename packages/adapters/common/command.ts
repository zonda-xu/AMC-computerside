import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { EngineId } from '../../protocol/src/types.ts';

type Command = { command: string; args: string[] };
const exec = promisify(execFile);

export async function supportsCodexListen(native: Command, env: NodeJS.ProcessEnv): Promise<boolean> {
  const { stdout, stderr } = await exec(native.command, [...native.args, 'app-server', '--help'],
    { env, timeout: 10000, maxBuffer: 131072, windowsHide: true });
  return /(?:^|\s)--listen(?:[\s=<]|$)/m.test(stdout + '\n' + stderr);
}

export async function readCliVersion(engine: EngineId, native: Command, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await exec(native.command, [...native.args, '--version'], { env, timeout: 10000, maxBuffer: 65536, windowsHide: true });
    const label = stdout.trim();
    if (label) return label;
    throw new Error('CLI did not report a version');
  } catch (error) {
    if (engine === 'codex' && await supportsCodexListen(native, env).catch(() => false)) return 'unknown';
    throw error;
  }
}

// Execute npm's Windows JS entry point directly. Never pass user paths through cmd.exe.
export function nativeCommand(command: string, os = process.platform, searchPath = process.env.PATH || process.env.Path || ''): { command: string; args: string[] } {
  if (os !== 'win32') return { command, args: [] };
  let file = command;
  if (!isAbsolute(file)) {
    const extensions = extname(file) ? [''] : ['.exe', '.cmd', ''];
    const found = searchPath.split(delimiter).flatMap(dir => extensions.map(ext => join(dir.replace(/^"|"$/g, ''), file + ext))).find(p => existsSync(p));
    if (found) file = found;
  }
  if (!/\.cmd$/i.test(file)) return { command: file, args: [] };
  if(/(?:^|[\\/])deveco\.cmd$/i.test(file)){
    const executable=join(dirname(file),'node_modules','@deveco','deveco-code','bin','deveco.exe');
    if(existsSync(executable))return {command:executable,args:[]};
  }
  const source = readFileSync(file, 'utf8');
  const match = source.match(/"%(?:dp0|~dp0)%?\\([^"\r\n]+\.(?:c?js|mjs))"/i);
  if (!match) throw new Error('Unsupported Windows command shim; use the native .exe path');
  const entry = resolve(dirname(file), match[1]);
  if (!existsSync(entry)) throw new Error('npm command entry point is missing');
  return { command: process.execPath, args: [entry] };
}

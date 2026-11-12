import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';

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
  const source = readFileSync(file, 'utf8');
  const match = source.match(/"%(?:dp0|~dp0)%?\\([^"\r\n]+\.(?:c?js|mjs))"/i);
  if (!match) throw new Error('Unsupported Windows command shim; use the native .exe path');
  const entry = resolve(dirname(file), match[1]);
  if (!existsSync(entry)) throw new Error('npm command entry point is missing');
  return { command: process.execPath, args: [entry] };
}

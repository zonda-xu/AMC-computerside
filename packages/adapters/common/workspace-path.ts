import { win32 } from 'node:path';

// Windows runtimes can store an ordinary drive or UNC path with the Win32
// extended-length prefix. Other device namespaces and special components
// have different semantics and must not be reinterpreted as project paths.
export function nativeWorkspacePath(path: string, platform = process.platform) {
  if (platform !== 'win32' || !path.startsWith('\\\\?\\')) return path;
  const tail = path.slice(4);
  const plain = /^[a-z]:\\/i.test(tail) ? tail : /^UNC\\[^\\]+\\[^\\]+(?:\\|$)/i.test(tail) ? '\\\\' + tail.slice(4) : undefined;
  if (!plain || plain.split('\\').some(part => /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) return path;
  return plain;
}

export function sameWorkspacePath(left: unknown, right: unknown) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  if (left === right) return true;
  if (process.platform !== 'win32') return false;
  const key = (path: string) => nativeWorkspacePath(path).replaceAll('/', '\\').replace(/^[a-z]:/i, drive => drive.toUpperCase());
  return key(left) === key(right);
}

export function codexWorkspaceFilter(cwd: string) {
  const plain = nativeWorkspacePath(cwd);
  if (process.platform !== 'win32' || !/^(?:[a-z]:[\\/]|\\\\[^\\?.][^\\]*\\[^\\]+)/i.test(plain)) return cwd;
  const extended = win32.toNamespacedPath(plain);
  return extended === plain ? cwd : [plain, extended];
}

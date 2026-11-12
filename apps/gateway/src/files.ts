import { constants } from 'node:fs';
import { mkdir, realpath, lstat, open, readdir, rename, unlink, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, basename, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Attachment, Workspace } from '../../../packages/protocol/src/types.ts';
import { requireValue } from '../../../packages/protocol/src/validation.ts';
import { digest } from './store.ts';
export const MAX_FILE = 16 * 1024 * 1024;
export function inside(root: string, path: string) { const r = relative(root,path); return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)); }
export function overlaps(a: string, b: string) { return inside(a,b) || inside(b,a); }
export async function canonical(path: string) { const p = await realpath(path); requireValue((await stat(p)).isDirectory(),'not_directory','Workspace must be an existing directory'); return p; }
export async function authorizedPath(w: Workspace, path: string) {
  requireValue(!isAbsolute(path) && !path.includes('\0'),'path_invalid','Use a project-relative path');
  const p = await realpath(resolve(w.path,path)); requireValue(inside(w.path,p),'path_escape','Path leaves the project',403); return p;
}
export async function readProject(w: Workspace, path: string, max = 1024 * 1024): Promise<Buffer> {
  const p = await authorizedPath(w,path);
  const f = await open(p,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const st = await f.stat(); const now = await realpath(p); const st2 = await lstat(now);
    requireValue(inside(w.path,now) && st.ino === st2.ino && st.dev === st2.dev && st.isFile(),'file_changed','File changed during authorization',403);
    requireValue(st.size <= max,'file_too_large','File exceeds read limit',413);
    const data = Buffer.alloc(Math.min(st.size + 1,max + 1)); const {bytesRead} = await f.read(data,0,data.length,0);
    requireValue(bytesRead <= max,'file_too_large','File exceeds read limit',413);
    return data.subarray(0,bytesRead);
  } finally { await f.close(); }
}
export async function listProject(w: Workspace, path: string) {
  const p=await authorizedPath(w,path || '.');
  const entries=await readdir(p,{withFileTypes:true});
  return entries.filter(e=>e.name!=='.git').sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name)).slice(0,1000).map(e=>({name:e.name,directory:e.isDirectory(),symlink:e.isSymbolicLink(),path:relative(w.path,join(p,e.name)).split(sep).join('/')}));
}
export async function upload(w: Workspace, name: string, mime: string, data: Buffer): Promise<Attachment> {
  requireValue(data.length > 0 && data.length <= MAX_FILE,'file_too_large','Attachment must be 1 byte–16 MiB',413);
  requireValue(name === basename(name) && !/[\\/\x00-\x1f]/.test(name) && name.length <= 160,'name_invalid','Invalid filename');
  const root = join(w.path,'.ai-maid-cafe','attachments');
  await mkdir(root,{recursive:true,mode:0o700});
  requireValue(inside(w.path,await realpath(root)),'path_escape','Attachment directory leaves project',403);
  const id=randomUUID(); const dir=join(root,id); await mkdir(dir,{mode:0o700});
  const part=join(dir,'.upload'); const destination=join(dir,name);
  const file=await open(part,'wx',0o600);
  try { await file.writeFile(data); await file.sync(); } catch(e) { await unlink(part).catch(()=>{}); throw e; } finally { await file.close(); }
  await rename(part,destination);
  return {id,workspaceId:w.id,name,mime,bytes:data.length,sha256:digest(data),relativePath:relative(w.path,destination).split(sep).join('/')};
}
export async function projectDiff(w: Workspace) {
  const {stdout}=await promisify(execFile)('git',['-C',w.path,'diff','--no-ext-diff','--no-textconv','--','.'],{maxBuffer:1024*1024,timeout:15_000,windowsHide:true});
  return {source:'current_project_worktree',detail:'当前项目差异，可能包含手动修改；不含未跟踪文件',text:stdout};
}

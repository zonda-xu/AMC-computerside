import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Workspace } from '../../../packages/protocol/src/types.ts';
import { authorizedPath, inside } from './files.ts';
import { resultPath } from './artifacts.ts';
import { requireValue } from '../../../packages/protocol/src/validation.ts';

export const MAX_MEDIA = 48 * 1024 * 1024;
const chunkSize = 512 * 1024;
const formats: Record<string,string> = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif',
  '.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm' };

function validHeader(mime: string, b: Buffer) {
  switch (mime) {
    case 'image/png': return b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    case 'image/jpeg': return b[0]===255 && b[1]===216 && b[2]===255;
    case 'image/gif': return /^GIF8[79]a/.test(b.toString('ascii',0,6));
    case 'image/webp': return b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WEBP';
    case 'video/mp4': case 'video/quicktime': return ['ftyp','moov','mdat','wide','free'].includes(b.toString('ascii',4,8));
    case 'video/webm': return b.subarray(0,4).equals(Buffer.from([26,69,223,163]));
    default: return false;
  }
}

export async function readMedia(workspace: Workspace, reference: string, offset: number, revision?: string) {
  const path = resultPath(workspace, reference);
  requireValue(path, 'media_path','媒体必须在当前授权项目内',403);
  const mime = formats[extname(path).toLowerCase()];
  requireValue(mime, 'media_type','该文件类型不支持内嵌预览',415);
  const file = await authorizedPath(workspace,path);
  const fd = await open(file,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await fd.stat({bigint:true});
    const current = await realpath(file);
    const linked = await lstat(current,{bigint:true});
    requireValue(inside(workspace.path,current) && info.isFile() && info.dev===linked.dev && info.ino===linked.ino,
      'media_changed','媒体文件位置已变化',409);
    const bytes = Number(info.size);
    requireValue(bytes>0 && bytes<=MAX_MEDIA,'media_size','单个预览文件最多 48 MiB',413);
    const stamp = createHash('sha256').update([current,info.dev,info.ino,info.mtimeNs,info.ctimeNs,info.size].join('|')).digest('hex');
    requireValue(Number.isSafeInteger(offset) && offset>=0 && offset<bytes && (offset===0 || revision===stamp),
      'media_changed','媒体已变化或读取位置无效，请重新打开',409);
    const data = Buffer.alloc(Math.min(chunkSize,bytes-offset)); let filled = 0;
    while (filled<data.length) {
      const read = await fd.read(data,filled,data.length-filled,offset+filled);
      requireValue(read.bytesRead>0,'media_changed','读取期间文件被截断',409); filled+=read.bytesRead;
    }
    if (offset===0) requireValue(validHeader(mime,data),'media_format','媒体格式与扩展名不符',415);
    const end = await fd.stat({bigint:true});
    requireValue(end.size===info.size && end.mtimeNs===info.mtimeNs && end.ctimeNs===info.ctimeNs,'media_changed','读取期间文件发生变化',409);
    return {path,name:basename(path),mime,bytes,offset,next:offset+filled,revision:stamp,data:data.toString('base64')};
  } finally { await fd.close(); }
}

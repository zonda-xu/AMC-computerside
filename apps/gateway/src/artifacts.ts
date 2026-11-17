import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Session, Workspace } from '../../../packages/protocol/src/types.ts';
import { authorizedPath, inside, MAX_FILE, readProject } from './files.ts';
import { requireValue } from '../../../packages/protocol/src/validation.ts';

export interface ResultFile { id:string; path:string; name:string; kind:'image'|'table'|'text'|'file'; bytes:number; source:string }
export interface FilePreview { name:string; path:string; kind:ResultFile['kind']; mime:string; bytes:number; text?:string; data?:string; columns?:string[]; rows?:string[][]; truncated?:boolean; detail?:string }
const textExtensions=new Set(['.txt','.md','.markdown','.json','.yaml','.yml','.xml','.html','.css','.js','.ts','.py','.log','.r','.rmd','.ipynb','.svg','.sh','.toml','.sql']);
function fileKind(path:string):ResultFile['kind']{const ext=extname(path).toLowerCase();return ['.png','.jpg','.jpeg','.webp','.gif'].includes(ext)?'image':['.csv','.tsv'].includes(ext)?'table':textExtensions.has(ext)?'text':'file';}

// Decode only references, never whole message text. All referenced paths still
// pass the same realpath/workspace authorization used by the file browser.
export function resultPath(workspace:Workspace, value:string):string|undefined{
  let path=value.trim();
  if(path.startsWith('<')&&path.endsWith('>'))path=path.slice(1,-1);
  try{path=decodeURIComponent(path);}catch{return;}
  if(/^file:\/\//i.test(path)){
    try{const url=new URL(path);if(url.hostname&&url.hostname!=='localhost')return;path=url.pathname;if(/^\/[A-Za-z]:/.test(path))path=path.slice(1);}catch{return;}
  }
  if(/^(?:https?|data|javascript|content|sandbox):/i.test(path)||path.includes('\0'))return;
  path=path.replace(/#.*$/,'');
  if(!path||path.startsWith('\\\\')||path.startsWith('//'))return;
  const absolute=resolve(workspace.path,path);
  if(!inside(workspace.path,absolute))return;
  if(!isAbsolute(path)&&/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path))return;
  return relative(workspace.path,absolute).split(sep).join('/');
}
export function referencedFiles(session:Session):string[]{
  const lastUser=session.messages.findLastIndex(m=>m.role==='user');
  const messages=session.messages.slice(Math.max(0,lastUser)).filter(m=>m.role==='assistant'&&!m.abandoned&&!m.temporary&&(!m.runId||m.runId===session.runId));
  const refs:string[]=[];
  for(const m of messages){
    for(const match of m.text.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g))refs.push(match[1]);
    for(const match of m.text.matchAll(/`([^`\n]+\.[A-Za-z0-9]{1,12})`/g))refs.push(match[1]);
  }
  function collect(value:unknown,depth=0){
    if(depth>7||refs.length>=200||!value||typeof value!=='object')return;
    if(Array.isArray(value)){for(const item of value.slice(0,100))collect(item,depth+1);return;}
    for(const [key,item]of Object.entries(value)){
      if(['path','file_path','filePath','relativePath','outputPath','url'].includes(key)&&typeof item==='string')refs.push(item);
      else if(item&&typeof item==='object')collect(item,depth+1);
    }
  }
  collect(session.result);
  for(const t of session.tools.filter(t=>t.runId===session.runId&&!!t.runId)){try{collect(JSON.parse(t.detail));}catch{}}
  return [...new Set(refs)].slice(0,100);
}
export async function sessionArtifacts(session:Session,workspace:Workspace):Promise<ResultFile[]>{
  const paths=[...new Set(referencedFiles(session).map(r=>resultPath(workspace,r)).filter((p):p is string=>!!p))];
  const results=await Promise.all(paths.map(async path=>{
    try{const file=await authorizedPath(workspace,path);const info=await stat(file);if(!info.isFile())return;
      return{id:createHash('sha256').update(session.id+'\0'+path).digest('hex'),path,name:basename(path),kind:fileKind(path),bytes:info.size,source:'任务引用的工作区文件'} satisfies ResultFile;
    }catch{return;}
  }));
  return results.filter((r):r is ResultFile=>!!r);
}
export function parseDelimited(text:string,delimiter:string):{columns:string[];rows:string[][];truncated:boolean}{
  const rows:string[][]=[];let row:string[]=[];let cell='';let quoted=false;let truncated=false;
  const push=()=>{if(row.length<30)row.push(cell.slice(0,4000));else truncated=true;cell='';};
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(quoted||!cell)quoted=!quoted;else cell+=c;}
    else if(!quoted&&c===delimiter)push();
    else if(!quoted&&(c==='\r'||c==='\n')){if(c==='\r'&&text[i+1]==='\n')i++;push();rows.push(row);row=[];if(rows.length>=201){truncated=i<text.length-1;break;}}
    else{if(cell.length<4001)cell+=c;else truncated=true;}
  }
  if((cell||row.length)&&rows.length<201){push();rows.push(row);}
  return{columns:rows.shift()||[],rows,truncated};
}
function imageMime(data:Buffer):string{
  if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';
  if(data[0]===255&&data[1]===216&&data[2]===255)return'image/jpeg';
  if(data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP')return'image/webp';
  if(/^GIF8[79]a/.test(data.subarray(0,6).toString()))return'image/gif';
  return'';
}
export async function previewProject(workspace:Workspace,path:string):Promise<FilePreview>{
  const file=await authorizedPath(workspace,path);const info=await stat(file);requireValue(info.isFile(),'not_file','Preview requires a file');
  const kind=fileKind(path);const base:FilePreview={name:basename(path),path,kind,mime:'application/octet-stream',bytes:info.size};
  if(kind==='file'||info.size>(kind==='image'?MAX_FILE:1024*1024))return{...base,kind:'file',detail:info.size>MAX_FILE?'文件超过 16 MiB，请在主机查看':'可保存到设备后使用对应应用打开'};
  const data=await readProject(workspace,path,kind==='image'?MAX_FILE:1024*1024);
  if(kind==='image'){const mime=imageMime(data);requireValue(mime,'invalid_image','Image file signature is invalid');return{...base,mime,data:data.toString('base64')};}
  const text=data.toString('utf8').replace(/^\uFEFF/,'');
  if(kind==='table')return{...base,mime:'text/plain',...parseDelimited(text,extname(path).toLowerCase()==='.tsv'?'\t':',')};
  return{...base,mime:'text/plain',text:text.slice(0,200000),truncated:text.length>200000};
}

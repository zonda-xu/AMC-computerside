import { readFile, readdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
async function walk(root){return(await Promise.all((await readdir(root,{withFileTypes:true})).filter(e=>!['node_modules','.git','build','oh_modules','dist','output','.impeccable'].includes(e.name)).map(e=>e.isDirectory()?walk(join(root,e.name)):join(root,e.name)))).flat();}
const files=await walk('.');let count=0;
for(const f of files){
  if(f.endsWith('.ts')){
    const parsed=ts.createSourceFile(f,await readFile(f,'utf8'),ts.ScriptTarget.Latest,true);if(parsed.parseDiagnostics.length)throw new Error(f+': '+ts.flattenDiagnosticMessageText(parsed.parseDiagnostics[0].messageText,' '));count++;
  }
  if(f.endsWith('.mjs')){const r=spawnSync(process.execPath,['--check',f],{encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);count++;}
  if(f.endsWith('.json'))JSON.parse(await readFile(f,'utf8'));
  if(f.endsWith('.ets')){
    const s=await readFile(f,'utf8');if(/(?:\bas\s+|:\s*)(any|unknown)\b/.test(s))throw new Error('Dynamic type in ArkTS '+f);
    for(const m of s.matchAll(/from ['"]([^'"]+)['"]/g)){if(m[1].startsWith('.'))await access(resolve(dirname(f),m[1]+'.ets'));}
    for(const m of s.matchAll(/\$rawfile\(['"]([^'"]+)['"]\)/g))await access(join('apps/harmony/entry/src/main/resources/rawfile',m[1]));
    count++;
  }
}
console.log(`Inspected ${count} source files, JSON, ArkTS import paths and static resources. No code emitted; Harmony compiler was not run.`);

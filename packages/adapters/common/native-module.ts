import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function loadNativeModule(specifier:string,name:string,pinnedVersion?:string){
  const resolved=import.meta.resolve(specifier);
  let directory=dirname(fileURLToPath(resolved));
  while(true){
    let manifest:{name?:string;version?:string}|undefined;
    try{manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(manifest?.name===name){
      if(pinnedVersion && manifest.version!==pinnedVersion)throw new Error(`${name}@${pinnedVersion} required; found ${manifest.version}`);
      return import(resolved);
    }
    const parent=dirname(directory);
    if(parent===directory)throw new Error(`${specifier} is not provided by ${name}`);
    directory=parent;
  }
}

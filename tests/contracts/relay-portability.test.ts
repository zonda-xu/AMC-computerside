import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toml } from '../../deploy/easytier/render.mjs';

test('relay transport depends on the network profile rather than cloud vendor identity',async()=>{
  const profile=JSON.parse(await readFile(new URL('../../deploy/easytier/profile.example.json',import.meta.url),'utf8'));
  const first=toml({...profile,relayPublicHost:'relay.vendor-a.example'},'a'.repeat(43));
  const second=toml({...profile,relayPublicHost:'relay.vendor-b.example'},'a'.repeat(43));
  assert.equal(first,second);
  for(const mapping of ['10.89.90.3:8899','10.89.90.4:8899','10.89.90.2:8899'])assert.ok(first.includes(mapping));
  assert.equal(first.includes('private_key'),false);assert.equal(first.includes('certificate'),false);
});

test('relay renderer CLI works with native filesystem paths and never overwrites an existing secret config',async t=>{
  const root=await mkdtemp(join(tmpdir(),'relay-portability-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const profile=await readFile(new URL('../../deploy/easytier/profile.example.json',import.meta.url),'utf8');
  const input=join(root,'profile.json'),output=join(root,'rendered');await writeFile(input,profile);
  const script=fileURLToPath(new URL('../../deploy/easytier/render.mjs',import.meta.url));
  await promisify(execFile)(process.execPath,[script,input,output],{env:{...process.env,ET_NETWORK_SECRET:'a'.repeat(43)}});
  const rendered=await readFile(join(output,'relay.toml'),'utf8');assert.ok(rendered.includes('proto = "tcp"'));
  await assert.rejects(promisify(execFile)(process.execPath,[script,input,output],{env:{...process.env,ET_NETWORK_SECRET:'b'.repeat(43)}}));
  assert.equal(await readFile(join(output,'relay.toml'),'utf8'),rendered);
});

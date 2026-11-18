import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fixture } from '../helpers.ts';
import { desktopCatalog } from '../../apps/gateway/src/desktop-catalog.ts';
import { MAX_MEDIA, readMedia } from '../../apps/gateway/src/media.ts';
import { transcriptRemoval } from '../../packages/adapters/claude-code/origin.ts';
import { CageBrowser, validatePublicLink } from '../../apps/gateway/src/browser-link.ts';

test('desktop and mobile share revisioned catalog, offline restore and retry-only native deletion',async t=>{
  const f=await fixture();t.after(f.close);
  const desktop=(data:Record<string,unknown>,online=true)=>desktopCatalog(f.core,{id:f.s.id,...data},online);
  const edit=(action:'archive'|'restore'|'delete'|'pin',revision:number)=>f.core.editSession(f.s.id,{action,revision,confirmNativeId:f.s.ref.nativeSessionId});
  const renames=await Promise.allSettled([desktop({operation:'edit',change:{action:'rename',title:'回头客',revision:0}}),edit('pin',0)]);
  assert.deepEqual(renames.map(r=>r.status),['fulfilled','rejected']);
  let released=0, attempts=0;
  Object.assign(f.adapter,{releaseSession:async()=>{released++;},prepareDelete:async()=>async()=>{if(++attempts===1)throw Error('temporary native failure');}});
  await edit('archive',1);assert.equal(released,1);
  assert.equal(f.core.session(f.s.id).archived,true);
  const archived=await desktop({operation:'list'},false) as {items:Array<{id:string;title:string;archived:boolean}>};
  assert.ok(archived.items.some(s=>s.id===f.s.id&&s.title==='回头客'&&s.archived));
  await assert.rejects(desktop({operation:'edit',change:{action:'delete',revision:2,confirmNativeId:f.s.ref.nativeSessionId}},false));
  await desktop({operation:'edit',change:{action:'restore',revision:2}},false);
  await edit('archive',3);
  await assert.rejects(edit('delete',4),/temporary native failure/);
  assert.equal(f.core.session(f.s.id).deletionPending,true);
  await assert.rejects(edit('restore',4),/只能重试/);
  await edit('delete',4);assert.equal(f.store.get('session',f.s.id),undefined);
  await edit('delete',4);assert.equal(attempts,2);
});

test('archiving cannot interrupt a run or consume a pending approval',async t=>{
  const f=await fixture();t.after(f.close);
  f.adapter.context.emit(f.s.id,'run.updated',{state:'running'});
  await assert.rejects(f.core.editSession(f.s.id,{action:'archive',revision:0}),/仍在制作/);
  assert.equal(f.core.session(f.s.id).archived,undefined);
});

test('media chunks enforce exact 48 MiB limit, project, file identity and signatures',async t=>{
  const f=await fixture();t.after(f.close);
  const file=join(f.w.path,'frappe.png');
  const fd=await open(file,'w');
  try {await fd.write(Buffer.from([137,80,78,71,13,10,26,10]));await fd.truncate(MAX_MEDIA);}finally{await fd.close();}
  const first=await readMedia(f.w,'frappe.png',0);
  assert.equal(first.bytes,MAX_MEDIA);assert.equal(first.next,512*1024);
  const last=await readMedia(f.w,'frappe.png',MAX_MEDIA-1,first.revision);assert.equal(last.next,MAX_MEDIA);
  await rename(file,file+'.old');await writeFile(file,Buffer.from('not a png'));
  await assert.rejects(readMedia(f.w,'frappe.png',1,first.revision),/已变化/);
  await assert.rejects(readMedia(f.w,'frappe.png',0),/格式/);
  await assert.rejects(readMedia(f.w,'../b/other.png',0));
  const bigger=await open(file,'r+');try{await bigger.truncate(MAX_MEDIA+1);}finally{await bigger.close();}
  await assert.rejects(readMedia(f.w,'frappe.png',0),/48 MiB/);
  await writeFile(join(f.w.path,'drink.mov'),Buffer.from([0,0,0,16,102,116,121,112,113,116,32,32,0,0,0,0]));
  assert.equal((await readMedia(f.w,'drink.mov',0)).mime,'video/quicktime');
});

test('Claude purge checks original project and removes only that transcript and its subagents',async t=>{
  const f=await fixture();t.after(f.close);
  const root=join(f.dir,'claude-projects'), project=join(root,'project'), id=randomUUID(), other=randomUUID();
  const child=join(project,id,'subagents');await mkdir(child,{recursive:true});
  const file=join(project,id+'.jsonl'),neighbor=join(project,other+'.jsonl');
  await writeFile(file,JSON.stringify({sessionId:id,cwd:f.w.path})+'\n');
  await writeFile(neighbor,'keep');await writeFile(join(child,'agent-one.jsonl'),'temporary child');
  await assert.rejects(transcriptRemoval(root,id,f.wb.path,false),/无法核验/);
  await (await transcriptRemoval(root,id,f.w.path,false))();
  await assert.rejects(readFile(file));await assert.rejects(readFile(join(child,'agent-one.jsonl')));
  assert.equal(await readFile(neighbor,'utf8'),'keep');
  await (await transcriptRemoval(root,id,f.w.path,true))();
});

test('public link uses the paired Cage browser, checks the acknowledgment and reuses the official cookie',async t=>{
  const f=await fixture();t.after(f.close);
  let boot=0,opened=0;let port=0;
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.origin,'http://127.0.0.1:'+port);
    const parts=[];for await(const part of req)parts.push(part);
    const body=JSON.parse(Buffer.concat(parts).toString());
    if(req.url==='/link-session'){
      boot++;assert.equal(body.token,'synthetic-entry-secret-12345');
      res.writeHead(204,{'Set-Cookie':'cage_mobile_link_'+port+'=synthetic_cookie; HttpOnly; SameSite=Strict'});res.end();return;
    }
    assert.equal(req.url,'/api/mobile/browser/open');assert.equal(req.headers.cookie,'cage_mobile_link_'+port+'=synthetic_cookie');
    assert.equal(body.url,'https://example.com/menu');opened++;
    res.end(JSON.stringify({id:opened===3?'other':body.id}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');port=(server.address() as {port:number}).port;
  t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  const file=join(f.dir,'launch.html');await writeFile(file,'<meta content="0;url=http://127.0.0.1:'+port+'/link-bootstrap#synthetic-entry-secret-12345">');
  const browser=new CageBrowser();assert.equal((await browser.open(file,'https://example.com/menu')).browser,'Cage');
  await browser.open(file,'https://example.com/menu');await assert.rejects(browser.open(file,'https://example.com/menu'),/未确认/);
  assert.equal(boot,1);assert.equal(opened,3);
  await assert.rejects(validatePublicLink('http://127.0.0.1/private'),/公网/);
});

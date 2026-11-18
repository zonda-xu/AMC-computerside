import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Core } from '../../apps/gateway/src/core.ts';
import { type ProjectPolicy } from '../../apps/gateway/src/native-projects.ts';
import { closedProfile, type ExternalSessionProvider } from '../../packages/adapters/common/external.ts';
import { type EngineId } from '../../packages/protocol/src/types.ts';
import { fixture, TestAdapter } from '../helpers.ts';

function source(engineId: EngineId, pages: string[][]): ExternalSessionProvider {
  return {
    engineId, projectDirectories: async cursor => {
      const i = Number(cursor ?? 0);
      return { paths:pages[i], cursor:i+1<pages.length ? String(i+1) : undefined };
    },
    profile: async () => ({...closedProfile(engineId,'fixture','test'), profile:'fixture', namespace:engineId,
      discover:{state:'supported',reason:'fixture'}, history:{state:'supported',reason:'fixture'}}),
    discover: async cwd => ({items:[{nativeId:'original-'+engineId,title:'PC order',cwd}]}),
    history: async () => ({items:[]})
  };
}

test('native directories across platforms keep their original sessions and separate creation authority', async () => {
  const f = await fixture();
  try {
    const destination = join(f.dir,'new-projects'), manual = join(f.dir,'manual'), nested = join(f.w.path,'nested');
    await Promise.all([destination,manual,nested].map(path=>mkdir(path)));
    const policy: ProjectPolicy = {creationRoot:destination,syncEngines:['codex','opencode','claude-code','deepseek-harness'],manualProjects:[manual],excludedProjects:[]};
    const core = new Core(f.store,f.core.hostId,[],policy);
    core.adapters.set('codex',new TestAdapter(core.context('codex')));
    core.external.providers.set('codex',source('codex',[[f.w.path],[nested]]));
    core.external.providers.set('opencode',source('opencode',[[f.w.path,f.wb.path]]));
    core.external.providers.set('claude-code',source('claude-code',[[nested]]));
    core.external.providers.set('deepseek-harness',source('deepseek-harness',[[nested]]));
    await Promise.all([core.projects.refresh(),core.projects.refresh()]);
    const list=core.visibleWorkspaces();
    assert.equal(list.length,4);
    assert.deepEqual(core.workspace(f.w.id).engines?.sort(),['codex','opencode']);
    assert.deepEqual(list.find(w=>w.path===nested)?.engines?.sort(),['claude-code','codex','deepseek-harness']);
    assert.equal(list.find(w=>w.path===manual)?.engines,undefined);
    assert.throws(()=>core.workspace(f.wb.id,'codex'));
    await assert.rejects(core.registerWorkspace(join(f.dir,'projects'),'Parent'));
    const page=await core.external.discover(f.w.id,'codex');
    assert.equal(page.items.length,1);
    const original=await core.external.ensureImport(page.items[0].candidateId);
    assert.equal(original.ref.nativeSessionId,'original-codex');
    const fresh=await core.createSession('phone','new-order',f.w.id,'codex');
    assert.notEqual(fresh.id,original.id);
    assert.equal(fresh.cwd,f.w.path);
    const roots=await core.workspaceCreator.roots();
    assert.deepEqual(roots.map(r=>r.rootId),[core.workspaceCreator.rootId(destination)]);
    await assert.rejects(core.workspaceCreator.create('phone','wrong',core.workspaceCreator.rootId(f.w.path),'sibling','Sibling'));
    const newProject=await core.workspaceCreator.create('phone','right',roots[0].rootId,'order','New order');
    assert.equal(newProject.path,join(destination,'order'));
    await mkdir(join(destination,'unrelated'));
    await assert.rejects(core.registerWorkspace(join(destination,'unrelated'),'Unrelated'));
    const restarted = new Core(f.store,f.core.hostId,[],policy);
    assert.equal(restarted.workspace(f.w.id,'codex').id,f.w.id);
    assert.equal(restarted.workspace(newProject.id,'opencode').id,newProject.id);
    assert.equal(restarted.session(original.id).ref.nativeSessionId,'original-codex');
    const excluded = new Core(f.store,f.core.hostId,[],{...policy,excludedProjects:[f.w.path]});
    assert.throws(()=>excluded.workspace(f.w.id));
    assert.ok(excluded.visibleWorkspaces().some(w=>w.path===manual));
    await rename(nested,nested+'-moved');await mkdir(nested);
    assert.throws(()=>restarted.workspace(list.find(w=>w.path===nested)!.id));
  } finally { await f.close(); }
});

test('an interrupted native list retains the last complete grant, and a successful empty list revokes it',async()=>{
  const f=await fixture();
  try {
    const core=new Core(f.store,f.core.hostId,[],{creationRoot:f.dir,syncEngines:['codex'],manualProjects:[],excludedProjects:[]});
    const provider=source('codex',[[f.w.path]]);
    core.external.providers.set('codex',provider);
    await core.projects.refresh();
    provider.projectDirectories=async()=>({paths:[],cursor:'repeated'});
    await core.projects.refresh();
    assert.ok(core.workspace(f.w.id));
    assert.match(core.projects.status.get('codex')!,/分页/);
    provider.projectDirectories=async()=>({paths:[]});
    await core.projects.refresh();
    assert.throws(()=>core.workspace(f.w.id));
    assert.equal(f.store.get('session',f.s.id)!==undefined,true);
  } finally { await f.close(); }
});

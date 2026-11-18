import type { Core } from './core.ts';
import { catalogEntry, type LibraryChange } from './session-library.ts';
import { isAbsolute } from 'node:path';
import { ENGINES, type EngineId, type Session, type Workspace } from '../../../packages/protocol/src/types.ts';
import { string, requireValue } from '../../../packages/protocol/src/validation.ts';

export async function desktopCatalog(core: Core, input: Record<string,unknown>, online: boolean) {
  if (input.operation==='list') {
    const workspaces=core.visibleWorkspaces();
    const ids=new Map(workspaces.map(w=>[w.id,w]));
    return {online,hostId:core.hostId,workspaces:workspaces.map(w=>({id:w.id,name:w.name,engines:w.engines})),items:core.store.list<Session>('session').filter(s=>ids.has(s.ref.workspaceId) && (ids.get(s.ref.workspaceId)?.engines?.includes(s.ref.engineId) ?? true)).map(catalogEntry)};
  }
  if (input.operation==='project-sync') {
    await core.projects.refresh();
    return { projects:core.projects.known(), status:Object.fromEntries(core.projects.status) };
  }
  if (input.operation==='browser-config') {
    const path=string(input.path,'path',4096);
    requireValue(isAbsolute(path) && /\.html?$/i.test(path),'cage_entry','请选择电脑上的 Cage HTML 入口');
    core.store.put('host-preference','cage-browser',{path}); return {saved:true};
  }
  if (input.operation==='register') {
    requireValue(online,'offline','请先启动网关');
    return core.registerWorkspace(string(input.path,'path',4096),string(input.name,'name',100));
  }
  if (input.operation==='create' || input.operation==='discover') {
    requireValue(online,'offline','请先启动网关',409);
    const project=core.workspace(string(input.workspaceId,'workspaceId',160));
    const engine=string(input.engine,'engine',32) as EngineId;
    requireValue(ENGINES.includes(engine),'engine_invalid','请选择已登记的平台');
    if (input.operation==='discover') return core.external.discover(project.id,engine,typeof input.cursor==='string'?input.cursor:undefined);
    return catalogEntry(await core.createSession('desktop',string(input.requestId,'requestId',128),project.id,engine));
  }
  if (input.operation==='import') {
    requireValue(online,'offline','请先连接原生运行时',409);
    return catalogEntry(await core.external.ensureImport(string(input.candidateId,'candidateId',128)));
  }
  if (input.operation==='receipt') return core.store.getReceipt('desktop',string(input.requestId,'requestId',128)) ?? null;
  const id=string(input.id,'id',160);
  if (input.operation==='edit') {
    const change=input.change as LibraryChange;
    requireValue(change && (online || change.action==='restore'),'offline','此操作需要网关在线',409);
    return core.editSession(id,change);
  }
  const s=core.session(id); core.workspace(s.ref.workspaceId,s.ref.engineId);
  if (input.operation==='read') return {...s,messages:s.messages.slice(-100),tools:s.tools.slice(-100)};
  requireValue(online && !s.archived,'offline','请启动网关并恢复会话',409);
  if (input.operation==='open') {
    const a=core.adapters.get(s.ref.engineId);
    if (s.externalSource && (!s.binding || s.binding.state==='unbound')) {
      await core.external.sync(s.id);
      if ((await a?.probe())?.controlCapabilities?.attach) {
        await core.attachExisting('desktop',id,{protocolVersion:2,hostId:core.hostId,clientRequestId:string(input.requestId,'requestId',128),runtimeInstanceId:core.context(s.ref.engineId).runtimeInstanceId,ref:s.ref});
      }
    } else if (s.binding?.state==='disconnected') await core.reconcile(id);
    return {id};
  }

  requireValue(input.operation==='command','invalid_operation','未知的会话操作');
  requireValue(input.generation===s.binding?.generation,'stale_generation','会话连接已更新，请重新查看',409);
  return core.accept('desktop',{protocolVersion:2,hostId:core.hostId,sessionId:id,ref:s.ref,clientRequestId:string(input.requestId,'requestId',128),
    action:input.action,payload:input.payload});
}

import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { ExternalMessage, ExternalProfile, ExternalTool } from '../../protocol/src/types.ts';
import type { DiscoveryPage, ExternalSessionProvider } from '../common/external.ts';
import { closedProfile } from '../common/external.ts';
import { requireValue } from '../../protocol/src/validation.ts';
import { ClaudeCodeAdapter } from './index.ts';

/** Official SDK transcript access does not assert ownership of an external CLI. */
export class ClaudeExternalProvider implements ExternalSessionProvider {
  engineId='claude-code' as const;
  adapter:ClaudeCodeAdapter;
  constructor(adapter:ClaudeCodeAdapter){this.adapter=adapter;}
  async profile():Promise<ExternalProfile>{
    const profile=closedProfile(this.engineId,'','Claude 外部 CLI 的运行状态与控制句柄未提供；可读取历史，已由本主机管理的会话可继续');
    try{
      const sdk=await this.adapter.loadSdk(false);await this.adapter.checkVersion();
      profile.version=this.adapter.observedVersion;
      if(typeof sdk.listSessions!=='function'||typeof sdk.getSessionMessages!=='function')return profile;
      profile.profile='claude-official-sdk-transcripts';profile.namespace=createHash('sha256').update(JSON.stringify([this.adapter.context.runtimeInstanceId,this.adapter.config.executablePath,this.adapter.config.env?.CLAUDE_CONFIG_DIR||'default'])).digest('hex');
      profile.discover={state:'supported',reason:'Official SDK listSessions, scoped to the authorized project'};
      profile.history={state:'supported',reason:'Official SDK getSessionMessages with stable message UUIDs'};
      profile.observe={state:'supported',reason:'Manual transcript refresh; does not imply live control'};
      profile.coverage='原生用户与助手历史消息；不会据历史消息猜测运行终态';profile.syncMode='manual-refresh';
    }catch{}
    return profile;
  }
  async projectDirectories() {
    const sdk = await this.adapter.loadSdk(false);
    await this.adapter.checkVersion();
    const rows = await sdk.listSessions();
    requireValue(Array.isArray(rows) && rows.length <= 50000, 'external_format', 'Claude 会话目录列表不可用');
    const paths = new Set<string>();
    for (const row of rows) if (typeof row.cwd === 'string' && row.cwd) paths.add(row.cwd);
    return { paths: [...paths] };
  }
  async discover(cwd:string,cursor?:string):Promise<DiscoveryPage>{
    requireValue((await this.profile()).discover.state==='supported','external_unavailable','Claude SDK history unavailable',409);
    const offset=cursor?Number(cursor):0;requireValue(Number.isSafeInteger(offset)&&offset>=0&&offset<=5000,'external_cursor','Invalid history cursor');
    const sdk=await this.adapter.loadSdk(false);const items=await sdk.listSessions({dir:cwd,includeWorktrees:false});requireValue(Array.isArray(items)&&items.length<=10000,'external_format','Invalid Claude session list');
    const matches=[];for(const item of items){if(typeof item.sessionId!=='string'||typeof item.cwd!=='string')continue;if(await realpath(item.cwd).catch(()=>'')!==cwd)continue;matches.push({nativeId:item.sessionId,cwd,title:String(item.summary||item.customTitle||'Claude Code')});}
    return{items:matches.slice(offset,offset+100),cursor:offset+100<matches.length?String(offset+100):undefined};
  }
  async history(cwd:string,nativeId:string,cursor?:string){
    const sdk=await this.adapter.loadSdk(false);const sessions=await sdk.listSessions({dir:cwd,includeWorktrees:false});
    const info=sessions.find((s:any)=>s.sessionId===nativeId);
    requireValue(info&&typeof info.cwd==='string'&&await realpath(info.cwd).catch(()=>'')===cwd,'source_changed','Claude session/workspace mismatch',409);
    const offset=cursor?Number(cursor):0;requireValue(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,'external_cursor','Invalid message cursor');
    const messages=await sdk.getSessionMessages(nativeId,{dir:cwd,limit:100,offset});requireValue(Array.isArray(messages)&&messages.length<=100,'external_format','Invalid Claude transcript page');
    const items:ExternalMessage[]=[]; const tools:ExternalTool[]=[];
    for(const m of messages){
      requireValue(m.session_id===nativeId && typeof m.uuid==='string','source_changed','Claude transcript identity mismatch',409);
      if(!['user','assistant'].includes(m.type)) continue;
      const content=m.message?.content;
      if(Array.isArray(content)) for(const block of content){
        if(block.type==='tool_use' && typeof block.id==='string'){
          tools.push({id:block.id,title:String(block.name||'工具调用').slice(0,500),status:'running',detail:JSON.stringify(block.input||{}).slice(0,8192)});
        } else if(block.type==='tool_result' && typeof block.tool_use_id==='string'){
          const result=typeof block.content==='string'?block.content:Array.isArray(block.content)?block.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n'):'';
          tools.push({id:block.tool_use_id,status:block.is_error?'failed':'completed',detail:result.slice(0,8192)});
        }
      }
      if(m.parent_tool_use_id) continue;
      const text=typeof content==='string'?content:Array.isArray(content)?content.filter((c:any)=>c.type==='text'&&typeof c.text==='string').map((c:any)=>c.text).join('\n'):'';
      if(text)items.push({nativeEventId:m.uuid,role:m.type,text});
    }
    return{items,...(tools.length?{tools}:{}),cursor:messages.length===100?String(offset+100):undefined};
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { controllerBridge } from '../../plugins/dsh-bridge/controller.mjs';
import { controllerEvidence, controllerProfile } from '../../plugins/dsh-bridge/profile.mjs';
import { decodeRequestIdentity, humanUserEvent, modelCatalog, resolveAgent, validateFollowFrame } from '../../plugins/dsh-bridge/features.mjs';
import { DshAdapter } from '../../packages/adapters/deepseek-harness/index.ts';
import { DshExternalProvider } from '../../packages/adapters/deepseek-harness/external.ts';
import { nativeContext } from './fixtures/native-context.ts';

function host() {
  const events:any[]=[];const prompts:any[]=[];const uploads:any[]=[];const commands:any[]=[];const membership:string[]=[];
  const agent={id:'native',session:{id:'native',header:{origin:'user'},snapshotEvents:()=>events},inbox:{nextTurn:[],nextStep:[]},steer() {}};
  const ctl:any={
    create:async()=>({sessionId:'native'}),list:async()=>({items:[{sessionId:'native'}]}),
    page:async()=>({records:[],hasMore:false}),async *follow(){},projections:async()=>({kind:'sequenced',asOfSeq:-1}),cancel:()=>({accepted:true}),
    prompt:async(p:any)=>{prompts.push(p);events.push({type:'agent/inbox/spliced',data:{inserted:[{source:{kind:'user',rpcId:p.requestId}}]}});return {accepted:true};},
    modelCatalog:async()=>({groups:[{id:'deepseek',models:[{id:'chat',name:'Chat',reasoning:{efforts:[{id:'high'}]}}]}]}),
    selectModel:async(p:any)=>({selected:{provider:p.provider,model:p.model,reasoningEffort:p.reasoningEffort}}),
    resolveAgent:async()=>({agent})
  };
  const services:any={sessionController:ctl,agents:{get:()=>agent},attachments:{admitPromptContent:async(x:any)=>x},fileUploads:{upload:async(a:any,p:any)=>{assert.equal(a,agent);uploads.push(p);return{receiptId:'file-receipt'};}},commands:{list:async()=>[{name:'compact'}],execute:async(a:any,line:string,parts:any)=>{assert.equal(a,agent);commands.push({line,parts});return{status:'completed'};}},userQuestions:{ask(){}},approval:{},workspaceRegistry:{resolveByPath:async()=>({id:'workspace',attachSession:async(id:string)=>{membership.push(id);}}),create:async()=>{throw new Error('already exists');}}};
  const ctx:any={get:(key:string)=>services[key],on:()=>()=>{}};
  return {ctx,ctl,services,agent,events,prompts,uploads,commands,membership};
}
function upload(name:string,mime:string,text='payload') { const bytes=Buffer.from(text);return{name,mime,dataBase64:bytes.toString('base64'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}; }

test('DSH bundled controller enables detected capabilities without pinned package hash, using only a passive probe',async()=>{
  const h=host();const evidence=await controllerEvidence(h.ctl,h.ctx);
  assert.equal(evidence.apiProfile,controllerProfile);assert.equal(evidence.verified,false);
  assert.equal(evidence.capabilities.files,true);assert.equal(evidence.capabilities.configure,true);assert.equal(evidence.capabilities.slash,true);assert.equal(h.prompts.length,0);
  delete h.services.fileUploads;delete h.services.commands;delete h.ctl.selectModel;
  const reduced=await controllerEvidence(h.ctl,h.ctx);assert.equal(reduced.apiProfile,controllerProfile);assert.equal(reduced.capabilities.files,false);assert.equal(reduced.capabilities.slash,false);assert.equal(reduced.capabilities.configure,false);
  h.ctl.list=async()=>({unknown:[]});assert.equal((await controllerEvidence(h.ctl,h.ctx)).apiProfile,'');
});

test('DSH different host service, explicit pin and missing required methods cannot enable controls',async()=>{
  const h=host();assert.equal((await controllerEvidence({...h.ctl},h.ctx)).apiProfile,'');
  assert.equal((await controllerEvidence(h.ctl,h.ctx,{compatibilityMode:'pinned',expectedVersion:'999.0.0'})).apiProfile,'');
  delete h.ctl.follow;assert.equal((await controllerEvidence(h.ctl,h.ctx)).apiProfile,'');
});

test('DSH accepts context-scoped Cordis proxies only for the same original service',async()=>{
  const h=host();const original=Symbol.for('cordis.original');
  const proxy=(target:object)=>new Proxy(target,{get:(target,key,receiver)=>key===original?target:Reflect.get(target,key,receiver)});
  h.ctx.get=(key:string)=>key==='sessionController'?proxy(h.ctl):h.services[key];
  assert.equal((await controllerEvidence(proxy(h.ctl),h.ctx)).apiProfile,controllerProfile);
  assert.equal((await controllerEvidence(proxy({...h.ctl}),h.ctx)).apiProfile,'');
});

test('DSH text/image/file admission uses native image blocks and session-owned upload receipts',async()=>{
  const h=host();const bridge=controllerBridge(h.ctx,h.ctl,'plugin',()=>{});
  try{
    const p={sessionId:'native',requestId:'req',text:'inspect',attachments:[upload('pic.png','IMAGE/PNG'),upload('notes.txt','text/plain')]};
    await Promise.all([bridge.handlers.prompt(p),bridge.handlers.prompt(p)]);
    assert.equal(h.prompts.length,1);assert.equal(h.uploads.length,1);
    assert.deepEqual(h.prompts[0].content.map((x:any)=>x.type),['text','image','file']);assert.equal(h.prompts[0].content[1].mediaType,'image/png');assert.equal(h.prompts[0].content[2].receiptId,'file-receipt');
    assert.equal(decodeRequestIdentity(h.prompts[0].requestId)?.requestId,'req');
    await assert.rejects(bridge.handlers.prompt({...p,attachments:[upload('other.txt','text/plain')]}),/different input/);
    await assert.rejects(bridge.handlers.prompt({...p,requestId:'bad',attachments:[{...upload('x.txt','text/plain'),sha256:'bad'}]}),/integrity/);
    assert.equal(h.prompts.length,1);
  }finally{bridge.close();}
});

test('DSH reload recovers claimed-before-user-message admission and rejects changed payload without resending',async()=>{
  const h=host();const p={sessionId:'native',requestId:'original',text:'same text'};
  const first=controllerBridge(h.ctx,h.ctl,'one',()=>{});await first.handlers.prompt(p);first.close();
  assert.equal(h.events[0].type,'agent/inbox/spliced');
  const next=controllerBridge(h.ctx,h.ctl,'two',()=>{});
  try{
    const snapshot=await next.handlers.snapshot({sessionId:'native'});assert.ok(snapshot.promptReceipts.some((r:any)=>r.requestId==='original'&&r.pluginInstanceId==='two'));
    await assert.rejects(next.handlers.prompt({...p,text:'different'}),/different input/);
  }finally{next.close();}
  const third=controllerBridge(h.ctx,h.ctl,'three',()=>{});
  try{assert.equal((await third.handlers.prompt(p)).replayed,true);assert.equal(h.prompts.length,1);}finally{third.close();}
});

test('DSH cold snapshot can recover native receipts without activating the Agent',async()=>{
  const h=host();const first=controllerBridge(h.ctx,h.ctl,'one',()=>{});await first.handlers.prompt({sessionId:'native',requestId:'r',text:'hello'});first.close();
  h.services.agents.get=()=>undefined;h.ctl.inspect=async()=>({events:h.events});h.ctl.resolveAgent=async()=>{throw new Error('must not activate');};
  const next=controllerBridge(h.ctx,h.ctl,'two',()=>{});
  try{assert.equal((await next.handlers.snapshot({sessionId:'native'})).promptReceipts[0].requestId,'r');assert.equal(h.prompts.length,1);}finally{next.close();}
});

test('DSH native slash execution is singleflight and does not fabricate a model prompt',async()=>{
  const h=host();const bridge=controllerBridge(h.ctx,h.ctl,'plugin',()=>{});
  try{
    assert.equal((await bridge.handlers.slashCommands({sessionId:'native'})).commands[0].name,'compact');
    const p={sessionId:'native',requestId:'cmd',line:'/compact',attachments:[upload('notes.txt','text/plain')]};
    await Promise.all([bridge.handlers.slash(p),bridge.handlers.slash(p)]);assert.equal(h.commands.length,1);assert.equal(h.prompts.length,0);assert.equal(h.commands[0].parts[0].receiptId,'file-receipt');
    await assert.rejects(bridge.handlers.slash({...p,line:'/other'}),/conflict/);
  }finally{bridge.close();}
});

test('DSH steer uses the real native capability and never silently queues unsupported input',async()=>{
  const h=host();const bridge=controllerBridge(h.ctx,h.ctl,'plugin',()=>{});
  try{await bridge.handlers.prompt({sessionId:'native',requestId:'steer',text:'change direction',mode:'steer'});assert.equal(h.prompts[0].mode,'steer');delete (h.agent as any).steer;await assert.rejects(bridge.handlers.prompt({sessionId:'native',requestId:'unsupported',text:'no',mode:'steer'}),/steer unavailable/);assert.equal(h.prompts.length,1);}finally{bridge.close();}
});

test('DSH workspace membership and confirmed model selection use host services',async()=>{
  const h=host();const bridge=controllerBridge(h.ctx,h.ctl,'plugin',()=>{});
  try{const created=await bridge.handlers.create({cwd:await realpath('.')});assert.equal(created.workspace.attached,true);assert.deepEqual(h.membership,['native']);assert.equal((await bridge.handlers.models()).models[0].providerId,'deepseek');assert.equal((await bridge.handlers.configure({sessionId:'native',model:{providerId:'deepseek',modelId:'chat',reasoningEffort:'high'}})).selected.reasoningEffort,'high');h.ctl.selectModel=async()=>({accepted:true});await assert.rejects(bridge.handlers.configure({sessionId:'native',model:{providerId:'deepseek',modelId:'chat'}}),/invalid model selection/);}finally{bridge.close();}
});

test('DSH fallback catalog keeps successful providers when another fails',async()=>{
  const h=host();delete h.ctl.modelCatalog;h.services.llm={listProviders:()=>[{id:'ok'},{id:'bad'}],listModels:async(id:string)=>{if(id==='bad')throw new Error('offline');return[{id:'real',name:'Real'}];}};
  const catalog=await modelCatalog(h.ctx,h.ctl);assert.equal(catalog.models[0].modelId,'real');assert.equal(catalog.failures[0].id,'bad');
});

test('DSH capability profile supports future/bundled versions while explicit pin is still honored',async()=>{
  const f=nativeContext('deepseek-harness');const adapter=new DshAdapter('deepseek-harness',{command:'unused',expectedVersion:''},f.context);
  adapter.call=async()=>({version:'0.2.2-rc.3',apiProfile:controllerProfile,externalProtocol:2,instanceId:'host',capabilities:{externalHistory:true}});
  const provider=new DshExternalProvider(adapter);assert.equal((await provider.profile()).discover.state,'supported');
  adapter.config.expectedVersion='0.2.1-rc.5';assert.equal((await provider.profile()).discover.state,'supported');
  adapter.config.compatibilityMode='pinned';assert.equal((await provider.profile()).discover.state,'unverified');
});

test('DSH history excludes runtime context and never permits subagent attachment helpers',async()=>{
  assert.equal(humanUserEvent({data:{source:{kind:'runtime-context'},content:[{type:'text',text:'private context'}]}}),false);
  assert.equal(humanUserEvent({data:{source:{kind:'user'},content:[{type:'text',text:'human text'}]}}),true);
  const h=host();h.agent.session.header.origin='subagent';await assert.rejects(resolveAgent(h.ctx,h.ctl,'native'),/ordinary Agent/);
});

test('DSH newer versions cannot silently change snapshot/event waterlines or stream frame shapes',()=>{
  assert.throws(()=>validateFollowFrame({type:'snapshot',cursor:2,hasMore:false,records:[{event:{seq:3,type:'turn/start',data:{}}}]}),/waterline/);
  assert.throws(()=>validateFollowFrame({type:'snapshot',cursor:2,hasMore:false,records:[{event:{seq:1,type:'turn/start',data:{}}},{event:{seq:1,type:'turn/start',data:{}}}]}),/order/);
  assert.throws(()=>validateFollowFrame({type:'unknown'}),/contract changed/);
  assert.throws(()=>validateFollowFrame({type:'assistant-stream',frame:{type:'unknown'}}),/contract changed/);
});

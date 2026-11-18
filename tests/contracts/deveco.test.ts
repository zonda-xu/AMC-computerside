import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { DevEcoCodeAdapter,DevEcoExternalProvider } from '../../packages/adapters/opencode/deveco.ts';
import { nativeContext } from './fixtures/native-context.ts';

function harness(){
  const fixture=nativeContext('opencode');
  const adapter=new DevEcoCodeAdapter({command:'deveco',expectedVersion:'0.2.5'},fixture.context,'.');
  adapter.connection=async()=>{};
  adapter.endpoint={url:'http://127.0.0.1:12345',headers:{},identity:'test-service'};
  adapter.byNative.set('native',fixture.session.id);
  return {...fixture,adapter};
}

test('DevEco sends to the original session and waits for an assistant response linked to the durable user message',async()=>{
  const f=harness(),cwd=await realpath('.');
  const user=(id:string)=>({info:{id,role:'user',sessionID:'native'},parts:[{type:'text',text:'same text'}]});
  const reply=(id:string,parentID:string)=>({info:{id,parentID,role:'assistant',sessionID:'native',finish:'stop',time:{completed:10}},parts:[{type:'text',text:'reply'}]});
  const messages=[user('old'),reply('old-answer','old')];const sent:string[]=[];
  f.session.runId='run';f.session.state='accepted';
  f.context.getRun=()=>({runId:'run',sessionId:f.session.id,generation:1,state:'accepted',deviceId:'phone',clientRequestId:'request',nativeRequestId:'request'});
  f.adapter.http=async(path,method='GET',body)=>{
    const url=new URL(path,'http://127.0.0.1');
    assert.equal(url.searchParams.get('directory'),cwd);
    if(url.pathname==='/session/native')return{id:'native',directory:cwd};
    if(url.pathname==='/session/status')return{};
    if(url.pathname==='/session/native/prompt_async'){
      assert.equal(method,'POST');sent.push(body!.messageID);return{};
    }
    if(url.pathname==='/session/native/message')return messages;
    if(['/permission','/question'].includes(url.pathname))return[];
    throw Error('unexpected route '+url.pathname);
  };
  await f.adapter.submit(f.session,{text:'same text',requestId:'request',attachments:[]});
  assert.equal(sent.length,1);assert.match(sent[0],/^msg_/);
  await f.adapter.reconcile('native',f.session.id);
  assert.equal(f.session.state,'accepted');
  messages.push(user(sent[0]),reply('new-answer',sent[0]));
  await f.adapter.reconcile('native',f.session.id);assert.equal(f.session.state,'completed');
  assert.ok(f.events.some(e=>e.type==='message.completed'&&e.data.id==='new-answer'));
  f.adapter.close();
});

test('DevEco refuses a changed project or source, and carries native page cursors and tools into the history catalogue',async()=>{
  const f=harness(),cwd=await realpath('.');
  let directory=cwd;
  f.adapter.http=async path=>{
    if(path.startsWith('/session/native?'))return{id:'native',directory};
    assert.ok(path.includes('cursor=opaque'));return {data:[{type:'user',id:'u',text:'PC message'},{type:'assistant',id:'a',content:[{type:'text',text:'PC reply'},{type:'tool',id:'t',name:'Read',state:{status:'completed',input:{path:'example'}}}]}],cursor:{next:'next'}};
  };
  const provider=new DevEcoExternalProvider(f.adapter),page=await provider.history(cwd,'native','opaque');
  assert.deepEqual(page.items.map(m=>m.text),['PC message','PC reply']);assert.equal(page.tools?.[0].title,'Read');assert.equal(page.cursor,'next');
  directory=await realpath('..');await assert.rejects(provider.history(cwd,'native','opaque'),/项目目录/);
  f.session.externalSource={namespace:'another-store',nativeId:'native',generation:'0',profile:'deveco-session-api',readOnly:true};
  await assert.rejects(f.adapter.attachExistingSession(f.session,'test-service'),/数据来源/);
  f.adapter.close();
});

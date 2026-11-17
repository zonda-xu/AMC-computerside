import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, command } from '../helpers.ts';

test('native-confirmed model configuration clears an older next-turn choice and persists once',async()=>{
  const f=await fixture();
  try{
    const model={providerId:'openai',modelId:'test-model',label:'test-model'};
    const s=f.core.session(f.s.id);s.model=model;s.nextModel={...model,modelId:'stale-choice'};f.store.put('session',s.id,s);
    let configured=0;f.adapter.configure=async()=>{configured++;f.adapter.context.emit(s.id,'model.confirmed',{model});};
    const c=command(s,'configure',{model});f.core.accept('device',c);await f.core.drain();
    assert.equal(f.store.getReceipt('device',c.clientRequestId)?.status,'native_accepted');
    assert.equal(f.core.session(s.id).nextModel,undefined);assert.deepEqual(f.core.session(s.id).model,model);
    f.core.accept('device',c);await f.core.drain();assert.equal(configured,1);assert.equal(f.adapter.submitted,0);
  }finally{await f.close();}
});

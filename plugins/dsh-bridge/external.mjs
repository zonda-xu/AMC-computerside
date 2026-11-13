import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { mapDurable } from './mapping.mjs';

export function externalHandlers(ctl, observed, instanceId) {
  const pages=new Map();
  async function check(p){
    if(p.instanceId!==instanceId)throw new Error('DSH host generation changed');
    const rows=await ctl.list({},AbortSignal.timeout(30000));
    if(!Array.isArray(rows.items)||rows.items.length>5000)throw new Error('DSH list exceeds snapshot budget');
    const row=rows.items.find(r=>r.sessionId===p.sessionId&&r.origin!=='subagent');
    if(!row?.cwd||await realpath(row.cwd)!==p.cwd)throw new Error('DSH external project identity changed');
  }
  return {
    async externalList(p){
      if(p.instanceId!==instanceId)throw new Error('DSH host generation changed');
      let snapshot;
      if(p.cursor){snapshot=pages.get(p.cursor);pages.delete(p.cursor);if(!snapshot||snapshot.cwd!==p.cwd||snapshot.expires<Date.now())throw new Error('DSH discovery cursor expired');}
      else {
        const rows=await ctl.list({},AbortSignal.timeout(30000));
        if(!Array.isArray(rows.items)||rows.items.length>5000)throw new Error('DSH list exceeds snapshot budget');
        const items=[];
        for(const r of rows.items){if(!r.cwd||r.origin==='subagent')continue;const cwd=await realpath(r.cwd).catch(()=>'');if(cwd===p.cwd)items.push({nativeId:r.sessionId,cwd,title:'DSH '+r.sessionId});}
        snapshot={items,cwd:p.cwd,expires:Date.now()+60000};
      }
      const items=snapshot.items.slice(0,50);snapshot.items=snapshot.items.slice(50);let cursor;
      for(const [key,value] of pages)if(value.expires<Date.now())pages.delete(key);
      if(snapshot.items.length){if(pages.size>=100)throw new Error('DSH cursor budget exhausted');cursor=randomUUID();pages.set(cursor,snapshot);}
      return{items,cursor};
    },
    async externalHistory(p){
      await check(p);
       const signal=AbortSignal.timeout(30000);const records=[];let beforeSeq;let bytes=0;
       const baseline=await ctl.projections({sessionId:p.sessionId},signal);
       if(baseline?.kind!=='sequenced'||!Number.isSafeInteger(baseline.asOfSeq)||baseline.asOfSeq< -1)throw new Error('DSH non-activating history waterline unavailable; migration or host review required');
       const throughSeq=baseline.asOfSeq;
       for(let n=0;n<50;n++){
         const page=await ctl.page({address:{kind:'session',sessionId:p.sessionId},maxMessages:100,throughSeq,...(beforeSeq===undefined?{}:{beforeSeq})},signal);
         if(!Array.isArray(page.records)||page.records.length>10000||typeof page.hasMore!=='boolean')throw new Error('Malformed DSH history page');
        bytes+=Buffer.byteLength(JSON.stringify(page.records));if(bytes>8*1024*1024)throw new Error('DSH history exceeds byte budget');
        records.unshift(...page.records);
        if(records.length>20000)throw new Error('DSH history exceeds record budget');
        if(!page.hasMore){
          const items=[];let prior=-1;
           for(const r of records){const e=r.event;if(r.type!=='event'||!e||!Number.isSafeInteger(e.seq)||e.seq!==prior+1||e.seq>throughSeq)throw new Error('DSH event order or waterline mismatch');prior=e.seq;
            if(e.type==='user/message'){
              if(!Array.isArray(e.data.content))throw new Error('Malformed DSH user content');
              items.push({nativeEventId:String(e.seq)+':user',role:'user',text:e.data.content.filter(c=>c.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n')});
            }else if(e.type==='assistant/message'||e.type==='assistant/attempt'){
              for(const m of mapDurable(e))if(m.type==='message.completed')items.push({nativeEventId:String(e.seq)+':'+m.data.role,role:m.data.role,text:m.data.text});
            }
          }
           if(prior!==throughSeq)throw new Error('DSH history did not reach the pinned waterline');
           if(items.length>5000||Buffer.byteLength(JSON.stringify(items))>4*1024*1024)throw new Error('DSH history exceeds message budget');
           await check(p);
          return{items};
        }
        const next=page.records[0]?.event?.seq;
        if(!Number.isSafeInteger(next)||(beforeSeq!==undefined&&next>=beforeSeq))throw new Error('DSH history cursor made no progress');beforeSeq=next;
      }
      throw new Error('DSH history exceeds page budget');
    },
    async externalObserve(p){await check(p);if(p.enabled===true)observed.add(p.sessionId);else observed.delete(p.sessionId);return{observing:p.enabled===true};}
  };
}

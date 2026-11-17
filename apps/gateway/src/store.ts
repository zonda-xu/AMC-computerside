import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ConsoleEvent, LegacyConsoleEvent, EventType, Interaction, Receipt, Session, RunRecord, Command } from '../../../packages/protocol/src/types.ts';
import { ACTIVE, NO_CONTROL, TERMINAL } from '../../../packages/protocol/src/types.ts';
import { Fault, requireValue, stable, validateEventData } from '../../../packages/protocol/src/validation.ts';

export const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export class Store {
  db: DatabaseSync;
  notificationIntent?: (event:ConsoleEvent,session:Session)=>void;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS tickets(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS commands(device TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(device,id));
      CREATE TABLE IF NOT EXISTS events(session TEXT NOT NULL,seq INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(session,seq));
      CREATE TABLE IF NOT EXISTS push_bindings(device TEXT PRIMARY KEY REFERENCES devices(id),token TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_baselines(session TEXT PRIMARY KEY,source TEXT NOT NULL,watermark INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_jobs(id TEXT PRIMARY KEY,device TEXT NOT NULL,revision TEXT NOT NULL,session TEXT NOT NULL,event TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,due INTEGER NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,lease TEXT,lease_until INTEGER);
      CREATE INDEX IF NOT EXISTS push_jobs_due ON push_jobs(status,due);
      CREATE INDEX IF NOT EXISTS push_jobs_group ON push_jobs(device,session,status,created);
      CREATE TABLE IF NOT EXISTS push_intents(id TEXT PRIMARY KEY,job TEXT NOT NULL REFERENCES push_jobs(id));
      CREATE TABLE IF NOT EXISTS command_intents(device TEXT NOT NULL,id TEXT NOT NULL,session TEXT,json TEXT NOT NULL,phase TEXT NOT NULL,PRIMARY KEY(device,id));
      CREATE TABLE IF NOT EXISTS native_events(session TEXT NOT NULL,generation INTEGER NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(session,generation,id));`);
    for(const s of this.list<Session>('session'))if(!s.binding){s.binding={runtimeInstanceId:s.ref.runtimeInstanceId,nativeSessionId:s.ref.nativeSessionId,generation:s.epoch,state:s.externalSource?'unbound':'disconnected',capabilities:{...NO_CONTROL},reason:'Control ownership requires native reconciliation'};this.put('session',s.id,s);}
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const v = fn(); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  get<T>(kind: string, id: string): T | undefined { const row = this.db.prepare('SELECT json FROM objects WHERE kind=? AND id=?').get(kind,id); return row ? JSON.parse(row.json as string) as T : undefined; }
  list<T>(kind: string): T[] { return this.db.prepare('SELECT json FROM objects WHERE kind=?').all(kind).map(r => JSON.parse(r.json as string) as T); }
  put(kind: string, id: string, value: unknown) { this.db.prepare('INSERT INTO objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json').run(kind,id,JSON.stringify(value)); }
  ticket(ttlMs = 120_000) {
    const token = randomBytes(32).toString('base64url'); const expiresAt = Date.now() + ttlMs;
    this.db.prepare('DELETE FROM tickets WHERE expires<? OR used=1').run(Date.now());
    this.db.prepare('INSERT INTO tickets VALUES(?,?,0)').run(digest(token), expiresAt);
    return { token, expiresAt };
  }
  redeem(ticket: string, name: string) {
    return this.transaction(() => {
      const used = this.db.prepare('UPDATE tickets SET used=1 WHERE hash=? AND used=0 AND expires>?').run(digest(ticket),Date.now());
      requireValue(used.changes === 1, 'invalid_ticket', 'Pairing ticket expired or already used', 403);
      const deviceId = randomUUID(); const token = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO devices VALUES(?,?,?,0)').run(deviceId,name,digest(token));
      return { deviceId, token };
    });
  }
  authenticate(token: string): string { const r = this.db.prepare('SELECT id FROM devices WHERE hash=? AND revoked=0').get(digest(token)); requireValue(r,'unauthorized','Device authorization required',401); return r.id as string; }
  devices() { return this.db.prepare('SELECT id,name,revoked FROM devices').all(); }
  revoke(id: string) { this.transaction(() => { this.db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(id); this.clearPush(id); }); }
  clearPush(id: string) { this.db.prepare('DELETE FROM push_bindings WHERE device=?').run(id); this.db.prepare("UPDATE push_jobs SET status='cancelled',lease=NULL WHERE device=? AND status IN ('pending','sending')").run(id); }
  receive(device: string, id: string, request: unknown): { fresh: boolean; receipt: Receipt } {
    return this.transaction(() => {
      const hash = digest(stable(request));
      const row = this.db.prepare('SELECT hash,json FROM commands WHERE device=? AND id=?').get(device,id);
      if (row) { requireValue(row.hash === hash,'idempotency_conflict','Request ID already has different target or contents',409); return { fresh: false, receipt: JSON.parse(row.json as string) }; }
      const receipt: Receipt = { clientRequestId: id, status: 'received' };
      this.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(device,id,hash,JSON.stringify(receipt));
      const body=request as Partial<Command>;
      this.db.prepare('INSERT INTO command_intents VALUES(?,?,?,?,?)').run(device,id,body.sessionId??null,JSON.stringify(request),'received');
      return { fresh: true, receipt };
    });
  }
  receipt(device: string, receipt: Receipt) {
    const old=this.getReceipt(device,receipt.clientRequestId);
    if(old&&['native_accepted','rejected'].includes(old.status)&&old.status!==receipt.status)return;
    this.transaction(()=>{this.db.prepare('UPDATE commands SET json=? WHERE device=? AND id=?').run(JSON.stringify({...old,...receipt}),device,receipt.clientRequestId);this.db.prepare('UPDATE command_intents SET phase=? WHERE device=? AND id=?').run(receipt.status,device,receipt.clientRequestId);});
  }
  intent(device:string,id:string){return this.db.prepare('SELECT session,json,phase FROM command_intents WHERE device=? AND id=?').get(device,id);}
  dispatching(device:string,id:string,run?:RunRecord){this.transaction(()=>{this.db.prepare("UPDATE command_intents SET phase='dispatching' WHERE device=? AND id=?").run(device,id);if(run)this.put('run',run.runId,run);});}
  unresolvedCancel(sessionId:string){return this.db.prepare("SELECT json FROM command_intents WHERE session=? AND phase IN ('dispatching','uncertain')").all(sessionId).some(r=>(JSON.parse(r.json as string) as Command).action==='cancel');}
  unresolvedSubmission(sessionId:string){return this.db.prepare("SELECT json FROM command_intents WHERE session=? AND phase IN ('dispatching','uncertain')").all(sessionId).some(r=>['submit','steer','slash'].includes((JSON.parse(r.json as string) as Command).action));}
  pendingCommands(sessionId:string){return this.db.prepare("SELECT device,id,json FROM command_intents WHERE session=? AND phase IN ('received','dispatching','uncertain')").all(sessionId).map(r=>({deviceId:r.device as string,clientRequestId:r.id as string,command:JSON.parse(r.json as string) as Command,receipt:this.getReceipt(r.device as string,r.id as string)!})).filter(p=>['submit','cancel','decide','configure','slash','steer'].includes(p.command.action));}
  getReceipt(device: string, id: string): Receipt | undefined { const r = this.db.prepare('SELECT json FROM commands WHERE device=? AND id=?').get(device,id); return r ? JSON.parse(r.json as string) : undefined; }
  event(id: string, type: EventType, data: Record<string, unknown>, transactional = true): ConsoleEvent {
    const apply = (): ConsoleEvent => {
      const s = this.get<Session>('session',id); if (!s) throw new Fault(404,'session_missing','Session not registered');
      validateEventData(type,data);
      const generation=typeof data.generation==='number'?data.generation:s.binding?.generation??s.epoch;
      const nativeEventId=typeof data.nativeEventId==='string'?data.nativeEventId:undefined;
      if(nativeEventId){const old=this.db.prepare('SELECT seq FROM native_events WHERE session=? AND generation=? AND id=?').get(id,generation,nativeEventId);if(old)return this.events(id,(old.seq as number)-1,1)[0];}
      data={...data};
      let runId=typeof data.runId==='string'?data.runId:s.runId;
      if(type==='run.updated'&&runId&&runId!==s.runId&&!this.get<RunRecord>('run',runId)&&s.runId){
        data.nativeRunId=data.nativeRunId??runId;runId=s.runId;data.runId=runId;
      }
      const nativeKey=typeof data.nativeRunId==='string'?digest(stable([s.ref.runtimeInstanceId,generation,s.ref.nativeSessionId,data.nativeRunId])):undefined;
      const nativeMapping=nativeKey?this.get<{runId:string}>('native-run',nativeKey):undefined;
      if(nativeMapping){runId=nativeMapping.runId;data.runId=runId;}
      const observing=type==='run.updated'&&data.state==='running'&&data.nativeAccepted===true&&(nativeKey?!nativeMapping:!s.runId)&&(!ACTIVE.includes(s.state)||(!s.runId&&s.state==='uncertain'))&&generation===(s.binding?.generation??s.epoch)&&s.binding?.state==='attached';
      if(observing){runId=randomUUID();data.runId=runId;const observed:RunRecord={runId,sessionId:id,generation,nativeRunId:data.nativeRunId as string,state:'running'};this.put('run',runId,observed);}
       const run=runId?this.get<RunRecord>('run',runId):undefined;
       const starting=observing||(type==='run.updated'&&data.state==='accepted'&&run&&runId!==s.runId&&!ACTIVE.includes(s.state));
       const historicalArtifact=data.historical===true&&(type==='message.completed'||type==='tool.updated');
       const stale=generation!==(s.binding?.generation??s.epoch)||(!starting&&!historicalArtifact&&runId&&s.runId&&runId!==s.runId)||(!starting&&!historicalArtifact&&data.nativeRunId&&s.nativeRunId&&data.nativeRunId!==s.nativeRunId);
      const backwards=type==='run.updated'&&!starting&&((data.state==='accepted'&&s.state!=='idle'&&s.state!=='accepted')||(s.state==='cancel_requested'&&!TERMINAL.includes(data.state as Session['state'])&&data.state!=='uncertain'&&data.state!=='cancel_requested')||(data.state==='idle'&&s.runId));
       const terminatedInteraction=type==='interaction.created'&&TERMINAL.includes(s.state)&&(!runId||runId===s.runId);
       if(stale||backwards||terminatedInteraction||(type==='run.updated'&&TERMINAL.includes(s.state)&&runId===s.runId)){
        data={...data,ignoredUpdate:{...data},state:s.state,runId:s.runId,ignored:true};
      }
      if(observing){s.parentEndState=undefined;s.writeRoots=[];s.agents=[];s.nativeRunId=undefined;s.result=undefined;s.runGeneration=generation;}
      const event: ConsoleEvent = { protocolVersion:2,eventId:randomUUID(),hostId:s.ref.hostId,runtimeInstanceId:s.ref.runtimeInstanceId,generation,runId,nativeEventId,sessionId: id, ref: s.ref, seq: s.watermark + 1, time: Date.now(), type, data };
      project(s,event);
       if(run&&!data.ignored&&!historicalArtifact){run.state=s.state;if(typeof data.nativeRunId==='string')run.nativeRunId=data.nativeRunId;if(typeof data.nativeStartedAt==='number'&&Number.isFinite(data.nativeStartedAt))run.nativeStartedAt=data.nativeStartedAt;if(type==='run.updated'&&TERMINAL.includes(s.state))run.result=data;this.put('run',run.runId,run);}
       if(nativeKey&&run&&!data.ignored&&!historicalArtifact)this.put('native-run',nativeKey,{runId:run.runId});
      this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(id,event.seq,JSON.stringify(event));
      if(nativeEventId)this.db.prepare('INSERT INTO native_events VALUES(?,?,?,?)').run(id,generation,nativeEventId,event.seq);
      this.put('session',id,s);
      if(!data.ignored&&!data.silentBaseline&&!data.historical&&(type==='run.updated'||type==='interaction.created')&&(!s.externalSource||s.binding?.state==='attached'))this.notificationIntent?.(event,s);
      return event;
    };
    return transactional ? this.transaction(apply) : apply();
  }
  private decodeEvent(json:string):ConsoleEvent{const e:LegacyConsoleEvent=JSON.parse(json);return{...e,protocolVersion:2,eventId:e.eventId??digest(`${e.sessionId}:${e.seq}`),hostId:e.hostId??e.ref.hostId,runtimeInstanceId:e.runtimeInstanceId??e.ref.runtimeInstanceId,generation:e.generation??0};}
  events(id: string, after: number, limit = 500) { return this.db.prepare('SELECT json FROM events WHERE session=? AND seq>? ORDER BY seq LIMIT ?').all(id,after,limit).map(r=>this.decodeEvent(r.json as string)); }
  history(id: string, before: number, limit = 100) { return this.db.prepare('SELECT json FROM events WHERE session=? AND seq<? ORDER BY seq DESC LIMIT ?').all(id,before,limit).reverse().map(r=>this.decodeEvent(r.json as string)); }
  claimDecision(sessionId: string, id: string, epoch: number, decision: unknown): Interaction {
    return this.transaction(() => {
      const s = this.get<Session>('session',sessionId)!;
      const i = s.interactions.find(v=>v.id===id);
      requireValue(i && (i.generation??i.epoch) === epoch && (s.binding?.generation??s.epoch) === epoch && (!i.runId||i.runId===s.runId),'stale_interaction','Interaction belongs to a previous connection or run',409);
      if (i.status !== 'pending') throw new Fault(409,'already_decided','Interaction already claimed or closed');
      i.status = 'responding'; this.put('decision',id,decision); this.put('session',sessionId,s); return i;
    });
  }
  recover() {
    for (const s of this.list<Session>('session')) {
      // Historical projections never held an execution handle. A gateway restart
      // must not turn discovery into authorization to resume a native writer.
      if (s.binding?.state === 'unbound') continue;
      if (ACTIVE.includes(s.state)) this.event(s.id,'run.updated',{ state: 'uncertain', detail: 'Gateway restarted; native state needs reconciliation' });
      const fresh = this.get<Session>('session',s.id)!;
       if(fresh.binding)fresh.binding={...fresh.binding,state:'disconnected',reason:'Gateway restarted; native binding requires reconciliation'};
      this.put('session',s.id,fresh);
    }
    for (const r of this.db.prepare('SELECT device,id,json FROM commands').all()) {
      const receipt = JSON.parse(r.json as string) as Receipt;
      if (receipt.status === 'received') {
        const intent=this.intent(r.device as string,r.id as string);
        const attachment=intent&&JSON.parse(intent.json as string).kind==='session.attach';
        this.receipt(r.device as string,{...receipt,status:attachment?'rejected':'uncertain',detail:attachment?'Read-only ownership verification was interrupted; refresh state and retry attachment with a new request':'Acceptance was not confirmed before restart; do not resend automatically'});
      }
    }
  }
  close() { this.db.close(); }
}
export function project(s: Session, e: LegacyConsoleEvent) {
  const d = e.data;
  if(d.ignored){s.watermark=e.seq;s.updatedAt=e.time;return;}
  if(Number.isSafeInteger(d.nativeSeq))s.nativeCursor=Math.max(s.nativeCursor||0,d.nativeSeq as number);
  if (e.type === 'message.delta' || e.type === 'message.completed') {
    const id = d.id as string; let m = s.messages.find(v=>v.id===id);
    if (!m) { m = {id,role:(d.role as 'assistant') || 'assistant',text:'',complete:false,startSeq:e.seq,runId:d.historical?undefined:e.runId}; s.messages.push(m); }
    if (e.type === 'message.completed') { m.text = d.text as string; m.complete = true; }
    else if(!m.complete)m.text += d.text as string;
    if (d.model) m.model = d.model as Session['model'];
    if (typeof d.nativeKey==='string')m.nativeKey=d.nativeKey;
    if (typeof d.temporary==='boolean')m.temporary=d.temporary;
    if (typeof d.abandoned==='boolean')m.abandoned=d.abandoned;
    if (typeof d.attemptId==='string')m.attemptId=d.attemptId;
    if (typeof d.revision==='number')m.revision=d.revision;
  }
  if (e.type === 'run.updated') { s.state = d.state as Session['state']; if (d.runId) s.runId = d.runId as string; if(typeof d.nativeRunId==='string')s.nativeRunId=d.nativeRunId;if(d.parentEndState)s.parentEndState=d.parentEndState as Session['state'];if(d.state==='accepted'){s.parentEndState=undefined;s.writeRoots=[];s.agents=[];s.nativeRunId=typeof d.nativeRunId==='string'?d.nativeRunId:undefined;s.result=undefined;s.runGeneration=e.generation;}if(TERMINAL.includes(s.state)){s.result={...d};s.interactions=s.interactions.map(i=>i.status==='resolved'?i:{...i,status:'stale'});} }
  if (e.type === 'model.confirmed' && d.model) { s.model = d.model as Session['model']; if(s.nextModel?.providerId===s.model?.providerId&&s.nextModel?.modelId===s.model?.modelId)s.nextModel = undefined; }
  if (e.type === 'tool.updated') { const t = {...d,runId:d.historical?undefined:e.runId} as unknown as Session['tools'][number]; const n = s.tools.findIndex(v=>v.id===t.id); if (n < 0) s.tools.push(t); else s.tools[n] = {...s.tools[n],...t}; }
  if (e.type === 'agent.updated') { const a = d as unknown as Session['agents'][number]; const n=s.agents.findIndex(v=>v.id===a.id); if(n<0)s.agents.push(a); else s.agents[n]={...s.agents[n],...a}; }
  if (e.type === 'interaction.created') { const i={...d,generation:e.generation,runId:e.runId,runtimeInstanceId:e.runtimeInstanceId} as unknown as Interaction;const n=s.interactions.findIndex(v=>v.id===i.id);if(n<0)s.interactions.push(i);else if(!['resolved','stale'].includes(s.interactions[n].status))s.interactions[n]={...s.interactions[n],...i}; }
  if (e.type === 'interaction.closed') { const i=s.interactions.find(v=>v.id===d.id); if(i)i.status=(d.status as Interaction['status']) || 'resolved'; }
  s.watermark = e.seq; s.updatedAt = e.time;
}

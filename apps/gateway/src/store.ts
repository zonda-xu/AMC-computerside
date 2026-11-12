import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ConsoleEvent, EventType, Interaction, Receipt, Session } from '../../../packages/protocol/src/types.ts';
import { ACTIVE } from '../../../packages/protocol/src/types.ts';
import { Fault, requireValue, stable } from '../../../packages/protocol/src/validation.ts';

export const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS tickets(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS commands(device TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(device,id));
      CREATE TABLE IF NOT EXISTS events(session TEXT NOT NULL,seq INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(session,seq));`);
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
  revoke(id: string) { this.db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(id); }
  receive(device: string, id: string, request: unknown): { fresh: boolean; receipt: Receipt } {
    return this.transaction(() => {
      const hash = digest(stable(request));
      const row = this.db.prepare('SELECT hash,json FROM commands WHERE device=? AND id=?').get(device,id);
      if (row) { requireValue(row.hash === hash,'idempotency_conflict','Request ID already has different target or contents',409); return { fresh: false, receipt: JSON.parse(row.json as string) }; }
      const receipt: Receipt = { clientRequestId: id, status: 'received' };
      this.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(device,id,hash,JSON.stringify(receipt));
      return { fresh: true, receipt };
    });
  }
  receipt(device: string, receipt: Receipt) { this.db.prepare('UPDATE commands SET json=? WHERE device=? AND id=?').run(JSON.stringify(receipt),device,receipt.clientRequestId); }
  getReceipt(device: string, id: string): Receipt | undefined { const r = this.db.prepare('SELECT json FROM commands WHERE device=? AND id=?').get(device,id); return r ? JSON.parse(r.json as string) : undefined; }
  event(id: string, type: EventType, data: Record<string, unknown>): ConsoleEvent {
    return this.transaction(() => {
      const s = this.get<Session>('session',id); if (!s) throw new Fault(404,'session_missing','Session not registered');
      const event: ConsoleEvent = { sessionId: id, ref: s.ref, seq: s.watermark + 1, time: Date.now(), type, data };
      project(s,event);
      this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(id,event.seq,JSON.stringify(event));
      this.put('session',id,s);
      return event;
    });
  }
  events(id: string, after: number, limit = 500) { return this.db.prepare('SELECT json FROM events WHERE session=? AND seq>? ORDER BY seq LIMIT ?').all(id,after,limit).map(r=>JSON.parse(r.json as string) as ConsoleEvent); }
  history(id: string, before: number, limit = 100) { return this.db.prepare('SELECT json FROM events WHERE session=? AND seq<? ORDER BY seq DESC LIMIT ?').all(id,before,limit).reverse().map(r=>JSON.parse(r.json as string) as ConsoleEvent); }
  claimDecision(sessionId: string, id: string, epoch: number, decision: unknown): Interaction {
    return this.transaction(() => {
      const s = this.get<Session>('session',sessionId)!;
      const i = s.interactions.find(v=>v.id===id);
      requireValue(i && i.epoch === epoch && s.epoch === epoch,'stale_interaction','Interaction belongs to a previous connection',409);
      if (i.status !== 'pending') throw new Fault(409,'already_decided','Interaction already claimed or closed');
      i.status = 'responding'; this.put('decision',id,decision); this.put('session',sessionId,s); return i;
    });
  }
  recover() {
    for (const s of this.list<Session>('session')) {
      if (ACTIVE.includes(s.state)) this.event(s.id,'run.updated',{ state: 'uncertain', detail: 'Gateway restarted; native state needs reconciliation' });
      const fresh = this.get<Session>('session',s.id)!;
      fresh.interactions = fresh.interactions.map(i=>({...i,status: i.status === 'resolved' ? 'resolved' : 'stale'}));
      this.put('session',s.id,fresh);
    }
    for (const r of this.db.prepare('SELECT device,id,json FROM commands').all()) {
      const receipt = JSON.parse(r.json as string) as Receipt;
      if (receipt.status === 'received') this.receipt(r.device as string,{...receipt,status:'uncertain',detail:'Acceptance was not confirmed before restart; do not resend automatically'});
    }
  }
  close() { this.db.close(); }
}
export function project(s: Session, e: ConsoleEvent) {
  const d = e.data;
  if(Number.isSafeInteger(d.nativeSeq))s.nativeCursor=Math.max(s.nativeCursor||0,d.nativeSeq as number);
  if (e.type === 'message.delta' || e.type === 'message.completed') {
    const id = d.id as string; let m = s.messages.find(v=>v.id===id);
    if (!m) { m = {id,role:(d.role as 'assistant') || 'assistant',text:'',complete:false,startSeq:e.seq}; s.messages.push(m); }
    if (e.type === 'message.completed') { m.text = d.text as string; m.complete = true; }
    else m.text += d.text as string;
    if (d.model) m.model = d.model as Session['model'];
    if (typeof d.nativeKey==='string')m.nativeKey=d.nativeKey;
  }
  if (e.type === 'run.updated') { s.state = d.state as Session['state']; if (d.runId) s.runId = d.runId as string; if(d.parentEndState)s.parentEndState=d.parentEndState as Session['state'];if(d.state==='accepted'){s.parentEndState=undefined;s.writeRoots=[];} }
  if (e.type === 'model.confirmed') { s.model = d.model as Session['model']; s.nextModel = undefined; }
  if (e.type === 'tool.updated') { const t = d as unknown as Session['tools'][number]; const n = s.tools.findIndex(v=>v.id===t.id); if (n < 0) s.tools.push(t); else s.tools[n] = {...s.tools[n],...t}; }
  if (e.type === 'agent.updated') { const a = d as unknown as Session['agents'][number]; const n=s.agents.findIndex(v=>v.id===a.id); if(n<0)s.agents.push(a); else s.agents[n]={...s.agents[n],...a}; }
  if (e.type === 'interaction.created') { const i=d as unknown as Interaction;const n=s.interactions.findIndex(v=>v.id===i.id);if(n<0)s.interactions.push(i);else s.interactions[n]={...s.interactions[n],...i}; }
  if (e.type === 'interaction.closed') { const i=s.interactions.find(v=>v.id===d.id); if(i)i.status=(d.status as Interaction['status']) || 'resolved'; }
  s.watermark = e.seq; s.updatedAt = e.time;
}

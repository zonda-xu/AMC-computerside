import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { realpath } from 'node:fs/promises';

export function service(ctx, name) {
  try { return ctx?.get?.(name) ?? ctx?.[name]; } catch { return ctx?.[name]; }
}
export function sessionRows(value) {
  const rows = Array.isArray(value) ? value : value?.items ?? value?.sessions ?? value?.rows;
  if (!Array.isArray(rows) || rows.length > 5000 || rows.some(r => !r || typeof r.sessionId !== 'string' || !r.sessionId)) throw new Error('DSH list contract unavailable or exceeds snapshot budget');
  return rows;
}
export function validatePage(page, throughSeq) {
  if (!Array.isArray(page?.records) || typeof page.hasMore !== 'boolean' || page.records.length > 20000) throw new Error('DSH history page contract changed');
  let prior = -1;
  for (const record of page.records) {
    const event = record?.event;
    if (!Number.isSafeInteger(event?.seq) || event.seq <= prior || typeof event.type !== 'string' || !event.data || typeof event.data !== 'object' || Number.isSafeInteger(throughSeq) && event.seq > throughSeq) throw new Error('DSH history event order or waterline mismatch');
    prior = event.seq;
  }
  return page;
}
export function validateFollowFrame(frame) {
  if (frame?.type === 'snapshot') {
    if (!Number.isSafeInteger(frame.cursor) || frame.cursor < -1) throw new Error('DSH snapshot missing pinned page cut');
    validatePage(frame, frame.cursor);
  } else if (frame?.type === 'event') validatePage({ records: [frame], hasMore: false });
  else if (frame?.type === 'assistant-stream') {
    if (!['start','chunk','end'].includes(frame.frame?.type)) throw new Error('DSH assistant stream contract changed');
  } else throw new Error('DSH follow frame contract changed');
  return frame;
}
export function featureCapabilities(ctx, ctl) {
  const resolve = typeof ctl.resolveAgent === 'function' || typeof service(ctx, 'agents')?.get === 'function';
  return { create: true, submit: true, observe: true, cancel: true, resume: true, attach: true,
    approve: !!service(ctx, 'approval'), answer: typeof service(ctx, 'userQuestions')?.ask === 'function',
    configure: typeof ctl.selectModel === 'function',
    models: typeof ctl.modelCatalog === 'function' || typeof service(ctx, 'llm')?.listProviders === 'function',
    image: typeof service(ctx, 'attachments')?.admitPromptContent === 'function',
    files: resolve && typeof service(ctx, 'fileUploads')?.upload === 'function',
    slash: resolve && typeof service(ctx, 'commands')?.list === 'function' && typeof service(ctx, 'commands')?.execute === 'function',
    steer: resolve, externalHistory: true };
}
export async function resolveAgent(ctx, ctl, sessionId) {
  let agent = service(ctx, 'agents')?.get?.(sessionId);
  if (!agent && typeof ctl.resolveAgent === 'function') {
    const result = await ctl.resolveAgent(sessionId);
    if (result?.error) throw result.error;
    agent = result?.agent ?? result;
  }
  if (!agent?.session || agent.session.header?.origin === 'subagent') throw new Error('DSH ordinary Agent unavailable');
  if ((agent.session.id ?? agent.id) !== sessionId) throw new Error('DSH Agent ownership mismatch');
  return agent;
}
export function normalizeSelection(value) {
  if (typeof value?.provider !== 'string' || !value.provider || typeof value?.model !== 'string' || !value.model) throw new Error('DSH returned an invalid model selection');
  return { providerId: value.provider, modelId: value.model, label: value.model,
    ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}) };
}
export async function modelCatalog(ctx, ctl) {
  let catalog;
  if (typeof ctl.modelCatalog === 'function') catalog = await ctl.modelCatalog();
  else {
    const llm = service(ctx, 'llm');
    if (typeof llm?.listProviders !== 'function' || typeof llm.listModels !== 'function') throw new Error('DSH model catalog unavailable');
    const groups = []; const failures = [];
    for (const provider of await llm.listProviders()) {
      const id = typeof provider === 'string' ? provider : provider.id;
      if (typeof id !== 'string') continue;
      try { groups.push({ id, models: await llm.listModels(id) }); }
      catch (error) { failures.push({ id, message: String(error.message).slice(0,300) }); }
    }
    catalog = { groups, failures };
  }
  if (!Array.isArray(catalog?.groups)) throw new Error('DSH model catalog contract changed');
  const models = [];
  for (const group of catalog.groups) {
    if (typeof group?.id !== 'string' || !Array.isArray(group.models)) continue;
    for (const entry of group.models) {
      const item = typeof entry === 'string' ? { id: entry } : entry;
      if (typeof item?.id !== 'string' || !item.id) continue;
      models.push({ providerId: group.id, modelId: item.id, label: item.name || item.id,
        ...(Number.isFinite(item.contextWindow) ? { contextWindow: item.contextWindow } : {}), ...(item.reasoning ? { reasoning: item.reasoning } : {}) });
    }
  }
  return { models, failures: catalog.failures ?? [] };
}
export function validateUploads(uploads = []) {
  if (!Array.isArray(uploads) || uploads.length > 10) throw new Error('Invalid DSH attachments');
  let total = 0;
  return uploads.map(upload => {
    if (typeof upload?.name !== 'string' || !upload.name || /[\\/\x00-\x1f]/.test(upload.name) || upload.name.length > 160) throw new Error('Invalid DSH attachment name');
    if (typeof upload.dataBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(upload.dataBase64)) throw new Error('Invalid DSH attachment encoding');
    const bytes = Buffer.from(upload.dataBase64, 'base64'); total += bytes.length;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!bytes.length || bytes.length > 16*1024*1024 || total > 32*1024*1024 || upload.sha256 !== sha256 || upload.bytes !== bytes.length) throw new Error('DSH attachment integrity or size mismatch');
    return { ...upload, sha256, mime: String(upload.mime || 'application/octet-stream').split(';')[0].trim().toLowerCase() };
  });
}
export async function promptContent(ctx, ctl, sessionId, text, uploads) {
  const content = text ? [{ type: 'text', text }] : [];
  let agent;
  for (const upload of uploads) {
    if (upload.mime.startsWith('image/')) {
      if (typeof service(ctx, 'attachments')?.admitPromptContent !== 'function') throw new Error('DSH image admission unavailable');
      content.push({ type: 'image', mediaType: upload.mime, data: upload.dataBase64, name: upload.name });
    } else {
      const fileUploads = service(ctx, 'fileUploads');
      if (typeof fileUploads?.upload !== 'function') throw new Error('DSH native file upload unavailable');
      agent ??= await resolveAgent(ctx, ctl, sessionId);
      const receipt = await fileUploads.upload(agent, { data: upload.dataBase64, name: upload.name }, AbortSignal.timeout(30000));
      if (typeof receipt?.receiptId !== 'string' || !receipt.receiptId) throw new Error('DSH file upload did not return a receipt');
      content.push({ type: 'file', receiptId: receipt.receiptId });
    }
  }
  return content;
}
const PREFIX = 'amc-dsh-v2:';
export function requestIdentity(requestId, hash) { return PREFIX + Buffer.from(JSON.stringify([requestId,hash])).toString('base64url'); }
export function decodeRequestIdentity(value) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith(PREFIX)) return { requestId: value };
  try { const [requestId, hash] = JSON.parse(Buffer.from(value.slice(PREFIX.length),'base64url').toString());
    if (typeof requestId === 'string' && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) return { requestId, hash };
  } catch { /* Malformed source is never acceptance evidence. */ }
  return null;
}
export function journalReceipts(events = [], inbox = []) {
  const messages = [...inbox];
  for (const event of events) {
    if (event?.type === 'user/message') messages.push(event.data);
    if (event?.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) messages.push(...event.data.inserted);
  }
  return messages.flatMap(message => message?.source?.kind === 'user' ? [decodeRequestIdentity(message.source.rpcId)].filter(Boolean) : []);
}
export async function nativeReceipts(ctx, ctl, sessionId) {
  const agent = service(ctx, 'agents')?.get?.(sessionId);
  if (agent?.session?.snapshotEvents) return journalReceipts(agent.session.snapshotEvents(), [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])]);
  if (typeof ctl.inspect === 'function') {
    const inspected = await ctl.inspect(sessionId, AbortSignal.timeout(10000));
    return journalReceipts(inspected?.events);
  }
  return [];
}
export async function attachWorkspace(ctx, sessionId, cwd) {
  const registry = service(ctx, 'workspaceRegistry');
  if (typeof registry?.resolveByPath !== 'function' || typeof registry.create !== 'function') return { attached: false, reason: 'workspace registry unavailable' };
  try {
    const canonical = await realpath(cwd);
    const workspace = await registry.resolveByPath(canonical) || await registry.create(canonical, basename(canonical));
    if (typeof workspace?.attachSession !== 'function') throw new Error('workspace attachment unavailable');
    await workspace.attachSession(sessionId);
    return { attached: true, workspaceId: workspace.id };
  } catch (error) { return { attached: false, reason: String(error.message).slice(0,300) }; }
}
export function humanUserEvent(event) {
  const kind = event?.data?.source?.kind;
  if (kind && !['user', 'user-question-reply'].includes(kind)) return false;
  const text = (event?.data?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').trimStart();
  return !/^<(?:runtime-context|working-directory|model-selection|tool-registry)(?:\s|>)/.test(text);
}

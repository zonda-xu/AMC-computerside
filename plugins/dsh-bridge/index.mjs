import WebSocket from 'ws';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { externalHandlers } from './external.mjs';
import { controllerEvidence } from './profile.mjs';
import { controllerBridge } from './controller.mjs';

export default async function activate(ctx, config = {}) {
  const ctl = ctx.get('sessionController');
  if (!ctl) throw new Error('DSH Session Controller is required');
  const endpoint = new URL(config.gatewayUrl || 'ws://127.0.0.1:8898');
  if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'ws:') throw new Error('Bridge endpoint must be local ws://127.0.0.1');
  const token = (await readFile(config.tokenFile, 'utf8')).trim();
  const evidence = await controllerEvidence(ctl, ctx, config);
  const instanceId = randomUUID();
  const home = await realpath(process.env.DSH_HOME || join(homedir(),'.dsh')).catch(()=>undefined);
  const historyNamespace = home ? 'dsh-store:'+createHash('sha256').update(home).digest('hex') : undefined;
  const observed = new Set();
  const handlers = externalHandlers(ctl, observed, instanceId);
  let ws; let retry; let stopped = false; let delay = 250;
  const bridge=evidence.apiProfile?controllerBridge(ctx,ctl,instanceId,message=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(message));}):undefined;
  const dispose = ctx.on('session/event', (session) => {
    if (observed.has(session.id) && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'event', params: { sessionId: session.id, type: 'external.changed', instanceId } }));
  });
  function connect() {
    if (stopped) return;
    const socket = new WebSocket(endpoint, { headers: { authorization: `Bearer ${token}` }, maxPayload:48*1024*1024 });
    ws = socket;
    socket.on('open', () => { delay = 250; });
    socket.on('message', async raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
        let result;
        if (message.method === 'probe') result = { ...evidence, externalProtocol: 2, instanceId, historyNamespace, pluginInstanceId:instanceId, control:!!bridge };
        else {
          if (!evidence.apiProfile) throw new Error(evidence.detail);
          const handler = Object.hasOwn(handlers, message.method) ? handlers[message.method] : bridge&&Object.hasOwn(bridge.handlers,message.method)?bridge.handlers[message.method]:undefined;
          if (typeof handler !== 'function') throw new Error('DSH bridge method unavailable');
          result = await handler(message.params);
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, result }));
      } catch (error) {
        if (message?.id && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, error: error.message }));
      }
    });
    socket.on('error', () => socket.close());
    socket.on('close', () => { bridge?.disconnect();if (stopped) return; retry = setTimeout(connect, delay); delay = Math.min(delay * 2, 10000); retry.unref?.(); });
  }
  connect();
  return () => { stopped = true; clearTimeout(retry); bridge?.close();ws?.close(); observed.clear(); if (typeof dispose === 'function') dispose(); };
}

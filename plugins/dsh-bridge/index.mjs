import WebSocket from 'ws';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { externalHandlers } from './external.mjs';
import { controllerEvidence } from './profile.mjs';

export default async function activate(ctx, config = {}) {
  const ctl = ctx.get('sessionController');
  if (!ctl) throw new Error('DSH Session Controller is required');
  const endpoint = new URL(config.gatewayUrl || 'ws://127.0.0.1:8898');
  if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'ws:') throw new Error('Bridge endpoint must be local ws://127.0.0.1');
  const token = (await readFile(config.tokenFile, 'utf8')).trim();
  const evidence = await controllerEvidence(ctl);
  const instanceId = randomUUID();
  const observed = new Set();
  const handlers = externalHandlers(ctl, observed, instanceId);
  let ws; let retry; let stopped = false; let delay = 250;
  const dispose = ctx.on('session/event', (session) => {
    if (observed.has(session.id) && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'event', params: { sessionId: session.id, type: 'external.changed', instanceId } }));
  });
  function connect() {
    if (stopped) return;
    const socket = new WebSocket(endpoint, { headers: { authorization: `Bearer ${token}` } });
    ws = socket;
    socket.on('open', () => { delay = 250; });
    socket.on('message', async raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
        let result;
        if (message.method === 'probe') result = { ...evidence, externalProtocol: 2, instanceId, control: false };
        else {
          if (!evidence.apiProfile) throw new Error(evidence.detail);
          const handler = Object.hasOwn(handlers, message.method) ? handlers[message.method] : undefined;
          if (typeof handler !== 'function') throw new Error('DSH bridge is read-only; managed control and approval competition are not verified');
          result = await handler(message.params);
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, result }));
      } catch (error) {
        if (message?.id && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, error: error.message }));
      }
    });
    socket.on('error', () => socket.close());
    socket.on('close', () => { if (stopped) return; retry = setTimeout(connect, delay); delay = Math.min(delay * 2, 10000); retry.unref?.(); });
  }
  connect();
  return () => { stopped = true; clearTimeout(retry); ws?.close(); observed.clear(); if (typeof dispose === 'function') dispose(); };
}

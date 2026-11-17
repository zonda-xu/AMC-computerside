import { constants, createPrivateKey, createHash, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PushNotice, PushResult, PushTransport } from './push.ts';

export interface PushServiceAccount { key_id: string; sub_account: string; private_key: string; project_id: string }
export interface HuaweiPushConfig { serviceAccountFile: string; category: string; testMessage?: boolean }
interface ProviderResponse { code?: string; requestId?: string }
export function makePushJwt(account: PushServiceAccount, seconds = Math.floor(Date.now() / 1000)): string {
  const header = Buffer.from(JSON.stringify({ alg: 'PS256', typ: 'JWT', kid: account.key_id })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: account.sub_account, aud: 'https://oauth-login.cloud.huawei.com/oauth2/v3/token', iat: seconds, exp: seconds + 3600 })).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(input, 'ascii'), { key: createPrivateKey(account.private_key), padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64url');
  return `${input}.${signature}`;
}
export class HuaweiPushTransport implements PushTransport {
  private account: PushServiceAccount;
  private config: HuaweiPushConfig;
  private request: typeof fetch;
  private now: () => number;
  private jwt = '';
  private expires = 0;
  lastResult?: { code: string; requestId?: string };
  constructor(account: PushServiceAccount, config: HuaweiPushConfig, request: typeof fetch = fetch, now: () => number = Date.now) {
    if (!account.key_id || !account.sub_account || !account.private_key || !/^[A-Za-z0-9_-]+$/.test(account.project_id) || !config.category) throw new Error('Invalid Harmony Push account or category configuration');
    createPrivateKey(account.private_key);
    this.account = account; this.config = config; this.request = request; this.now = now;
  }
  static async load(config: HuaweiPushConfig): Promise<HuaweiPushTransport> {
    const account: PushServiceAccount = JSON.parse(await readFile(config.serviceAccountFile, 'utf8'));
    return new HuaweiPushTransport(account, config);
  }
  async send(token: string, notice: PushNotice, signal: AbortSignal): Promise<PushResult> {
    this.lastResult = undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const seconds = Math.floor(this.now() / 1000);
      if (!this.jwt || seconds >= this.expires - 60) { this.jwt = makePushJwt(this.account, seconds); this.expires = seconds + 3600; }
      let response: Response;
      try {
        response = await this.request(`https://push-api.cloud.huawei.com/v3/${this.account.project_id}/messages:send`, {
          method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.jwt}`, 'push-type': '0' },
          body: JSON.stringify({ payload: { notification: { category: this.config.category, title: notice.title, body: notice.body, clickAction: { actionType: 0, data: { hostId: notice.hostId, sessionId: notice.sessionId, eventId: notice.eventId, ...(notice.interactionId ? { interactionId: notice.interactionId } : {}) } }, notifyId: createHash('sha256').update(notice.notificationId).digest().readUInt32BE(0) & 0x7fffffff, foregroundShow: false } }, target: { token: [token] }, pushOptions: { testMessage: this.config.testMessage ?? false, ttl: Math.max(1, Math.min(3600, notice.ttlSeconds)) } })
        });
      } catch { signal.throwIfAborted(); return 'retry'; }
      if (response.status === 429 || response.status >= 500) return 'retry';
      let body: ProviderResponse;
      try { body = await response.json(); } catch { return response.ok ? 'permanent' : response.status === 401 ? 'authentication' : 'permanent'; }
      const code = typeof body.code === 'string' ? body.code : 'invalid_response';
      this.lastResult = { code, requestId: typeof body.requestId === 'string' ? body.requestId : undefined };
      if (code === '80200005' && attempt === 0) { this.jwt = ''; continue; }
      if (code === '80000000' && response.ok) return 'accepted';
      if (code === '80300029') return 'retry';
      if (code === '80200001' || code === '80200005' || response.status === 401) return 'authentication';
      if (code === '80300002' || code === '80300007' || response.status === 403) return 'permission';
      return 'permanent';
    }
    return 'authentication';
  }
}

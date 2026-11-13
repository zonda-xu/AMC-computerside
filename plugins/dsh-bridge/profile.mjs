import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const controllerDigest = 'a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386';
export const controllerProfile = 'dsh-controller-0.2.1-rc.5-page-v2';

export async function controllerEvidence(ctl) {
  try {
    const entry = import.meta.resolve('@deepseek-ai/dsh-api-session-controller');
    const bytes = await readFile(new URL(entry));
    if (createHash('sha256').update(bytes).digest('hex') !== controllerDigest) throw new Error('controller package entry digest mismatch');
    const native = await import(entry);
    if (!(ctl instanceof native.SessionController)) throw new Error('loaded service is not the verified SessionController instance');
    for (const method of ['list', 'page', 'projections']) if (typeof ctl[method] !== 'function') throw new Error('missing controller method: ' + method);
    return { version: '0.2.1-rc.5', apiProfile: controllerProfile, controllerDigest, detail: 'Official controller artifact and loaded service identity verified; read-only page/projections only' };
  } catch (error) {
    return { version: '', apiProfile: '', controllerDigest: '', detail: 'DSH API unverified: ' + error.message };
  }
}

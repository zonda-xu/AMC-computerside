import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { service, sessionRows, featureCapabilities } from './features.mjs';

export const controllerDigest = 'a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386';
export const controllerProfile = 'dsh-controller-capabilities-v2';

// Cordis 4 returns a fresh context-bound proxy on each service access. Compare
// its documented original target, while retaining the scoped proxy for calls.
const originalService = value => value?.[Symbol.for('cordis.original')] ?? value;

/** @returns {Promise<{version:string,apiProfile:string,controllerDigest:string,verified:boolean,capabilities:Record<string,boolean>,detail:string}>} */
export async function controllerEvidence(ctl, ctx, options = {}) {
  let version = ''; let digest = '';
  try {
    const entry = import.meta.resolve('@deepseek-ai/dsh-api-session-controller');
    digest = createHash('sha256').update(await readFile(new URL(entry))).digest('hex');
    let directory = dirname(fileURLToPath(entry));
    for (let n = 0; n < 5; n++) {
      const manifest = await readFile(join(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (manifest?.name === '@deepseek-ai/dsh-api-session-controller') { version = manifest.version || ''; break; }
      directory = dirname(directory);
    }
  } catch { /* Bundled hosts need not expose the package to this plugin. */ }
  try {
    if (!ctx || !ctl || originalService(service(ctx, 'sessionController')) !== originalService(ctl) || typeof ctx.on !== 'function') throw new Error('loaded host service identity/events unavailable');
    for (const method of ['create', 'prompt', 'cancel', 'list', 'page', 'follow', 'projections']) if (typeof ctl[method] !== 'function') throw new Error('missing controller method: ' + method);
    if (options.compatibilityMode === 'pinned' && (!version || version !== options.expectedVersion)) throw new Error('pinned controller version mismatch');
    sessionRows(await ctl.list({}, AbortSignal.timeout(10000)));
    return { version, apiProfile: controllerProfile, controllerDigest: digest, verified: false, capabilities: featureCapabilities(ctx, ctl),
      detail: 'Loaded host controller and list contract available; capabilities detected independently. Native end-to-end verification is still required.' };
  } catch (error) {
    return { version, apiProfile: '', controllerDigest: digest, verified: false, capabilities: {}, detail: 'DSH API unverified; control disabled: ' + error.message };
  }
}

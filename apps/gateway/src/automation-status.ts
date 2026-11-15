import type { Core } from './core.ts';
import { automationSettings } from './automation.ts';

export function automationStatus(core: Core) {
  const automation = core.automation;
  const settings = automation?.settings ?? automationSettings();
  const discovery = automation?.discovery.status;
  const sync = [...automation?.externalSync.statuses.values() ?? []];
  const successes = sync.flatMap(status => status.lastSuccessAt ? [status.lastSuccessAt] : []);
  if (discovery?.state === 'complete' && discovery.finishedAt) successes.push(discovery.finishedAt);
  const failedScan = discovery?.state === 'partial';
  const failedSync = sync.some(status => status.state === 'failed');
  const candidates = [...automation?.externalSync.candidateStatuses.values() ?? []];
  const limited = !!discovery?.errors.some(error => /budget/i.test(error)) || sync.some(status => /budget/i.test(status.error ?? '')) || candidates.some(status => status.error === 'external_budget');
  const failures = [failedScan ? discovery?.finishedAt : undefined, automation?.externalSync.lastFailureAt, core.lastListenerFailure?.at].filter((time): time is number => typeof time === 'number');
  const backgroundFailed = !!automation?.externalSync.lastFailureCode || !!core.lastListenerFailure;
  return {
    enabled: settings.enabled,
    roots: [...core.allowedRoots],
    scanIntervalSeconds: settings.scanIntervalSeconds,
    syncIntervalSeconds: settings.syncIntervalSeconds,
    limited,
    ...(successes.length ? { lastSuccessAt: Math.max(...successes) } : {}),
    ...(failures.length ? { lastFailureAt: Math.max(...failures) } : {}),
    ...(failedScan || failedSync || backgroundFailed ? { lastFailureCode: limited ? 'automation_budget' : failedScan ? 'discovery_failed' : backgroundFailed ? 'automation_background_failed' : 'synchronization_failed' } : {})
  };
}

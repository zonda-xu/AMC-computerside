export interface AutomationConfig {
  enabled?: boolean;
  scanIntervalSeconds?: number;
  syncIntervalSeconds?: number;
  excludedDirectoryNames?: string[];
}
export interface AutomationSettings {
  enabled: boolean;
  scanIntervalSeconds: number;
  syncIntervalSeconds: number;
  excludedDirectoryNames: string[];
}
export function automationSettings(value?: AutomationConfig): AutomationSettings {
  const interval = (n: number | undefined, fallback: number) => n === undefined ? fallback : n;
  const settings = { enabled: value?.enabled ?? false, scanIntervalSeconds: interval(value?.scanIntervalSeconds, 60),
    syncIntervalSeconds: interval(value?.syncIntervalSeconds, 15), excludedDirectoryNames: value?.excludedDirectoryNames ?? [] };
  if (typeof settings.enabled !== 'boolean' || ![settings.scanIntervalSeconds, settings.syncIntervalSeconds].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 86400)
    || !Array.isArray(settings.excludedDirectoryNames) || settings.excludedDirectoryNames.length > 1000
    || !settings.excludedDirectoryNames.every(n => typeof n === 'string' && n.length > 0 && n.length <= 255 && !/[\\/\0]/.test(n))) throw new Error('Invalid automation configuration');
  return settings;
}

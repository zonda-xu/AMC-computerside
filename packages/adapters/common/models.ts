import type { ModelIdentity } from '../../protocol/src/types.ts';

// Identity always comes from the native catalog. Labels and parameter counts are
// descriptive metadata, never substitutes for the provider/model pair.
export function catalogModel(providerId: unknown, modelId: unknown, label: unknown, source: string, metadata: Record<string, any> = {}): ModelIdentity | undefined {
  if (typeof providerId !== 'string' || !providerId.trim() || typeof modelId !== 'string' || !modelId.trim()) return;
  const model: ModelIdentity = { providerId, modelId, label: typeof label === 'string' && label ? label : modelId, catalogSource: source };
  if (typeof metadata.parameterCount === 'number' && Number.isFinite(metadata.parameterCount) && metadata.parameterCount > 0) {
    model.parameterCount = metadata.parameterCount; model.parameterSource = source;
  }
  return model;
}
export function uniqueModels(items: Array<ModelIdentity | undefined>): ModelIdentity[] {
  const seen = new Set<string>();
  return items.filter((m): m is ModelIdentity => { if (!m) return false; const key = JSON.stringify([m.providerId, m.modelId]); if (seen.has(key)) return false; seen.add(key); return true; });
}
export function openCodeModels(response: Record<string, any>): ModelIdentity[] {
  if (!Array.isArray(response.data)) throw new Error('OpenCode model.list did not return data[]');
  return uniqueModels(response.data.filter((m: Record<string, any>) => !m.type || m.type === 'chat').map((m: Record<string, any>) => catalogModel(m.providerID, m.id, m.name, 'opencode:/api/model', m)));
}

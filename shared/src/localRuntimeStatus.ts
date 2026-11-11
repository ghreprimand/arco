import type { ArcoSettings, Capabilities } from './index.js';
import type { OllamaLiveStatus, LlamacppLiveStatus } from './protocol/usage.js';

export const LOCAL_STATUS_PROVIDERS = ['ollama', 'llamacpp', 'strata', 'deepseek'] as const;
export type LocalStatusProvider = typeof LOCAL_STATUS_PROVIDERS[number];
export const LOCAL_STATUS_LABELS: Record<LocalStatusProvider, string> = { ollama: 'Ollama', llamacpp: 'llama.cpp', strata: 'Strata', deepseek: 'Xolotl' };
export type LocalRuntimeState = 'loaded' | 'idle' | 'stopped' | 'down' | 'unknown';
export interface LocalRuntimeStatus {
  provider: LocalStatusProvider;
  state: LocalRuntimeState;
  models: string[];
  detail?: string;
  modelExpiries?: Record<string, string>;
}
export interface LocalRuntimeSnapshot {
  rows: LocalRuntimeStatus[];
  fetchedAt: number;
  ollama?: OllamaLiveStatus;
  llamacpp?: LlamacppLiveStatus;
}
export function aggregateLocalRuntimeState(rows: readonly LocalRuntimeStatus[]): LocalRuntimeState {
  if (rows.some(r => r.state === 'down')) return 'down';
  if (rows.some(r => r.state === 'loaded')) return 'loaded';
  if (!rows.length || rows.some(r => r.state === 'unknown')) return 'unknown';
  return 'idle';
}
export function localRuntimeStateText(row: LocalRuntimeStatus): string {
  if (row.state === 'loaded') return row.models.length ? `model loaded: ${row.models.join(', ')}` : 'model loaded';
  if (row.state === 'idle') return 'up and idle';
  if (row.state === 'stopped') return 'stopped - starts on demand';
  if (row.state === 'down') return 'unavailable / down';
  return row.detail ?? 'status not yet known';
}

// Reuse the installed-version signals already used by VERSIONS. No new
// installation discovery, endpoint or service-manager call is needed here.
export function enabledLocalStatusProviders(settings: ArcoSettings | null, versions: Pick<Capabilities, 'strataVersion' | 'xolotlRevision'> | null = null): LocalStatusProvider[] {
  return LOCAL_STATUS_PROVIDERS.filter(provider => {
    if (settings?.enabledProviders[provider] === false) return false;
    const version = provider === 'strata' ? versions?.strataVersion : provider === 'deepseek' ? versions?.xolotlRevision : null;
    return provider !== 'strata' && provider !== 'deepseek' || !!version && version !== 'unknown';
  });
}
export function localModelExpiry(iso: string, now = Date.now()): string {
  const delta = new Date(iso).getTime() - now;
  if (!Number.isFinite(delta)) return 'time unknown';
  if (delta <= 0) return 'any moment';
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return 'in <1m';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return remainder ? `in ${hours}h ${remainder}m` : `in ${hours}h`;
}

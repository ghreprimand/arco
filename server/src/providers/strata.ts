import { readStrataProfiles, strataProfileManager } from './strataProfiles.js';
import { readSettings } from '../settings.js';
import { resolveConfigValue } from '../configValue.js';
import { OpenAIHttpWorkerProcess, type LmstudioModelCapabilities } from './lmstudio.js';
import type { Provider } from './types.js';

export async function getStrataBase(): Promise<string> {
  const settings = await readSettings();
  const configured = settings.strata?.baseUrl;
  const raw = configured ? (await resolveConfigValue(configured)).value : process.env.STRATA_URL_BASE;
  const base = (raw || 'http://127.0.0.1:8081/v1').trim().replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

// Strata enriches the OpenAI model list with the configured context and live
// input modalities. Never infer vision from the Qwen name: it needs an encoder.
export async function probeStrata(): Promise<{
  up: boolean;
  models: string[];
  capabilities?: Record<string, LmstudioModelCapabilities>;
  labels?: Record<string, string>;
  error?: string;
}> {
  const base = await getStrataBase();
  const models: string[] = [];
  const capabilities: Record<string, LmstudioModelCapabilities> = {};
  const labels: Record<string, string> = {};
  let managed = false;
  try {
    const registry = await readStrataProfiles(base);
    managed = !!registry?.profiles.length;
    for (const p of registry?.profiles ?? []) {
      models.push(p.model); capabilities[p.model] = p.capabilities; labels[p.model] = p.label;
    }
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`/models HTTP ${res.status}`);
    const json = await res.json() as { data?: Array<{
      id?: string;
      meta?: { n_ctx?: number };
      architecture?: { input_modalities?: string[] };
    }> };
    if (!Array.isArray(json.data)) throw new Error('/models missing data array');
    for (const m of json.data) {
      if (typeof m.id !== 'string' || !m.id) continue;
      if (!models.includes(m.id)) models.push(m.id);
      capabilities[m.id] = {
        tools: true, thinking: true,
        vision: m.architecture?.input_modalities?.includes('image') === true,
        ...(Number.isSafeInteger(m.meta?.n_ctx) && m.meta!.n_ctx! > 0 ? { numCtx: m.meta!.n_ctx } : {}),
      };
    }
    return { up: true, models, capabilities, labels };
  } catch (err) {
    return { up: managed, models, capabilities, labels, error: `Strata at ${base}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const StrataProvider: Provider = {
  create(id, config) {
    return new OpenAIHttpWorkerProcess(id, config, {
      name: 'strata', label: 'Strata', base: getStrataBase, probe: probeStrata, chatWeb: true,
      toolResultPolicy: 'runtime',
      prepare: (base, model, signal, notice) => strataProfileManager.ensure(base, model, signal, notice),
    });
  },
};

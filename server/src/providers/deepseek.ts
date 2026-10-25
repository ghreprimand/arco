import { readSettings } from '../settings.js';
import { resolveConfigValue } from '../configValue.js';
import { OpenAIHttpWorkerProcess, type LmstudioModelCapabilities } from './lmstudio.js';
import { deepseekProfileManager, readDeepSeekProfiles } from './deepseekProfiles.js';
import type { Provider } from './types.js';

export async function getDeepSeekBase(): Promise<string> {
  const configured = (await readSettings()).deepseek?.baseUrl;
  const raw = configured ? (await resolveConfigValue(configured)).value : process.env.DEEPSEEK_URL_BASE;
  const base = (raw || 'http://127.0.0.1:8150/v1').trim().replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}
export async function probeDeepSeek(): Promise<{
  up: boolean; models: string[]; labels?: Record<string, string>;
  capabilities?: Record<string, LmstudioModelCapabilities>; error?: string;
}> {
  try {
    const registry = await readDeepSeekProfiles(await getDeepSeekBase());
    if (!registry) return { up: false, models: [], error: 'Register the prepared DeepSeek Xolotl profiles in ~/.archon/deepseek-profiles.json.' };
    return { up: true, models: registry.profiles.map((p) => p.model),
      labels: Object.fromEntries(registry.profiles.map((p) => [p.model, p.label])),
      capabilities: Object.fromEntries(registry.profiles.map((p) => [p.model, p.capabilities])) };
  } catch (err) { return { up: false, models: [], error: err instanceof Error ? err.message : String(err) }; }
}
export const DeepSeekProvider: Provider = {
  create(id, config) {
    return new OpenAIHttpWorkerProcess(id, config, {
      name: 'deepseek', label: 'DeepSeek (Xolotl)', base: getDeepSeekBase, probe: probeDeepSeek,
      chatWeb: true, toolResultPolicy: 'runtime',
      prepare: (base, model, signal, notice) => deepseekProfileManager.ensure(base, model, signal, notice),
    });
  },
};

import type { LocalModelProvider, LocalModelUnloadOutcome, LocalModelUnloadReport } from '@archon/shared';
import { isIP } from 'node:net';
import { workflows } from './server/state.js';
import { broadcastWorkflow } from './server/broadcast.js';
import { aggregateOllamaPs, unloadOllamaModel } from './providers/ollama.js';
import { getStrataBase } from './providers/strata.js';
import { getDeepSeekBase } from './providers/deepseek.js';
import { deepseekProfileManager, readDeepSeekProfiles } from './providers/deepseekProfiles.js';
import { getLmstudioBase } from './providers/lmstudio.js';
import { llamacppManager } from './providers/llamacppManager.js';
import { beginLocalModelUnload, isLocalModelProvider, localModelBusyMessage } from './providers/localModelControl.js';

export function isLoopbackModelEndpoint(base: string): boolean {
  try {
    const url = new URL(base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  } catch { return false; }
}

export function activeLocalWork(): boolean {
  return [...workflows.values()].some((wf) =>
    (wf.busy && isLocalModelProvider(wf.primary.provider)) ||
    Object.values(wf.manager.snapshotWorkers()).some((w) =>
      isLocalModelProvider(w.provider) && (w.status === 'running' || w.status === 'spawning')));
}

async function request(url: string, body?: object): Promise<any> {
  const res = await fetch(url, {
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(body ? 60_000 : 4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// All targets come from server settings, never a caller-supplied URL. Loopback
// only: freeing this machine's VRAM must not evict a peer's serving model.
export async function unloadLocalModels(): Promise<LocalModelUnloadReport> {
  const release = beginLocalModelUnload();
  if (!release) return { blocked: true, error: localModelBusyMessage(), results: [] };
  try {
    if (activeLocalWork()) return { blocked: true, error: 'Finish or cancel active local model turns before freeing VRAM.', results: [] };
    const results: LocalModelUnloadOutcome[] = [];
    const attempt = async (provider: LocalModelProvider, fn: () => Promise<void>) => {
      // A provider hidden in the picker can still have a model resident.
      try { await fn(); }
      catch (err) { results.push({ provider, state: 'failed', detail: err instanceof Error ? err.message : String(err) }); }
    };
    await Promise.all([
      attempt('ollama', async () => {
        const ps = await aggregateOllamaPs();
        for (const backend of ps.backends) {
          if (!isLoopbackModelEndpoint(backend.baseUrl)) {
            results.push({ provider: 'ollama', state: 'skipped', detail: `${backend.label}: remote endpoint` }); continue;
          }
          if (!backend.reachable) { results.push({ provider: 'ollama', state: 'unavailable', detail: backend.label }); continue; }
          if (!backend.loadedModels.length) results.push({ provider: 'ollama', state: 'idle' });
          for (const model of backend.loadedModels) {
            const unloaded = await unloadOllamaModel(model.name, backend.baseUrl);
            results.push({ provider: 'ollama', model: model.name, state: unloaded.ok ? 'unloaded' : 'failed', detail: unloaded.error });
          }
        }
      }),
      attempt('deepseek', async () => {
        const base = await getDeepSeekBase();
        if (!await readDeepSeekProfiles(base)) { results.push({ provider: 'deepseek', state: 'unavailable', detail: 'No matching prepared Xolotl registry' }); return; }
        results.push({ provider: 'deepseek', state: await deepseekProfileManager.unload(base) });
      }),
      attempt('strata', async () => {
        const base = await getStrataBase();
        if (!isLoopbackModelEndpoint(base)) { results.push({ provider: 'strata', state: 'skipped', detail: 'Remote endpoint' }); return; }
        let status: any;
        try { status = await request(`${base}/status`); }
        catch { results.push({ provider: 'strata', state: 'unavailable' }); return; }
        if (!status.loaded) { results.push({ provider: 'strata', state: 'idle' }); return; }
        if (status.activity?.in_flight > 0) throw new Error('Strata is busy; finish its active request first.');
        const response = await request(`${base}/unload`, { model: status.model });
        if (response.loaded !== false) throw new Error('Strata did not confirm that the model was unloaded.');
        results.push({ provider: 'strata', model: status.model, state: 'unloaded' });
      }),
      attempt('llamacpp', async () => {
        const status = llamacppManager.getStatus();
        if (status.state === 'idle' || status.state === 'failed') { results.push({ provider: 'llamacpp', state: 'idle' }); return; }
        if (status.state === 'loading') throw new Error('llama.cpp is loading a model; wait for it to finish.');
        await llamacppManager.unload();
        results.push({ provider: 'llamacpp', model: status.alias, state: 'unloaded' });
      }),
      attempt('lmstudio', async () => {
        const base = await getLmstudioBase();
        if (!isLoopbackModelEndpoint(base)) { results.push({ provider: 'lmstudio', state: 'skipped', detail: 'Remote endpoint' }); return; }
        const api = `${base.replace(/\/v\d+$/, '')}/api/v1/models`;
        let response: any;
        try { response = await request(api); }
        catch { results.push({ provider: 'lmstudio', state: 'unavailable', detail: 'Native model-management API unavailable' }); return; }
        if (!Array.isArray(response.models)) throw new Error('LM Studio returned an invalid model list.');
        const instances = response.models.filter((m: any) => m.type === 'llm').flatMap((m: any) => m.loaded_instances ?? []);
        if (!instances.length) results.push({ provider: 'lmstudio', state: 'idle' });
        for (const instance of instances) {
          if (typeof instance.id !== 'string') continue;
          try {
            const unloaded = await request(`${api}/unload`, { instance_id: instance.id });
            if (unloaded.instance_id !== instance.id) throw new Error('Unload was not confirmed');
            results.push({ provider: 'lmstudio', model: instance.id, state: 'unloaded' });
          } catch (err) {
            results.push({ provider: 'lmstudio', model: instance.id, state: 'failed', detail: err instanceof Error ? err.message : String(err) });
          }
        }
      }),
    ]);
    const content = `[FREE VRAM] ${results.map((r) => `${r.provider}${r.model ? ` (${r.model})` : ''}: ${r.state}${r.detail ? ` — ${r.detail}` : ''}`).join('; ')}. The next model request reloads it from disk.`;
    console.log(`[archon] ${content}`);
    for (const [workflowId, wf] of workflows) {
      if (!wf.config.incognito && isLocalModelProvider(wf.primary.provider)) {
        broadcastWorkflow(workflowId, { type: 'system_notice', workflowId, content });
      }
    }
    return { results };
  } finally { release(); }
}

// Xolotl has its own assets, flags and guarded launcher. Keep it out of the
// Qwen-only Strata registry and never launch the engine beneath an Archon worker.
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LmstudioModelCapabilities } from './lmstudio.js';
import { isManagedStrataEndpoint } from './strataProfiles.js';
import { beginLocalModelSwitch, localModelBusyMessage } from './localModelControl.js';
import { archonHome } from '../archonHome.js';

const exec = promisify(execFile);
export interface DeepSeekProfile {
  id: 'exact' | 'light'; model: string; label: string; config: string;
  capabilities: LmstudioModelCapabilities;
}
export interface DeepSeekRegistry {
  baseUrl: string; runtime: string;
  launcher: { python: string; script: string };
  profiles: DeepSeekProfile[];
}
export interface DeepSeekStatus {
  model?: string; loaded?: boolean; engine?: string;
  context?: { max_positions?: number };
  vision?: { enabled?: boolean };
  activity?: { in_flight?: number };
}
export function deepseekProfilesPath(): string {
  return process.env.ARCHON_DEEPSEEK_PROFILES || join(archonHome(), 'deepseek-profiles.json');
}

export async function readDeepSeekProfiles(base: string): Promise<DeepSeekRegistry | null> {
  if (!isManagedStrataEndpoint(base)) return null;
  let raw: any;
  try { raw = JSON.parse(await readFile(deepseekProfilesPath(), 'utf8')); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('DeepSeek profile registry is not valid JSON.'); }
  if (raw.baseUrl !== base) return null;
  for (const file of [raw.runtime, raw.launcher?.python, raw.launcher?.script]) {
    if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('DeepSeek runtime and launcher paths must be absolute.');
    await access(file, constants.R_OK);
  }
  if (!Array.isArray(raw.profiles) || raw.profiles.length !== 2) throw new Error('Register both DeepSeek Exact and Light profiles.');
  const seen = new Set<string>();
  const profiles: DeepSeekProfile[] = [];
  for (const p of raw.profiles) {
    if (!p || !['exact', 'light'].includes(p.id) || seen.has(p.id) || typeof p.label !== 'string' || !p.label ||
        typeof p.config !== 'string' || !isAbsolute(p.config) || p.model !== `deepseek-v4.1-flash-1017-${p.id}`) throw new Error('Invalid DeepSeek profile registration.');
    seen.add(p.id);
    const cfg = JSON.parse(await readFile(p.config, 'utf8'));
    if (cfg.model_name !== p.model || cfg.cwd !== raw.runtime || !Array.isArray(cfg.args)) throw new Error(`DeepSeek ${p.id} does not match its configuration.`);
    const arg = (flag: string) => { const i = cfg.args.indexOf(flag); return i < 0 ? undefined : cfg.args[i + 1]; };
    if (Number(arg('--ctx')) !== 262144 || (cfg.args.includes('--vision') && !cfg.vision)) throw new Error(`DeepSeek ${p.id} must use the prepared 262144-token configuration.`);
    const bias = p.id === 'exact' ? ['0', '0'] : ['0.25', '0.15'];
    if (arg('--route-bias') !== bias[0] || arg('--route-bias-file') !== bias[1]) throw new Error(`DeepSeek ${p.id} routing does not match its label.`);
    for (const file of [cfg.exe, cfg.tokenizer, arg('-m'), arg('--engram'), arg('--rank')]) {
      if (typeof file !== 'string' || !isAbsolute(file)) throw new Error(`DeepSeek ${p.id} assets are not prepared.`);
      await access(file, constants.R_OK);
    }
    if (cfg.vision !== undefined) {
      if (!cfg.vision || typeof cfg.vision !== 'object' || cfg.vision.model !== arg('-m') ||
          typeof cfg.vision.gpu !== 'boolean' || cfg.vision.lazy !== true ||
          !Number.isInteger(cfg.vision.max_tokens) || cfg.vision.max_tokens < 1 || cfg.vision.max_tokens > 1024) {
        throw new Error(`DeepSeek ${p.id} vision configuration does not match its prepared model.`);
      }
      for (const file of [cfg.vision.exe, cfg.vision.python, cfg.vision.mmproj,
        join(cfg.vision.reference_dir ?? '', 'vision.py'), join(cfg.vision.reference_dir ?? '', 'image_processor.py')]) {
        if (typeof file !== 'string' || !isAbsolute(file)) throw new Error(`DeepSeek ${p.id} vision assets are not prepared.`);
        await access(file, constants.R_OK);
      }
    }
    profiles.push({ id: p.id, model: p.model, label: p.label, config: p.config,
      capabilities: { tools: true, thinking: true, vision: !!cfg.vision, numCtx: 262144 } });
  }
  return { baseUrl: base, runtime: raw.runtime, launcher: raw.launcher, profiles };
}

export async function deepseekStatus(base: string): Promise<DeepSeekStatus | null> {
  try {
    const res = await fetch(`${base}/status`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() as DeepSeekStatus : null;
  } catch { return null; }
}
export interface DeepSeekDependencies {
  registry: typeof readDeepSeekProfiles;
  status: typeof deepseekStatus;
  state: (id: string) => Promise<string>;
  launcher: (registry: DeepSeekRegistry, action: 'start' | 'stop', id: string) => Promise<void>;
  checkSwitch: (registry: DeepSeekRegistry) => Promise<void>;
  otherLocalWork: (includeDeepSeek?: boolean) => boolean;
  pause: () => Promise<void>;
  timeoutMs: number;
}
let otherLocalWork = (_includeDeepSeek?: boolean) => false;
export function setDeepSeekActivityCheck(check: typeof otherLocalWork): void { otherLocalWork = check; }
const defaults: DeepSeekDependencies = {
  registry: readDeepSeekProfiles, status: deepseekStatus,
  async state(id) {
    const { stdout } = await exec('systemctl', ['--user', 'show', `deepseek-flash@${id}.service`, '--property=ActiveState', '--value'], { timeout: 10000 });
    return stdout.trim();
  },
  async launcher(registry, action, id) {
    try { await exec(registry.launcher.python, [registry.launcher.script, action, id], { timeout: 150000, maxBuffer: 256 * 1024 }); }
    catch (err) { throw new Error(`DeepSeek ${action} refused: ${String((err as { stderr?: string }).stderr || 'inspect the guarded launcher and service journal').trim()}`); }
  },
  async checkSwitch(registry) {
    // The launcher's full check cannot pass while the previous profile holds
    // RAM/VRAM. Check mining before stopping it; start repeats ALL guards.
    const { stdout } = await exec(registry.launcher.python, [registry.launcher.script, 'status'], { timeout: 20000, maxBuffer: 512 * 1024 });
    const status = JSON.parse(stdout);
    if (!Array.isArray(status.miners) || status.miners.length) throw new Error('Mining is running or its state is unknown. Stop the miner yourself before loading DeepSeek.');
    if (status.preparation?.phase !== 'ready') throw new Error('DeepSeek asset preparation is incomplete.');
  },
  otherLocalWork: (includeDeepSeek) => otherLocalWork(includeDeepSeek),
  pause: () => new Promise((resolve) => setTimeout(resolve, 500)), timeoutMs: 900000,
};

export class DeepSeekProfileManager {
  constructor(private deps: DeepSeekDependencies = defaults) {}
  private validateLoaded(status: DeepSeekStatus, target: DeepSeekProfile): void {
    if (status.context?.max_positions !== 262144 || (status.vision?.enabled === true) !== target.capabilities.vision) throw new Error('DeepSeek live context/modalities do not match the prepared 262144-token profile.');
  }
  async snapshot(base: string) {
    const registry = await this.deps.registry(base);
    const live = await this.deps.status(base);
    const profiles = await Promise.all((registry?.profiles ?? []).map(async (p) => ({
      ...p, serviceState: await this.deps.state(p.id), loaded: live?.model === p.model && live.loaded === true,
    })));
    return { runtime: 'Xolotl', baseUrl: base, managed: !!registry, profiles, live };
  }
  private async ready(base: string, target: DeepSeekProfile, signal?: AbortSignal): Promise<void> {
    const end = Date.now() + this.deps.timeoutMs;
    while (Date.now() < end) {
      signal?.throwIfAborted();
      const status = await this.deps.status(base);
      if (status?.model === target.model && status.loaded === true) { this.validateLoaded(status, target); return; }
      if (['failed', 'inactive'].includes(await this.deps.state(target.id))) throw new Error('DeepSeek service stopped before the model became ready. Inspect its journal.');
      await this.deps.pause();
    }
    throw new Error('DeepSeek exceeded its 15-minute readiness limit.');
  }
  async ensure(base: string, model: string, signal: AbortSignal, notice: (text: string) => void, manual = false): Promise<void> {
    const registry = await this.deps.registry(base);
    if (!registry) throw new Error('DeepSeek requires a prepared local profile registry matching its endpoint.');
    const target = registry.profiles.find((p) => p.model === model);
    if (!target) throw new Error('Select a registered DeepSeek Exact or Light profile.');
    signal.throwIfAborted();
    const release = beginLocalModelSwitch('deepseek');
    if (!release) throw new Error(localModelBusyMessage());
    let previous: DeepSeekProfile | undefined;
    let previousLoaded = false, stopped = false, attempted = false;
    try {
      if (this.deps.otherLocalWork(manual)) throw new Error('Finish or cancel other local model turns before loading DeepSeek.');
      const states = await Promise.all(registry.profiles.map(async (p) => ({ p, state: await this.deps.state(p.id) })));
      if (states.some((s) => ['activating', 'deactivating'].includes(s.state)) || states.filter((s) => s.state === 'active').length > 1) throw new Error('DeepSeek services are changing state; wait for them to settle.');
      previous = states.find((s) => s.state === 'active')?.p;
      const live = await this.deps.status(base);
      if (live?.activity?.in_flight) throw new Error('DeepSeek has an external request running or queued. Wait for it to finish.');
      if ((live && (!previous || live.model !== previous.model)) || (previous && !live)) throw new Error('DeepSeek endpoint identity does not match a ready managed service; nothing was stopped.');
      previousLoaded = live?.loaded === true;
      if (previous?.id === target.id && previousLoaded) { this.validateLoaded(live!, target); return; }
      await this.deps.checkSwitch(registry);
      signal.throwIfAborted();
      notice(`Loading DeepSeek · ${target.label} through the guarded Xolotl service.`);
      // Restart an idle-unloaded service too: the guarded start must recheck
      // miners, competing models and RAM/VRAM before the engine loads again.
      if (previous) { stopped = true; await this.deps.launcher(registry, 'stop', previous.id); }
      signal.throwIfAborted();
      attempted = true;
      await this.deps.launcher(registry, 'start', target.id);
      await this.ready(base, target, signal);
      notice(`DeepSeek ready · ${target.label} · 262144 tokens · ${target.capabilities.vision ? 'text + images' : 'text only'}.`);
    } catch (err) {
      if (stopped || attempted) {
        try {
          if (attempted) await this.deps.launcher(registry, 'stop', target.id);
          // A stopped/unloaded previous model remains unloaded. A loaded one
          // is restored only through the same resource/mining guard.
          if (previous && previousLoaded) {
            await this.deps.launcher(registry, 'start', previous.id);
            await this.ready(base, previous);
            notice(`DeepSeek restored · ${previous.label}.`);
          } else notice('DeepSeek remains stopped; model memory released.');
        } catch (rollback) { throw new Error(`DeepSeek load failed (${String(err)}); recovery also failed (${String(rollback)}). Inspect both service journals.`); }
      }
      throw err;
    } finally { release(); }
  }
  // Caller owns the global unload guard and has checked Archon's active work.
  async unload(base: string): Promise<'unloaded' | 'idle'> {
    const registry = await this.deps.registry(base);
    if (!registry) throw new Error('No managed DeepSeek profiles match this endpoint.');
    const live = await this.deps.status(base);
    if (live?.activity?.in_flight) throw new Error('DeepSeek has an external request running or queued.');
    const states = await Promise.all(registry.profiles.map(async (p) => ({ p, state: await this.deps.state(p.id) })));
    if (states.some((s) => ['activating', 'deactivating'].includes(s.state))) throw new Error('DeepSeek is changing service state.');
    const active = states.filter((s) => s.state === 'active');
    if (active.length > 1 || (live && (!active[0] || live.model !== active[0].p.model))) throw new Error('DeepSeek endpoint identity does not match its managed service.');
    if (!active.length) return 'idle';
    await this.deps.launcher(registry, 'stop', active[0].p.id);
    if ((await this.deps.state(active[0].p.id)) !== 'inactive' || await this.deps.status(base)) throw new Error('DeepSeek stop/resource release was not confirmed.');
    return 'unloaded';
  }
}
export const deepseekProfileManager = new DeepSeekProfileManager();

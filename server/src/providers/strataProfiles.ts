// Operator-registered local profiles. Discovery is read-only; a turn may switch
// only the named user units in this registry, never a model-supplied command.
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LmstudioModelCapabilities } from './lmstudio.js';
import { beginLocalModelSwitch, localModelBusyMessage } from './localModelControl.js';

const exec = promisify(execFile);
export interface StrataProfile {
  id: string;
  model: string;
  label: string;
  unit: string;
  config: string;
  capabilities: LmstudioModelCapabilities;
}
export interface StrataProfileRegistry {
  baseUrl: string;
  launcher: { python: string; script: string };
  profiles: StrataProfile[];
}
export function strataProfilesPath(): string {
  return process.env.ARCHON_STRATA_PROFILES || join(homedir(), '.archon', 'strata-profiles.json');
}
export function isManagedStrataEndpoint(base: string): boolean {
  try {
    const url = new URL(base);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export async function readStrataProfiles(base: string): Promise<StrataProfileRegistry | null> {
  if (!isManagedStrataEndpoint(base)) return null;
  let raw: any;
  try { raw = JSON.parse(await readFile(strataProfilesPath(), 'utf8')); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Strata profile registry is not valid JSON.'); }
  if (raw.baseUrl !== base || !Array.isArray(raw.profiles) || !raw.launcher) return null;
  for (const key of ['python', 'script']) {
    if (typeof raw.launcher[key] !== 'string' || !isAbsolute(raw.launcher[key])) throw new Error('Strata launcher paths must be absolute.');
    await access(raw.launcher[key], constants.R_OK);
  }
  const profiles: StrataProfile[] = [];
  const ids = new Set<string>(), models = new Set<string>(), units = new Set<string>();
  for (const p of raw.profiles) {
    if (!p || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(p.id) || typeof p.model !== 'string' || !p.model ||
        typeof p.label !== 'string' || !p.label || typeof p.unit !== 'string' || !/^strata[\w.-]*@[\w.-]+\.service$/.test(p.unit) ||
        typeof p.config !== 'string' || !isAbsolute(p.config) || ids.has(p.id) || models.has(p.model) || units.has(p.unit)) throw new Error('Invalid or duplicate Strata profile registration.');
    ids.add(p.id); models.add(p.model); units.add(p.unit);
    const cfg = JSON.parse(await readFile(p.config, 'utf8'));
    if (cfg.model_name !== p.model || !Array.isArray(cfg.args)) throw new Error(`Strata profile ${p.id} does not match its configuration.`);
    const arg = (flag: string) => { const i = cfg.args.indexOf(flag); return i < 0 ? undefined : cfg.args[i + 1]; };
    const nCtx = Number(arg('--max-context'));
    if (!Number.isSafeInteger(nCtx) || nCtx <= 0) throw new Error(`Strata profile ${p.id} has no configured context window.`);
    for (const file of [cfg.exe, cfg.tokenizer, arg('--pack'), arg('--native'), arg('--ple-gguf')]) {
      if (typeof file !== 'string' || !isAbsolute(file)) throw new Error(`Strata profile ${p.id} is not prepared.`);
      await access(file, constants.R_OK);
    }
    let vision = false;
    if (cfg.args.includes('--vision') && cfg.vision) {
      for (const file of [cfg.vision.exe, cfg.vision.mmproj, cfg.vision.model]) {
        if (typeof file !== 'string' || !isAbsolute(file)) throw new Error(`Strata profile ${p.id} has an invalid image encoder.`);
        await access(file, constants.R_OK);
      }
      vision = true;
    }
    profiles.push({ ...p, capabilities: { tools: true, thinking: true, vision, numCtx: nCtx } });
  }
  return { baseUrl: raw.baseUrl, launcher: raw.launcher, profiles };
}

interface Status { model?: string; loaded?: boolean; activity?: { in_flight?: number } }
export interface StrataSwitchDependencies {
  registry: (base: string) => Promise<StrataProfileRegistry | null>;
  status: (base: string) => Promise<Status | null>;
  unitState: (unit: string) => Promise<{ active: string; loaded: boolean }>;
  control: (action: 'start' | 'stop', unit: string) => Promise<void>;
  preflight: (registry: StrataProfileRegistry, profile: StrataProfile) => Promise<void>;
  otherLocalWork: () => boolean;
  unload: (base: string) => Promise<void>;
  pause: () => Promise<void>;
  readyTimeoutMs: number;
}
const defaults: StrataSwitchDependencies = {
  registry: readStrataProfiles,
  async status(base) {
    try {
      const res = await fetch(`${base}/status`, { signal: AbortSignal.timeout(3000) });
      return res.ok ? await res.json() as Status : null;
    } catch { return null; }
  },
  async unitState(unit) {
    const { stdout } = await exec('systemctl', ['--user', 'show', unit, '--property=ActiveState,LoadState'], { timeout: 10000 });
    const fields = Object.fromEntries(stdout.trim().split('\n').map((s) => s.split('=')));
    return { active: fields.ActiveState, loaded: fields.LoadState === 'loaded' };
  },
  async control(action, unit) { await exec('systemctl', ['--user', action, unit], { timeout: 120000 }); },
  async preflight(registry, profile) {
    try { await exec(registry.launcher.python, [registry.launcher.script, 'check-switch', profile.id], { timeout: 15000 }); }
    catch (err) { throw new Error(`Strata preflight refused the switch: ${String((err as { stderr?: string }).stderr || 'check the guarded launcher').trim()}`); }
  },
  async unload(base) {
    const res = await fetch(`${base}/unload`, { method: 'POST', signal: AbortSignal.timeout(15000) });
    if (!res.ok || (await res.json() as { loaded?: boolean }).loaded !== false) throw new Error('Strata unload was not confirmed.');
  },
  otherLocalWork: () => false,
  pause: () => new Promise((resolve) => setTimeout(resolve, 500)),
  readyTimeoutMs: 180000,
};
// A separate injection keeps discovery and tests free of server-state imports.
let otherLocalWork = () => false;
export function setStrataSwitchActivityCheck(check: () => boolean): void { otherLocalWork = check; }

export class StrataProfileManager {
  constructor(private deps: StrataSwitchDependencies = { ...defaults, otherLocalWork: () => otherLocalWork() }) {}
  private async ready(base: string, model: string, signal?: AbortSignal, unit?: string): Promise<Status> {
    const end = Date.now() + this.deps.readyTimeoutMs;
    while (Date.now() < end) {
      signal?.throwIfAborted();
      const status = await this.deps.status(base);
      if (status?.model === model && status.loaded === true) return status;
      if (unit && ['failed', 'inactive'].includes((await this.deps.unitState(unit)).active)) {
        throw new Error('Strata service stopped before the selected model became ready. Check its journal.');
      }
      await this.deps.pause();
    }
    throw new Error('Strata did not become ready before the load timeout.');
  }

  // Called only after the serial Strata turn slot is acquired. Selecting a
  // model never interrupts another tab; each turn reloads its chosen profile.
  async ensure(base: string, model: string, signal: AbortSignal, notice: (text: string) => void): Promise<void> {
    const registry = await this.deps.registry(base);
    if (!registry?.profiles.length) return; // Standalone/remote connection unchanged.
    const target = registry.profiles.find((p) => p.model === model);
    if (!target) throw new Error('This Strata model is not a registered profile. Refresh the model list.');
    signal.throwIfAborted();
    const status = await this.deps.status(base);
    // Keep FREE VRAM effective: the current unloaded profile reloads naturally
    // on its next completion request, without restarting the Python service.
    if (status?.model === model) return;
    const release = beginLocalModelSwitch();
    if (!release) throw new Error(localModelBusyMessage());
    let previous: StrataProfile | undefined;
    let stopped = false, attemptedStart = false;
    let previousLoaded = true;
    try {
      if (this.deps.otherLocalWork()) throw new Error('Finish or cancel other active local model turns before switching Strata.');
      const states = await Promise.all(registry.profiles.map(async (p) => ({ p, state: await this.deps.unitState(p.unit) })));
      const targetState = states.find((s) => s.p.model === model)!.state;
      if (!targetState.loaded) throw new Error('The selected Strata user service is not installed.');
      const active = states.filter((s) => s.state.active === 'active');
      if (states.some((s) => ['activating', 'deactivating'].includes(s.state.active)) || active.length > 1) throw new Error('Strata is already changing profiles; retry when it settles.');
      previous = active[0]?.p;
      const live = await this.deps.status(base);
      previousLoaded = live?.loaded !== false;
      if (live?.activity?.in_flight) throw new Error('Strata has an active request outside this turn. Wait for it to finish.');
      if ((live && (!previous || live.model !== previous.model)) || (previous && !live)) throw new Error('The endpoint does not match a ready registered Strata service; nothing was stopped.');
      // The existing guarded launcher checks miners and loaded Ollama models
      // before stopping anything. Its full RAM/VRAM preflight runs on start.
      await this.deps.preflight(registry, target);
      signal.throwIfAborted();
      notice(`Switching Strata to ${target.label}. Only one profile is loaded at a time.`);
      if (previous) { stopped = true; await this.deps.control('stop', previous.unit); }
      signal.throwIfAborted();
      attemptedStart = true;
      await this.deps.control('start', target.unit);
      await this.ready(base, model, signal, target.unit);
      notice(`Strata ready: ${target.label} (${target.capabilities.numCtx} tokens${target.capabilities.vision ? ', vision' : ''}).`);
    } catch (err) {
      if (stopped || attemptedStart) {
        notice('Strata could not finish the switch; restoring the previous profile.');
        try {
          if (attemptedStart) await this.deps.control('stop', target.unit);
          if (previous) {
            await this.deps.control('start', previous.unit); await this.ready(base, previous.model, undefined, previous.unit);
            if (!previousLoaded) await this.deps.unload(base);
          }
          notice(previous ? `Strata restored: ${previous.label}.` : 'Strata remains stopped.');
        } catch { throw new Error('Strata switch failed and the previous profile could not be restored. Check the service journal.'); }
      }
      throw err;
    } finally { release(); }
  }
}
export const strataProfileManager = new StrataProfileManager();

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { enabledLocalStatusProviders, type Capabilities, type ArcoSettings, type LocalRuntimeSnapshot, type LocalRuntimeStatus, type LocalStatusProvider, type OllamaLiveStatus, type LlamacppLiveStatus } from '@arco/shared';
import { readSettings } from './settings.js';
import { probeOllamaLive } from './providers/ollama.js';
import { resolveLlamaServer } from './providers/llamacppBinary.js';
import { probeLlamacppLive } from './providers/llamacpp.js';
import { getStrataBase } from './providers/strata.js';
import { getDeepSeekBase } from './providers/deepseek.js';
import { readStrataProfiles } from './providers/strataProfiles.js';
import { readDeepSeekProfiles } from './providers/deepseekProfiles.js';

const exec = promisify(execFile);
export interface ManagedUnitState { active: string; installed: boolean }
export function stoppedEngineState(states: readonly ManagedUnitState[]): LocalRuntimeStatus['state'] {
  if (states.some(s => !s.installed || s.active === 'failed')) return 'down';
  if (states.length && states.every(s => s.active === 'inactive')) return 'stopped';
  if (states.some(s => s.active === 'active')) return 'down'; // Running service, unreachable endpoint.
  return 'unknown';
}
export interface EngineStatusDependencies {
  base: (provider: 'strata' | 'deepseek') => Promise<string>;
  status: (base: string) => Promise<{ loaded?: boolean; model?: string } | null>;
  units: (provider: 'strata' | 'deepseek', base: string) => Promise<string[] | null>;
  unitStates: (units: string[]) => Promise<ManagedUnitState[]>;
}
const engineDefaults: EngineStatusDependencies = {
  base: p => p === 'strata' ? getStrataBase() : getDeepSeekBase(),
  async status(base) {
    try {
      const response = await fetch(`${base}/status`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return null;
      const value: unknown = await response.json();
      return value && typeof value === 'object' ? value as { loaded?: boolean; model?: string } : {};
    } catch { return null; }
  },
  async units(provider, base) {
    if (provider === 'strata') return (await readStrataProfiles(base))?.profiles.map(p => p.unit) ?? null;
    return (await readDeepSeekProfiles(base))?.profiles.map(p => `deepseek-flash@${p.id}.service`) ?? null;
  },
  async unitStates(units) {
    // Registry readers validate these unit names. This is a single bounded,
    // read-only metadata command; no launchers or service controls are called.
    const { stdout } = await exec('systemctl', ['--user', 'show', ...units, '--property=Id,LoadState,ActiveState'], { timeout: 1500, maxBuffer: 256 * 1024 });
    const blocks = stdout.trim().split(/\n\s*\n/).map(block => Object.fromEntries(block.split('\n').map(line => line.split('='))));
    return units.map(unit => {
      const fields = blocks.find(b => b.Id === unit);
      return { active: fields?.ActiveState ?? 'unknown', installed: fields?.LoadState === 'loaded' };
    });
  },
};
export async function probeEngineStatus(provider: 'strata' | 'deepseek', deps = engineDefaults): Promise<LocalRuntimeStatus> {
  const row = (state: LocalRuntimeStatus['state'], models: string[] = [], detail?: string): LocalRuntimeStatus => ({ provider, state, models, ...(detail ? { detail } : {}) });
  const base = await deps.base(provider);
  const live = await deps.status(base);
  if (live?.loaded === true) return row('loaded', typeof live.model === 'string' && live.model ? [live.model] : []);
  if (live?.loaded === false) return row('idle');
  if (live) return row('unknown');
  let units: string[] | null;
  try { units = await deps.units(provider, base); }
  catch { return row('down'); }
  if (!units?.length) return row('down');
  try { return row(stoppedEngineState(await deps.unitStates(units))); }
  catch { return row('unknown', [], 'service status unavailable'); }
}

interface StatusDependencies {
  settings: () => Promise<ArcoSettings>;
  ollama: () => Promise<Omit<OllamaLiveStatus, 'fetchedAt'>>;
  llamacpp: () => Promise<Omit<LlamacppLiveStatus, 'fetchedAt'>>;
  engine: (provider: 'strata' | 'deepseek') => Promise<LocalRuntimeStatus>;
  llamaInstalled?: () => boolean;
  now: () => number;
  timeoutMs: number;
}
const defaults: StatusDependencies = { settings: readSettings, llamaInstalled: () => !!resolveLlamaServer(), ollama: probeOllamaLive, llamacpp: probeLlamacppLive, engine: probeEngineStatus, now: Date.now, timeoutMs: 4500 };
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('status deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
export class LocalRuntimeStatusService {
  private cached?: { key: string; value: LocalRuntimeSnapshot; expires: number };
  private pending = new Map<string, Promise<LocalRuntimeSnapshot>>();
  constructor(private deps: StatusDependencies = defaults) {}
  async snapshot(versions: Pick<Capabilities, 'strataVersion' | 'xolotlRevision'> = {}): Promise<LocalRuntimeSnapshot> {
    const settings = await this.deps.settings();
    const enabled = enabledLocalStatusProviders(settings, versions).filter(provider => provider !== 'llamacpp' || this.deps.llamaInstalled?.() !== false);
    const key = JSON.stringify([enabled, settings.ollama, settings.strata, settings.deepseek]);
    if (this.cached?.key === key && this.cached.expires > this.deps.now()) return this.cached.value;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const work = this.collect(enabled).then(value => { this.cached = { key, value, expires: this.deps.now() + 5000 }; return value; }).finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
  private async collect(enabled: LocalStatusProvider[]): Promise<LocalRuntimeSnapshot> {
    const value: LocalRuntimeSnapshot = { rows: [], fetchedAt: this.deps.now() };
    value.rows = await Promise.all(enabled.map(async (provider): Promise<LocalRuntimeStatus> => {
      try {
        if (provider === 'ollama') {
          const live = await bounded(this.deps.ollama(), this.deps.timeoutMs);
          value.ollama = { ...live, fetchedAt: this.deps.now() };
          return { provider, state: !live.up ? 'down' : live.loadedModels.length ? 'loaded' : 'idle', models: live.up ? live.loadedModels.map(m => m.name) : [],
            ...(live.up && live.loadedModels.length ? { modelExpiries: Object.fromEntries(live.loadedModels.filter(m => m.expiresAt).map(m => [m.name, m.expiresAt!])) } : {}),
            ...(!live.up ? { detail: 'Daemon not reachable. Run ollama serve on this machine, or set OLLAMA_URL_BASE to point elsewhere.' } : {}) };
        }
        if (provider === 'llamacpp') {
          const live = await bounded(this.deps.llamacpp(), this.deps.timeoutMs);
          value.llamacpp = { ...live, fetchedAt: this.deps.now() };
          const state = !live.up || live.state === 'failed' ? 'down' : live.state === 'loading' ? 'unknown' : live.loadedModel ? 'loaded' : live.version ? 'stopped' : 'unknown';
          return { provider, state, models: state === 'loaded' && live.loadedModel ? [live.loadedModel] : [], ...(live.state === 'loading' ? { detail: 'model loading' } : {}) };
        }
        return await bounded(this.deps.engine(provider), this.deps.timeoutMs);
      } catch { return { provider, state: 'unknown', models: [], detail: 'status unavailable' }; }
    }));
    value.fetchedAt = this.deps.now();
    return value;
  }
}
export const localRuntimeStatusService = new LocalRuntimeStatusService();

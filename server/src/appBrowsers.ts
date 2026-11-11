// App window browser (Settings > Advanced). The detection and launch rules
// live in scripts/packaging/browsers.mjs so `arco open`, the application
// shortcut and this server agree; the module is loaded at run time from the
// package or the source checkout (server/src and server/dist sit two levels
// below the root).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { readSettings } from './settings.js';

export interface AppBrowser {
  id: string;
  family: string | null;
  name: string;
  path: string;
  command: string;
  flatpak?: string;
  installationId?: string;
  version?: string;
}
interface BrowsersModule {
  findBrowsers(platform: string, env?: NodeJS.ProcessEnv): AppBrowser[];
  resolveBrowser(choice: string | undefined, platform: string, env?: NodeJS.ProcessEnv, deps?: { browsers: AppBrowser[] }): { browser: AppBrowser | null; missing: boolean; unsupported?: boolean };
  browserVersionTarget(browser: AppBrowser, platform?: string): string | null;
  launchCommand(browser: AppBrowser, url: string, profile?: string): [string, string[]];
}

export const BROWSERS_MODULE = new URL('../../scripts/packaging/browsers.mjs', import.meta.url);
let loaded: Promise<BrowsersModule> | null = null;
export function browsersModule(): Promise<BrowsersModule> {
  loaded ??= import(BROWSERS_MODULE.href) as Promise<BrowsersModule>;
  return loaded;
}

export interface AppBrowserReport {
  platform: string;
  // The saved choice; null means Automatic.
  choice: string | null;
  // Installed browsers in search order (the first is the Automatic choice).
  browsers: Array<Pick<AppBrowser, 'id' | 'name' | 'path' | 'version'>>;
  // What a window would open in now, or null for a normal browser tab.
  using: Pick<AppBrowser, 'id' | 'name' | 'path' | 'version'> | null;
  // The saved choice was not found; Automatic is used instead.
  missing: boolean;
  // The saved choice names a browser without an app window (Firefox, Safari).
  unsupported: boolean;
}

const view = (b: AppBrowser) => ({ id: b.installationId || b.id, name: b.name, path: b.path });
const exec = promisify(execFile);
// Failures share the cache too: opening Settings must not repeatedly probe an
// unsupported or stuck build. No scripts, AppImages or browser windows run.
export class BrowserVersionCache {
  private values = new Map<string, { expires: number; value: Promise<string | undefined> }>();
  constructor(private read: (target: string, platform: string, env: NodeJS.ProcessEnv) => Promise<string | undefined> = async (target, platform, env) => {
    const options = { env, timeout: 1000, killSignal: 'SIGKILL' as const, windowsHide: true, maxBuffer: 16 * 1024 };
    const { stdout } = platform === 'win32'
      ? await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:ARCO_BROWSER_VERSION_FILE).VersionInfo.ProductVersion'], { ...options, env: { ...env, ARCO_BROWSER_VERSION_FILE: target } })
      : await exec(target, ['--version'], options);
    return stdout.match(/\b\d+(?:\.\d+){1,4}(?:[-.][a-z0-9]+)?\b/i)?.[0];
  }) {}
  async get(target: string, platform: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    let key = target;
    try { const file = await stat(target); key += `:${file.size}:${file.mtimeMs}`; } catch { return undefined; }
    const previous = this.values.get(key);
    if (previous && previous.expires > Date.now()) return previous.value;
    if (this.values.size >= 64) this.values.delete(this.values.keys().next().value!);
    const value = this.read(target, platform, env).catch(() => undefined);
    this.values.set(key, { expires: Date.now() + 10 * 60_000, value });
    return value;
  }
}
const versions = new BrowserVersionCache();

export async function appBrowserReport(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<AppBrowserReport> {
  const mod = await browsersModule();
  const choice = (await readSettings()).appWindowBrowser ?? null;
  const installed = mod.findBrowsers(platform, env);
  const { browser, missing, unsupported } = mod.resolveBrowser(choice ?? undefined, platform, env, { browsers: installed });
  const target = browser && mod.browserVersionTarget(browser, platform);
  const version = target ? await versions.get(target, platform, env) : undefined;
  return { platform, choice, browsers: installed.map(view), using: browser ? { ...view(browser), ...(version ? { version } : {}) } : null, missing, unsupported: unsupported === true };
}

// The saved choice for a server-opened window, when one is set and found.
// Unset or missing returns null so the caller keeps its own search.
export async function chosenAppBrowser(env: NodeJS.ProcessEnv = process.env): Promise<{ command: string; args: (url: string) => string[]; name: string } | null> {
  const choice = (await readSettings()).appWindowBrowser;
  if (!choice) return null;
  const mod = await browsersModule();
  const { browser, missing } = mod.resolveBrowser(choice, process.platform, env);
  if (!browser || missing) return null;
  return { command: browser.command, name: browser.name, args: (url) => mod.launchCommand(browser, url)[1] };
}

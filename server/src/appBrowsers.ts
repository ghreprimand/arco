// App window browser (Settings > Advanced). The detection and launch rules
// live in scripts/packaging/browsers.mjs so `arco open`, the application
// shortcut and this server agree; the module is loaded at run time from the
// package or the source checkout (server/src and server/dist sit two levels
// below the root).

import { readSettings } from './settings.js';

export interface AppBrowser {
  id: string;
  family: string | null;
  name: string;
  path: string;
  command: string;
  flatpak?: string;
}
interface BrowsersModule {
  findBrowsers(platform: string, env?: NodeJS.ProcessEnv): AppBrowser[];
  resolveBrowser(choice: string | undefined, platform: string, env?: NodeJS.ProcessEnv): { browser: AppBrowser | null; missing: boolean; unsupported?: boolean };
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
  browsers: Array<Pick<AppBrowser, 'id' | 'name' | 'path'>>;
  // What a window would open in now, or null for a normal browser tab.
  using: Pick<AppBrowser, 'id' | 'name' | 'path'> | null;
  // The saved choice was not found; Automatic is used instead.
  missing: boolean;
  // The saved choice names a browser without an app window (Firefox, Safari).
  unsupported: boolean;
}

const view = (b: AppBrowser) => ({ id: b.id, name: b.name, path: b.path });

export async function appBrowserReport(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<AppBrowserReport> {
  const mod = await browsersModule();
  const choice = (await readSettings()).appWindowBrowser ?? null;
  const { browser, missing, unsupported } = mod.resolveBrowser(choice ?? undefined, platform, env);
  return { platform, choice, browsers: mod.findBrowsers(platform, env).map(view), using: browser ? view(browser) : null, missing, unsupported: unsupported === true };
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

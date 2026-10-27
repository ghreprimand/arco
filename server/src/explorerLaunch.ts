// ARCHIVE (docs/CLIENT.md) - launch the standalone chromeless file
// explorer window. A web page can't spawn its own `--app=` chrome window, so
// the header ARCHIVE button POSTs here and the server spawns a Chromium-family
// browser in `--app=` mode (same detach pattern as the `claude auth login`
// spawn in auth.ts). This is the LOCAL path only; the client falls back to a
// `window.open` popup when this reports no-browser / spawn-failed (remote/
// tunnelled operators, or a headless prod unit with no display).
//
// Read-only feature, zero model authority — passes the four-question test
// trivially (§2). The one action is spawning a browser at a URL the operator
// clicked; nothing here touches the workflow, the filesystem, or any model.

import { spawn } from 'child_process';
import { access, constants } from 'fs/promises';
import { delimiter, join } from 'path';
import { desktopLaunchEnv } from './runtimeEnv.js';

// Preference order per §3: brave-origin-beta first (the binary the main
// workspace window uses), then plain Brave, then Chromium, then Chrome. The
// `*-stable` / `*-browser` aliases cover the various distro package names.
const BROWSER_CANDIDATES = [
  'brave-origin-beta',
  'brave',
  'brave-browser',
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
];

// macOS `open -na <app>` application names, tried when no CLI binary is on PATH
// (the common Mac case — browsers install as .app bundles, not PATH binaries).
const MACOS_APP_NAMES = ['Brave Browser Beta', 'Brave Browser', 'Chromium', 'Google Chrome'];

export type ExplorerLaunchResult =
  | { ok: true; binary: string; url: string }
  | { ok: false; code: 'no-browser'; error: string }
  | { ok: false; code: 'spawn-failed'; error: string };

// Find the first candidate that resolves to an executable on PATH. POSIX-
// portable (no `which`/`command -v` shell-out — this runs on Linux AND macOS):
// scans each PATH entry for an X_OK file. Returns the absolute path so the
// spawn can't be re-resolved against a different PATH inside the child.
async function findOnPath(candidates: string[]): Promise<string | null> {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const name of candidates) {
    for (const dir of dirs) {
      const abs = join(dir, name);
      try {
        await access(abs, constants.X_OK);
        return abs;
      } catch { /* not here — keep scanning */ }
    }
  }
  return null;
}

// Spawn detached and wait a short window for an immediate failure. A browser
// that opens successfully stays running (it's the window), so it will NOT exit
// inside the window — only a genuine spawn failure (ENOENT via 'error', or a
// non-zero exit like "no display") lands before the deadline. Resolves true on
// apparent success, false on early failure.
function spawnDetachedProbe(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    let proc;
    try {
      proc = spawn(bin, args, { detached: true, stdio: 'ignore', env });
    } catch {
      done(false);
      return;
    }
    proc.on('error', () => done(false));
    proc.on('exit', (code) => done(code === 0));
    // §3 DISPLAY caveat: a real window keeps the process alive past this
    // window. Unref so the child never keeps the server event loop open, then
    // treat "still running after the grace window" as success.
    const timer = setTimeout(() => {
      try { proc.unref(); } catch { /* already gone */ }
      done(true);
    }, 500);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

// Launch the explorer window at `<origin>/?app=explorer`. `origin` is derived
// by the route from the request Host/Origin so dev (5173) and prod (3001)
// both resolve without config. Fail-soft: every non-launch path returns a
// structured result so the client engages its popup fallback (never a throw).
export async function launchExplorerWindow(origin: string): Promise<ExplorerLaunchResult> {
  const url = `${origin.replace(/\/$/, '')}/?app=explorer`;
  // Prefer the service/desktop env so a systemd user unit inherits DISPLAY /
  // WAYLAND_DISPLAY / DBUS; fall back to DISPLAY=:0 when the unit carries
  // neither (§3 — the prod unit may not export a display).
  const env = desktopLaunchEnv();
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) env.DISPLAY = ':0';

  const bin = await findOnPath(BROWSER_CANDIDATES);
  if (bin) {
    const ok = await spawnDetachedProbe(bin, [`--app=${url}`], env);
    if (ok) return { ok: true, binary: bin, url };
    return { ok: false, code: 'spawn-failed', error: `${bin} exited before opening a window` };
  }

  // No CLI binary on PATH. On macOS try `open -na <app> --args --app=<url>`.
  if (process.platform === 'darwin') {
    for (const app of MACOS_APP_NAMES) {
      const ok = await spawnDetachedProbe('open', ['-na', app, '--args', `--app=${url}`], env);
      if (ok) return { ok: true, binary: `open:${app}`, url };
    }
    return { ok: false, code: 'no-browser', error: 'no Chromium-family browser found (tried Brave/Chromium/Chrome via `open`)' };
  }

  return { ok: false, code: 'no-browser', error: 'no Chromium-family browser on PATH (tried brave-origin-beta/brave/chromium/google-chrome)' };
}

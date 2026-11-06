// Temporary-home guard: the one place that decides whether this server may use
// outside services named only by inherited environment variables.
//
// Rule: when the Arco home (resolved with realpath) is the system temporary
// folder or inside it (os.tmpdir(), also resolved with realpath, so a symlinked
// TMPDIR and macOS /var -> /private/var count), the server is a test or
// throwaway instance:
// - It does not join the hub named by ARCO_HUB_URL: no link, no registration,
//   no heartbeat, no vault requests. Every hub user (the hub link in
//   initHubLink.ts and the cloud vault in clusterSnapshotRoutes.ts) reads the
//   hub URL through hubUrlForServer(), never from process.env directly.
// - It sends no phone notices to ARCO_NTFY_URL (with ARCO_NTFY_TOKEN and the
//   console link from ARCO_CONSOLE_URL or ARCO_HUB_URL). ntfyTransport.ts and
//   attention.ts ask environmentNtfyAllowed() before using them. A phone
//   address saved in that home's own Settings is not inherited and still works.
// ARCO_ALLOW_TEMP_HOME=1 lifts both rules; the older name
// ARCO_HUB_ALLOW_TEMP_HOME=1 is still accepted. Homes outside the temporary
// folder behave as before.
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { arcoHome } from '../arcoHome.js';

export const TEMP_HOME_OVERRIDE = 'ARCO_ALLOW_TEMP_HOME';
// The first name, from before the rule covered phone notices; still accepted.
export const HUB_TEMP_HOME_OVERRIDE = 'ARCO_HUB_ALLOW_TEMP_HOME';

export function tempHomeOverridden(env: NodeJS.ProcessEnv): boolean {
  return env[TEMP_HOME_OVERRIDE]?.trim() === '1' || env[HUB_TEMP_HOME_OVERRIDE]?.trim() === '1';
}

// The Arco home the guard checks: ARCO_HOME from `env` when it sets one (tests
// pass their own), otherwise this process's Arco home.
function guardedHome(env: NodeJS.ProcessEnv): string {
  return env.ARCO_HOME?.trim() || arcoHome();
}

export interface HubDecision {
  // The hub URL this server may use; undefined when none is set or the guard holds it back.
  hubUrl?: string;
  // True when ARCO_HUB_URL is set but the guard holds the link back.
  heldBack: boolean;
}

export interface HubDecisionInput {
  hubUrl?: string;
  home: string;
  tempDir: string;
  override?: string;
  // Injected for tests; defaults to fs.realpathSync.native.
  realpath?: (p: string) => string;
  pathApi?: typeof path;
}

// Resolve symlinks for a path that may not exist yet: the deepest existing
// ancestor is resolved and the missing tail is appended unchanged.
export function realpathLoose(target: string, realpath: (p: string) => string = realpathSync.native, pathApi: typeof path = path): string {
  const absolute = pathApi.resolve(target);
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return pathApi.join(realpath(current), ...tail.reverse());
    } catch {
      const parent = pathApi.dirname(current);
      if (parent === current) return absolute;
      tail.push(pathApi.basename(current));
      current = parent;
    }
  }
}

// True when `child` is `parent` or lies below it. A sibling that only shares a
// prefix (/tmpfoo next to /tmp) is not inside. path.win32.relative compares
// case-insensitively, so letter case does not matter there.
export function isSameOrInside(child: string, parent: string, pathApi: typeof path = path): boolean {
  const relative = pathApi.relative(parent, child);
  if (relative === '') return true;
  if (pathApi.isAbsolute(relative)) return false; // another drive on Windows
  return relative !== '..' && !relative.startsWith(`..${pathApi.sep}`);
}

// True when the home, with symlinks resolved, is the temporary folder or inside it.
export function homeIsInsideTemp(input: Pick<HubDecisionInput, 'home' | 'tempDir' | 'realpath' | 'pathApi'>): boolean {
  const pathApi = input.pathApi ?? path;
  const realpath = input.realpath ?? realpathSync.native;
  const home = realpathLoose(input.home, realpath, pathApi);
  const temp = realpathLoose(input.tempDir, realpath, pathApi);
  return isSameOrInside(home, temp, pathApi);
}

export function decideHubLink(input: HubDecisionInput): HubDecision {
  const hubUrl = input.hubUrl?.trim();
  if (!hubUrl) return { heldBack: false };
  if (input.override?.trim() === '1') return { hubUrl, heldBack: false };
  if (homeIsInsideTemp(input)) return { heldBack: true };
  return { hubUrl, heldBack: false };
}

let reported = false;
let ntfyReported = false;

// The hub URL this server may contact, or undefined. Logs once per process when
// the guard holds a configured hub back.
export function hubUrlForServer(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const decision = decideHubLink({
    hubUrl: env.ARCO_HUB_URL,
    home: guardedHome(env),
    tempDir: tmpdir(),
    override: tempHomeOverridden(env) ? '1' : undefined,
  });
  if (decision.heldBack && !reported) {
    reported = true;
    console.log(`[hub-link] ARCO_HUB_URL is set, but the Arco home is inside the temporary folder, so this server does not join the hub. Set ${TEMP_HOME_OVERRIDE}=1 to join anyway.`);
  }
  return decision.hubUrl;
}

// May this server send phone notices to an ntfy address it inherited from the
// environment (ARCO_NTFY_URL)? True when none is set (nothing to hold back),
// for homes outside the temporary folder, and with the override. Logs once per
// process when it holds a set ARCO_NTFY_URL back. Callers still prefer a phone
// address saved in Settings, which this does not affect.
export function environmentNtfyAllowed(env: NodeJS.ProcessEnv = process.env, tempDir: string = tmpdir()): boolean {
  if (!(env.ARCO_NTFY_URL || '').trim()) return true;
  if (tempHomeOverridden(env)) return true;
  if (!homeIsInsideTemp({ home: guardedHome(env), tempDir })) return true;
  if (!ntfyReported) {
    ntfyReported = true;
    console.log(`[ntfy] ARCO_NTFY_URL is set, but the Arco home is inside the temporary folder, so this server sends no phone notices to it. A phone address saved in Settings still works. Set ${TEMP_HOME_OVERRIDE}=1 to send anyway.`);
  }
  return false;
}

export function _resetGuardNotesForTest(): void { reported = false; ntfyReported = false; }

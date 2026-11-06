// Hub guard: the one place that decides whether this server may contact the
// management hub named by ARCO_HUB_URL. Every hub user (the hub link in
// initHubLink.ts and the cloud vault in clusterSnapshotRoutes.ts) reads the hub
// URL through hubUrlForServer(), never from process.env directly.
//
// Rule: when the Arco home (arcoHome(), resolved with realpath) is the system
// temporary folder or inside it (os.tmpdir(), also resolved with realpath, so a
// symlinked TMPDIR and macOS /var -> /private/var count), the server is a test
// or throwaway instance and does not join the hub: no link, no registration, no
// heartbeat, no vault requests. ARCO_HUB_ALLOW_TEMP_HOME=1 lifts the rule. Homes
// outside the temporary folder behave as before.
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { arcoHome } from '../arcoHome.js';

export const HUB_TEMP_HOME_OVERRIDE = 'ARCO_HUB_ALLOW_TEMP_HOME';

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

export function decideHubLink(input: HubDecisionInput): HubDecision {
  const hubUrl = input.hubUrl?.trim();
  if (!hubUrl) return { heldBack: false };
  if (input.override?.trim() === '1') return { hubUrl, heldBack: false };
  const pathApi = input.pathApi ?? path;
  const realpath = input.realpath ?? realpathSync.native;
  const home = realpathLoose(input.home, realpath, pathApi);
  const temp = realpathLoose(input.tempDir, realpath, pathApi);
  if (isSameOrInside(home, temp, pathApi)) return { heldBack: true };
  return { hubUrl, heldBack: false };
}

let reported = false;

// The hub URL this server may contact, or undefined. Logs once per process when
// the guard holds a configured hub back.
export function hubUrlForServer(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const decision = decideHubLink({
    hubUrl: env.ARCO_HUB_URL,
    home: arcoHome(),
    tempDir: tmpdir(),
    override: env[HUB_TEMP_HOME_OVERRIDE],
  });
  if (decision.heldBack && !reported) {
    reported = true;
    console.log(`[hub-link] ARCO_HUB_URL is set, but the Arco home is inside the temporary folder, so this server does not join the hub. Set ${HUB_TEMP_HOME_OVERRIDE}=1 to join anyway.`);
  }
  return decision.hubUrl;
}

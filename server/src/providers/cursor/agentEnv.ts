// docs/PROVIDERS.md "Cursor sign-in": the environment every cursor-agent that
// needs the user's sign-in is started with.
//
// On Linux, cursor-agent keeps its sign-in in the desktop keyring (secret
// service) once it has run in a desktop session, leaving only
// { "storedIn": "os-secret-store" } in auth.json. It reads that keyring only
// when its process has a session bus AND DISPLAY or WAYLAND_DISPLAY; without a
// display it reads auth.json alone and reports "Not logged in". Arco usually
// runs as a service with a session bus but no display. When the sign-in is in
// the keyring, Arco passes the display of the user's own running desktop
// session, found as a socket owned by this user, so cursor-agent reads (and
// refreshes) the same keyring entry as the desktop.
//
// Only the name of a display is passed, never a token. A sign-in kept in
// auth.json gets no display, so Arco never causes cursor-agent to move file
// tokens into the keyring.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { cursorAuthPaths } from './authToken.js';

const X11_SOCKET_DIR = '/tmp/.X11-unix';

export interface CursorDisplayInputs {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  // `storedIn` of the CLI's own auth.json, if any.
  storedIn: unknown;
  uid: number | undefined;
  // Owner uid of a socket, or undefined when the path is missing or not a socket.
  socketOwner: (path: string) => number | undefined;
  listDir: (path: string) => string[];
}

// `no-display`: the sign-in is in the keyring but cursor-agent cannot reach
// it from this process (no session bus, or no desktop session of this user).
export type CursorDisplayDecision =
  | { kind: 'not-needed' }
  | { kind: 'display'; name: 'WAYLAND_DISPLAY' | 'DISPLAY'; value: string }
  | { kind: 'no-display' };

function busAvailable(inputs: CursorDisplayInputs): boolean {
  if (inputs.env.DBUS_SESSION_BUS_ADDRESS) return true;
  const runtime = inputs.env.XDG_RUNTIME_DIR;
  return !!runtime && inputs.socketOwner(join(runtime, 'bus')) !== undefined;
}

function ownSockets(inputs: CursorDisplayInputs, dir: string, pattern: RegExp): number[] {
  let names: string[];
  try { names = inputs.listDir(dir); } catch { return []; }
  return names
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((entry) => entry.match && inputs.socketOwner(join(dir, entry.name)) === inputs.uid)
    .map((entry) => Number(entry.match![1]))
    .sort((a, b) => a - b);
}

export function decideCursorDisplay(inputs: CursorDisplayInputs): CursorDisplayDecision {
  if (inputs.platform !== 'linux' || inputs.env.ARCO_CURSOR_AUTH) return { kind: 'not-needed' };
  if (inputs.env.DISPLAY || inputs.env.WAYLAND_DISPLAY) return { kind: 'not-needed' };
  if (inputs.storedIn !== 'os-secret-store') return { kind: 'not-needed' };
  if (inputs.uid === undefined || !busAvailable(inputs)) return { kind: 'no-display' };
  const runtime = inputs.env.XDG_RUNTIME_DIR;
  const wayland = runtime ? ownSockets(inputs, runtime, /^wayland-(\d+)$/) : [];
  if (wayland.length) return { kind: 'display', name: 'WAYLAND_DISPLAY', value: `wayland-${wayland[0]}` };
  const x11 = ownSockets(inputs, X11_SOCKET_DIR, /^X(\d+)$/);
  if (x11.length) return { kind: 'display', name: 'DISPLAY', value: `:${x11[0]}` };
  return { kind: 'no-display' };
}

function readStoredIn(env: NodeJS.ProcessEnv): unknown {
  try {
    return (JSON.parse(readFileSync(cursorAuthPaths(process.platform, env)[0], 'utf8')) as { storedIn?: unknown } | null)?.storedIn;
  } catch {
    return undefined;
  }
}

export function currentCursorDisplay(env: NodeJS.ProcessEnv = process.env): CursorDisplayDecision {
  if (process.platform !== 'linux') return { kind: 'not-needed' };
  return decideCursorDisplay({
    platform: process.platform,
    env,
    storedIn: readStoredIn(env),
    uid: process.getuid?.(),
    socketOwner: (path) => {
      try {
        const stat = statSync(path);
        return stat.isSocket() ? stat.uid : undefined;
      } catch {
        return undefined;
      }
    },
    listDir: (path) => readdirSync(path),
  });
}

// The one environment for a cursor-agent child that uses the sign-in: a copy
// of this process's environment plus, when needed, the desktop display name.
export function cursorAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const decision = currentCursorDisplay(env);
  return decision.kind === 'display' ? { ...env, [decision.name]: decision.value } : { ...env };
}

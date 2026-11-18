import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { arcoHome } from '../arcoHome.js';
import { atomicWriteFile } from '../atomicFile.js';

// When a phone upload last worked through each private address and port.
// Only the server-known origin of the link and the time are kept: no phone
// address, file name, size or token. Recorded after a file is stored, never
// for a failed upload or for opening a code.
const FILE_NAME = 'phone-upload-routes.json';
const MAX_ROUTES = 16;
const MAX_BYTES = 4096;

let routes: Map<string, number> | null = null;
let writing: Promise<void> = Promise.resolve();

function historyFile(): string {
  return join(arcoHome(), FILE_NAME);
}

function route(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && url.origin === origin ? origin : null;
  } catch {
    return null;
  }
}

function load(): Map<string, number> {
  if (routes) return routes;
  routes = new Map();
  try {
    const stat = lstatSync(historyFile());
    if (!stat.isFile() || stat.size > MAX_BYTES) return routes;
    const saved = JSON.parse(readFileSync(historyFile(), 'utf8')) as unknown;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return routes;
    const entries = Object.entries(saved).filter(([origin, at]) =>
      route(origin) === origin && Number.isSafeInteger(at) && (at as number) > 0) as [string, number][];
    for (const [origin, at] of entries.sort((a, b) => a[1] - b[1]).slice(-MAX_ROUTES)) routes.set(origin, at);
  } catch { /* no history yet, or unreadable: every route stays unverified */ }
  return routes;
}

export function routeSuccesses(origins: string[]): Record<string, number> {
  const seen = load();
  return Object.fromEntries(origins.flatMap(origin => seen.has(origin) ? [[origin, seen.get(origin)!]] : []));
}

// Updates the in-memory history at once, so the open code shows the result on
// its next poll, then saves it. A failed save is logged with its error code
// only and never fails the upload that triggered it.
export function recordRouteSuccess(origin: string, at = Date.now()): Promise<void> {
  const normalised = route(origin);
  if (!normalised) return writing;
  const seen = load();
  seen.delete(normalised);
  seen.set(normalised, at);
  while (seen.size > MAX_ROUTES) seen.delete(seen.keys().next().value!);
  const contents = JSON.stringify(Object.fromEntries(seen));
  writing = writing.then(() => atomicWriteFile(historyFile(), contents, { mode: 0o600 })).catch((e) => {
    console.warn(`[arco] phone upload route history could not be saved: ${(e as NodeJS.ErrnoException).code ?? 'unknown error'}`);
  });
  return writing;
}

export function _forgetRouteHistoryForTest(): void {
  routes = null;
}

export function _routeHistorySavedForTest(): Promise<void> {
  return writing;
}

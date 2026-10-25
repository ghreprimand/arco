// Live Cursor model catalog, enumerated by a short-lived `cursor-agent models`
// spawn. Mirrors the Codex/Claude catalog pattern (codex-appserver/catalog.ts):
//
//   - 1h in-memory cache, lazy refresh on first request after expiry
//   - On fetch failure, serve the last good cache rather than throw
//   - Cold-start with no successful fetch returns an empty snapshot; the UI
//     falls back to a compile-time seed (`auto` at minimum)
//
// Unlike Codex there's no JSON-RPC handshake — `cursor-agent models` prints a
// flat text list (`<id> - <Display Name>`, ~155 rows) preceded by an "Available
// models" header and followed by a "Tip:" line. We parse the `id - name` rows.
// Cursor bakes reasoning effort into the id (`-low`/`-high`/`-xhigh`/`-max`), so
// there's no per-model effort surface to distil — just id + displayName.
//
// The spawn reuses `cursor-agent`'s existing auth state in ~/.config/cursor/ —
// no separate auth flow. `models` works even when logged out (static list), so
// a cold catalog does not imply a login problem.

import { spawn } from 'node:child_process';
import type { CursorCatalogModel, CursorCatalogSnapshot } from '@arco/shared';

export type { CursorCatalogModel, CursorCatalogSnapshot } from '@arco/shared';

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const SPAWN_TIMEOUT_MS = 15_000;

let cache: CursorCatalogSnapshot | null = null;
let inFlight: Promise<CursorCatalogSnapshot> | null = null;

// Parse `cursor-agent models` stdout into catalog rows. Rows look like:
//   auto - Auto (current, default)
//   grok-4.5-xhigh - Cursor Grok 4.5
// The leading "Available models" header and any non-`id - name` lines
// (blank, "Tip: ...") are skipped. `isDefault` is the row cursor-agent tags
// "(current, default)" — normally `auto`.
export function parseCursorModels(stdout: string): CursorCatalogModel[] {
  const models: CursorCatalogModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const dash = line.indexOf(' - ');
    if (dash <= 0) continue; // header ("Available models"), "Tip:" — no " - " id split
    const id = line.slice(0, dash).trim();
    const displayName = line.slice(dash + 3).trim();
    // A valid model id is a single token (no spaces). Guards against prose
    // lines that happen to contain " - ".
    if (!id || /\s/.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, displayName, isDefault: /\(current, default\)/i.test(displayName) });
  }
  return models;
}

// Public accessor. Returns cached snapshot; refreshes if older than
// REFRESH_INTERVAL_MS or never fetched. Failures degrade to stale cache.
export async function getCursorCatalog(force = false): Promise<CursorCatalogSnapshot> {
  const now = Date.now();
  if (!force && cache && now - cache.fetchedAt < REFRESH_INTERVAL_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = fetchCursorCatalog().finally(() => { inFlight = null; });
  try {
    const fresh = await inFlight;
    cache = fresh;
    return fresh;
  } catch (err) {
    if (cache) {
      console.warn('[cursor:catalog] refresh failed; serving stale cache:', err instanceof Error ? err.message : err);
      return { ...cache, fresh: false };
    }
    console.warn('[cursor:catalog] no cache and fetch failed:', err instanceof Error ? err.message : err);
    return { fetchedAt: now, models: [], fresh: false };
  }
}

// Kick a refresh in the background. Idempotent — the inFlight guard prevents
// overlapping fetches. Used at server startup so the picker has data before
// the first user action.
export function scheduleCursorCatalogPrefetch(): void {
  void getCursorCatalog().catch(() => { /* logged inside */ });
}

async function fetchCursorCatalog(): Promise<CursorCatalogSnapshot> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const proc = spawn('cursor-agent', ['models'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* gone */ }
      reject(new Error(`cursor-agent models timed out after ${SPAWN_TIMEOUT_MS}ms`));
    }, SPAWN_TIMEOUT_MS);
    proc.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
    proc.stderr?.on('data', (c: Buffer) => { err += c.toString(); if (err.length > 16 * 1024) err = err.slice(-8 * 1024); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`cursor-agent models exited ${code}: ${err.slice(0, 200)}`));
    });
  });
  const models = parseCursorModels(stdout);
  if (models.length === 0) throw new Error('cursor-agent models returned no parseable rows');
  return { fetchedAt: Date.now(), models, fresh: true };
}

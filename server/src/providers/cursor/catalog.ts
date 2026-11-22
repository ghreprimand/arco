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
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { CursorCatalogModel, CursorCatalogSnapshot } from '@arco/shared';
import { arcoHome } from '../../arcoHome.js';
import { atomicWriteFile } from '../../atomicFile.js';
import { commandArgs } from '../../windowsCommand.js';
import { isCursorAuthErrorText, noteCursorAuthRejected } from './authState.js';
import { isAutoModel, parseAcpModelId, parseCatalogId, type AcpModel } from './modelMap.js';

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

// Models the Cursor program offers over ACP but leaves out of `cursor-agent
// models` (GLM 5.3 was one). Each Cursor session's session/new lists every
// model the sign-in may use; the worker passes that list here, it is saved in
// the Arco home so a restart keeps it, and every model with no variant in the
// text list joins the catalog as one entry: its ACP base name as the id (the
// mapping in modelMap.ts resolves it to the advertised id) and a readable
// name. No session is ever started just to read the list, so such a model
// appears once a Cursor session has run on this machine.
const ACP_MODELS_FILE = 'cursor-acp-models.json';
let acpModels: AcpModel[] | null = null;

function acpModelsPath(): string { return join(arcoHome(), ACP_MODELS_FILE); }

async function savedAcpModels(): Promise<AcpModel[]> {
  if (acpModels) return acpModels;
  try {
    const parsed = JSON.parse(await fs.readFile(acpModelsPath(), 'utf8')) as { models?: unknown };
    acpModels = Array.isArray(parsed.models)
      ? parsed.models.filter((m): m is AcpModel => typeof (m as AcpModel)?.modelId === 'string')
        .map((m) => ({ modelId: m.modelId, ...(typeof m.name === 'string' ? { name: m.name } : {}) }))
      : [];
  } catch {
    acpModels = [];
  }
  return acpModels;
}

/** Record the models a Cursor ACP session advertised. */
export async function noteAcpModels(list: readonly AcpModel[]): Promise<void> {
  const models = list.filter((m) => typeof m?.modelId === 'string' && m.modelId.trim())
    .map((m) => ({ modelId: m.modelId, ...(typeof m.name === 'string' ? { name: m.name } : {}) }));
  if (models.length === 0) return;
  const before = await savedAcpModels();
  if (JSON.stringify(before) === JSON.stringify(models)) return;
  acpModels = models;
  await atomicWriteFile(acpModelsPath(), `${JSON.stringify({ savedAt: new Date().toISOString(), models }, null, 2)}\n`)
    .catch((err) => console.warn('[cursor:catalog] could not save the ACP model list:', err instanceof Error ? err.message : err));
}

// `glm-5p3-flash` -> `GLM 5.3 Flash`: short letter words in capitals, `5p3`
// as 5.3, other words capitalised.
export function readableCursorModelName(name: string): string {
  const words = name.split(/[-_\s]+/).filter(Boolean).map((w) => {
    if (/^\d+p\d+$/i.test(w)) return w.replace(/p/i, '.');
    if (/^[a-z]{1,3}$/i.test(w)) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  // `claude-haiku-4-5` -> Claude Haiku 4.5: neighbouring numbers are one version.
  return words.reduce<string[]>((out, w) => {
    if (/^\d+$/.test(w) && out.length > 0 && /^\d+(\.\d+)*$/.test(out[out.length - 1])) out[out.length - 1] += `.${w}`;
    else out.push(w);
    return out;
  }, []).join(' ');
}

const sameTokens = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** The text catalog plus one entry for each ACP model it has no variant of. */
export function mergeAcpModels(textModels: readonly CursorCatalogModel[], acp: readonly AcpModel[]): CursorCatalogModel[] {
  const out = [...textModels];
  const bases = textModels.map((m) => parseCatalogId(m.id).base);
  for (const m of acp) {
    if (isAutoModel(m.modelId)) continue;
    const base = parseAcpModelId(m.modelId).base;
    const tokens = parseCatalogId(base).base;
    if (!base || tokens.length === 0 || bases.some((b) => sameTokens(b, tokens))) continue;
    if (out.some((x) => x.id === base)) continue;
    out.push({ id: base, displayName: readableCursorModelName(m.name?.trim() || base), isDefault: false });
    bases.push(tokens);
  }
  return out;
}

async function withAcpModels(snapshot: CursorCatalogSnapshot): Promise<CursorCatalogSnapshot> {
  const acp = await savedAcpModels();
  return acp.length === 0 ? snapshot : { ...snapshot, models: mergeAcpModels(snapshot.models, acp) };
}

// Public accessor. Returns cached snapshot; refreshes if older than
// REFRESH_INTERVAL_MS or never fetched. Failures degrade to stale cache.
export async function getCursorCatalog(force = false): Promise<CursorCatalogSnapshot> {
  return withAcpModels(await getTextCatalog(force));
}

async function getTextCatalog(force: boolean): Promise<CursorCatalogSnapshot> {
  const now = Date.now();
  if (!force && cache && now - cache.fetchedAt < REFRESH_INTERVAL_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const fresh = await fetchCursorCatalog();
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
  })().finally(() => { inFlight = null; });
  return inFlight;
}

// Kick a refresh in the background. Idempotent — the inFlight guard prevents
// overlapping fetches. Used at server startup so the picker has data before
// the first user action.
export function scheduleCursorCatalogPrefetch(): void {
  void getCursorCatalog().catch(() => { /* logged inside */ });
}

async function fetchCursorCatalog(): Promise<CursorCatalogSnapshot> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const proc = spawn(...commandArgs('cursor-agent', ['models']), {
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
      else {
        if (isCursorAuthErrorText(err)) void noteCursorAuthRejected('model catalog');
        reject(new Error(`cursor-agent models exited ${code}: ${err.slice(0, 200)}`));
      }
    });
  });
  const models = parseCursorModels(stdout);
  if (isCursorAuthErrorText(stdout)) void noteCursorAuthRejected('model catalog');
  if (models.length === 0) throw new Error('cursor-agent models returned no parseable rows');
  return { fetchedAt: Date.now(), models, fresh: true };
}

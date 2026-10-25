// ── Cookbook download + run + auto-register (Workbench Expansion G4) ──
//
// Closes the Cookbook loop: take a chosen catalog pick (HF GGUF or an Ollama
// tag) and, on an EXPLICIT operator request, fetch the weights, surface live
// progress, and — for a GGUF pick — auto-register a llama.cpp catalog entry so
// the model is selectable in CONFIG immediately. NEVER auto-pulls: every
// download is operator-initiated (a DOWNLOAD click, or a confirmed G3 rec).
//
// ── Four-question test (CLAUDE.md) ──
//   1. Operator-initiated — the WS handler only runs on an explicit
//      cookbook_download_request. No timer, no hook, no "is this done?" judge
//      pulls weights.
//   2. Deterministic & bounded — the pre-flight is a pure size-vs-free-disk
//      refusal; the download is a single bounded fetch with a hard cancel.
//   3. Visible — start / progress / done / refused / cancelled all broadcast
//      with `workflowId`, so they persist to events.jsonl (audit trail).
//   4. Reversible — the operator deletes the .gguf and removes the catalog
//      entry. A failed/cancelled download leaves NO partial file and NO entry.
//
// ── Hard fences (the director reads this file line by line) ──
//   • NO shell-string interpolation, NO subprocess. Ollama = HTTP /api/pull
//     (honours the operator's configurable/remote base URL over Tailscale via
//     getOllamaBase). HF = a streamed `fetch`. There is no `ollama pull` exec
//     and no execFile anywhere in this file.
//   • PATH CONFINEMENT — HF weights land ONLY in ~/.archon/models/. The target
//     filename is sanitized to a basename (reject leading '-', NUL, separators,
//     '..', '.', empty) and the FINAL resolved path is prefix-checked to sit
//     inside the models dir before any byte is written. A malicious repo /
//     filename can neither escape the dir nor smuggle a flag.
//   • DISK PRE-FLIGHT — before a single byte downloads, compute size + free
//     disk (fs.statfs) and REFUSE if size + margin > free. Never fill the disk.
//   • CANCEL/ERROR CLEANUP — an aborted or failed download deletes the partial
//     file; no corrupt .gguf is left behind, and NO catalog entry is written
//     for an incomplete pull.
//   • ATOMIC REGISTER — only after a fully successful download do we add a
//     LlamacppModelDef (validated, unique alias, absolute ggufPath) via the
//     existing atomic writeCatalog. We never hand-roll the catalog write.
//
// ── Testability split (load-bearing for the smoke) ──
// The deterministic, side-effect-free cores are exported so the smoke asserts
// them WITHOUT touching the real catalog / models dir / network:
//   • preflight(sizeBytes, freeBytes, marginBytes)  — pure refusal decision.
//   • sanitizeModelFilename(name)                   — basename sanitizer.
//   • resolveWithinModelsDir(modelsDir, name)       — confinement check.
//   • uniqueAlias(base, existing)                   — alias de-dup.
//   • buildCatalogEntry(args)                       — LlamacppModelDef builder.
// The non-deterministic parts (resolveHfQuantFilename, pull*) take injected
// paths / fetch and are exercised against a local stub when one is stood up.

import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import type { LlamacppModelDef } from '@archon/shared';
import { readCatalog, writeCatalog, type LlamacppCatalog } from '../llamacppCatalog.js';
import { getOllamaBase } from '../providers/ollama.js';
import { archonHome } from '../archonHome.js';

// ── Models dir ────────────────────────────────────────────────────────────
// The ONE fixed directory HF GGUF weights download into. Mirrors the catalog's
// ~/.archon home. Created on demand. Confinement is checked against the
// RESOLVED real path of this dir, so a symlink swap can't widen the target.
export function modelsDir(): string {
  return path.join(archonHome(), 'models');
}

// Safety margin layered on top of the model size in the disk pre-flight: a
// download must leave at least this much headroom so the OS / other writers
// aren't starved (and a slightly-underreported size doesn't fill the disk).
export const PREFLIGHT_MARGIN_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

// ── Pure cores (smoke imports these directly) ───────────────────────────────

export interface PreflightResult {
  fits: boolean;
  sizeBytes: number;
  freeBytes: number;
  marginBytes: number;
  // Bytes needed (size + margin) vs free — surfaced so the client renders the
  // "model size vs free disk" panel and a precise refusal message.
  neededBytes: number;
}

// PURE refusal decision. Refuses when size + margin exceeds free disk. A
// non-positive / unknown size is treated as "unknown" and does NOT auto-refuse
// (the streamed download still bails on a real ENOSPC), but a known size that
// won't fit is rejected up front. Deterministic: only arithmetic.
export function preflight(
  sizeBytes: number,
  freeBytes: number,
  marginBytes: number = PREFLIGHT_MARGIN_BYTES,
): PreflightResult {
  const size = Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.floor(sizeBytes) : 0;
  const free = Number.isFinite(freeBytes) && freeBytes > 0 ? Math.floor(freeBytes) : 0;
  const margin = Number.isFinite(marginBytes) && marginBytes > 0 ? Math.floor(marginBytes) : 0;
  const needed = size + margin;
  // Unknown size (0): can't refuse deterministically, but if even the margin
  // alone exceeds free we still refuse (no room for anything).
  const fits = size > 0 ? needed <= free : margin <= free;
  return { fits, sizeBytes: size, freeBytes: free, marginBytes: margin, neededBytes: needed };
}

// Reasons a filename is rejected (returned by sanitizeModelFilename for a clear
// error + the smoke's adversarial assertions).
export type FilenameRejection = 'empty' | 'separator' | 'traversal' | 'leading-dash' | 'nul' | 'not-gguf';

export interface SanitizeResult {
  ok: boolean;
  basename?: string;
  reason?: FilenameRejection;
}

// Sanitize an operator-/repo-supplied filename to a SAFE basename. Models the
// guard on gitSafe.ts's isSafePath spirit, hardened for a write target:
//   • reject empty;
//   • reject anything containing a path separator (/ or \) or NUL;
//   • reject '.' / '..' / any '..' substring (traversal);
//   • reject a leading '-' (flag smuggling — defense-in-depth even though we
//     never exec; a downstream argv use must not parse it as an option);
//   • require a .gguf extension (HF GGUF weights only).
// Returns the bare basename on success — never a path. The confinement check
// (resolveWithinModelsDir) is the second, load-bearing gate on top of this.
export function sanitizeModelFilename(name: string): SanitizeResult {
  if (typeof name !== 'string') return { ok: false, reason: 'empty' };
  const raw = name.trim();
  if (!raw) return { ok: false, reason: 'empty' };
  if (raw.includes('\0')) return { ok: false, reason: 'nul' };
  if (raw.includes('/') || raw.includes('\\')) return { ok: false, reason: 'separator' };
  if (raw === '.' || raw === '..' || raw.includes('..')) return { ok: false, reason: 'traversal' };
  if (raw.startsWith('-')) return { ok: false, reason: 'leading-dash' };
  if (!/\.gguf$/i.test(raw)) return { ok: false, reason: 'not-gguf' };
  return { ok: true, basename: raw };
}

export interface ConfineResult {
  ok: boolean;
  fullPath?: string;
  reason?: FilenameRejection | 'escape';
}

// THE confinement check. Sanitize the filename to a basename, join it onto the
// models dir, then RESOLVE both and verify the target still sits inside the
// (resolved) models dir via a path-prefix check. Anything that resolves outside
// — even a sanitizer miss — is rejected. Pure (path math only); the smoke calls
// it with an injected modelsDir fixture so it never touches the real tree.
export function resolveWithinModelsDir(dir: string, name: string): ConfineResult {
  const san = sanitizeModelFilename(name);
  if (!san.ok || !san.basename) return { ok: false, reason: san.reason };
  const baseResolved = path.resolve(dir);
  const full = path.resolve(baseResolved, san.basename);
  // Prefix-check with a trailing separator so /a/models-evil isn't accepted as
  // being under /a/models. Equality is fine too (the dir itself, though a
  // basename file is always strictly inside).
  const prefix = baseResolved.endsWith(path.sep) ? baseResolved : baseResolved + path.sep;
  if (full !== baseResolved && !full.startsWith(prefix)) {
    return { ok: false, reason: 'escape' };
  }
  return { ok: true, fullPath: full };
}

// Derive a llama.cpp catalog alias from a repo/name + quant, sanitized to a
// safe token: lowercased, non [a-z0-9._-] collapsed to '-', no leading dash.
export function deriveAlias(repoOrName: string, quant?: string): string {
  const last = (repoOrName.split('/').pop() || repoOrName).trim();
  const q = (quant || '').trim();
  let base = q ? `${last}-${q}` : last;
  base = base
    .toLowerCase()
    .replace(/\.gguf$/i, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return base || 'model';
}

// Make `base` unique against the aliases already in the catalog by appending
// -2, -3, … on collision. PURE — the smoke feeds an existing-catalog fixture.
export function uniqueAlias(base: string, existingAliases: readonly string[]): string {
  const taken = new Set(existingAliases);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological collision space — fall back to a timestamp suffix.
  return `${base}-${Date.now().toString(36)}`;
}

export interface BuildCatalogEntryArgs {
  // Display repo/name the alias is derived from (e.g. "unsloth/Qwen3-Coder").
  repoOrName: string;
  quant: string;
  // ABSOLUTE path to the downloaded GGUF (caller passes the confined fullPath).
  ggufPath: string;
  // Recommended context from G1/G3.
  ctxSize?: number;
  // Operator-declared capabilities (the rec / row carry these).
  capabilities?: LlamacppModelDef['capabilities'];
  // The existing catalog's aliases, for uniqueness.
  existingAliases: readonly string[];
  // Optional explicit alias the operator typed; sanitized + made unique.
  alias?: string;
}

// Build a validated LlamacppModelDef for a freshly-downloaded GGUF. PURE: no
// I/O — the caller persists it via the atomic writeCatalog. The alias is
// derived (or taken from the operator), sanitized, and made unique vs the
// existing catalog; ggufPath MUST be absolute (asserted).
export function buildCatalogEntry(args: BuildCatalogEntryArgs): LlamacppModelDef {
  if (!args.ggufPath || !path.isAbsolute(args.ggufPath)) {
    throw new Error(`buildCatalogEntry: ggufPath must be absolute, got ${JSON.stringify(args.ggufPath)}`);
  }
  const baseAlias = args.alias && args.alias.trim()
    ? deriveAlias(args.alias)
    : deriveAlias(args.repoOrName, args.quant);
  const alias = uniqueAlias(baseAlias, args.existingAliases);
  const def: LlamacppModelDef = {
    alias,
    ggufPath: args.ggufPath,
    // -ngl all: VRAM-resident is the typical pick on the 5090. The operator can
    // edit this in llamacpp.json if they want CPU offload.
    ngl: 999,
  };
  if (args.ctxSize && args.ctxSize > 0) def.ctxSize = Math.floor(args.ctxSize);
  if (args.capabilities) def.capabilities = args.capabilities;
  return def;
}

// ── HF quant-filename resolution (live; the only HF metadata read) ──────────
//
// Re-query the HF repo's sibling file list and pick the EXACT GGUF filename for
// the requested quant. We re-query (rather than trust a filename from the G2
// row) so the download URL is grounded in the live repo contents at pull time.
// Returns the basename + its reported size (for the pre-flight). Throws on a
// network error or when no matching GGUF exists.
export interface HfQuantPick {
  filename: string;
  sizeBytes: number;
}

interface HfRepoInfo {
  siblings?: Array<{ rfilename?: string; size?: number }>;
}

// fetch the repo's file tree. `fetchImpl` is injectable for the smoke (defaults
// to global fetch). Keyless public GET.
export async function resolveHfQuantFilename(
  repo: string,
  quant: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HfQuantPick> {
  const url = `https://huggingface.co/api/models/${encodeURIComponent(repo)}?full=true`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HF repo lookup failed: HTTP ${res.status}`);
  const info = (await res.json()) as HfRepoInfo;
  const siblings = Array.isArray(info.siblings) ? info.siblings : [];
  const want = quant.trim().toUpperCase();
  const ggufs = siblings.filter((s) => typeof s.rfilename === 'string' && /\.gguf$/i.test(s.rfilename));
  // Prefer an exact quant-tag match in the filename; fall back to the first
  // GGUF if the repo names files without the quant token (single-quant repos).
  const match = ggufs.find((s) => filenameQuant(s.rfilename!) === want) || ggufs[0];
  if (!match || !match.rfilename) throw new Error(`No GGUF found in ${repo} for quant ${quant}`);
  return {
    filename: match.rfilename.split('/').pop() || match.rfilename,
    sizeBytes: typeof match.size === 'number' && match.size > 0 ? match.size : 0,
  };
}

// Extract a quant tag from a GGUF filename (mirrors catalog.ts's logic). Used
// only to match the requested quant in resolveHfQuantFilename.
function filenameQuant(file: string): string | null {
  const base = file.replace(/\.gguf$/i, '');
  const q = /\b(Q\d+(?:_[A-Z0-9]+)*|IQ\d+(?:_[A-Z0-9]+)*|F16|BF16|F32)\b/i.exec(base);
  return q ? q[1].toUpperCase() : null;
}

// ── Streamed download lifecycle (non-deterministic; cancel-aware) ───────────

export interface DownloadProgress {
  phase: 'preflight' | 'downloading' | 'registering' | 'done' | 'error' | 'cancelled';
  receivedBytes?: number;
  totalBytes?: number;
  freeBytes?: number;
  message?: string;
}

export interface PullHfArgs {
  repo: string;
  quant: string;
  // The recommended context to register. Optional capabilities + explicit alias.
  ctxSize?: number;
  capabilities?: LlamacppModelDef['capabilities'];
  alias?: string;
  // Injection seams for the smoke / tests — default to the real impls.
  dir?: string;
  fetchImpl?: typeof fetch;
  marginBytes?: number;
}

export interface PullResult {
  registered?: LlamacppModelDef;
  cancelled?: boolean;
  error?: string;
  // The refusal surfaces the size/free numbers so the client can explain it.
  refused?: { sizeBytes: number; freeBytes: number; neededBytes: number };
}

// Free bytes on the filesystem hosting `dir`, via fs.statfs (Linux + macOS).
// Returns 0 on any failure so the pre-flight degrades to "unknown free" rather
// than crashing — the streamed write still surfaces a real ENOSPC.
export async function freeBytesOn(dir: string): Promise<number> {
  try {
    const st = await fs.statfs(dir);
    // bavail = blocks available to an unprivileged process; bsize = block size.
    return Number(st.bsize) * Number(st.bavail);
  } catch {
    return 0;
  }
}

// Download an HF GGUF with live progress + cancel, then auto-register it.
//
// ORDERING (load-bearing): resolve the exact filename + size → CONFINE the
// target path → PRE-FLIGHT (refuse before any byte) → stream to a `.part` temp
// → rename into place → register. A cancel (via `signal`) or any error aborts
// the fetch AND deletes the partial; the catalog is touched ONLY on full
// success.
export async function pullHfGguf(
  args: PullHfArgs,
  signal: AbortSignal,
  onProgress: (p: DownloadProgress) => void,
): Promise<PullResult> {
  const dir = args.dir ?? modelsDir();
  const fetchImpl = args.fetchImpl ?? fetch;
  const margin = args.marginBytes ?? PREFLIGHT_MARGIN_BYTES;

  // 1. Resolve the exact GGUF filename + size from the live repo tree.
  let pick: HfQuantPick;
  try {
    pick = await resolveHfQuantFilename(args.repo, args.quant, fetchImpl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress({ phase: 'error', message: msg });
    return { error: msg };
  }
  if (signal.aborted) { onProgress({ phase: 'cancelled' }); return { cancelled: true }; }

  // 2. Confine the target path INSIDE the models dir (sanitize + resolve-check).
  const confined = resolveWithinModelsDir(dir, pick.filename);
  if (!confined.ok || !confined.fullPath) {
    const msg = `Refusing unsafe download filename (${confined.reason}): ${pick.filename}`;
    onProgress({ phase: 'error', message: msg });
    return { error: msg };
  }
  const fullPath = confined.fullPath;

  // 3. PRE-FLIGHT — refuse BEFORE downloading if it won't fit.
  await fs.mkdir(dir, { recursive: true });
  const free = await freeBytesOn(dir);
  const pf = preflight(pick.sizeBytes, free, margin);
  onProgress({ phase: 'preflight', totalBytes: pick.sizeBytes, freeBytes: free });
  if (!pf.fits) {
    const msg = `Not enough free disk: need ~${fmtGb(pf.neededBytes)} (model ${fmtGb(pf.sizeBytes)} + ${fmtGb(pf.marginBytes)} margin), ${fmtGb(pf.freeBytes)} free.`;
    onProgress({ phase: 'error', message: msg, totalBytes: pick.sizeBytes, freeBytes: free });
    return { refused: { sizeBytes: pf.sizeBytes, freeBytes: pf.freeBytes, neededBytes: pf.neededBytes }, error: msg };
  }

  // 4. Stream the download into a sibling `.part` temp (never a half-written
  //    .gguf the catalog could point at). The AbortController cancels the fetch;
  //    finally{} cleans up the partial on cancel/error.
  const url = `https://huggingface.co/${args.repo}/resolve/main/${encodeURIComponent(pick.filename)}`;
  const tmp = `${fullPath}.part`;
  let received = 0;
  let succeeded = false;
  try {
    const res = await fetchImpl(url, { signal, headers: { Accept: 'application/octet-stream' } });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const total = pick.sizeBytes || Number(res.headers.get('content-length')) || 0;
    const handle = await fs.open(tmp, 'w');
    try {
      // res.body is a web ReadableStream; iterate its chunks.
      const body = res.body as ReadableStream<Uint8Array> | null;
      if (!body) throw new Error('download response had no body');
      const reader = body.getReader();
      for (;;) {
        if (signal.aborted) throw new DownloadAbort();
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          await handle.write(value);
          received += value.length;
          onProgress({ phase: 'downloading', receivedBytes: received, totalBytes: total });
        }
      }
    } finally {
      await handle.close();
    }
    // 5. Atomically move the completed temp into place.
    await fs.rename(tmp, fullPath);
    succeeded = true;
  } catch (err) {
    // Cancel or error: delete the partial. No corrupt .gguf, no catalog entry.
    await safeUnlink(tmp);
    if (signal.aborted || err instanceof DownloadAbort) {
      onProgress({ phase: 'cancelled', receivedBytes: received });
      return { cancelled: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    onProgress({ phase: 'error', message: msg, receivedBytes: received });
    return { error: msg };
  }

  if (!succeeded) {
    await safeUnlink(tmp);
    return { error: 'download did not complete' };
  }

  // 6. Register — ONLY now, after a fully successful download. Atomic catalog
  //    write via the existing writeCatalog (never hand-rolled); alias unique.
  try {
    onProgress({ phase: 'registering' });
    const catalog: LlamacppCatalog = await readCatalog();
    const entry = buildCatalogEntry({
      repoOrName: args.repo,
      quant: args.quant,
      ggufPath: fullPath,
      ctxSize: args.ctxSize,
      capabilities: args.capabilities,
      alias: args.alias,
      existingAliases: catalog.models.map((m) => m.alias),
    });
    await writeCatalog({ models: [...catalog.models, entry] });
    onProgress({ phase: 'done', receivedBytes: received, totalBytes: pick.sizeBytes, message: `Registered as "${entry.alias}".` });
    return { registered: entry };
  } catch (err) {
    // The weights are on disk but the catalog write failed (e.g. the 64 KB cap).
    // Leave the .gguf (the operator can hand-add the entry) and surface the
    // error — do NOT delete a fully-downloaded model over a registry hiccup.
    const msg = err instanceof Error ? err.message : String(err);
    onProgress({ phase: 'error', message: `Downloaded but registration failed: ${msg}` });
    return { error: msg };
  }
}

// Ollama pull via the HTTP /api/pull endpoint — honours the operator's
// configurable/remote base URL (getOllamaBase). Streams NDJSON progress lines
// ({ status, total, completed }) into DownloadProgress. NO subprocess, NO
// `ollama pull` exec. On success, Ollama auto-discovers the tag via /api/tags —
// NO catalog write needed (the confirmExists check below proves it landed).
export interface PullOllamaArgs {
  name: string;
  baseUrl?: string; // injection seam; defaults to getOllamaBase()
  fetchImpl?: typeof fetch;
}

export async function pullOllama(
  args: PullOllamaArgs,
  signal: AbortSignal,
  onProgress: (p: DownloadProgress) => void,
): Promise<PullResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const base = args.baseUrl ?? (await getOllamaBase());
  const url = `${base.replace(/\/+$/, '')}/api/pull`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ name: args.name, stream: true }),
    });
    if (!res.ok) throw new Error(`ollama pull failed: HTTP ${res.status}`);
    const body = res.body as ReadableStream<Uint8Array> | null;
    if (!body) throw new Error('ollama pull response had no body');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      if (signal.aborted) throw new DownloadAbort();
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // NDJSON: emit progress per complete line.
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
          if (obj.error) throw new Error(obj.error);
          onProgress({
            phase: 'downloading',
            message: obj.status,
            receivedBytes: typeof obj.completed === 'number' ? obj.completed : undefined,
            totalBytes: typeof obj.total === 'number' ? obj.total : undefined,
          });
        } catch (parseErr) {
          if (parseErr instanceof Error && parseErr.message && !/JSON/.test(parseErr.message)) throw parseErr;
          // A non-JSON keepalive line — ignore.
        }
      }
    }
    onProgress({ phase: 'done', message: `Pulled ${args.name} (Ollama auto-discovers it via /api/tags).` });
    return {};
  } catch (err) {
    if (signal.aborted || err instanceof DownloadAbort) {
      onProgress({ phase: 'cancelled' });
      return { cancelled: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    onProgress({ phase: 'error', message: msg });
    return { error: msg };
  }
}

// Confirm an Ollama tag is now present (post-pull verification). Best-effort —
// a failure to reach /api/tags just returns false; the caller surfaces it.
export async function ollamaTagPresent(
  name: string,
  baseUrl?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const base = (baseUrl ?? (await getOllamaBase())).replace(/\/+$/, '');
    const res = await fetchImpl(`${base}/api/tags`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const want = name.includes(':') ? name : `${name}:latest`;
    return (data.models ?? []).some((m) => m.name === name || m.name === want);
  } catch {
    return false;
  }
}

// Sentinel so the abort path is distinguishable from a real fetch error.
class DownloadAbort extends Error {
  constructor() {
    super('cancelled');
    this.name = 'DownloadAbort';
  }
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[archon] cookbook: failed to delete partial ${p}:`, err instanceof Error ? err.message : err);
    }
  }
}

function fmtGb(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

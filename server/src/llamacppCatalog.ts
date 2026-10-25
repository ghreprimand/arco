// Operator-declared llama.cpp model registry, stored at ~/.archon/llamacpp.json.
// Unlike Ollama (which auto-discovers via /api/tags), llama-server takes one
// model per process — the operator names each loadout up front and the
// lifecycle manager spawns llama-server with the right -m / --mmproj / -ngl
// flags on demand.
//
// Atomic-write pattern matches catalog.ts / settings.ts: write to .tmp.<pid>
// then rename, so a crash mid-save never leaves a half-written file the
// daemon would refuse to start with.

import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import type { LlamacppModelDef } from '@archon/shared';
import { atomicWriteFile } from './atomicFile.js';

const CATALOG_PATH = path.join(homedir(), '.archon', 'llamacpp.json');

// 64 KB is plenty for a few dozen model entries; the actual GGUF / mmproj
// blobs live on disk separately. Cap exists so a runaway hand-edit can't
// inflate the auth-status payload.
const MAX_CATALOG_BYTES = 64 * 1024;

export interface LlamacppCatalog {
  // First entry's alias is treated as the default model when nothing else
  // is specified. Operators reorder by editing the JSON.
  models: LlamacppModelDef[];
}

function emptyCatalog(): LlamacppCatalog {
  return { models: [] };
}

// Bootstrap: write a stub on first read so the operator has a starting
// point. The stub includes a worked example for a Qwen3.6 + mmproj loadout
// — same pattern as catalog.ts seeding models.md.
const BOOTSTRAP: string = JSON.stringify({
  $schema_note: 'See docs/PROVIDERS.md § llama.cpp for field reference.',
  $example: {
    alias: 'qwen3.6-vl',
    ggufPath: '/path/to/Qwen3.6-27B-UD-Q4_K_XL.gguf',
    mmprojPath: '/path/to/mmproj-BF16.gguf',
    ctxSize: 32768,
    ngl: 999,
    capabilities: { tools: true, vision: true, thinking: true },
  },
  models: [],
}, null, 2) + '\n';

export async function ensureCatalog(): Promise<void> {
  await fs.mkdir(path.dirname(CATALOG_PATH), { recursive: true });
  try {
    await fs.stat(CATALOG_PATH);
    return; // already present; leave operator edits alone
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await fs.writeFile(CATALOG_PATH, BOOTSTRAP, 'utf8');
}

function isLlamacppModelDef(raw: unknown): raw is LlamacppModelDef {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return typeof r.alias === 'string' && r.alias.length > 0
    && typeof r.ggufPath === 'string' && r.ggufPath.length > 0;
}

// Read + validate. Bad JSON or a missing file returns an empty catalog
// rather than throwing — the auth probe surfaces "no models" cleanly that
// way and the operator can fix the file without having to restart Archon.
export async function readCatalog(): Promise<LlamacppCatalog> {
  try {
    const raw = await fs.readFile(CATALOG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyCatalog();
    const models = (parsed as { models?: unknown }).models;
    if (!Array.isArray(models)) return emptyCatalog();
    // Drop entries that don't shape-check; preserve the order operators picked.
    // Aliases are de-duplicated by keeping the first occurrence.
    const seen = new Set<string>();
    const valid: LlamacppModelDef[] = [];
    for (const m of models) {
      if (!isLlamacppModelDef(m)) continue;
      if (seen.has(m.alias)) continue;
      seen.add(m.alias);
      valid.push(m);
    }
    return { models: valid };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyCatalog();
    console.error('[archon] llamacpp.json malformed; treating as empty:', err instanceof Error ? err.message : err);
    return emptyCatalog();
  }
}

export async function writeCatalog(catalog: LlamacppCatalog): Promise<void> {
  const body = JSON.stringify(catalog, null, 2) + '\n';
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_CATALOG_BYTES) {
    throw new Error(`llamacpp.json too large (${bytes} bytes > ${MAX_CATALOG_BYTES} cap)`);
  }
  await atomicWriteFile(CATALOG_PATH, body);
}

export function findModel(catalog: LlamacppCatalog, alias: string): LlamacppModelDef | undefined {
  return catalog.models.find((m) => m.alias === alias);
}

export function defaultModel(catalog: LlamacppCatalog): LlamacppModelDef | undefined {
  return catalog.models[0];
}

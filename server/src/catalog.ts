// Model catalog + calibration log, both stored under ~/.arco/.
// See docs/ARCHITECTURE.md
//
// - models.md is operator-edited; we bootstrap it from the shipped template
//   on first run, then never overwrite. Operator edits survive upgrades.
// - calibration.md is orchestrator-appended (never overwritten) so operator
//   reads in `models.md` stay pure.

import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { atomicWriteFile } from './atomicFile.js';
import { arcoHome } from './arcoHome.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arcoUserDir(): string {
  return arcoHome();
}

function modelsPath(): string {
  return path.join(arcoUserDir(), 'models.md');
}

function calibrationPath(): string {
  return path.join(arcoUserDir(), 'calibration.md');
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

// Bootstrap: copy the shipped default models.md into ~/.arco/models.md the
// first time an operator uses Arco. Never overwrites. Safe to call at every
// startup.
export async function ensureCatalog(): Promise<void> {
  await ensureDir(arcoUserDir());
  const target = modelsPath();
  try {
    await fs.stat(target);
    return; // already present; leave operator edits alone
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const source = path.join(__dirname, 'defaults', 'models.md');
  try {
    const template = await fs.readFile(source, 'utf8');
    await fs.writeFile(target, template, 'utf8');
  } catch (err) {
    // If the template is missing (build glitch), don't crash — just log.
    console.error('[arco] catalog bootstrap failed:', err instanceof Error ? err.message : err);
  }
  // Seed an empty calibration log alongside.
  const cal = calibrationPath();
  try {
    await fs.stat(cal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const header = '# Arco Calibration Log\n\nOrchestrator appends here when a model underperforms on a task class. Operator can prune entries to reset the learning signal.\n\n';
      await fs.writeFile(cal, header, 'utf8');
    }
  }
}

export async function readCatalog(): Promise<string | null> {
  try {
    return await fs.readFile(modelsPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// Slot 12 — operator catalog editor. Atomic write (tmp + rename, mirrors
// memory.ts / buildLog.ts / workflowMeta.ts) so a crash mid-save never
// leaves a half-written models.md. 128 KB soft cap — catalogs are markdown
// not code, so a reasonable ceiling prevents runaway operator edits from
// blowing up first-turn injection cost.
const MAX_CATALOG_BYTES = 128 * 1024;

export async function writeCatalog(contents: string): Promise<void> {
  if (typeof contents !== 'string') throw new Error('catalog contents must be a string');
  const bytes = Buffer.byteLength(contents, 'utf8');
  if (bytes > MAX_CATALOG_BYTES) {
    throw new Error(`catalog too large (${bytes} bytes > ${MAX_CATALOG_BYTES} cap)`);
  }
  await ensureDir(arcoUserDir());
  await atomicWriteFile(modelsPath(), contents);
}

export async function readCalibration(): Promise<string | null> {
  try {
    return await fs.readFile(calibrationPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function appendCalibration(line: string): Promise<void> {
  await ensureDir(arcoUserDir());
  const cal = calibrationPath();
  const ts = new Date().toISOString();
  const entry = `- [${ts}] ${line.trim()}\n`;
  await fs.appendFile(cal, entry, 'utf8');
}

// Build the catalog injection blob: the full models.md + the last ~25 lines
// of calibration so the orchestrator sees recent learning signal without
// dragging in the entire history.
export async function buildCatalogInjection(): Promise<string> {
  const [catalog, calibration] = await Promise.all([readCatalog(), readCalibration()]);
  if (!catalog) return '';
  const parts: string[] = ['## MODEL CATALOG (routing brain)', catalog.trim()];
  if (calibration) {
    const lines = calibration.trim().split('\n');
    // Skip the header block; keep tail of actual entries.
    const entries = lines.filter((l) => l.startsWith('- ['));
    if (entries.length > 0) {
      parts.push('');
      parts.push('### Recent calibration (last 25)');
      parts.push(entries.slice(-25).join('\n'));
    }
  }
  return parts.join('\n');
}

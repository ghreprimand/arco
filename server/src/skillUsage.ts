// §5.2 — skill-usage telemetry sidecar. A read-only `use_count` / `last_used`
// record surfaced in the Skills UI, written from the one reliable cross-transport
// use signal: a `Read` tool_use whose `file_path` is a skill's SKILL.md. There is
// no `skill_view` tool to hook — the model learns a skill from the manifest and
// applies it by Reading its `path` — so the Read of that path IS the use event.
//
// Discipline (matches the rest of the borrowed-improvements work):
//   • Operator-visible  — counts render in the Skills list; the sidecar is a flat
//                         JSON the operator can read or delete by hand.
//   • Deterministic     — increment on a matched Read, nothing model-judged.
//   • Non-authoritative — purely diagnostic; NOTHING is auto-archived on a low
//                         count. (Archiving is an operator decision, out of scope.)
//   • Fail-safe         — a malformed/absent sidecar reads as empty; a write error
//                         is swallowed (telemetry must never break a turn).
//
// `created_at` is deliberately NOT a usage signal: a freshly authored skill has
// not been *used*, so last_used stays absent until the first real Read.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFile, withFileLock } from './atomicFile.js';
import { arcoHome } from './arcoHome.js';

const USAGE_FILE = path.join(arcoHome(), 'skill-usage.json');

export interface SkillUsageEntry {
  count: number;
  // epoch ms of the most recent matched Read.
  lastUsed: number;
}

// On-disk shape: a flat map keyed by canonical absolute SKILL.md path → entry.
// Versioned so a future migration is unambiguous.
export interface SkillUsageFile {
  version: 1;
  entries: Record<string, SkillUsageEntry>;
}

// ── Pure core (unit-tested without fs) ──

// Canonicalize a SKILL.md path for keying: resolve to absolute. `scanScope` keys
// each skill by its absolute SKILL.md path and the manifest hands the model that
// same path, so the Read input matches after resolve. Symlinks are intentionally
// not resolved (the operator reads keys as the paths they typed).
export function canonicalSkillKey(p: string): string {
  return path.resolve(p);
}

// True if `p` is a `.arco/skills/<slug>/SKILL.md` path. Segment-aware so a file
// literally named `SKILL.md` outside a skills root (or a `.arco/skillsfoo`
// sibling) does not count. Both project (`<cwd>/.arco/skills/...`) and global
// (`~/.arco/skills/...`) skills match — the same Read signal covers both.
export function isSkillMdPath(p: string): boolean {
  if (!p) return false;
  const resolved = path.resolve(p);
  if (path.basename(resolved) !== 'SKILL.md') return false;
  const segs = resolved.split(path.sep);
  // need .../.arco/skills/<slug>/SKILL.md → ['.arco','skills',slug,'SKILL.md']
  // at the tail, with `.arco` and `skills` adjacent.
  for (let i = 0; i + 3 < segs.length; i++) {
    if (segs[i] === '.arco' && segs[i + 1] === 'skills' && segs[i + 3] === 'SKILL.md') {
      return true;
    }
  }
  return false;
}

// Extract the Read target path from a tool_use input. The input arrives as a JSON
// string ({file_path: ...} for Read on every transport). Returns null on anything
// unparseable / missing — the caller then records nothing.
export function extractReadPath(inputJson: string | undefined): string | null {
  if (!inputJson) return null;
  try {
    const parsed = JSON.parse(inputJson) as { file_path?: unknown };
    return typeof parsed.file_path === 'string' && parsed.file_path ? parsed.file_path : null;
  } catch {
    return null;
  }
}

// ── fs wrappers (fail-safe) ──

// Lenient parse. ENOENT or malformed → empty. `file` override exists for tests.
export async function readSkillUsage(file: string = USAGE_FILE): Promise<Record<string, SkillUsageEntry>> {
  try {
    const text = await fs.readFile(file, 'utf8');
    const obj = JSON.parse(text) as { entries?: unknown };
    const entries: Record<string, SkillUsageEntry> = {};
    if (obj.entries && typeof obj.entries === 'object') {
      for (const [k, v] of Object.entries(obj.entries as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') continue;
        const e = v as { count?: unknown; lastUsed?: unknown };
        const count = typeof e.count === 'number' && e.count >= 0 ? Math.floor(e.count) : 0;
        const lastUsed = typeof e.lastUsed === 'number' && e.lastUsed >= 0 ? e.lastUsed : 0;
        if (count > 0) entries[k] = { count, lastUsed };
      }
    }
    return entries;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[arco] skill-usage.json malformed; treating as empty:', err instanceof Error ? err.message : err);
    }
    return {};
  }
}

// Record a single matched Read. No-op (and never throws) for a non-skill path or
// any fs error. `now` is epoch ms; `file` override exists for tests.
//
// Serialized on the target file so concurrent Reads (multiple tabs) don't
// read-modify-write over each other. This used to be a module-local chain;
// it now shares atomicFile.ts § withFileLock, which keys per file rather than
// serializing every target behind one queue.
export function recordSkillRead(filePath: string, now: number, file: string = USAGE_FILE): Promise<void> {
  if (!isSkillMdPath(filePath)) return Promise.resolve();
  const key = canonicalSkillKey(filePath);
  return withFileLock(file, async () => {
    try {
      const entries = await readSkillUsage(file);
      const prev = entries[key];
      entries[key] = { count: (prev?.count ?? 0) + 1, lastUsed: now };
      const payload: SkillUsageFile = { version: 1, entries };
      await atomicWriteFile(file, JSON.stringify(payload, null, 2) + '\n', { durability: 'advisory' });
    } catch (err) {
      console.error('[arco] skill-usage write failed (telemetry only, ignoring):', err instanceof Error ? err.message : err);
    }
  });
}

// Walk-up CLAUDE.md discovery — provider-agnostic. Phase 7a folds
// discovered files into appendSystemPrompt at primary-turn build time so
// CLI and Native Claude tabs both pick up project-level CLAUDE.md without
// duplicating the walk in each provider.
//
// Walks from `cwd` up to the filesystem root, collecting CLAUDE.md files
// along the way. Concatenated in walk-up order (root last) so the most
// specific (closest-to-cwd) instructions override.

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const FILE_BYTE_CAP = 64 * 1024;

export async function discoverClaudeMdFiles(
  cwd: string,
  opts?: { includeProject?: boolean },
): Promise<string> {
  if (!cwd) return '';
  const collected: string[] = [];
  const home = resolve(homedir());
  // DD7 — when the repo is untrusted the project walk is suppressed entirely;
  // we still read the USER-level ~/.claude/CLAUDE.md below (the operator's own
  // global instructions are never a cloned-repo injection risk). The walk would
  // otherwise pick up <cwd>/CLAUDE.md and any ancestor's, which is exactly the
  // prompt-injection surface the gate closes.
  const includeProject = opts?.includeProject !== false;
  let dir = resolve(cwd);
  // Cap walk depth defensively so a pathological mount doesn't loop.
  for (let i = 0; includeProject && i < 64; i++) {
    const path = join(dir, 'CLAUDE.md');
    try {
      const stat = await fs.stat(path);
      if (stat.isFile()) {
        const buf = await fs.readFile(path, 'utf8');
        const trimmed = buf.length > FILE_BYTE_CAP ? buf.slice(0, FILE_BYTE_CAP) : buf;
        collected.push(`# ${path}\n\n${trimmed.trim()}`);
      }
    } catch {
      /* missing file is the common case */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // ~/.claude/CLAUDE.md (user-level) — read if not already covered.
  const userPath = join(home, '.claude', 'CLAUDE.md');
  if (!collected.some((c) => c.startsWith(`# ${userPath}\n`))) {
    try {
      const buf = await fs.readFile(userPath, 'utf8');
      const trimmed = buf.length > FILE_BYTE_CAP ? buf.slice(0, FILE_BYTE_CAP) : buf;
      collected.push(`# ${userPath}\n\n${trimmed.trim()}`);
    } catch {
      /* missing */
    }
  }
  if (collected.length === 0) return '';
  // Reverse so most-general (root / user) lands first; closest-to-cwd
  // overrides at the end. Each block prefixed with its path so the model
  // can attribute guidance.
  return collected.reverse().join('\n\n---\n\n');
}

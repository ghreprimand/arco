import { managedPath } from './managedPath.js';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './atomicFile.js';

export const LEGACY_PROJECT_IGNORE = "# Arco per-workflow state \u2014 ephemeral, don't commit\nworkflows/\nsession-index.json\ntitle-events.jsonl\n";
export const DEFAULT_PROJECT_IGNORE = '# Arco project state is ignored by default.\n# Add an exception such as !settings.json to share a specific file.\n*\n';

// SHARE WITH REPOSITORY (skillManagement.ts) appends one block per skill to
// .arco/.gitignore: this comment, then the exception lines that make
// .arco/skills/<slug>/ trackable. The project-state check (publicProject.ts)
// reads the same exception lines to tell a shared skill from stray state.
export const SHARED_SKILL_COMMENT = '# Shared with the repository: ';

/** The exception lines a share of `slug` adds, minus those `existing` already has. */
export function skillShareLines(slug: string, existing: string): string[] {
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  return ['!skills/', 'skills/*', `!skills/${slug}/`, `!skills/${slug}/**`].filter((l) => !have.has(l));
}

/** `existing` with the share block for `slug` appended, exactly as SHARE WITH REPOSITORY writes it. */
export function appendShareBlock(existing: string, slug: string): string {
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  const add = skillShareLines(slug, existing);
  return `${existing}${prefix}${SHARED_SKILL_COMMENT}${slug}\n${add.join('\n')}${add.length ? '\n' : ''}`;
}

/**
 * Skills the ignore file shares, in file order: a slug counts when its own
 * exception line (`!skills/<slug>/` or `!skills/<slug>/**`) is present, not
 * from the comment or file names alone.
 */
export function sharedSkillSlugs(ignoreText: string): string[] {
  const out: string[] = [];
  for (const raw of ignoreText.split(/\r?\n/)) {
    const m = /^!skills\/([^/\s*?[\]\\!#]+)\/(?:\*\*)?$/.exec(raw.trim());
    if (m && !out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** `base` with a share block for each slug, in order. */
export function ignoreWithShares(base: string, slugs: string[]): string {
  return slugs.reduce((text, slug) => appendShareBlock(text, slug), base);
}

/** Create protection before writing project state. Preserve every edited ignore file. */
export function ensureProjectStateIgnore(cwd: string): void {
  if (!cwd) throw new Error('Project directory required');
  const dir = managedPath(cwd, '.arco');
  const file = join(dir, '.gitignore');
  mkdirSync(dir, { recursive: true });
  try { writeFileSync(file, DEFAULT_PROJECT_IGNORE, { encoding: 'utf8', flag: 'wx' }); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!lstatSync(file).isFile()) throw new Error('Project state ignore file is not a regular file');
  if (readFileSync(file, 'utf8') === LEGACY_PROJECT_IGNORE) atomicWriteFileSync(file, DEFAULT_PROJECT_IGNORE);
}

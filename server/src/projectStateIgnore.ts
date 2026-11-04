import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './atomicFile.js';

export const LEGACY_PROJECT_IGNORE = "# Arco per-workflow state \u2014 ephemeral, don't commit\nworkflows/\nsession-index.json\ntitle-events.jsonl\n";
export const DEFAULT_PROJECT_IGNORE = '# Arco project state is ignored by default.\n# Add an exception such as !settings.json to share a specific file.\n*\n';

/** Create protection before writing project state. Preserve every edited ignore file. */
export function ensureProjectStateIgnore(cwd: string): void {
  if (!cwd) throw new Error('Project directory required');
  const dir = join(cwd, '.arco');
  const file = join(dir, '.gitignore');
  mkdirSync(dir, { recursive: true });
  try { writeFileSync(file, DEFAULT_PROJECT_IGNORE, { encoding: 'utf8', flag: 'wx' }); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!lstatSync(file).isFile()) throw new Error('Project state ignore file is not a regular file');
  if (readFileSync(file, 'utf8') === LEGACY_PROJECT_IGNORE) atomicWriteFileSync(file, DEFAULT_PROJECT_IGNORE);
}

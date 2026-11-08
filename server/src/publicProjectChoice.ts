// Explicit project privacy choices live in Arco's home, not in project files.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { suggestFromRemote } from './publicProject.js';
import { arcoHome } from './arcoHome.js';
import { atomicWriteFile, withFileLock } from './atomicFile.js';

const file = join(arcoHome(), 'public-project-choices.json');
async function key(cwd: string): Promise<string> {
  const canonical = await fs.realpath(resolve(cwd));
  return createHash('sha256').update(canonical).digest('hex');
}
async function read(): Promise<Record<string, boolean>> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid public-project choices');
  return Object.fromEntries(Object.entries(value).filter(([k, v]) => /^[a-f0-9]{64}$/.test(k) && typeof v === 'boolean')) as Record<string, boolean>;
}
export async function getPublicProjectChoice(cwd: string): Promise<boolean | null> {
  return (await read())[await key(cwd)] ?? null;
}
export async function setPublicProjectChoice(cwd: string, value: boolean): Promise<void> {
  const id = await key(cwd);
  await withFileLock(file, async () => {
    const choices = await read();
    choices[id] = value;
    await atomicWriteFile(file, JSON.stringify(choices, null, 2) + '\n', { mode: 0o600 });
  });
}

/** Classification for plan safety checks; suggestions never become explicit choices. */
export async function getEffectivePublicProjectChoice(cwd: string): Promise<boolean> {
  const saved = await getPublicProjectChoice(cwd);
  if (saved !== null) return saved;
  return (await suggestFromRemote(cwd)).state === 'public';
}

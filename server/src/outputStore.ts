// Private per-workflow output metadata. Never expose the surrounding runtime
// directory as a browser root. The caller must establish the workflow binding.
import { lstat, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { WorkflowOutput } from '@arco/shared';
import { safeDirectory, isPathWithin } from './fileAccessPolicy.js';
import { atomicWriteFile } from './atomicFile.js';

export interface StoredOutput extends Omit<WorkflowOutput, 'missing' | 'size'> { aliases?: string[]; actions?: Array<{ action: 'copy' | 'move'; from: string; to: string; at: number }>; }
export interface OutputIndex { version: 1; offset: number; entries: StoredOutput[]; }
export async function outputDirectory(cwd: string, workflowId: string): Promise<string> {
  if (!/^[a-z0-9_-]{1,64}$/i.test(workflowId)) throw new Error('Invalid output workflow.');
  const root = safeDirectory(cwd);
  const expected = path.join(root, '.arco', 'workflows', workflowId);
  const actual = realpathSync(expected);
  if (actual !== expected || !isPathWithin(root, actual)) throw new Error('Output workflow directory is unavailable.');
  return actual;
}
export async function readOutputIndex(cwd: string, workflowId: string): Promise<OutputIndex> {
  const dir = await outputDirectory(cwd, workflowId);
  const file = path.join(dir, 'outputs.json');
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 8 * 1024 * 1024) throw new Error();
    const index = JSON.parse(await readFile(file, 'utf8')) as OutputIndex;
    if (index.version !== 1 || !Number.isSafeInteger(index.offset) || index.offset < 0 || !Array.isArray(index.entries) || index.entries.length > 2000
      || index.entries.some(e => !e || !/^[a-f0-9]{32}$/.test(e.id) || e.workflowId !== workflowId || typeof e.title !== 'string'
        || typeof e.name !== 'string' || typeof e.cwd !== 'string' || typeof e.producer !== 'string' || typeof e.source !== 'string'
        || !['images', 'documents', 'audio', 'video', 'other'].includes(e.category) || !Number.isFinite(e.createdAt) || !Number.isFinite(e.updatedAt)
        || (!e.path && !e.inline) || (e.path !== undefined && (typeof e.path !== 'string' || !path.isAbsolute(e.path)))
        || (e.inputPath !== undefined && (typeof e.inputPath !== 'string' || !path.isAbsolute(e.inputPath)))
        || (e.inline !== undefined && (!e.inline || typeof e.inline.content !== 'string' || (e.inline.language !== undefined && typeof e.inline.language !== 'string')))
        || (e.aliases !== undefined && (!Array.isArray(e.aliases) || e.aliases.length > 128 || e.aliases.some(p => typeof p !== 'string' || !path.isAbsolute(p))))
        || (e.actions !== undefined && (!Array.isArray(e.actions) || e.actions.length > 128 || e.actions.some(a => !a || !['copy', 'move'].includes(a.action) || typeof a.from !== 'string' || typeof a.to !== 'string' || !Number.isFinite(a.at)))))) throw new Error();
    return index;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, offset: 0, entries: [] };
    throw new Error('The output index could not be read. Original files were left intact.');
  }
}
export async function writeOutputIndex(cwd: string, workflowId: string, index: OutputIndex): Promise<void> {
  const dir = await outputDirectory(cwd, workflowId);
  const file = path.join(dir, 'outputs.json');
  try { if ((await lstat(file)).isSymbolicLink()) throw new Error('Output index cannot be a link.'); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  const serialized = JSON.stringify(index) + '\n';
  if (index.entries.length > 2000 || Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new Error('Output metadata exceeds its size limit.');
  await atomicWriteFile(file, serialized);
}
export async function mappedOutputPath(cwd: string, workflowId: string, requested: string): Promise<string | null> {
  const target = path.resolve(cwd, requested);
  const index = await readOutputIndex(cwd, workflowId);
  const entry = index.entries.find(e => e.path && (e.path === target || e.originPath === target || e.aliases?.includes(target)));
  return entry?.path ?? null;
}

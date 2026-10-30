import { lstatSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// Only used after the original cleanup fails. Names outside this fixture vocabulary
// are redacted so diagnostics cannot expose arbitrary file or user data.
const names = new Set(['home', 'project', 'missing-project', '.arco', '.codex', '.claude', '.config', '.local', 'share', '.cache', 'clusters', 'workflows', 'snapshots', 'meta.json', 'events.jsonl', 'settings.json']);
const label = (root: string, path: string) => path === root ? '.' : relative(root, path).split(/[\\/]/).map(part => names.has(part) ? part : '<item>').join('/');

export function reportCleanupFailure(root: string): void {
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  console.error('fixture cleanup diagnostics:', JSON.stringify({ cwdIsRoot: process.cwd() === root, resources: process.getActiveResourcesInfo(), handles: handles.map(h => (h as object)?.constructor?.name ?? 'unknown') }));
  let count = 0;
  function inspect(path: string, depth: number): void {
    if (count++ >= 150 || depth > 12) return;
    let stat;
    try { stat = lstatSync(path); } catch (error) { console.error('fixture stat:', JSON.stringify({ path: label(root, path), code: (error as NodeJS.ErrnoException).code })); return; }
    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    if (kind === 'directory') {
      try { for (const name of readdirSync(path).sort()) inspect(join(path, name), depth + 1); }
      catch (error) { console.error('fixture read:', JSON.stringify({ path: label(root, path), code: (error as NodeJS.ErrnoException).code })); }
    }
    try { if (kind === 'directory') rmdirSync(path); else rmSync(path); console.error('fixture remove:', JSON.stringify({ path: label(root, path), kind, result: 'ok' })); }
    catch (error) { console.error('fixture remove:', JSON.stringify({ path: label(root, path), kind, code: (error as NodeJS.ErrnoException).code, mode: stat.mode & 0o777 })); }
  }
  inspect(root, 0);
  if (count >= 150) console.error('fixture diagnostics truncated');
}

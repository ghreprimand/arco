import { accessSync, constants, statSync } from 'node:fs';
import { posix } from 'node:path';
import { findWindowsCommand } from '../windowsCommand.js';
import { resolveLlamaServer, type BinaryLookup } from '../providers/llamacppBinary.js';

// Diagnostics and runtime share Windows command suffixes and the llama override.
export function findDiagnosticExecutable(bin: string, lookup: BinaryLookup = {}): string | null {
  if (bin === 'llama-server') return resolveLlamaServer(lookup);
  const env = lookup.env ?? process.env, platform = lookup.platform ?? process.platform;
  const isFile = lookup.isFile ?? ((p: string) => {
    try { accessSync(p, platform === 'win32' ? constants.F_OK : constants.X_OK); return statSync(p).isFile(); }
    catch { return false; }
  });
  if (platform === 'win32') return findWindowsCommand(bin, env, isFile);
  for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = posix.join(dir, bin);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

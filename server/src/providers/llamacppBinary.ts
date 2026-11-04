// Locating the llama-server executable. ARCO_LLAMACPP_BIN overrides; otherwise
// the PATH is searched with the platform's executable name (llama-server.exe
// on Windows, honouring PATHEXT there).
import { statSync } from 'node:fs';
import path from 'node:path';

export interface BinaryLookup {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isFile?: (candidate: string) => boolean;
}

export const LLAMACPP_NOT_FOUND = 'llama-server not found on PATH (set ARCO_LLAMACPP_BIN)';

function fileExists(candidate: string): boolean {
  try { return statSync(candidate).isFile(); } catch { return false; }
}

// The resolved executable path, or null when none is found.
export function resolveLlamaServer(lookup: BinaryLookup = {}): string | null {
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const isFile = lookup.isFile ?? fileExists;
  const override = env.ARCO_LLAMACPP_BIN?.trim();
  if (override) return isFile(override) ? override : null;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = pathValue.split(win ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const names = win
    ? ['llama-server', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => `llama-server${e.toLowerCase()}`)]
    : ['llama-server'];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = p.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

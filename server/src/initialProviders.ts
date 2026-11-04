import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { ArcoSettings, AuthLoginTarget } from '@arco/shared';
import { getConnectionStatus } from './auth.js';

async function binaryOnPath(name: string): Promise<boolean> {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        const candidate = path.join(dir, name + extension);
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        if ((await stat(candidate)).isFile()) return true;
      } catch { /* try the next path */ }
    }
  }
  return false;
}

export async function detectInitialProviders(
  check: (provider: AuthLoginTarget) => Promise<{ loggedIn: boolean }> = getConnectionStatus,
  binary: (name: string) => Promise<boolean> = binaryOnPath,
): Promise<ArcoSettings['enabledProviders']> {
  const ids = ['claude', 'codex', 'cursor', 'ollama', 'lmstudio', 'llamacpp'] as const;
  const statuses = await Promise.all(ids.map(id => check(id).then(status => status.loggedIn).catch(() => false)));
  const binaries = await Promise.all(['ollama', 'lms', 'llama-server'].map(name => binary(name).catch(() => false)));
  return { claude: statuses[0], codex: statuses[1], cursor: statuses[2], ollama: statuses[3] || binaries[0], lmstudio: statuses[4] || binaries[1], llamacpp: statuses[5] || binaries[2], strata: false, deepseek: false };
}

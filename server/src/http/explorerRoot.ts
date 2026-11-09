import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { readSettings } from '../settings.js';
import { safeDirectory, type ReadAccessContext } from '../fileAccessPolicy.js';

// Startup and content reads must agree on the first available browsing root.
// This read-only fallback does not register a project or grant write access.
export async function explorerRoot(access?: ReadAccessContext, settingsSnapshot?: Awaited<ReturnType<typeof readSettings>> | null): Promise<string> {
  const settings = settingsSnapshot === undefined ? await readSettings().catch(() => null) : settingsSnapshot;
  for (const candidate of [settings?.defaultWorkingDirectory, join(homedir(), 'Projects'), homedir()]) {
    if (!candidate) continue;
    try {
      const root = access ? await access.rootDirectory(candidate) : safeDirectory(candidate);
      await readdir(root);
      return root;
    } catch { /* try the next available location */ }
  }
  throw new Error('No readable folder is available for the file tree.');
}

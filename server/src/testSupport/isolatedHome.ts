import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// Call before importing any module that resolves runtime or provider homes.
export function installIsolatedTestHome(root: string): void {
  if (!root || !isAbsolute(root)) throw new Error('An absolute temporary test root is required');
  const home = join(root, 'home');
  const arcoHome = join(home, '.arco');
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ARCO_HOME = arcoHome;
  process.env.CODEX_HOME = join(home, '.codex');
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.XDG_DATA_HOME = join(home, '.local', 'share');
  process.env.XDG_CACHE_HOME = join(home, '.cache');
  process.env.ARCO_UPDATE_CHECK = '0';
  if (!root || !process.env.HOME || !process.env.ARCO_HOME || process.env.HOME !== home || process.env.ARCO_HOME !== arcoHome) {
    throw new Error('A temporary HOME and ARCO_HOME are required for this test');
  }
}

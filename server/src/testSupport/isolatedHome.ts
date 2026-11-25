import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export function isolatedTestHomeEnvironment(root: string) {
  if (!root || !isAbsolute(root)) throw new Error('An absolute temporary test root is required');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return {
    HOME: home,
    USERPROFILE: home,
    ARCO_HOME: join(root, 'state'),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    ARCO_UPDATE_CHECK: '0',
  };
}

// Call before importing any module that resolves runtime or provider homes.
export function installIsolatedTestHome(root: string): void {
  const env = isolatedTestHomeEnvironment(root);
  Object.assign(process.env, env);
  if (process.env.HOME !== env.HOME || process.env.ARCO_HOME !== env.ARCO_HOME) {
    throw new Error('A temporary HOME and ARCO_HOME are required for this test');
  }
}

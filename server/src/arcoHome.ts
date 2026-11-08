// The Arco home: global state, settings and provider logins. Defaults to
// `~/.arco` (on Windows `%USERPROFILE%\.arco`); ARCO_HOME relocates it
// (envAliases.ts fills ARCO_HOME from the upstream-prefixed name when only
// that one is set).
import { homedir, userInfo } from 'node:os';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const initialDefaultHome = join(homedir(), '.arco');

// Resolve existing ancestors too: a not-yet-created state directory can still
// be reached through a symlinked parent (including a symlinked TMPDIR).
function canonical(path: string): string {
  try { return realpathSync(path); } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(canonical(parent), basename(path));
  }
}

function runningTests(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT)
    || process.argv.some(arg => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg))
    || ((process as NodeJS.Process & { moduleLoadList?: string[] }).moduleLoadList ?? [])
      .some(name => name.startsWith('NativeModule internal/test_runner/'));
}

export function arcoHome(): string {
  const configured = process.env.ARCO_HOME?.trim();
  const home = configured ? resolve(configured) : join(homedir(), '.arco');
  assertTestHomeSafe(home);
  return home;
}

// Recheck cached paths at write time, after late node:test imports.
export function assertTestHomeSafe(home: string): void {
  if (runningTests()) {
    const target = canonical(home);
    // HOME may be changed by a fixture. Also protect the account's original
    // home so that an explicit ARCO_HOME cannot point back into live state.
    const defaults = [initialDefaultHome, join(homedir(), '.arco'), join(userInfo().homedir, '.arco')];
    for (const path of defaults) {
      const rest = relative(canonical(path), target);
      if (!rest || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))) {
        throw new Error('Refusing to use the default Arco home during a test. Set ARCO_HOME to a separate temporary directory before importing runtime modules.');
      }
    }
  }
}

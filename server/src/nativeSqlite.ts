// Packaged builds carry one Node-API binding per operating system and architecture.
// Source checkouts keep better-sqlite3's normal resolver.
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { arcoHome } from './arcoHome.js';
import { fileURLToPath } from 'node:url';

export const nativeRepairCommand = 'arco setup --repair-native';
export function nativeSqliteRemediation(env = process.env): string {
  return env.ARCO_PACKAGED === '1' ? nativeRepairCommand : 'npm ci --include=dev, then check platform compatibility';
}
export function nativeSqliteOptions(env = process.env, platform = process.platform, arch = process.arch, _abi = process.versions.modules): { nativeBinding?: string } {
  if (env.ARCO_PACKAGED !== '1') return {};
  const key = `${platform}-${arch}`;
  const home = env.ARCO_HOME?.trim() ? resolve(env.ARCO_HOME) : arcoHome();
  const repairDir = join(home, 'native', key), repaired = join(repairDir, 'better_sqlite3.node');
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  try {
    const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).arcoNativeDependencies;
    const actual = JSON.parse(readFileSync(join(repairDir, 'manifest.json'), 'utf8'));
    if (typeof expected?.['better-sqlite3'] === 'string' && typeof expected?.['node-pty'] === 'string' && expected['better-sqlite3'] === actual?.['better-sqlite3'] && expected['node-pty'] === actual?.['node-pty'] && existsSync(repaired)) return { nativeBinding: repaired };
  } catch { /* no matching repaired binding */ }
  return { nativeBinding: join(root, 'native', key, 'better_sqlite3.node') };
}

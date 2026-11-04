import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readStrataProfiles } from './strataProfiles.js';
import { readDeepSeekProfiles } from './deepseekProfiles.js';

const exec = promisify(execFile);
export { strataEngineReleaseVersion } from '@arco/shared';
// Read metadata only. Version discovery must work with all engines stopped
// and must never load weights or run an engine's --version entry point.
export async function installedStrataVersion(base: string): Promise<string | undefined> {
  try {
    const registry = await readStrataProfiles(base);
    if (!registry?.profiles.length) return undefined;
    const cfg = JSON.parse(await readFile(registry.profiles[0].config, 'utf8'));
    const build = JSON.parse(await readFile(join(dirname(cfg.exe), 'BUILD.json'), 'utf8'));
    return typeof build.version === 'string' ? build.version.replace(/^v/, '') : undefined;
  } catch { return undefined; }
}
export async function probeStrataVersion(base: string): Promise<string | undefined> {
  // Managed installs carry the full package version (including its fourth
  // component). A running engine can report only its three-part build version.
  const installed = await installedStrataVersion(base);
  if (installed) return installed;
  try {
    const response = await fetch(`${base}/status`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return undefined;
    const data = await response.json() as { engine?: unknown };
    return typeof data.engine === 'string' ? data.engine.replace(/^v/, '') : undefined;
  } catch { return undefined; }
}
export async function installedXolotlRevision(base: string): Promise<string | undefined> {
  try {
    const registry = await readDeepSeekProfiles(base);
    if (!registry) return undefined;
    const { stdout } = await exec('git', ['-C', registry.runtime, 'rev-parse', 'HEAD'], { timeout: 3000 });
    const revision = stdout.trim();
    return /^[a-f0-9]{40}$/.test(revision) ? revision : undefined;
  } catch { return undefined; }
}

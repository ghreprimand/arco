import { spawnSync } from 'node:child_process';
import { commandArgs } from '../windowsCommand.js';

let cached: { version: string; expires: number } | undefined;
export function installedCodexVersion(): string {
  if (cached && cached.expires > Date.now()) return cached.version;
  const result = spawnSync(...commandArgs('codex', ['--version']), {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true,
  });
  const version = result.status === 0 ? result.stdout?.match(/\b(\d+\.\d+\.\d+(?:[-.][\w.-]+)?)\b/)?.[1] ?? 'unknown' : 'unknown';
  cached = { version, expires: Date.now() + 60_000 };
  return version;
}

import { spawnSync } from 'node:child_process';
import { commandArgs } from '../windowsCommand.js';

export const RESEARCH_CODEX_VERSION = '0.171.0';

export function codexResearchVersionReason(version: string): string | undefined {
  if (version === RESEARCH_CODEX_VERSION) return undefined;
  return version === 'unknown'
    ? `Codex researchers need Codex ${RESEARCH_CODEX_VERSION}; the installed version could not be determined.`
    : `Codex researchers need Codex ${RESEARCH_CODEX_VERSION}; ${version} is installed.`;
}

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

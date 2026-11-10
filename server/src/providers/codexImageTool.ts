import { spawnSync } from 'node:child_process';
import { commandArgs } from '../windowsCommand.js';

/** Older CLIs configure this tool directly; newer CLIs advertise a feature. */
export function codexImageToolKey(features: string): 'features.view_image' | 'tools.view_image' {
  return /^view_image\s/m.test(features) ? 'features.view_image' : 'tools.view_image';
}

let cached: { key: ReturnType<typeof codexImageToolKey>; expires: number } | undefined;
export function installedCodexImageToolKey(): ReturnType<typeof codexImageToolKey> {
  if (cached && cached.expires > Date.now()) return cached.key;
  const result = spawnSync(...commandArgs('codex', ['features', 'list']), {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  const key = codexImageToolKey(result.status === 0 ? result.stdout ?? '' : '');
  cached = { key, expires: Date.now() + 60_000 };
  return key;
}

export function codexImageToolConfig(): Record<string, { view_image: boolean }> {
  return { [installedCodexImageToolKey().split('.')[0]]: { view_image: true } };
}

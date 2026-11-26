import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCommand } from '../../windowsCommand.js';

const exec = promisify(execFile);
export interface AntigravityUsagePool { name: string; percentLeft: number; reset: string }

export function parseAntigravityUsage(text: string): AntigravityUsagePool[] | null {
  try {
    const value = JSON.parse(text);
    if (value.status !== 'SUCCESS' || value.command?.name !== 'usage' || !Array.isArray(value.command.data?.groups)) return null;
    const pools: AntigravityUsagePool[] = [];
    for (const group of value.command.data.groups) {
      if (typeof group.name !== 'string' || !Array.isArray(group.buckets)) return null;
      for (const bucket of group.buckets) {
        if (typeof bucket.name !== 'string' || typeof bucket.remaining_fraction !== 'number' || !Number.isFinite(bucket.remaining_fraction) || bucket.remaining_fraction < 0 || bucket.remaining_fraction > 1 || typeof bucket.reset_time !== 'string' || Number.isNaN(Date.parse(bucket.reset_time))) return null;
        pools.push({ name: `${group.name} · ${bucket.name}`, percentLeft: Math.round(bucket.remaining_fraction * 100), reset: bucket.reset_time });
      }
    }
    return pools.length ? pools : null;
  } catch { return null; }
}

export async function getAntigravityUsage(): Promise<AntigravityUsagePool[] | null> {
  try {
    const agy = resolveCommand('agy', ['-p', '/usage', '--output-format', 'json'], { fresh: true });
    const { stdout } = await exec(agy.command, agy.args, { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true, ...(agy.env ? { env: agy.env } : {}) });
    return parseAntigravityUsage(stdout);
  } catch { return null; }
}

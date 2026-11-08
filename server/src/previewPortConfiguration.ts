import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parsePreviewPorts } from './previewProxy.js';

let temporaryStart: Promise<number> | undefined;
export function hostTemporaryPortStart(): Promise<number> {
  return temporaryStart ??= (async () => {
    try {
      if (process.platform === 'linux') return Number((await readFile('/proc/sys/net/ipv4/ip_local_port_range', 'utf8')).trim().split(/\s+/)[0]) || 32768;
      if (process.platform === 'darwin') return Number((await promisify(execFile)('sysctl', ['-n', 'net.inet.ip.portrange.first'], { timeout: 3000 })).stdout.trim()) || 32768;
      if (process.platform === 'win32') {
        const starts = await Promise.all(['ipv4', 'ipv6'].map(async family => {
          const { stdout } = await promisify(execFile)('netsh', ['int', family, 'show', 'dynamicport', 'tcp'], { timeout: 3000 });
          return Number(stdout.match(/:\s*(\d+)/)?.[1]) || 32768;
        }));
        return Math.min(...starts);
      }
      // Windows uses 49152 by default. The conservative ceiling also avoids
      // the Unix defaults if dynamic-range inspection is unavailable.
    } catch { /* conservative supported-platform ceiling */ }
    return 32768;
  })();
}
export async function previewPortRange(setting?: string): Promise<string> {
  const value = process.env.ARCO_PREVIEW_PORTS ?? setting ?? '4300-4309';
  parsePreviewPorts(value, Math.min(await hostTemporaryPortStart(), 32768)); return value;
}

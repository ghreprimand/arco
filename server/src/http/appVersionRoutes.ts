import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APP_BUILD } from '../appVersion.js';
import { readinessSnapshot } from '../server/readiness.js';
import { arcoHome } from '../arcoHome.js';

const checkoutPath = realpathSync.native(fileURLToPath(new URL('../../../', import.meta.url)));
const checkoutFingerprint = createHash('sha256').update(process.platform === 'win32' ? checkoutPath.replace(/\\/g, '/').toLowerCase() : checkoutPath).digest('hex');
function homeFingerprint(): string {
  const home = arcoHome();
  let canonical: string;
  try { canonical = realpathSync.native(home); } catch { canonical = home; }
  return createHash('sha256').update(process.platform === 'win32' ? canonical.replace(/\\/g, '/').toLowerCase() : canonical).digest('hex');
}

export function tryHandleAppVersionRoutes(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET') return false;
  if (req.url === '/api/app/version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(APP_BUILD));
    return true;
  }
  if (req.url === '/healthz' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'live', ...APP_BUILD, checkoutFingerprint, homeFingerprint: homeFingerprint(), pid: process.pid, uptimeSec: readinessSnapshot().uptimeSec }));
    return true;
  }
  return false;
}

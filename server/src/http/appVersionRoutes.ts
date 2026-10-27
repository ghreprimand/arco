import type { IncomingMessage, ServerResponse } from 'node:http';
import { APP_BUILD } from '../appVersion.js';
import { readinessSnapshot } from '../server/readiness.js';

export function tryHandleAppVersionRoutes(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET') return false;
  if (req.url === '/api/app/version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(APP_BUILD));
    return true;
  }
  if (req.url === '/healthz' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'live', ...APP_BUILD, pid: process.pid, uptimeSec: readinessSnapshot().uptimeSec }));
    return true;
  }
  return false;
}

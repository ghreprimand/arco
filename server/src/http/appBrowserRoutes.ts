// GET /api/app-browsers: the browsers Settings > Advanced > App window browser
// can choose, the saved choice and what a window opens in now. Read-only.
import type { IncomingMessage, ServerResponse } from 'http';
import { appBrowserReport } from '../appBrowsers.js';

export async function tryHandleAppBrowserRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.url !== '/api/app-browsers' || req.method !== 'GET') return false;
  try {
    const report = await appBrowserReport();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(report));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
  return true;
}

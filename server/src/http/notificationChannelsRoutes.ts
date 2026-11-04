import type { IncomingMessage, ServerResponse } from 'node:http';
import { channelsView, getChannels, loadChannels, saveChannels, sendTest } from '../attention.js';

function sendJson(res: ServerResponse, code: number, body: unknown): true {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

async function readBody(req: IncomingMessage, limit = 8192): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > limit) throw new Error('request too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  return text ? JSON.parse(text) : {};
}

// GET  /api/notification-channels        current switches and phone address (the token is never returned)
// PUT  /api/notification-channels        replace them; ntfy.token absent keeps the saved token, '' clears it
// POST /api/notification-channels/test   send one test message to the phone address in the body (or the saved one)
export async function tryHandleNotificationChannelsRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/api/notification-channels' && path !== '/api/notification-channels/test') return false;
  try {
    if (path === '/api/notification-channels' && req.method === 'GET') {
      await loadChannels();
      return sendJson(res, 200, channelsView());
    }
    if (path === '/api/notification-channels' && req.method === 'PUT') {
      await saveChannels(await readBody(req));
      return sendJson(res, 200, channelsView());
    }
    if (path === '/api/notification-channels/test' && req.method === 'POST') {
      const body = await readBody(req);
      const draft = body && typeof body === 'object' && Object.keys(body as object).length ? { ...getChannels(), ...(body as object) } : getChannels();
      return sendJson(res, 200, await sendTest(draft));
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

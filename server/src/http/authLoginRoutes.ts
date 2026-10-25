// In-app login session routes (server/src/authLoginSession.ts).
//   GET  /api/auth-login/session?provider=  → the provider's current session or null
//   POST /api/auth-login/code   { provider, code }  → paste the browser's code (Claude)
//   POST /api/auth-login/cancel { provider }
// Registered ahead of the prefix-matched POST /api/auth-login handler.
import { IncomingMessage, ServerResponse } from 'http';
import type { AuthLoginTarget } from '@arco/shared';
import { cancelLoginSession, getLoginSession, submitLoginCode } from '../authLoginSession.js';
import { PORT } from '../server/constants.js';

const TARGETS = new Set<string>(['claude', 'codex', 'gemini', 'zai', 'cursor', 'github', 'ollama']);

function sendJson(res: ServerResponse, code: number, body: unknown): true {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

async function readBody(req: IncomingMessage): Promise<{ provider?: unknown; code?: unknown }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 4096) throw new Error('login request is too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  return text ? (JSON.parse(text) as { provider?: unknown; code?: unknown }) : {};
}

function target(raw: unknown): AuthLoginTarget | null {
  return typeof raw === 'string' && TARGETS.has(raw) ? (raw as AuthLoginTarget) : null;
}

export async function tryHandleAuthLoginRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  if (!path.startsWith('/api/auth-login/')) return false;
  try {
    if (path === '/api/auth-login/session' && req.method === 'GET') {
      const provider = target(url.searchParams.get('provider'));
      if (!provider) return sendJson(res, 400, { error: 'unknown provider' });
      return sendJson(res, 200, { session: getLoginSession(provider) });
    }
    if (path === '/api/auth-login/code' && req.method === 'POST') {
      const body = await readBody(req);
      const provider = target(body.provider);
      if (!provider) return sendJson(res, 400, { error: 'unknown provider' });
      const result = submitLoginCode(provider, typeof body.code === 'string' ? body.code : '');
      return result.ok ? sendJson(res, 200, { session: result.session }) : sendJson(res, 400, { error: result.error });
    }
    if (path === '/api/auth-login/cancel' && req.method === 'POST') {
      const body = await readBody(req);
      const provider = target(body.provider);
      if (!provider) return sendJson(res, 400, { error: 'unknown provider' });
      return sendJson(res, 200, { session: cancelLoginSession(provider) });
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

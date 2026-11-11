import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { workflows } from '../server/state.js';
import { availableHandoffSources, executeHandoffHistory } from '../handoffHistoryTool.js';

type Capability = { callerId: string; workflow: unknown; expires: number };
const capabilities = new Map<string, Capability>();
/** Called by trusted provider launch code, never from HTTP input. */
export async function mintHandoffHistoryCapability(callerId: string): Promise<string | undefined> {
 for (const [key, value] of capabilities) if (workflows.get(value.callerId) !== value.workflow) capabilities.delete(key);
 if (!(await availableHandoffSources(callerId)).length) return undefined;
 for (const [token, cap] of capabilities) if (cap.callerId === callerId && cap.workflow === workflows.get(callerId)) {
  cap.expires = Date.now() + 24 * 60 * 60_000; return token;
 }
 if (capabilities.size >= 1024) return undefined;
 const token = randomBytes(32).toString('hex');
 capabilities.set(token, { callerId, workflow: workflows.get(callerId), expires: Date.now() + 24 * 60 * 60_000 });
 return token;
}
export async function tryHandleHandoffHistoryRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
 if (!req.url?.match(/^\/api\/agent-handoff-history(?:\?|$)/)) return false;
 const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
 const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
 const cap = capabilities.get(token);
 if (!cap || cap.expires < Date.now() || workflows.get(cap.callerId) !== cap.workflow) {
  if (cap && workflows.get(cap.callerId) !== cap.workflow) capabilities.delete(token);
  reply(403, { error: 'History capability is unavailable.' }); return true;
 }
 if (req.method !== 'POST') { reply(405, { error: 'POST required.' }); return true; }
 try {
  let bytes = 0; const parts: Buffer[] = [];
  for await (const part of req) {
   const data = Buffer.isBuffer(part) ? part : Buffer.from(part);
   bytes += data.length;
   if (bytes > 16 * 1024) { reply(413, { error: 'History request is too large.' }); return true; }
   parts.push(data);
  }
  const result = await executeHandoffHistory(cap.callerId, JSON.parse(Buffer.concat(parts).toString('utf8')));
  reply(200, result);
 } catch { reply(400, { error: 'History request is invalid or the source is unavailable.' }); }
 return true;
}

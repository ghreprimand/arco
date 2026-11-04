import type { IncomingMessage, ServerResponse } from 'node:http';
import { evaluatorCapabilities } from '../smartPickupAdapters.js';

// GET /api/smart-pickup/evaluators: which providers can serve as the Smart
// AUTO-PICKUP evaluator here, with the reason when one cannot. Connection
// state is the client's separate concern.
export async function tryHandleSmartPickupRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.url !== '/api/smart-pickup/evaluators') return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  const evaluators = await evaluatorCapabilities();
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ evaluators }));
  return true;
}

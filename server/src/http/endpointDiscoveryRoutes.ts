import { IncomingMessage, ServerResponse } from 'http';
import { discoverEndpoints } from '../providers/endpointDiscovery.js';
import type { EndpointDiscoverResponse } from '@archon/shared';

// Workbench Expansion §D2 — Endpoint auto-discovery route.
//
//   GET /api/endpoints/discover  → { endpoints, tailscaleAvailable, cached }
//
// Operator-triggered ONLY (the settings UI calls this when the operator clicks
// "Discover endpoints"); there is no background daemon. Suggestions only — the
// response lists reachable Ollama/OpenAI-compatible endpoints the operator can
// click to fill settings.ollama.baseUrl; this route never mutates settings.
//
// Always 200 in the non-fatal path — discoverEndpoints() degrades gracefully
// (tailscale absent ⇒ localhost-only) and never throws. A genuine internal
// error falls through to a 500 with an empty endpoint list so the UI shows
// "none found" rather than choking.

export async function tryHandleEndpointDiscoveryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!(req.url?.startsWith('/api/endpoints/discover') && req.method === 'GET')) {
    return false;
  }
  const send = (code: number, body: unknown): true => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };
  try {
    const result = await discoverEndpoints();
    return send(200, result);
  } catch (err) {
    console.error('[archon] endpoint discovery failed:', err);
    const body: EndpointDiscoverResponse = {
      endpoints: [],
      tailscaleAvailable: false,
      cached: false,
    };
    return send(500, body);
  }
}

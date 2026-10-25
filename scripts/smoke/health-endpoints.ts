// ARCHON_OPS_PLAN.md §B2 — liveness (/healthz) + readiness (/readyz) endpoints.
//
// Hits the LIVE server's GET /healthz, GET /health (back-compat alias), and
// GET /readyz (the director runs this against a running `npm run dev` on :3001
// — do NOT start a server here). A long-lived dev server has already finished
// its pre-listen capabilities probe and its post-listen workflow-store recovery,
// so it is ALWAYS ready by the time this smoke can connect — hence /readyz is
// asserted at 200/{status:'ready'} with both components true and no pending.
//
// The not-ready (503) transition is inherently a cold-boot race (the window
// between listen() and store recovery completing) and is exercised by the
// director's cold-boot verification, NOT here — a long-lived server is already
// past it.
//
// Run: npm run smoke:health-endpoints  (needs the dev server on :3001)

import { step, assert, assertEq, summary } from './lib.js';

const HTTP_BASE = process.env.ARCHON_SMOKE_HTTP_BASE || 'http://localhost:3001';

interface HealthBody {
  status?: string;
  version?: string;
  pid?: number;
  uptimeSec?: number;
}

interface ReadyBody {
  status?: string;
  components?: Record<string, boolean>;
  pending?: string[];
  uptimeSec?: number;
}

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  let r: Response;
  try {
    r = await fetch(`${HTTP_BASE}${path}`);
  } catch (err) {
    throw new Error(
      `could not connect to ${HTTP_BASE}${path} — is the dev server running on :3001? ` +
        `(this smoke does NOT start a server) — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { status: r.status, body: (await r.json()) as T };
}

async function main() {
  await step('GET /healthz → 200, status "live" with pid/uptime/version', async () => {
    const { status, body } = await getJson<HealthBody>('/healthz');
    assertEq(status, 200, 'status 200');
    assertEq(body.status, 'live', "body.status === 'live'");
    assert(typeof body.pid === 'number' && Number.isInteger(body.pid), `pid is an integer (got ${body.pid})`);
    assert(typeof body.uptimeSec === 'number', `uptimeSec is a number (got ${body.uptimeSec})`);
    assert(typeof body.version === 'string' && body.version.length > 0, 'version is a non-empty string');
  });

  await step('GET /health (alias) → 200, same "live" shape as /healthz', async () => {
    const { status, body } = await getJson<HealthBody>('/health');
    assertEq(status, 200, 'status 200');
    assertEq(body.status, 'live', "alias body.status === 'live'");
    assert(typeof body.pid === 'number' && Number.isInteger(body.pid), 'alias pid is an integer');
    assert(typeof body.uptimeSec === 'number', 'alias uptimeSec is a number');
  });

  await step('GET /readyz → 200, ready with both components true + no pending', async () => {
    const { status, body } = await getJson<ReadyBody>('/readyz');
    assertEq(status, 200, 'status 200 (a long-lived dev server is ready)');
    assertEq(body.status, 'ready', "body.status === 'ready'");
    assert(!!body.components, 'body has a components map');
    assertEq(body.components!.capabilities, true, 'components.capabilities === true');
    assertEq(body.components!.stores, true, 'components.stores === true');
    assert(Array.isArray(body.pending) && body.pending.length === 0, `pending is empty (got ${JSON.stringify(body.pending)})`);
  });

  summary('health-endpoints');
}

main();

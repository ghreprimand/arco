// docs/LOCAL_SERVICES.md - Local services discovery + kill +
// health-probe smoke.
//
// Hits the LIVE server's GET /api/services + DELETE /api/services/:pid (the
// director runs this against a running `npm run dev` on :3001 — do NOT start a
// server here). L1 asserts the response is well-formed: 200, a `services` array
// + numeric `generatedAt`, every service typed correctly, ports are integers
// ≥1024, url matches http://localhost:<port>/, and the list is sorted by port.
//
// Since the operator runs Arco's own dev stack (Vite on 5173, server on 3001),
// we expect AT LEAST ONE service AND either a recognized framework somewhere OR
// a `detail` (so the test is meaningful but not flaky if lsof is somehow absent
// — we branch on `detail`).
//
// L2 kill path: spawn a throwaway child listening on a high localhost port, poll
// until it shows up in GET /api/services, DELETE it (assert 200 {ok:true}), poll
// until it's gone, and assert the guards (pid<=1 → 400, a non-existent high pid
// → 404). Self-contained — the child is always killed in a finally so the smoke
// never leaks a process.
//
// Run: npm run smoke:services-discovery  (needs the dev server on :3001)

import { spawn, type ChildProcess } from 'node:child_process';
import { step, assert, assertEq, summary } from './lib.js';
import type { ServicesResponse, LocalService } from '../../shared/src/protocol/services.js';

const HTTP_BASE = process.env.ARCO_SMOKE_HTTP_BASE || 'http://localhost:3001';

// A fixed high port unlikely to clash with anything the operator runs.
const KILL_PORT = 39271;

// Poll a predicate against GET /api/services until it holds or we time out.
async function waitForServices(
  predicate: (r: ServicesResponse) => boolean,
  label: string,
  timeoutMs = 10000,
): Promise<ServicesResponse> {
  const deadline = Date.now() + timeoutMs;
  let last: ServicesResponse | null = null;
  while (Date.now() < deadline) {
    const r = await fetch(`${HTTP_BASE}/api/services`);
    last = (await r.json()) as ServicesResponse;
    if (predicate(last)) return last;
    await new Promise((res) => setTimeout(res, 400));
  }
  throw new Error(`waitForServices("${label}") timed out after ${timeoutMs}ms`);
}

async function main() {
  let report: ServicesResponse;

  await step('GET /api/services returns 200 with a response', async () => {
    let r: Response;
    try {
      r = await fetch(`${HTTP_BASE}/api/services`);
    } catch (err) {
      throw new Error(
        `could not connect to ${HTTP_BASE} — is the dev server running on :3001? ` +
          `(this smoke does NOT start a server) — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    assertEq(r.status, 200, 'status 200');
    report = (await r.json()) as ServicesResponse;
    assert(report && Array.isArray(report.services), 'response has a services array');
    assert(typeof report.generatedAt === 'number', 'generatedAt is a number');
  });

  await step('every service has the required fields with correct types', () => {
    for (const s of report.services) {
      assert(s.pid === null || (typeof s.pid === 'number' && Number.isInteger(s.pid)), 'pid is int|null');
      assert(typeof s.processName === 'string', 'processName is a string');
      assert(typeof s.cmdline === 'string', 'cmdline is a string');
      assert(s.cwd === null || typeof s.cwd === 'string', 'cwd is string|null');
      assert(typeof s.appName === 'string', 'appName is a string');
      assert(typeof s.host === 'string' && s.host.length > 0, 'host is a non-empty string');
      assert(typeof s.port === 'number' && Number.isInteger(s.port), `port is an integer (got ${s.port})`);
      assert(s.port >= 1024, `port is ≥1024 — privileged ports are skipped (got ${s.port})`);
      assertEq(s.url, `http://localhost:${s.port}/`, `url matches http://localhost:<port>/ for port ${s.port}`);
      assert(s.framework === null || typeof s.framework === 'string', 'framework is string|null');
      assert(s.frameworkEmoji === null || typeof s.frameworkEmoji === 'string', 'frameworkEmoji is string|null');
      assert(typeof s.friendlyName === 'string' && s.friendlyName.length > 0, 'friendlyName is non-empty');
      assert(typeof s.likelyWeb === 'boolean', 'likelyWeb is a boolean');
    }
  });

  await step('the list is sorted by port', () => {
    const ports = report.services.map((s) => s.port);
    for (let i = 1; i < ports.length; i++) {
      assert(ports[i] >= ports[i - 1], `ports sorted asc (index ${i}: ${ports[i - 1]} then ${ports[i]})`);
    }
  });

  await step('discovery is meaningful (≥1 service + a framework, or a detail)', () => {
    if (report.detail) {
      // lsof somehow absent / failed — the list may be empty. Not a flake.
      console.log(`        (detail present — discovery degraded: ${report.detail})`);
      return;
    }
    assert(report.services.length >= 1, `at least one service discovered (got ${report.services.length})`);
    const withFramework = report.services.filter((s: LocalService) => s.framework);
    assert(
      withFramework.length >= 1,
      `at least one service has a recognized framework (got ${withFramework.length}); ` +
        `the dev Vite server on 5173 should match`,
    );
    console.log(
      `        (discovered ${report.services.length} services; ` +
        `${withFramework.length} with a framework, e.g. ${withFramework.map((s) => s.friendlyName).slice(0, 3).join(', ')})`,
    );
  });

  // ── L3 — the health dot's only server dependency is the reused preview
  // probe endpoint. Assert its three behaviors against the live stack (no child
  // needed — the server itself is a guaranteed-alive loopback port).
  await step('GET /api/preview/probe backs the HEALTH dot (alive / dead / bad)', async () => {
    const aliveUrl = new URL('/api/preview/probe', HTTP_BASE);
    aliveUrl.searchParams.set('port', new URL(HTTP_BASE).port || '3001');
    const rAlive = await fetch(aliveUrl);
    assertEq(rAlive.status, 200, 'probe of the live server port → 200');
    assertEq(((await rAlive.json()) as { alive?: boolean }).alive, true, 'live port → {alive:true}');

    const rDead = await fetch(`${HTTP_BASE}/api/preview/probe?port=39998`);
    assertEq(rDead.status, 200, 'probe of a dead port → 200');
    assertEq(((await rDead.json()) as { alive?: boolean }).alive, false, 'dead port → {alive:false}');

    const rBad = await fetch(`${HTTP_BASE}/api/preview/probe?port=0`);
    assertEq(rBad.status, 400, 'probe of an invalid port → 400');
  });

  // ── L2 — kill path against a throwaway child ──
  let child: ChildProcess | null = null;
  try {
    await step('DELETE guards: pid<=1 → 400, nonexistent high pid → 404', async () => {
      const r1 = await fetch(`${HTTP_BASE}/api/services/1`, { method: 'DELETE' });
      assertEq(r1.status, 400, 'DELETE /api/services/1 → 400 (refuses pid<=1)');
      // A high pid that owns no listening socket → 404 (re-scan blast bound).
      const r2 = await fetch(`${HTTP_BASE}/api/services/4000000`, { method: 'DELETE' });
      assertEq(r2.status, 404, 'DELETE of a non-listening pid → 404');
    });

    await step('spawn a throwaway listener and kill it via DELETE /api/services/:pid', async () => {
      child = spawn(
        process.execPath,
        ['-e', `require("http").createServer((_,r)=>r.end("ok")).listen(${KILL_PORT},"127.0.0.1")`],
        { stdio: 'ignore' },
      );
      assert(typeof child.pid === 'number', 'child has a pid');
      const childPid = child.pid!;

      // Poll until the child's pid+port appears (lsof + per-pid resolve can lag).
      await waitForServices(
        (r) => r.services.some((s) => s.pid === childPid && s.port === KILL_PORT),
        `child pid ${childPid} on :${KILL_PORT} appears`,
      );

      const del = await fetch(`${HTTP_BASE}/api/services/${childPid}`, { method: 'DELETE' });
      assertEq(del.status, 200, 'DELETE the child → 200');
      const body = (await del.json()) as { ok?: boolean; signal?: string };
      assertEq(body.ok, true, 'response {ok:true}');
      assertEq(body.signal, 'SIGTERM', "response signal === 'SIGTERM'");

      // Poll until it's gone from the scan.
      await waitForServices(
        (r) => !r.services.some((s) => s.pid === childPid && s.port === KILL_PORT),
        `child pid ${childPid} disappears`,
      );
      console.log(`        (spawned pid ${childPid} on :${KILL_PORT}, killed it, confirmed gone)`);
    });
  } finally {
    // Never leak the child even if a step above threw mid-way.
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill(); } catch { /* already gone */ }
    }
  }

  summary('services-discovery');
}

main();

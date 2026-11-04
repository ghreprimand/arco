import { IncomingMessage, ServerResponse } from 'http';
import { discoverServices } from '../services/discover.js';
import type { ServicesResponse } from '@arco/shared';

// docs/LOCAL_SERVICES.md - Services routes.
//
//   GET    /api/services       → ServicesResponse { services, generatedAt, detail? }   (L1, read-only)
//   DELETE /api/services/:pid  → { ok, pid, signal } | error                            (L2, the ONE mutation)
//
// Operator-triggered ONLY (the L2 Services tab calls GET on mount / Refresh and
// DELETE on an operator's two-step KILL confirm); there is no background daemon.
//
// GET is READ-ONLY: L1 enumerates listening sockets and resolves each to its
// process / cwd / framework — no kill, no mutation, no writes. Always 200 in the
// normal path; discoverServices() never throws (a missing lsof binary degrades
// to an empty list carrying an explanatory `detail`; a single unreadable process
// degrades to partial info). A genuine internal failure falls through to 500.
//
// DELETE is the one mutating action, so it is guarded HARD (see killService):
//   - pid must be a positive integer > 1; pid === process.pid is refused — the
//     server must never SIGTERM itself.
//   - it re-scans via discoverServices() and confirms the pid owns a CURRENT
//     listening socket before signalling. This bounds the blast radius: the tab
//     can only kill what it actually shows. A stale/forged pid → 404.
//   - SIGTERM only (graceful terminate), via the Node process.kill primitive —
//     NEVER a shelled-out `kill`. No SIGKILL escalation.

export async function tryHandleServicesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const send = (code: number, body: unknown): true => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };

  // Strip any query string before matching the path.
  const path = req.url?.split('?')[0];

  // ── L1 — GET /api/services (bare path only) ──
  if (req.method === 'GET' && path === '/api/services') {
    try {
      const report = await discoverServices();
      return send(200, report);
    } catch (err) {
      console.error('[arco] services discovery failed:', err);
      const body: ServicesResponse = {
        services: [],
        generatedAt: Date.now(),
        detail: 'Could not enumerate local services.',
      };
      return send(500, body);
    }
  }

  // ── L2 — DELETE /api/services/:pid (the one mutating action) ──
  if (req.method === 'DELETE' && path && path.startsWith('/api/services/')) {
    const pidRaw = path.slice('/api/services/'.length);
    return killService(pidRaw, send);
  }

  return false;
}

// Kill guard. The mutation lives behind three fences (rationale inline):
//   (1) pid shape — a positive integer > 1. Rejecting pid <= 1 keeps us away
//       from init / the kernel idle task / a negative process-group signal.
//   (2) self-kill refusal — pid === process.pid would SIGTERM the Arco server
//       itself (the tab lists Arco's own listeners), bricking the session.
//   (3) re-scan blast-radius bound — only kill a pid that currently owns a
//       listening socket per a fresh discoverServices() scan. The tab can only
//       kill what it actually shows; a stale or forged pid never reaches kill().
// SIGTERM only — a graceful terminate; no SIGKILL escalation. ESRCH → 404
// (already gone), EPERM → 403 (not ours to signal). Never throws out.
async function killService(
  pidRaw: string,
  send: (code: number, body: unknown) => true,
): Promise<boolean> {
  // (1) pid shape.
  if (!/^\d+$/.test(pidRaw)) {
    return send(400, { ok: false, error: 'pid must be a positive integer' });
  }
  const pid = Number.parseInt(pidRaw, 10);
  if (!Number.isInteger(pid) || pid <= 1) {
    return send(400, { ok: false, error: 'pid must be a positive integer greater than 1' });
  }
  // (2) self-kill refusal.
  if (pid === process.pid) {
    return send(400, { ok: false, error: 'refusing to kill the Arco server itself' });
  }

  // (3) re-scan blast-radius bound — confirm the pid owns a current listening
  // socket. discoverServices() never throws; if it degraded (no lsof) we have
  // no listeners to confirm against, so the pid is treated as not-found.
  try {
    const report = await discoverServices();
    const owns = report.services.some((s) => s.pid === pid);
    if (!owns) {
      return send(404, { ok: false, error: 'no listening service with that pid' });
    }
  } catch (err) {
    console.error('[arco] services kill re-scan failed:', err);
    return send(500, { ok: false, error: 'could not verify the service before killing' });
  }

  // The mutation: SIGTERM via the Node primitive (no subprocess, no shell).
  try {
    process.kill(pid, 'SIGTERM');
    return send(200, { ok: true, pid, signal: 'SIGTERM' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') {
      // Raced — the process exited between the re-scan and the signal.
      return send(404, { ok: false, error: 'process already gone' });
    }
    if (code === 'EPERM') {
      return send(403, { ok: false, error: 'permission denied — not allowed to signal that process' });
    }
    console.error('[arco] services kill failed:', err);
    return send(500, { ok: false, error: 'kill failed' });
  }
}

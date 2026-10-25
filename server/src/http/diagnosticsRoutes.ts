import { IncomingMessage, ServerResponse } from 'http';
import { runDiagnostics } from '../diagnostics/checks.js';
import { buildSupportBundle } from '../diagnostics/supportBundle.js';
import { buildModelHealthReport } from '../diagnostics/modelHealth.js';
import type { DiagnosticsReport, ModelHealthReport, SupportBundleResponse } from '@arco/shared';

// ARCO_OPS_PLAN.md §A1/§A2/§A3 — Diagnostics routes.
//
//   GET /api/diagnostics                 → DiagnosticsReport { groups, generatedAt, arcoVersion, platform }
//   GET /api/diagnostics/support-bundle  → SupportBundleResponse { json: SupportBundle, text }  (REDACTED)
//   GET /api/diagnostics/model-health    → ModelHealthReport { ollama, llamacpp, cookbook, generatedAt, platform }
//
// Operator-triggered ONLY (the System modal's Diagnostics tab calls these on
// mount / Refresh / the Copy support bundle button); there is no background
// daemon. Both are READ-ONLY readouts. Every probe lives in
// server/src/diagnostics/checks.ts and degrades gracefully (a thrown probe
// becomes an `error` result, never a crashed call); the support bundle is built
// from an explicit safe-field allowlist with path + secret redaction layered on
// top (server/src/diagnostics/supportBundle.ts, Appendix D).
//
// Always 200 in the normal path. A genuine internal failure falls through to 500
// with an empty payload so the UI can show "couldn't run …" rather than hanging.
//
// Route order: the more specific /support-bundle + /model-health paths are
// matched BEFORE the bare /api/diagnostics handler.

export async function tryHandleDiagnosticsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!(req.url?.startsWith('/api/diagnostics') && req.method === 'GET')) {
    return false;
  }
  const send = (code: number, body: unknown): true => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };

  // Strip any query string before matching the path.
  const path = req.url.split('?')[0];

  if (path === '/api/diagnostics/support-bundle') {
    try {
      const bundle = await buildSupportBundle();
      return send(200, bundle);
    } catch (err) {
      console.error('[arco] support bundle failed:', err);
      const body: SupportBundleResponse = {
        json: {
          generatedAt: Date.now(),
          arcoVersion: 'unknown',
          gitRev: 'unknown',
          platform: `${process.platform}/${process.arch}`,
          runtime: { node: process.version, serviceMode: 'unknown' },
          diagnostics: {
            groups: [],
            generatedAt: Date.now(),
            arcoVersion: 'unknown',
            platform: `${process.platform}/${process.arch}`,
          },
        },
        text: 'Could not build support bundle.',
      };
      return send(500, body);
    }
  }

  if (path === '/api/diagnostics/model-health') {
    try {
      const report = await buildModelHealthReport();
      return send(200, report);
    } catch (err) {
      console.error('[arco] model-health failed:', err);
      // buildModelHealthReport never throws by contract, but stay defensive: a
      // degraded fallback keeps every subsystem present with a warn roll-up.
      const body: ModelHealthReport = {
        ollama: { status: 'warn', baseUrl: 'unknown', reachable: false, modelCount: 0, models: [], detail: 'model-health build failed' },
        llamacpp: { status: 'warn', binaryPath: null, modelCount: 0, models: [], managerState: 'idle', detail: 'model-health build failed' },
        cookbook: {
          status: 'warn',
          hardware: { gpus: [], totalVramBytes: 0, systemRamBytes: 0, cores: 0, backend: 'cpu' },
          downloadedModelCount: 0,
          downloadedModels: [],
          fitWarnings: [],
          detail: 'model-health build failed',
        },
        generatedAt: Date.now(),
        platform: `${process.platform}/${process.arch}`,
      };
      return send(500, body);
    }
  }

  try {
    const report = await runDiagnostics();
    return send(200, report);
  } catch (err) {
    console.error('[arco] diagnostics failed:', err);
    const body: DiagnosticsReport = {
      groups: [],
      generatedAt: Date.now(),
      arcoVersion: 'unknown',
      platform: `${process.platform}/${process.arch}`,
    };
    return send(500, body);
  }
}

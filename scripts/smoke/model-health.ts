// docs/ARCHITECTURE.md - Local model health endpoint smoke.
//
// Hits the LIVE server's GET /api/diagnostics/model-health (the director runs
// this against a running `npm run dev`). Asserts the report is well-formed:
// 200, all three subsystems present with valid roll-up statuses, Ollama reports
// its model count, llama.cpp reports its registered-model count + manager state,
// Cookbook reports the hardware profile (backend + VRAM), and a degraded
// subsystem surfaces warn/skipped — NOT error (unless a real last-launch failure).
//
// Run: npm run smoke:model-health  (needs the dev server on :3001)

import { step, assert, assertEq, summary } from './lib.js';
import type { ModelHealthReport, DiagnosticStatus } from '../../shared/src/protocol/opsDiagnostics.js';

const HTTP_BASE = process.env.ARCO_SMOKE_HTTP_BASE || 'http://localhost:3001';
const VALID_STATUS: DiagnosticStatus[] = ['ok', 'warn', 'error', 'skipped'];
const VALID_MANAGER_STATES = ['idle', 'loading', 'ready', 'failed'];

async function main() {
  let report: ModelHealthReport;

  await step('GET /api/diagnostics/model-health returns 200 with a report', async () => {
    const r = await fetch(`${HTTP_BASE}/api/diagnostics/model-health`);
    assertEq(r.status, 200, 'status 200');
    report = (await r.json()) as ModelHealthReport;
    assert(report && typeof report === 'object', 'report is an object');
    assert(typeof report.generatedAt === 'number', 'generatedAt is a number');
    assert(typeof report.platform === 'string' && report.platform.includes('/'), 'platform looks like os/arch');
  });

  await step('all three subsystems present with valid roll-up statuses', () => {
    assert(report.ollama && typeof report.ollama === 'object', 'ollama sub-report present');
    assert(report.llamacpp && typeof report.llamacpp === 'object', 'llamacpp sub-report present');
    assert(report.cookbook && typeof report.cookbook === 'object', 'cookbook sub-report present');
    for (const [name, sub] of [
      ['ollama', report.ollama],
      ['llamacpp', report.llamacpp],
      ['cookbook', report.cookbook],
    ] as const) {
      assert(VALID_STATUS.includes(sub.status), `${name} roll-up status valid (got ${sub.status})`);
      assert(typeof sub.detail === 'string' && sub.detail.length > 0, `${name} has a detail line`);
    }
  });

  await step('Ollama reports its model count + names array', () => {
    const o = report.ollama;
    assert(typeof o.baseUrl === 'string' && o.baseUrl.length > 0, 'ollama base URL present');
    assert(typeof o.reachable === 'boolean', 'ollama reachable is boolean');
    assert(typeof o.modelCount === 'number' && o.modelCount >= 0, 'ollama modelCount is a non-negative number');
    assert(Array.isArray(o.models), 'ollama models is an array');
    assertEq(o.models.length, o.modelCount, 'ollama models array length matches modelCount');
    // This box runs ollama with 11 models; if reachable we expect >0.
    if (o.reachable) assert(o.modelCount > 0, 'reachable ollama reports installed models');
  });

  await step('llama.cpp reports registered-model count + valid manager state', () => {
    const l = report.llamacpp;
    assert(VALID_MANAGER_STATES.includes(l.managerState), `manager state valid (got ${l.managerState})`);
    assert(typeof l.modelCount === 'number' && l.modelCount >= 0, 'llamacpp modelCount is a non-negative number');
    assert(Array.isArray(l.models), 'llamacpp models is an array');
    assertEq(l.models.length, l.modelCount, 'llamacpp models array length matches modelCount');
    // This box registers 2 llama.cpp models.
    assert(l.modelCount >= 1, 'expects at least one registered llama.cpp model on this box');
    // binaryPath is string-or-null (not on PATH is acceptable, not an error).
    assert(l.binaryPath === null || typeof l.binaryPath === 'string', 'binaryPath is string|null');
  });

  await step('Cookbook reports the hardware profile (backend + VRAM)', () => {
    const c = report.cookbook;
    assert(c.hardware && typeof c.hardware === 'object', 'cookbook hardware present');
    assert(['cuda', 'metal', 'cpu'].includes(c.hardware.backend), `backend valid (got ${c.hardware.backend})`);
    assert(typeof c.hardware.totalVramBytes === 'number' && c.hardware.totalVramBytes >= 0, 'totalVramBytes is a non-negative number');
    assert(typeof c.hardware.systemRamBytes === 'number' && c.hardware.systemRamBytes > 0, 'systemRamBytes positive');
    assert(typeof c.downloadedModelCount === 'number' && c.downloadedModelCount >= 0, 'downloadedModelCount non-negative');
    assert(Array.isArray(c.fitWarnings), 'fitWarnings is an array');
    for (const w of c.fitWarnings) {
      assert(typeof w.alias === 'string' && w.alias.length > 0, 'fit warning has an alias');
      assert(['PERFECT', 'GOOD', 'TIGHT', 'NO'].includes(w.verdict), `fit warning verdict valid (got ${w.verdict})`);
      assert(typeof w.detail === 'string' && w.detail.length > 0, 'fit warning has a detail');
    }
  });

  await step('a degraded subsystem surfaces warn/skipped, not a bare error', () => {
    // An unreachable Ollama daemon, an absent llama-server binary, or a fit
    // mismatch must degrade to warn/skipped. The only legitimate `error` is a
    // real llama.cpp last-launch failure (managerState === 'failed').
    for (const [name, sub] of [
      ['ollama', report.ollama],
      ['cookbook', report.cookbook],
    ] as const) {
      assert(sub.status !== 'error', `${name} must not be error on a normal box (got ${sub.status}: ${sub.detail})`);
    }
    if (report.llamacpp.status === 'error') {
      assertEq(report.llamacpp.managerState, 'failed', 'llamacpp error only when manager state is failed');
    }
  });

  summary('model-health');
}

main();

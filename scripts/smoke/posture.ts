// docs/ARCHITECTURE.md - Security / exposure posture smoke.
//
// Two halves:
//   1. Pure unit-assert of `classifyBindAddress` (imported directly — no server).
//      This is the phase ACCEPTANCE: binding 0.0.0.0 flips the bind-address check
//      to a clear warning.
//   2. Hits the LIVE server's GET /api/diagnostics (the director runs this against
//      a running `npm run dev` on :3001) and asserts the new `security` group
//      exists with all 9 check ids, and that on this loopback-bound box the
//      bind-address check is `ok`.
//
// Run: npm run smoke:posture  (needs the dev server on :3001)

import { step, assert, assertEq, summary } from './lib.js';
import { classifyBindAddress } from '../../server/src/diagnostics/checks.js';
import type {
  DiagnosticsReport,
  DiagnosticGroupId,
} from '../../shared/src/protocol/opsDiagnostics.js';

const HTTP_BASE = process.env.ARCO_SMOKE_HTTP_BASE || 'http://localhost:3001';
const SECURITY_GROUP: DiagnosticGroupId = 'security';
const EXPECTED_CHECKS = [
  'security.bind-address',
  'security.remote-access',
  'security.terminal',
  'security.git-ops',
  'security.writable-cwd-roots',
  'security.provider-auth',
  'security.preview-proxy',
  'security.local-model-endpoints',
  'security.risky-env-config',
];

async function main() {
  await step('classifyBindAddress: loopback → ok, 0.0.0.0 → warn, private → warn', () => {
    assertEq(classifyBindAddress('127.0.0.1').status, 'ok', 'loopback is ok');
    assertEq(classifyBindAddress('localhost').status, 'ok', 'localhost is ok');
    assertEq(classifyBindAddress('::1').status, 'ok', '::1 is ok');
    // Phase acceptance: 0.0.0.0 flips to a clear warning.
    assertEq(classifyBindAddress('0.0.0.0').status, 'warn', '0.0.0.0 is warn');
    assert(
      classifyBindAddress('0.0.0.0').detail.includes('0.0.0.0'),
      '0.0.0.0 detail names the bind',
    );
    assertEq(classifyBindAddress('192.168.1.5').status, 'warn', 'RFC1918 is warn');
    assertEq(classifyBindAddress('8.8.8.8').status, 'warn', 'public host is warn');
  });

  let report: DiagnosticsReport;

  await step('GET /api/diagnostics returns 200 with a report', async () => {
    const r = await fetch(`${HTTP_BASE}/api/diagnostics`);
    assertEq(r.status, 200, 'status 200');
    report = (await r.json()) as DiagnosticsReport;
    assert(report && Array.isArray(report.groups), 'report has a groups array');
  });

  await step('a security group exists', () => {
    const ids = report.groups.map((g) => g.id);
    assert(ids.includes(SECURITY_GROUP), 'security group present');
  });

  await step('security group contains all 9 expected check ids', () => {
    const sec = report.groups.find((g) => g.id === SECURITY_GROUP)!;
    const ids = sec.checks.map((c) => c.id);
    assertEq(ids.length, EXPECTED_CHECKS.length, 'nine security checks');
    for (const expected of EXPECTED_CHECKS) {
      assert(ids.includes(expected), `check "${expected}" present`);
    }
  });

  await step('on this loopback-bound box, security.bind-address is ok', () => {
    const sec = report.groups.find((g) => g.id === SECURITY_GROUP)!;
    const bind = sec.checks.find((c) => c.id === 'security.bind-address')!;
    assert(bind, 'bind-address check present');
    assertEq(bind.status, 'ok', `bind-address ok on loopback (got ${bind.status}: ${bind.detail})`);
  });

  await step('no security probe crashed the report (no thrown-probe error)', () => {
    const sec = report.groups.find((g) => g.id === SECURITY_GROUP)!;
    const thrown = sec.checks.filter((c) => c.status === 'error' && c.detail.startsWith('probe threw:'));
    assertEq(thrown.length, 0, `no probe threw (offenders: ${thrown.map((c) => c.id).join(', ')})`);
  });

  summary('posture');
}

main();

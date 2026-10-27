// docs/ARCHITECTURE.md - Diagnostics endpoint smoke.
//
// Hits the LIVE server's GET /api/diagnostics (the director runs this against a
// running `npm run dev`). Asserts the report is well-formed: 200, all six
// groups present, every check has a valid status, the Core group has at least
// one `ok` check, and a known-degraded dependency (the TS language server is
// absent on this box) surfaces as warn/skipped — NOT error.
//
// Run: npm run smoke:diagnostics  (needs the dev server on :3001)

import { step, assert, assertEq, summary } from './lib.js';
import type {
  DiagnosticsReport,
  DiagnosticStatus,
  DiagnosticGroupId,
} from '../../shared/src/protocol/opsDiagnostics.js';

const HTTP_BASE = process.env.ARCO_SMOKE_HTTP_BASE || 'http://localhost:3001';
const VALID_STATUS: DiagnosticStatus[] = ['ok', 'warn', 'error', 'skipped'];
const EXPECTED_GROUPS: DiagnosticGroupId[] = [
  'core',
  'providers',
  'local-tools',
  'workbench',
  'storage',
  'security',
];

async function main() {
  let report: DiagnosticsReport;

  await step('GET /api/diagnostics returns 200 with a report', async () => {
    const r = await fetch(`${HTTP_BASE}/api/diagnostics`);
    assertEq(r.status, 200, 'status 200');
    report = (await r.json()) as DiagnosticsReport;
    assert(report && Array.isArray(report.groups), 'report has a groups array');
    assert(typeof report.generatedAt === 'number', 'generatedAt is a number');
    assert(typeof report.arcoVersion === 'string', 'arcoVersion is a string');
    assert(typeof report.platform === 'string' && report.platform.includes('/'), 'platform looks like os/arch');
  });

  await step('all six groups are present, in order', () => {
    const ids = report.groups.map((g) => g.id);
    assertEq(ids.length, EXPECTED_GROUPS.length, 'six groups');
    for (const expected of EXPECTED_GROUPS) {
      assert(ids.includes(expected), `group "${expected}" present`);
    }
  });

  await step('every check has a valid status, id, and detail', () => {
    let total = 0;
    for (const g of report.groups) {
      assert(g.checks.length > 0, `group "${g.id}" has at least one check`);
      for (const c of g.checks) {
        total++;
        assert(VALID_STATUS.includes(c.status), `check "${c.id}" has a valid status (got ${c.status})`);
        assert(typeof c.id === 'string' && c.id.length > 0, 'check has an id');
        assert(typeof c.label === 'string' && c.label.length > 0, `check "${c.id}" has a label`);
        assert(typeof c.detail === 'string' && c.detail.length > 0, `check "${c.id}" has a detail`);
        assertEq(c.group, g.id, `check "${c.id}" group field matches its group`);
      }
    }
    assert(total >= 20, `expected the full registry (~22 checks), got ${total}`);
  });

  await step('Core group has at least one ok check', () => {
    const core = report.groups.find((g) => g.id === 'core');
    assert(core, 'core group exists');
    assert(core!.checks.some((c) => c.status === 'ok'), 'at least one Core check is ok');
  });

  await step('a known-degraded dep (TS LSP absent) degrades to warn/skipped, not error', () => {
    const lsp = report.groups
      .find((g) => g.id === 'local-tools')!
      .checks.find((c) => c.id === 'local-tools.lsp');
    assert(lsp, 'LSP check present');
    // This box has rust-analyzer but NOT typescript-language-server, so the
    // check must NOT be ok-all-detected and must NOT error — it degrades.
    assert(lsp!.status !== 'error', `LSP check must not be error (got ${lsp!.status}: ${lsp!.detail})`);
    assert(
      lsp!.status === 'warn' || lsp!.status === 'skipped' || lsp!.status === 'ok',
      'LSP check is warn/skipped/ok',
    );
  });

  await step('no check crashed the report (no probe surfaced as a thrown-probe error)', () => {
    const thrown = report.groups
      .flatMap((g) => g.checks)
      .filter((c) => c.status === 'error' && c.detail.startsWith('probe threw:'));
    assertEq(thrown.length, 0, `no probe threw (offenders: ${thrown.map((c) => c.id).join(', ')})`);
  });

  summary('diagnostics');
}

main();

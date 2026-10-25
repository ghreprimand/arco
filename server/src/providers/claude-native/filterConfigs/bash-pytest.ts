// EFFICIENCY_PLAN.md Phase C — pytest filter pack.
//
// Green (exit 0): drop the per-test "tests/foo.py::bar PASSED" lines, keep
// the session header ("platform …", "rootdir: …", "collected N items") and
// the trailing "= 12 passed in 1.2s =" summary.
// Red: preserve FAILED/ERROR lines plus the "FAILURES" section verbatim
// (we keep the whole block from "= FAILURES =" to the next "= … =" header
// so the operator and model see actual tracebacks).

import type { FilterPack } from '../filterToolResult.js';

const PASSED_LINE = /\bPASSED\b/;
const FAILED_LINE = /\b(FAILED|ERROR|XFAIL|XPASS)\b/;
const SECTION_HEADER = /^=+ .* =+$/;

export const bashPytest: FilterPack = {
  name: 'pytest-drop-passing',
  stripAnsi: true,
  parse: (text, exitCode) => {
    const lines = text.split('\n');
    if (exitCode === 0 || exitCode === null) {
      return lines.filter((l) => !PASSED_LINE.test(l) || FAILED_LINE.test(l)).join('\n');
    }
    // Red: keep section headers + everything inside the FAILURES section,
    // plus failed-line markers in the per-test progress.
    const out: string[] = [];
    let inFailures = false;
    for (const l of lines) {
      if (SECTION_HEADER.test(l)) {
        inFailures = /FAILURES/.test(l);
        out.push(l);
        continue;
      }
      if (inFailures) { out.push(l); continue; }
      if (FAILED_LINE.test(l)) { out.push(l); continue; }
      if (PASSED_LINE.test(l)) continue;
      // Keep the session header lines (top of pytest output).
      if (/^(platform |rootdir:|plugins:|configfile:|collected )/.test(l)) {
        out.push(l);
      }
    }
    return out.join('\n');
  },
};

// EFFICIENCY_PLAN.md Phase C — jest / vitest filter pack.
//
// Both runners share enough of an output shape that one pack handles them.
// Green (exit 0): drop ✓ / PASS lines, keep summary ("Tests:", "Test Suites:",
// "Time:", "Ran all test suites"). Red: preserve every ✗ / FAIL line plus
// surrounding diff/expected/received blocks until the next test marker.

import type { FilterPack } from '../filterToolResult.js';

const PASS_LINE = /^\s*(?:✓|PASS|√|ok)\s/;
const FAIL_LINE = /^\s*(?:✗|×|FAIL|✕)\s/;
const SUMMARY_LINE = /^(Tests|Test Suites|Snapshots|Time|Ran all test suites|Test Files):/;

export const bashJestVitest: FilterPack = {
  name: 'jest-vitest-drop-passing',
  stripAnsi: true,
  parse: (text, exitCode) => {
    const lines = text.split('\n');
    if (exitCode === 0 || exitCode === null) {
      return lines.filter((l) => !PASS_LINE.test(l)).join('\n');
    }
    // Red path: keep failures + summary + indented contextual lines that
    // immediately follow a fail marker (5 lines).
    const out: string[] = [];
    let bodyLeft = 0;
    for (const l of lines) {
      if (FAIL_LINE.test(l)) { out.push(l); bodyLeft = 5; continue; }
      if (SUMMARY_LINE.test(l)) { out.push(l); bodyLeft = 0; continue; }
      if (bodyLeft > 0) { out.push(l); bodyLeft -= 1; continue; }
      if (PASS_LINE.test(l)) continue;
      // Keep "● test name" headers and stack frames.
      if (/^\s*●/.test(l)) { out.push(l); bodyLeft = 5; continue; }
      if (/at .*\(.*:\d+:\d+\)/.test(l)) { out.push(l); continue; }
    }
    return out.join('\n');
  },
};

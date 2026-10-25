// EFFICIENCY_PLAN.md Phase C — cargo-test filter pack.
//
// Green run (exit 0): drop the per-test "test foo ... ok" lines, keep the
// "running N tests", "test result: ok" summary, and any non-test output
// (build warnings, doctest banners, integration runner banners).
//
// Red run (exit !== 0): preserve every "test foo ... FAILED" line plus the
// first 5 lines of each `---- foo stdout ----` failure block verbatim.
// We do NOT branch via head_cap/tail_cap on this pack because the parser
// does the structural cut directly — branchOnExit on a parsed pack would
// be a second cut on already-trimmed output.

import type { FilterPack } from '../filterToolResult.js';

export const bashCargoTest: FilterPack = {
  name: 'cargo-test-drop-passing',
  stripAnsi: true,
  parse: (text, exitCode) => {
    const lines = text.split('\n');
    if (exitCode === 0 || exitCode === null) {
      // Drop only the "test <path> ... ok" / "test <path> ... ignored" lines.
      // Anything else (compiler warnings, "running N tests", "test result:",
      // doctest output) survives as-is.
      const kept = lines.filter((l) => !/^test [\w:]+ \.\.\. (ok|ignored)$/.test(l));
      return kept.join('\n');
    }
    // Failure path: keep summary + FAILED markers + first 5 lines of each
    // `---- <name> stdout ----` block. Other lines drop unless they're the
    // tail "failures:" / "test result:" / panic context.
    const out: string[] = [];
    let inFailureBody = 0; // counts lines remaining to keep in current block
    for (const l of lines) {
      if (/^---- [\w:]+ stdout ----$/.test(l)) {
        out.push(l);
        inFailureBody = 5;
        continue;
      }
      if (inFailureBody > 0) {
        out.push(l);
        inFailureBody -= 1;
        continue;
      }
      if (/\.\.\. FAILED$/.test(l)) { out.push(l); continue; }
      if (/^running \d+ test/.test(l)) { out.push(l); continue; }
      if (/^test result:/.test(l)) { out.push(l); continue; }
      if (/^failures:/.test(l)) { out.push(l); continue; }
      if (/^thread .* panicked at/.test(l)) { out.push(l); continue; }
      if (/^\s+\d+:/.test(l)) { out.push(l); continue; } // backtrace frame
      // Drop everything else on the failure path (includes per-test "ok"
      // noise from sibling test crates).
    }
    return out.join('\n');
  },
};

// DD2 — bounded-tail bash + spill-to-tempfile smoke.
//
// Headless / module-level (no live server, no API spend) — but it DOES run the
// real Bash tool against /bin/sh, so it proves the end-to-end DD2 behavior:
//
//   (a) a command whose output far exceeds the 64 KB cap COMPLETES (exit 0) —
//       the old code killTree()'d on cap, turning a big-but-green command into a
//       truncated failure;
//   (b) the model-visible result is a bounded tail holding the MOST-RECENT
//       output (the final lines), not the head;
//   (c) the COMPLETE output is spilled to a tempfile named in the footer, and
//       that file holds every line;
//   (d) a small command still returns verbatim with no spill.
//
// Run: npm run smoke:output-accumulator   (no server needed)

import { step, assert, summary } from './lib.js';
import { readFileSync, existsSync } from 'node:fs';

async function main(): Promise<void> {
  const { executeNativeTool } = await import('../../server/src/providers/claude-native/tools.js');

  function ctx() {
    return {
      cwd: process.cwd(),
      abortSignal: new AbortController().signal,
      shells: { byId: new Map(), mintId: () => `sh-${Math.random().toString(36).slice(2, 8)}` },
      readSet: new Set<string>(),
      planMode: false,
      onTodos: () => {},
    } as never;
  }

  await step('DD2.a huge output completes (exit 0) — process NOT killed on cap', async () => {
    // ~100k lines ≈ ~600 KB, far over the 64 KB cap.
    const out = await executeNativeTool('Bash', { command: 'seq 1 100000', timeout: 60000 }, ctx());
    assert(out.includes('exit code: 0'), `command should exit 0, got: ${out.slice(0, 200)}`);
    assert(out.includes('output truncated'), 'should report truncation');
  });

  await step('DD2.b the tail holds the most-recent output (last lines, not the head)', async () => {
    const out = await executeNativeTool('Bash', { command: 'seq 1 100000', timeout: 60000 }, ctx());
    assert(out.includes('100000'), 'tail should contain the LAST line (100000)');
    assert(!out.includes('\n1\n'), 'tail should NOT contain the very first line');
  });

  await step('DD2.c complete output spilled to a tempfile named in the footer', async () => {
    const out = await executeNativeTool('Bash', { command: 'seq 1 100000', timeout: 60000 }, ctx());
    const m = out.match(/full output saved to (\S+)/);
    assert(!!m, 'footer names the spill file');
    const path = m![1];
    assert(existsSync(path), `spill file exists: ${path}`);
    const full = readFileSync(path, 'utf8');
    assert(full.startsWith('1\n'), 'spill is complete from byte 0 (starts at line 1)');
    assert(full.trimEnd().endsWith('100000'), 'spill ends at the last line');
    const lineCount = full.trimEnd().split('\n').length;
    assert(lineCount === 100000, `spill holds every line (got ${lineCount})`);
  });

  await step('DD2.d small output: verbatim, no truncation, no spill', async () => {
    const out = await executeNativeTool('Bash', { command: 'echo hello && echo world', timeout: 10000 }, ctx());
    assert(out.includes('hello'), 'has stdout');
    assert(out.includes('world'), 'has both lines');
    assert(!out.includes('output truncated'), 'small output not truncated');
    assert(!out.includes('full output saved'), 'no spill for small output');
    assert(out.includes('exit code: 0'), 'exit 0');
  });

  await step('DD2.e a failing command still returns its (tail) output + nonzero exit', async () => {
    const out = await executeNativeTool('Bash', { command: 'echo oops >&2; exit 3', timeout: 10000 }, ctx());
    assert(out.includes('oops'), 'stderr captured in combined output');
    assert(out.includes('exit code: 3'), 'nonzero exit surfaced');
  });

  summary('output-accumulator');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

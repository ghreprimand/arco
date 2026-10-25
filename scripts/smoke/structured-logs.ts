// ARCO_OPS_PLAN.md §B3 — structured file logger smoke.
//
// Tests the PURE logger only — createFileLogger's JSONL format + size-based
// rotation + keep-bound — and the new `logs --journal` arg-parse. NO live
// server, NO :3001: createFileLogger writes to a throwaway temp dir, asserts on
// the files, then tears the dir down. Runs on any platform (sync fs only),
// mirroring scripts/smoke/service-cli.ts.
//
// Run: npm run smoke:structured-logs  (no server needed)

import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { step, assert, assertEq, summary } from './lib.js';
import { createFileLogger } from '../../server/src/server/logger.js';
import { parseServiceArgs } from '../service/unit.js';

function lineCount(file: string): number {
  if (!existsSync(file)) return 0;
  const raw = readFileSync(file, 'utf8');
  return raw.length === 0 ? 0 : raw.trimEnd().split('\n').filter((l) => l.length > 0).length;
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'arco-logs-'));
  try {
    await step('each write is one JSON line with ts/level/msg + merged fields', () => {
      const sub = mkdtempSync(join(tmpdir(), 'arco-logs-fmt-'));
      const log = createFileLogger({ dir: sub });
      try {
        log.write('info', 'hello world', { wfid: 'abc12345', n: 7 });
        log.write('error', 'boom');
        const lines = readFileSync(log.path, 'utf8').trimEnd().split('\n');
        assertEq(lines.length, 2, 'two lines written');
        const a = JSON.parse(lines[0]) as Record<string, unknown>;
        assertEq(typeof a.ts, 'string', 'ts is a string');
        assert(!Number.isNaN(Date.parse(a.ts as string)), 'ts parses as a date (ISO)');
        assertEq(a.level, 'info', 'level info');
        assertEq(a.msg, 'hello world', 'msg preserved');
        assertEq(a.wfid, 'abc12345', 'extra field merged (wfid)');
        assertEq(a.n, 7, 'extra field merged (n)');
        const b = JSON.parse(lines[1]) as Record<string, unknown>;
        assertEq(b.level, 'error', 'second line level error');
        assertEq(b.msg, 'boom', 'second line msg');
      } finally {
        log.close();
        rmSync(sub, { recursive: true, force: true });
      }
    });

    await step('exceeding maxBytes rotates: arco.log.1 appears, live log resets', () => {
      // ~120-byte lines; maxBytes 400 forces a rotation every ~3-4 lines. keep
      // is set high enough that no rotated file rolls off within N lines, so the
      // "every line accounted for" sum below is exact.
      const log = createFileLogger({ dir, maxBytes: 400, keep: 20 });
      const live = join(dir, 'arco.log');
      const rotated1 = join(dir, 'arco.log.1');
      try {
        const N = 20;
        for (let i = 0; i < N; i++) {
          log.write('info', `line number ${i} with some padding to grow the byte count nicely`, { i });
        }
        assert(existsSync(rotated1), 'arco.log.1 exists after rotation');
        // The live log holds only the post-last-rotation tail → strictly fewer
        // than all N lines, and its byte counter was reset below maxBytes.
        const liveLines = lineCount(live);
        assert(liveLines < N, `live log (${liveLines}) holds fewer than all ${N} lines`);
        assert(log.bytesWritten() <= 400, `live byte counter (${log.bytesWritten()}) reset under maxBytes`);

        // Every written line is accounted for across live + all rotated files.
        let total = lineCount(live);
        for (const f of readdirSync(dir)) {
          if (/^arco\.log\.\d+$/.test(f)) total += lineCount(join(dir, f));
        }
        assertEq(total, N, `all ${N} lines accounted for across live + rotated files`);
      } finally {
        log.close();
      }
    });

    await step('keep bound respected: no unbounded .6/.7 rotated files', () => {
      const sub = mkdtempSync(join(tmpdir(), 'arco-logs-keep-'));
      const keep = 3;
      const log = createFileLogger({ dir: sub, maxBytes: 200, keep });
      try {
        // Write far past keep*maxBytes to force many rotations.
        for (let i = 0; i < 200; i++) {
          log.write('info', `padding line ${i} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
        }
        const rotated = readdirSync(sub).filter((f) => /^arco\.log\.\d+$/.test(f));
        assert(rotated.length <= keep, `at most ${keep} rotated files (got ${rotated.length}: ${rotated.join(', ')})`);
        // The highest index must not exceed `keep` (no .4 when keep=3).
        for (const f of rotated) {
          const idx = Number(f.split('.').pop());
          assert(idx >= 1 && idx <= keep, `rotated index ${idx} within [1, ${keep}]`);
        }
      } finally {
        log.close();
        rmSync(sub, { recursive: true, force: true });
      }
    });

    await step('write never throws on a bad dir (best-effort)', () => {
      // A logger whose dir can't be created/written must not throw out of write.
      const log = createFileLogger({ dir: join(dir, 'sub', 'made', 'recursively') });
      try {
        log.write('info', 'should not throw');
      } finally {
        log.close();
      }
    });

    await step('parseServiceArgs handles logs --journal -n N', () => {
      const a = parseServiceArgs(['logs', '--journal', '-n', '100']);
      assertEq(a.command, 'logs', 'command logs');
      assertEq(a.journal, true, '--journal → journal true');
      assertEq(a.lines, 100, '-n 100 → lines 100');
      assert(a.unknown.length === 0, 'no unknown tokens');
      const b = parseServiceArgs(['logs']);
      assertEq(b.journal, false, 'journal defaults false');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  summary('structured-logs');
}

main();

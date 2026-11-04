// Part N4 — Demucs stem-separation smoke.
//
// Imports the server cores DIRECTLY (no server, no WS) so a tsx-watch restart
// can't race it. Two halves:
//
//   PURE (always runs) — validateStemsSpec accepts good / rejects bad model /
//   stem / format; buildDemucsArgs emits the EXACT argv (whitelisted enums +
//   resolved paths only; positional track last; format flag correct).
//
//   REAL demucs (skip-with-notice if absent) — a full separation yields the
//   model's stem set as NEW files flattened into a fresh dir (no nested model
//   subdir); a two-stems split yields <stem> + no_<stem>; an out-of-cwd input is
//   rejected when the N2 fence is locked, accepted when unconfined. Uses **mp3**
//   output (the broadly-working path — wav/flac need torchcodec on some boxes).
//
// Run: npm run smoke:demucs   (no dev server / network needed)

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { step, assert, assertEq, summary } from './lib.js';
import {
  validateStemsSpec,
  buildDemucsArgs,
  runDemucsStems,
  demucsAvailable,
  DemucsError,
} from '../../server/src/media/demucs.js';

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, (err) => (err ? reject(err) : resolve()));
  });
}

function eqArgs(got: string[], want: string[], label: string) {
  assertEq(JSON.stringify(got), JSON.stringify(want), label);
}

async function main() {
  // ── PURE: validateStemsSpec ──
  await step('validateStemsSpec — accepts whitelisted, rejects unknown', () => {
    assertEq(validateStemsSpec({}), null, 'empty (all defaults) ok');
    assertEq(validateStemsSpec({ model: 'htdemucs_6s', twoStems: 'vocals', format: 'mp3' }), null, 'good combo ok');
    assert(validateStemsSpec({ model: 'evil' }) !== null, 'bad model rejected');
    assert(validateStemsSpec({ twoStems: 'guitar' }) !== null, 'bad two-stems rejected');
    assert(validateStemsSpec({ format: 'aiff' }) !== null, 'bad format rejected');
  });

  // ── PURE: buildDemucsArgs ──
  await step('buildDemucsArgs — exact argv (enums + paths only; track last)', () => {
    eqArgs(
      buildDemucsArgs('htdemucs', undefined, 'mp3', '/out', '/in.wav'),
      ['-o', '/out', '-n', 'htdemucs', '--filename', '{stem}.{ext}', '--mp3', '/in.wav'],
      'default mp3 full separation',
    );
    eqArgs(
      buildDemucsArgs('htdemucs', 'vocals', 'flac', '/out', '/in.wav'),
      ['-o', '/out', '-n', 'htdemucs', '--filename', '{stem}.{ext}', '--flac', '--two-stems', 'vocals', '/in.wav'],
      'two-stems flac',
    );
    eqArgs(
      buildDemucsArgs('mdx_extra_q', undefined, 'wav', '/out', '/in.wav'),
      ['-o', '/out', '-n', 'mdx_extra_q', '--filename', '{stem}.{ext}', '/in.wav'],
      'wav has no format flag',
    );
  });

  // ── REAL demucs ──
  const have = await demucsAvailable();
  if (!have) {
    await step('SKIP real stem separation — demucs not on PATH', () => assert(true, 'skipped (no demucs)'));
    summary('demucs');
    return;
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-n4-cwd-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-n4-outside-'));
  try {
    // A tiny mixed-ish fixture (a short tone is enough — we assert the stem SET +
    // file layout + the fence, not separation quality).
    const track = path.join(cwd, 'song.wav');
    await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', track]);

    await step('full separation → stem set as NEW files, flattened (no model subdir)', async () => {
      const r = await runDemucsStems(cwd, 'song.wav', { format: 'mp3', unconfined: false });
      assert(r.ok, `ok (got ${r.code ?? 'ok'}: ${r.error ?? ''})`);
      const names = (r.stems ?? []).map((s) => s.name).sort();
      assertEq(JSON.stringify(names), JSON.stringify(['bass', 'drums', 'other', 'vocals']), `4-stem set, got ${names.join(',')}`);
      // Flattened: every stem file sits directly in the stems dir (no nested dir).
      for (const s of r.stems ?? []) {
        assertEq(path.dirname(s.path), r.dir, `${s.name} is flat in the stems dir`);
        const st = await fs.stat(s.path);
        assert(st.isFile() && st.size > 0, `${s.name} is a non-empty file`);
        assert(!!s.relPath, `${s.name} has a relPath (in-cwd reveal)`);
      }
      const subdirs = (await fs.readdir(r.dir!, { withFileTypes: true })).filter((e) => e.isDirectory());
      assertEq(subdirs.length, 0, 'no leftover model subdir');
    });

    await step('two-stems split → <stem> + no_<stem>', async () => {
      const r = await runDemucsStems(cwd, 'song.wav', { format: 'mp3', twoStems: 'vocals', unconfined: false });
      assert(r.ok, `ok (got ${r.code ?? 'ok'}: ${r.error ?? ''})`);
      const names = (r.stems ?? []).map((s) => s.name).sort();
      assertEq(JSON.stringify(names), JSON.stringify(['no_vocals', 'vocals']), `2-stem set, got ${names.join(',')}`);
    });

    await step('a fresh dir is created per run (never clobbers a prior one)', async () => {
      const r1 = await runDemucsStems(cwd, 'song.wav', { format: 'mp3', unconfined: false });
      const r2 = await runDemucsStems(cwd, 'song.wav', { format: 'mp3', unconfined: false });
      assert(r1.dir !== r2.dir, 'two runs land in distinct dirs');
    });

    await step('CONFINED stems on an out-of-cwd input is REJECTED (bad-path)', async () => {
      const stray = path.join(outside, 'stray.wav');
      await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1', stray]);
      let code: string | undefined;
      try {
        await runDemucsStems(cwd, stray, { format: 'mp3', unconfined: false });
      } catch (e) { code = e instanceof DemucsError ? e.code : 'other'; }
      assertEq(code, 'bad-path', 'locked fence rejects the out-of-cwd input');
      // And UNCONFINED honors it.
      const r = await runDemucsStems(cwd, stray, { format: 'mp3', unconfined: true, allowedRoots: [outside] });
      assert(r.ok && (r.stems?.length ?? 0) > 0, 'unconfined out-of-cwd separation runs');
    });

    await step('output-dir-missing — a non-existent destination is rejected', async () => {
      let code: string | undefined;
      try {
        await runDemucsStems(cwd, 'song.wav', { format: 'mp3', unconfined: true, output: { dir: path.join(cwd, 'nope') } });
      } catch (e) { code = e instanceof DemucsError ? e.code : 'other'; }
      assertEq(code, 'output-dir-missing', 'missing output dir rejected');
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }

  summary('demucs');
}

void main();

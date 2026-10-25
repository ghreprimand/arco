// Part N2 — Media scratch + access-fence smoke.
//
// Imports the server cores DIRECTLY (no server, no WS) so a tsx-watch restart
// can't race it. Asserts the security-critical N2 surface:
//
//   (a) RESOLVER — resolveMediaInput gates by tier. Confined (unconfined:false)
//       ALLOWS an in-cwd path, REJECTS an out-of-cwd / absolute path. Unconfined
//       (true) ALLOWS the same absolute path. A scratch path is ALWAYS allowed
//       regardless of the fence.
//   (b) SCRATCH — sanitizeScratchBasename rejects traversal / flag / separator
//       names; saveScratchUpload writes the bytes under a fresh dir AND rejects a
//       bad ?name=. isWithinScratch is true for the written path.
//   (c) OUTPUT NAMING — outputBasenameFor honors an operator name but FORCES the
//       op's target extension; targetOutputExt is correct per op.
//   (d) REAL ffmpeg (skip-with-notice if absent): an op on a SCRATCH file runs
//       even with the fence LOCKED; an op on an absolute out-of-cwd file runs
//       only when UNCONFINED and is rejected when CONFINED; an explicit output
//       dir is honored; the output is a NEW file, never the source.
//
// Run: npm run smoke:media-scratch   (no dev server / network needed)

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { step, assert, assertEq, summary } from './lib.js';
import {
  resolveMediaInput,
  outputBasenameFor,
  targetOutputExt,
  runMediaOp,
  ffmpegAvailable,
  probeAudioCodec,
  MediaOpError,
  type MediaAccess,
} from '../../server/src/media/ffmpeg.js';
import {
  isWithinScratch,
  sanitizeScratchBasename,
  saveScratchUpload,
  SCRATCH_ROOT,
  ScratchError,
} from '../../server/src/media/scratch.js';

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, (err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  // ── (a) RESOLVER tiers ──
  await step('resolveMediaInput — confined allows in-cwd, rejects out-of-cwd', () => {
    const cwd = '/tmp/archon-cwd';
    const confined: MediaAccess = { cwd, unconfined: false };
    assertEq(resolveMediaInput(confined, 'sub/in.wav'), path.join(cwd, 'sub/in.wav'), 'in-cwd relative resolves');
    for (const bad of ['../../../etc/passwd', '/etc/hosts']) {
      let code: string | undefined;
      try { resolveMediaInput(confined, bad); } catch (e) { code = e instanceof MediaOpError ? e.code : 'other'; }
      assertEq(code, 'bad-path', `confined rejects "${bad}"`);
    }
  });

  await step('resolveMediaInput — unconfined allows an absolute out-of-cwd path', () => {
    const open: MediaAccess = { cwd: '/tmp/archon-cwd', unconfined: true };
    assertEq(resolveMediaInput(open, '/srv/media/clip.mp4'), '/srv/media/clip.mp4', 'unconfined allows /srv path');
  });

  await step('resolveMediaInput — a scratch path is allowed even when CONFINED', () => {
    const scratchAbs = path.join(SCRATCH_ROOT, 'abc-123', 'imported.ogg');
    const confined: MediaAccess = { cwd: '/tmp/archon-cwd', unconfined: false };
    assertEq(resolveMediaInput(confined, scratchAbs), scratchAbs, 'scratch path clears the fence');
    assert(isWithinScratch(scratchAbs), 'isWithinScratch true for a path under the root');
    assert(!isWithinScratch('/tmp/elsewhere/x.ogg'), 'isWithinScratch false outside the root');
  });

  // ── (b) SCRATCH basename + upload ──
  await step('sanitizeScratchBasename — rejects traversal / separators / flags', () => {
    for (const bad of ['../evil', 'a/b.wav', '..', '-rf', 'x\0y', '']) {
      assertEq(sanitizeScratchBasename(bad), null, `rejects "${bad.replace(/\0/g, '\\0')}"`);
    }
    assertEq(sanitizeScratchBasename('song take 1.wav'), 'song take 1.wav', 'accepts a normal name');
  });

  await step('saveScratchUpload — writes bytes under a fresh dir; bad ?name= rejected', async () => {
    const bytes = Buffer.from('hello-scratch-bytes');
    const r = await saveScratchUpload(Readable.from(bytes), 'note.bin');
    assert(isWithinScratch(r.path), 'written path is inside the scratch root');
    assertEq(r.basename, 'note.bin', 'sanitized basename preserved');
    assertEq(r.bytes, bytes.length, 'byte count matches');
    const onDisk = await fs.readFile(r.path);
    assert(onDisk.equals(bytes), 'on-disk bytes match the upload');
    await fs.rm(path.dirname(r.path), { recursive: true, force: true });

    let code: string | undefined;
    try { await saveScratchUpload(Readable.from(Buffer.from('x')), '../escape'); }
    catch (e) { code = e instanceof ScratchError ? e.code : 'other'; }
    assertEq(code, 'bad-name', 'an unsafe ?name= is rejected with bad-name');
  });

  // ── (c) OUTPUT NAMING ──
  await step('outputBasenameFor — operator name keeps stem, forces the op ext', () => {
    assertEq(targetOutputExt('in.wav', { op: 'convert', format: 'mp3' }), '.mp3', 'convert target ext');
    assertEq(targetOutputExt('in.mkv', { op: 'vclip', inSec: 0, outSec: 1 }), '.mkv', 'vclip keeps source ext');
    assertEq(outputBasenameFor('take', 'in.wav', { op: 'convert', format: 'mp3' }), 'take.mp3', 'no ext → forced .mp3');
    assertEq(outputBasenameFor('take.wav', 'in.wav', { op: 'convert', format: 'mp3' }), 'take.mp3', 'wrong ext → corrected');
    assertEq(outputBasenameFor(undefined, 'in.wav', { op: 'convert', format: 'mp3' }), 'in.convert.mp3', 'blank → derived');
    assertEq(outputBasenameFor('../evil', 'in.wav', { op: 'convert', format: 'mp3' }), null, 'unsafe name → null');
  });

  // ── (d) REAL ffmpeg ──
  const haveFfmpeg = await ffmpegAvailable();
  if (!haveFfmpeg) {
    await step('SKIP real scratch/unconfined ops — ffmpeg not on PATH', () => assert(true, 'skipped (no ffmpeg)'));
    summary('media-scratch');
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-n2-cwd-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-n2-outside-'));
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-n2-dest-'));
  let scratchDir: string | null = null;
  try {
    // A fixture OUTSIDE the workflow cwd (stand-in for an SMB-mounted file).
    const outsideFixture = path.join(outside, 'song.wav');
    await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', outsideFixture]);

    await step('CONFINED op on an out-of-cwd absolute path is REJECTED (bad-path)', async () => {
      let code: string | undefined;
      try {
        await runMediaOp(cwd, outsideFixture, { op: 'convert', format: 'mp3' }, { unconfined: false });
      } catch (e) { code = e instanceof MediaOpError ? e.code : 'other'; }
      assertEq(code, 'bad-path', 'locked fence rejects the absolute out-of-cwd input');
    });

    await step('UNCONFINED op on the same path runs; output dir + name honored', async () => {
      const r = await runMediaOp(
        cwd, outsideFixture,
        { op: 'convert', format: 'mp3', bitrate: '128k' },
        { unconfined: true, output: { dir: dest, basename: 'mytake' } },
      );
      assert(r.outputPath !== outsideFixture, 'output is a NEW file, never the source');
      assertEq(path.dirname(r.outputPath), dest, 'output landed in the chosen dir');
      assertEq(path.basename(r.outputPath), 'mytake.mp3', 'operator name + forced ext');
      assertEq(r.relPath, '', 'no relPath for an out-of-cwd output');
      const codec = await probeAudioCodec(r.outputPath);
      assertEq(codec, 'mp3', `output is mp3, got ${codec}`);
    });

    await step('SCRATCH op runs even with the fence LOCKED (no cwd needed)', async () => {
      const wav = await fs.readFile(outsideFixture);
      const up = await saveScratchUpload(Readable.from(wav), 'imported.wav');
      scratchDir = path.dirname(up.path);
      // cwd='' + unconfined:false — only the scratch tier can clear this.
      const r = await runMediaOp('', up.path, { op: 'convert', format: 'mp3' }, { unconfined: false });
      assert(isWithinScratch(r.outputPath), 'scratch op output stays in scratch by default');
      const st = await fs.stat(r.outputPath);
      assert(st.isFile() && st.size > 0, 'scratch op produced a non-empty file');
    });

    await step('output-dir-missing — a non-existent destination is rejected', async () => {
      let code: string | undefined;
      try {
        await runMediaOp(cwd, outsideFixture, { op: 'convert', format: 'mp3' },
          { unconfined: true, output: { dir: path.join(dest, 'does-not-exist') } });
      } catch (e) { code = e instanceof MediaOpError ? e.code : 'other'; }
      assertEq(code, 'output-dir-missing', 'a missing output dir is rejected');
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
    await fs.rm(dest, { recursive: true, force: true });
    if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true });
  }

  summary('media-scratch');
}

void main();

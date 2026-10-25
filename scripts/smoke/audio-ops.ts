// Workbench Expansion H6 — Audio ops (FFmpeg) smoke.
//
// Imports the server cores from ../media/ffmpeg.ts DIRECTLY (no server, no WS) so
// a tsx-watch restart can't race it. Asserts:
//
//   (a) buildArgs — the EXACT argv for clip + convert + resample (PURE, no I/O).
//       This is the security-critical core: typed spec → argv, fixed binary, no
//       shell, no operator-string concatenation. The director's gate.
//   (b) validateSpec — rejects in≥out, unknown format, bad fade.
//   (c) PATH ESCAPE — runAudioOp REJECTS an out-of-cwd input path (the security
//       assertion; passes regardless of ffmpeg presence).
//   (d) Real ffmpeg (skip-with-notice if absent): generate a fixture WAV, run a
//       CLIP (assert output exists + ffprobe duration ≈ requested) and a CONVERT
//       WAV→MP3 (assert output exists + codec is mp3 via ffprobe). Assert the
//       output is a NEW file, never the source.
//
// Run: npm run smoke:audio-ops   (no dev server / network needed)

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { step, assert, assertEq, summary } from './lib.js';
import {
  buildArgs,
  validateSpec,
  deriveOutputBasename,
  runAudioOp,
  ffmpegAvailable,
  probeDurationSec,
  probeAudioCodec,
  MediaOpError,
} from '../../server/src/media/ffmpeg.js';
import type { MediaOpSpec } from '@arco/shared';

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, (err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  await step('buildArgs(clip) → exact argv (seek/duration + stream copy, no shell)', () => {
    const spec: MediaOpSpec = { op: 'clip', inSec: 10, outSec: 20 };
    const argv = buildArgs(spec, '/cwd/in.wav', '/cwd/in.clip.wav');
    assertEq(
      JSON.stringify(argv),
      JSON.stringify(['-nostdin', '-n', '-i', '/cwd/in.wav', '-ss', '10', '-to', '20', '-c', 'copy', '/cwd/in.clip.wav']),
      'clip argv',
    );
    // Every element is a discrete arg — nothing a shell could parse.
    assert(argv.every((a) => typeof a === 'string'), 'all argv elements are strings');
  });

  await step('buildArgs(convert) → exact argv (codec from whitelist + bounded bitrate)', () => {
    const spec: MediaOpSpec = { op: 'convert', format: 'mp3', bitrate: '192k' };
    const argv = buildArgs(spec, '/cwd/in.wav', '/cwd/in.convert.mp3');
    assertEq(
      JSON.stringify(argv),
      JSON.stringify(['-nostdin', '-n', '-i', '/cwd/in.wav', '-c:a', 'libmp3lame', '-b:a', '192k', '/cwd/in.convert.mp3']),
      'convert argv',
    );
  });

  await step('buildArgs(resample) → exact argv', () => {
    const spec: MediaOpSpec = { op: 'resample', hz: 44100 };
    const argv = buildArgs(spec, '/cwd/in.wav', '/cwd/out.wav');
    assertEq(
      JSON.stringify(argv),
      JSON.stringify(['-nostdin', '-n', '-i', '/cwd/in.wav', '-ar', '44100', '/cwd/out.wav']),
      'resample argv',
    );
  });

  await step('validateSpec rejects in≥out, unknown format, empty fade', () => {
    assert(validateSpec({ op: 'clip', inSec: 20, outSec: 10 }) !== null, 'in>out rejected');
    assert(validateSpec({ op: 'clip', inSec: 5, outSec: 5 }) !== null, 'in==out rejected');
    // @ts-expect-error — deliberately bad format to exercise the runtime guard.
    assert(validateSpec({ op: 'convert', format: 'exe' }) !== null, 'unknown format rejected');
    assert(validateSpec({ op: 'fade' }) !== null, 'fade with no in/out rejected');
    assertEq(validateSpec({ op: 'clip', inSec: 0, outSec: 1 }), null, 'a valid clip passes');
  });

  await step('deriveOutputBasename never equals the source name', () => {
    assertEq(deriveOutputBasename('song.wav', { op: 'clip', inSec: 0, outSec: 1 }), 'song.clip.wav', 'clip keeps ext');
    assertEq(deriveOutputBasename('song.wav', { op: 'convert', format: 'mp3' }), 'song.convert.mp3', 'convert swaps ext');
    assert(deriveOutputBasename('song.wav', { op: 'normalize' }) !== 'song.wav', 'output differs from source');
  });

  // ── SECURITY: out-of-cwd input is REJECTED (independent of ffmpeg) ──
  await step('runAudioOp REJECTS an out-of-cwd input path', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-audio-cwd-'));
    try {
      let code: string | undefined;
      try {
        await runAudioOp(cwd, '../../../etc/passwd', { op: 'convert', format: 'mp3' });
      } catch (err) {
        code = err instanceof MediaOpError ? err.code : 'non-media-error';
      }
      assertEq(code, 'bad-path', 'a ../ traversal input must be rejected with bad-path');

      // An absolute path outside cwd is likewise rejected.
      let code2: string | undefined;
      try {
        await runAudioOp(cwd, '/etc/hosts', { op: 'convert', format: 'mp3' });
      } catch (err) {
        code2 = err instanceof MediaOpError ? err.code : 'non-media-error';
      }
      assertEq(code2, 'bad-path', 'an absolute-outside-cwd input must be rejected with bad-path');
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  // ── REAL ffmpeg: clip + convert on a generated fixture ──
  const haveFfmpeg = await ffmpegAvailable();
  if (!haveFfmpeg) {
    await step('SKIP real clip/convert — ffmpeg not on PATH (install per docs/OPERATIONS.md)', () => {
      assert(true, 'skipped (no ffmpeg)');
    });
  } else {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-audio-run-'));
    try {
      // Generate a 3s 440Hz sine WAV fixture.
      const fixture = path.join(cwd, 'fixture.wav');
      await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', fixture]);
      const fixtureDur = await probeDurationSec(fixture);
      assert(fixtureDur !== null && fixtureDur > 2.5 && fixtureDur < 3.5, `fixture ~3s, got ${fixtureDur}`);

      await step('CLIP 0.5–2.0s of the fixture → ~1.5s output (new file, not the source)', async () => {
        const r = await runAudioOp(cwd, 'fixture.wav', { op: 'clip', inSec: 0.5, outSec: 2.0 });
        assert(r.outputPath !== fixture, 'output is a NEW file, never the source');
        const st = await fs.stat(r.outputPath);
        assert(st.isFile() && st.size > 0, 'clip output exists and is non-empty');
        const dur = await probeDurationSec(r.outputPath);
        assert(dur !== null && Math.abs(dur - 1.5) < 0.25, `clip duration ≈ 1.5s, got ${dur}`);
        assertEq(path.basename(r.outputPath), 'fixture.clip.wav', 'derived output name');
      });

      await step('CONVERT fixture WAV → MP3 (valid mp3 via ffprobe)', async () => {
        const r = await runAudioOp(cwd, 'fixture.wav', { op: 'convert', format: 'mp3', bitrate: '128k' });
        const st = await fs.stat(r.outputPath);
        assert(st.isFile() && st.size > 0, 'mp3 output exists and is non-empty');
        const codec = await probeAudioCodec(r.outputPath);
        assertEq(codec, 'mp3', `output codec is mp3, got ${codec}`);
        assertEq(path.extname(r.outputPath), '.mp3', 'output has .mp3 extension');
      });

      await step('runAudioOp REJECTS a missing input file (input-missing)', async () => {
        let code: string | undefined;
        try {
          await runAudioOp(cwd, 'nope.wav', { op: 'convert', format: 'mp3' });
        } catch (err) {
          code = err instanceof MediaOpError ? err.code : 'non-media-error';
        }
        assertEq(code, 'input-missing', 'a missing input is rejected with input-missing');
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }

  summary('audio-ops');
}

main();

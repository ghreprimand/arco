// Workbench Expansion H7 — Video ops (FFmpeg) smoke.
//
// Imports the server cores from ../media/ffmpeg.ts DIRECTLY (no server, no WS) so
// a tsx-watch restart can't race it. Asserts:
//
//   (a) buildArgs — the EXACT argv for vclip + vconvert + extract-audio (PURE,
//       no I/O). The security-critical core: typed spec → argv, fixed binary, no
//       shell, no operator-string concatenation, resolution → a FIXED scale
//       filter we control. The director's gate.
//   (b) validateSpec — rejects in≥out, unknown container/codec, bad resolution.
//   (c) PATH ESCAPE — runVideoOp REJECTS an out-of-cwd input path (the security
//       assertion; passes regardless of ffmpeg presence).
//   (d) Real ffmpeg (skip-with-notice if absent): generate a 2s testsrc+sine MP4
//       fixture, run a VCLIP (assert output exists + ffprobe duration ≈ requested),
//       a VCONVERT MP4→WebM (assert output exists + VP9 video codec via ffprobe),
//       and an EXTRACT-AUDIO → mp3 (assert an audio-only file: audio codec mp3,
//       NO video stream). Outputs are NEW files, never the source.
//
// Run: npm run smoke:video-ops   (no dev server / network needed)

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { step, assert, assertEq, summary } from './lib.js';
import {
  buildArgs,
  validateSpec,
  deriveOutputBasename,
  runVideoOp,
  ffmpegAvailable,
  probeDurationSec,
  probeAudioCodec,
  probeVideoCodec,
  MediaOpError,
} from '../../server/src/media/ffmpeg.js';
import type { MediaOpSpec } from '@archon/shared';

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, (err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  await step('buildArgs(vclip) → exact argv (seek window + stream copy, no shell)', () => {
    const spec: MediaOpSpec = { op: 'vclip', inSec: 5, outSec: 12 };
    const argv = buildArgs(spec, '/cwd/in.mp4', '/cwd/in.clip.mp4');
    assertEq(
      JSON.stringify(argv),
      JSON.stringify(['-nostdin', '-n', '-i', '/cwd/in.mp4', '-ss', '5', '-to', '12', '-c', 'copy', '/cwd/in.clip.mp4']),
      'vclip (stream-copy) argv',
    );
    assert(argv.every((a) => typeof a === 'string'), 'all argv elements are strings');
  });

  await step('buildArgs(vclip reencode) → exact argv (no -c copy)', () => {
    const spec: MediaOpSpec = { op: 'vclip', inSec: 5, outSec: 12, reencode: true };
    const argv = buildArgs(spec, '/cwd/in.mp4', '/cwd/in.clip.mp4');
    assertEq(
      JSON.stringify(argv),
      JSON.stringify(['-nostdin', '-n', '-i', '/cwd/in.mp4', '-ss', '5', '-to', '12', '/cwd/in.clip.mp4']),
      'vclip (re-encode) argv',
    );
  });

  await step('buildArgs(vconvert) → exact argv (codecs from whitelist + fixed scale filter)', () => {
    const spec: MediaOpSpec = { op: 'vconvert', format: 'webm', resolution: '720p' };
    const argv = buildArgs(spec, '/cwd/in.mp4', '/cwd/in.convert.webm');
    assertEq(
      JSON.stringify(argv),
      JSON.stringify(['-nostdin', '-n', '-i', '/cwd/in.mp4', '-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-vf', 'scale=-2:720', '/cwd/in.convert.webm']),
      'vconvert argv (container default codecs + 720p scale)',
    );
  });

  await step('buildArgs(vconvert) → explicit {w,h} composes scale we control', () => {
    const spec: MediaOpSpec = { op: 'vconvert', format: 'mp4', resolution: { w: 640, h: 360 }, vcodec: 'libx265' };
    const argv = buildArgs(spec, '/cwd/in.mov', '/cwd/in.convert.mp4');
    assertEq(
      JSON.stringify(argv),
      JSON.stringify(['-nostdin', '-n', '-i', '/cwd/in.mov', '-c:v', 'libx265', '-c:a', 'aac', '-vf', 'scale=640:360', '/cwd/in.convert.mp4']),
      'vconvert argv (vcodec override + explicit wh)',
    );
  });

  await step('buildArgs(extract-audio) → exact argv (-vn + whitelisted codec, optional span)', () => {
    const noSpan: MediaOpSpec = { op: 'extract-audio', format: 'mp3' };
    assertEq(
      JSON.stringify(buildArgs(noSpan, '/cwd/in.mp4', '/cwd/in.audio.mp3')),
      JSON.stringify(['-nostdin', '-n', '-i', '/cwd/in.mp4', '-vn', '-c:a', 'libmp3lame', '/cwd/in.audio.mp3']),
      'extract-audio argv (no span)',
    );
    const span: MediaOpSpec = { op: 'extract-audio', format: 'wav', inSec: 1, outSec: 3 };
    assertEq(
      JSON.stringify(buildArgs(span, '/cwd/in.mp4', '/cwd/in.audio.wav')),
      JSON.stringify(['-nostdin', '-n', '-i', '/cwd/in.mp4', '-ss', '1', '-to', '3', '-vn', '-c:a', 'pcm_s16le', '/cwd/in.audio.wav']),
      'extract-audio argv (with span)',
    );
  });

  await step('validateSpec rejects bad video specs, accepts good ones', () => {
    assert(validateSpec({ op: 'vclip', inSec: 12, outSec: 5 }) !== null, 'vclip in>out rejected');
    assert(validateSpec({ op: 'vclip', inSec: 5, outSec: 5 }) !== null, 'vclip in==out rejected');
    // @ts-expect-error — deliberately bad container.
    assert(validateSpec({ op: 'vconvert', format: 'exe' }) !== null, 'unknown container rejected');
    // @ts-expect-error — deliberately bad vcodec (not in the whitelist).
    assert(validateSpec({ op: 'vconvert', format: 'mp4', vcodec: 'rm -rf' }) !== null, 'unknown vcodec rejected');
    // @ts-expect-error — deliberately bad resolution preset.
    assert(validateSpec({ op: 'vconvert', format: 'mp4', resolution: '4k; rm' }) !== null, 'bad res preset rejected');
    assert(validateSpec({ op: 'vconvert', format: 'mp4', resolution: { w: 0, h: 480 } }) !== null, 'res w<=0 rejected');
    assert(validateSpec({ op: 'vconvert', format: 'mp4', resolution: { w: 1.5, h: 480 } }) !== null, 'res non-integer rejected');
    assert(validateSpec({ op: 'vconvert', format: 'mp4', resolution: { w: 999999, h: 480 } }) !== null, 'res over cap rejected');
    // @ts-expect-error — bad audio format for extract.
    assert(validateSpec({ op: 'extract-audio', format: 'exe' }) !== null, 'extract-audio bad format rejected');
    assert(validateSpec({ op: 'extract-audio', format: 'mp3', inSec: 3, outSec: 1 }) !== null, 'extract-audio in>out rejected');
    // Good ones pass.
    assertEq(validateSpec({ op: 'vclip', inSec: 0, outSec: 1 }), null, 'a valid vclip passes');
    assertEq(validateSpec({ op: 'vconvert', format: 'webm', resolution: '1080p' }), null, 'a valid vconvert passes');
    assertEq(validateSpec({ op: 'vconvert', format: 'mp4', resolution: { w: 1280, h: 720 } }), null, 'a valid wh vconvert passes');
    assertEq(validateSpec({ op: 'extract-audio', format: 'mp3' }), null, 'a valid extract-audio passes');
  });

  await step('deriveOutputBasename picks the right target ext per video op', () => {
    assertEq(deriveOutputBasename('movie.mp4', { op: 'vclip', inSec: 0, outSec: 1 }), 'movie.clip.mp4', 'vclip keeps source ext');
    assertEq(deriveOutputBasename('movie.mp4', { op: 'vconvert', format: 'webm' }), 'movie.convert.webm', 'vconvert swaps to container ext');
    assertEq(deriveOutputBasename('movie.mp4', { op: 'extract-audio', format: 'mp3' }), 'movie.audio.mp3', 'extract-audio uses audio ext');
    assert(deriveOutputBasename('movie.mp4', { op: 'vconvert', format: 'webm' }) !== 'movie.mp4', 'output differs from source');
  });

  // ── SECURITY: out-of-cwd input is REJECTED (independent of ffmpeg) ──
  await step('runVideoOp REJECTS an out-of-cwd input path', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-video-cwd-'));
    try {
      let code: string | undefined;
      try {
        await runVideoOp(cwd, '../../../etc/passwd', { op: 'vconvert', format: 'webm' });
      } catch (err) {
        code = err instanceof MediaOpError ? err.code : 'non-media-error';
      }
      assertEq(code, 'bad-path', 'a ../ traversal input must be rejected with bad-path');

      let code2: string | undefined;
      try {
        await runVideoOp(cwd, '/etc/hosts', { op: 'vconvert', format: 'webm' });
      } catch (err) {
        code2 = err instanceof MediaOpError ? err.code : 'non-media-error';
      }
      assertEq(code2, 'bad-path', 'an absolute-outside-cwd input must be rejected with bad-path');
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  // ── REAL ffmpeg: vclip + vconvert + extract-audio on a generated fixture ──
  const haveFfmpeg = await ffmpegAvailable();
  if (!haveFfmpeg) {
    await step('SKIP real vclip/vconvert/extract-audio — ffmpeg not on PATH (install per docs/OPERATIONS.md)', () => {
      assert(true, 'skipped (no ffmpeg)');
    });
  } else {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-video-run-'));
    try {
      // Generate a 2s 320x240 testsrc video + 440Hz sine audio MP4 fixture.
      const fixture = path.join(cwd, 'fixture.mp4');
      await run('ffmpeg', [
        '-nostdin', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
        fixture,
      ]);
      const fixtureDur = await probeDurationSec(fixture);
      assert(fixtureDur !== null && fixtureDur > 1.5 && fixtureDur < 2.6, `fixture ~2s, got ${fixtureDur}`);
      assert((await probeVideoCodec(fixture)) === 'h264', 'fixture has an h264 video stream');

      await step('VCLIP 0.5–1.5s (re-encode for frame accuracy) → ~1s output (new file)', async () => {
        // Re-encode so the cut is frame-accurate and ffprobe reports a tight
        // duration (stream-copy snaps to keyframes → looser on a 2s clip).
        const r = await runVideoOp(cwd, 'fixture.mp4', { op: 'vclip', inSec: 0.5, outSec: 1.5, reencode: true });
        assert(r.outputPath !== fixture, 'output is a NEW file, never the source');
        const st = await fs.stat(r.outputPath);
        assert(st.isFile() && st.size > 0, 'clip output exists and is non-empty');
        const dur = await probeDurationSec(r.outputPath);
        assert(dur !== null && Math.abs(dur - 1.0) < 0.35, `clip duration ≈ 1.0s, got ${dur}`);
        assertEq(path.basename(r.outputPath), 'fixture.clip.mp4', 'derived output name keeps container');
      });

      await step('VCONVERT MP4 → WebM (VP9 video codec via ffprobe)', async () => {
        const r = await runVideoOp(cwd, 'fixture.mp4', { op: 'vconvert', format: 'webm' });
        const st = await fs.stat(r.outputPath);
        assert(st.isFile() && st.size > 0, 'webm output exists and is non-empty');
        assertEq(path.extname(r.outputPath), '.webm', 'output has .webm extension');
        const vcodec = await probeVideoCodec(r.outputPath);
        assertEq(vcodec, 'vp9', `output video codec is vp9, got ${vcodec}`);
      });

      await step('EXTRACT-AUDIO → mp3 (audio-only: mp3 codec, NO video stream)', async () => {
        const r = await runVideoOp(cwd, 'fixture.mp4', { op: 'extract-audio', format: 'mp3' });
        const st = await fs.stat(r.outputPath);
        assert(st.isFile() && st.size > 0, 'audio output exists and is non-empty');
        assertEq(path.extname(r.outputPath), '.mp3', 'output has .mp3 extension');
        const acodec = await probeAudioCodec(r.outputPath);
        assertEq(acodec, 'mp3', `output audio codec is mp3, got ${acodec}`);
        // ffprobe of the video stream returns null when there is no video stream.
        const vcodec = await probeVideoCodec(r.outputPath);
        assert(vcodec === null, `extract-audio output has NO video stream, got ${vcodec}`);
        assertEq(path.basename(r.outputPath), 'fixture.audio.mp3', 'derived audio output name');
      });

      await step('runVideoOp REJECTS a missing input file (input-missing)', async () => {
        let code: string | undefined;
        try {
          await runVideoOp(cwd, 'nope.mp4', { op: 'vconvert', format: 'webm' });
        } catch (err) {
          code = err instanceof MediaOpError ? err.code : 'non-media-error';
        }
        assertEq(code, 'input-missing', 'a missing input is rejected with input-missing');
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }

  summary('video-ops');
}

main();

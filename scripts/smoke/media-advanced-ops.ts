// Part N3 — Advanced ffmpeg ops smoke (framegrab/gif · geometry/speed/gain ·
// spectrogram · join/swap · inspect).
//
// Imports the server cores DIRECTLY (no server, no WS) so a tsx-watch restart
// can't race it. Two halves:
//
//   PURE (always runs) — validateSpec accepts good specs + rejects out-of-range
//   numbers / bad enums / malformed multi-input specs; buildArgs emits the EXACT
//   argv per op (no operator string ever lands anywhere but a validated slot);
//   targetOutputExt is correct for the new media-producing ops.
//
//   REAL ffmpeg (skip-with-notice if absent) — each op produces a correct output
//   on a generated fixture; inspect returns curated stream facts and writes NO
//   file; a join whose EXTRA input is out-of-cwd is rejected when the fence is
//   locked (the multi-input path obeys the same N2 access fence as the primary).
//
// Run: npm run smoke:media-advanced-ops   (no dev server / network needed)

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { step, assert, assertEq, summary } from './lib.js';
import {
  validateSpec,
  buildArgs,
  targetOutputExt,
  runMediaOp,
  inspectMedia,
  ffmpegAvailable,
  ffprobeAvailable,
  probeDurationSec,
  MediaOpError,
  type MediaAccess,
} from '../../server/src/media/ffmpeg.js';
import type { MediaOpSpec } from '@arco/shared';

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, (err) => (err ? reject(err) : resolve()));
  });
}

// Exact-argv equality (order matters — ffmpeg argv is positional).
function eqArgs(got: string[], want: string[], label: string) {
  assertEq(JSON.stringify(got), JSON.stringify(want), label);
}

async function main() {
  // ── PURE: validateSpec — good specs accepted ──
  await step('validateSpec — the new ops accept well-formed specs', () => {
    const ok: MediaOpSpec[] = [
      { op: 'framegrab', atSec: 1.5, format: 'png' },
      { op: 'gif', inSec: 0, outSec: 2, fps: 12, width: 320, format: 'gif' },
      { op: 'geometry', xform: { kind: 'crop', w: 100, h: 50, x: 10, y: 5 } },
      { op: 'geometry', xform: { kind: 'rotate', degrees: 90 } },
      { op: 'geometry', xform: { kind: 'resize', resolution: '720p' } },
      { op: 'speed', factor: 2, video: true },
      { op: 'gain', db: -6 },
      { op: 'spectrogram', width: 1280, height: 480 },
      { op: 'join', extraInputs: ['b.mp4'], video: true },
      { op: 'swap', action: { kind: 'mute' } },
      { op: 'swap', action: { kind: 'replace', audioPath: 'voice.mp3' } },
    ];
    for (const s of ok) assertEq(validateSpec(s), null, `accepts ${s.op}`);
  });

  // ── PURE: validateSpec — malformed specs rejected ──
  await step('validateSpec — rejects out-of-range numbers / bad enums / malformed', () => {
    const bad: MediaOpSpec[] = [
      { op: 'framegrab', atSec: -1, format: 'png' },
      { op: 'framegrab', atSec: 0, format: 'tiff' as never },
      { op: 'gif', inSec: 2, outSec: 1 },
      { op: 'gif', inSec: 0, outSec: 2, fps: 999 },
      { op: 'geometry', xform: { kind: 'crop', w: 0, h: 50, x: 0, y: 0 } },
      { op: 'geometry', xform: { kind: 'crop', w: 10, h: 10, x: -5, y: 0 } },
      { op: 'geometry', xform: { kind: 'rotate', degrees: 45 as never } },
      { op: 'speed', factor: 99, video: true },
      { op: 'speed', factor: 2, video: 'yes' as never },
      { op: 'gain', db: 999 },
      { op: 'spectrogram', width: -10 },
      { op: 'join', extraInputs: [], video: true },
      { op: 'join', extraInputs: ['x'], video: 'no' as never },
      { op: 'swap', action: { kind: 'replace' } as never },
    ];
    for (const s of bad) assert(validateSpec(s) !== null, `rejects ${JSON.stringify(s).slice(0, 60)}`);
  });

  // ── PURE: buildArgs — exact argv ──
  await step('buildArgs — framegrab seeks before -i, jpeg gets a quality bump', () => {
    eqArgs(
      buildArgs({ op: 'framegrab', atSec: 1, format: 'png' }, '/in.mp4', '/out.png'),
      ['-nostdin', '-n', '-ss', '1', '-i', '/in.mp4', '-frames:v', '1', '-update', '1', '/out.png'],
      'png framegrab',
    );
    eqArgs(
      buildArgs({ op: 'framegrab', atSec: 2, format: 'jpeg' }, '/in.mp4', '/out.jpg'),
      ['-nostdin', '-n', '-ss', '2', '-i', '/in.mp4', '-frames:v', '1', '-update', '1', '-q:v', '2', '/out.jpg'],
      'jpeg framegrab + -q:v',
    );
  });

  await step('buildArgs — gif builds a palette; webp is a plain fps/scale chain', () => {
    eqArgs(
      buildArgs({ op: 'gif', inSec: 0, outSec: 2 }, '/in.mp4', '/out.gif'),
      ['-nostdin', '-n', '-ss', '0', '-t', '2', '-i', '/in.mp4', '-vf', 'fps=12,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', '-loop', '0', '/out.gif'],
      'default gif (fps 12, palette)',
    );
    eqArgs(
      buildArgs({ op: 'gif', inSec: 0, outSec: 2, fps: 15, width: 320, format: 'webp' }, '/in.mp4', '/out.webp'),
      ['-nostdin', '-n', '-ss', '0', '-t', '2', '-i', '/in.mp4', '-vf', 'fps=15,scale=320:-1:flags=lanczos', '-loop', '0', '/out.webp'],
      'webp (no palette)',
    );
  });

  await step('buildArgs — geometry maps each xform to a fixed -vf filter', () => {
    const pre = ['-nostdin', '-n', '-i', '/in.mp4'];
    eqArgs(buildArgs({ op: 'geometry', xform: { kind: 'crop', w: 100, h: 50, x: 10, y: 5 } }, '/in.mp4', '/out.mp4'), [...pre, '-vf', 'crop=100:50:10:5', '/out.mp4'], 'crop');
    eqArgs(buildArgs({ op: 'geometry', xform: { kind: 'rotate', degrees: 90 } }, '/in.mp4', '/out.mp4'), [...pre, '-vf', 'transpose=1', '/out.mp4'], 'rotate 90');
    eqArgs(buildArgs({ op: 'geometry', xform: { kind: 'rotate', degrees: 180 } }, '/in.mp4', '/out.mp4'), [...pre, '-vf', 'transpose=1,transpose=1', '/out.mp4'], 'rotate 180');
    eqArgs(buildArgs({ op: 'geometry', xform: { kind: 'flip', axis: 'h' } }, '/in.mp4', '/out.mp4'), [...pre, '-vf', 'hflip', '/out.mp4'], 'flip h');
    eqArgs(buildArgs({ op: 'geometry', xform: { kind: 'resize', resolution: '720p' } }, '/in.mp4', '/out.mp4'), [...pre, '-vf', 'scale=-2:720', '/out.mp4'], 'resize 720p');
  });

  await step('buildArgs — speed (video adds setpts; audio is atempo-only, chained)', () => {
    eqArgs(buildArgs({ op: 'speed', factor: 2, video: true }, '/in.mp4', '/out.mp4'), ['-nostdin', '-n', '-i', '/in.mp4', '-vf', 'setpts=PTS/2', '-af', 'atempo=2', '/out.mp4'], 'video 2×');
    eqArgs(buildArgs({ op: 'speed', factor: 0.5, video: false }, '/in.wav', '/out.wav'), ['-nostdin', '-n', '-i', '/in.wav', '-af', 'atempo=0.5', '/out.wav'], 'audio 0.5×');
    eqArgs(buildArgs({ op: 'speed', factor: 4, video: false }, '/in.wav', '/out.wav'), ['-nostdin', '-n', '-i', '/in.wav', '-af', 'atempo=2.0,atempo=2', '/out.wav'], 'audio 4× chains atempo');
  });

  await step('buildArgs — gain / spectrogram', () => {
    eqArgs(buildArgs({ op: 'gain', db: -6 }, '/in.wav', '/out.wav'), ['-nostdin', '-n', '-i', '/in.wav', '-af', 'volume=-6dB', '/out.wav'], 'gain -6dB');
    eqArgs(buildArgs({ op: 'spectrogram' }, '/in.wav', '/out.png'), ['-nostdin', '-n', '-i', '/in.wav', '-lavfi', 'showspectrumpic=s=1280x480', '/out.png'], 'spectrogram default size');
  });

  await step('buildArgs — join concat (a/v vs audio-only) + swap (mute/replace)', () => {
    eqArgs(
      buildArgs({ op: 'join', extraInputs: ['/b.mp4'], video: true }, '/a.mp4', '/out.mp4', ['/b.mp4']),
      ['-nostdin', '-n', '-i', '/a.mp4', '-i', '/b.mp4', '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[outv][outa]', '-map', '[outv]', '-map', '[outa]', '/out.mp4'],
      'a/v join (2)',
    );
    eqArgs(
      buildArgs({ op: 'join', extraInputs: ['/b.wav'], video: false }, '/a.wav', '/out.wav', ['/b.wav']),
      ['-nostdin', '-n', '-i', '/a.wav', '-i', '/b.wav', '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[outa]', '-map', '[outa]', '/out.wav'],
      'audio-only join (2)',
    );
    eqArgs(
      buildArgs({ op: 'swap', action: { kind: 'mute' } }, '/in.mp4', '/out.mp4'),
      ['-nostdin', '-n', '-i', '/in.mp4', '-c', 'copy', '-an', '/out.mp4'],
      'swap mute',
    );
    eqArgs(
      buildArgs({ op: 'swap', action: { kind: 'replace', audioPath: '/v.mp3' } }, '/in.mp4', '/out.mp4', ['/v.mp3']),
      ['-nostdin', '-n', '-i', '/in.mp4', '-i', '/v.mp3', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-shortest', '/out.mp4'],
      'swap replace',
    );
  });

  await step('targetOutputExt — new media-producing ops force the right ext', () => {
    assertEq(targetOutputExt('in.mp4', { op: 'framegrab', atSec: 0, format: 'png' }), '.png', 'framegrab png');
    assertEq(targetOutputExt('in.mp4', { op: 'framegrab', atSec: 0, format: 'jpeg' }), '.jpg', 'framegrab jpeg→jpg');
    assertEq(targetOutputExt('in.mp4', { op: 'gif', inSec: 0, outSec: 1, format: 'webp' }), '.webp', 'gif webp');
    assertEq(targetOutputExt('in.wav', { op: 'spectrogram' }), '.png', 'spectrogram png');
    assertEq(targetOutputExt('in.mp4', { op: 'geometry', xform: { kind: 'flip', axis: 'v' } }), '.mp4', 'geometry keeps source ext');
  });

  // ── REAL ffmpeg ──
  const haveFfmpeg = await ffmpegAvailable();
  if (!haveFfmpeg) {
    await step('SKIP real advanced ops — ffmpeg not on PATH', () => assert(true, 'skipped (no ffmpeg)'));
    summary('media-advanced-ops');
    return;
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-n3-cwd-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-n3-outside-'));
  try {
    // A short video WITH an audio track, and a couple of audio clips.
    const vid = path.join(cwd, 'clip.mp4');
    await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-pix_fmt', 'yuv420p', vid]);
    const a1 = path.join(cwd, 'a1.wav');
    const a2 = path.join(cwd, 'a2.wav');
    await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', a1]);
    await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', a2]);

    const acc = { unconfined: false };

    await step('framegrab → a still png inside cwd', async () => {
      const r = await runMediaOp(cwd, 'clip.mp4', { op: 'framegrab', atSec: 1, format: 'png' }, acc);
      const st = await fs.stat(r.outputPath);
      assert(st.isFile() && st.size > 0, 'png frame written');
      assertEq(path.extname(r.outputPath), '.png', 'output is .png');
    });

    await step('gif → a looping animation', async () => {
      const r = await runMediaOp(cwd, 'clip.mp4', { op: 'gif', inSec: 0, outSec: 1, fps: 8, width: 160 }, acc);
      const st = await fs.stat(r.outputPath);
      assert(st.isFile() && st.size > 0, 'gif written');
      assertEq(path.extname(r.outputPath), '.gif', 'output is .gif');
    });

    await step('geometry crop → output has the cropped dimensions', async () => {
      const r = await runMediaOp(cwd, 'clip.mp4', { op: 'geometry', xform: { kind: 'crop', w: 160, h: 120, x: 0, y: 0 } }, acc);
      const info = await inspectMedia({ ...acc, cwd }, path.basename(r.outputPath));
      const v = info.streams?.find((s) => s.type === 'video');
      assertEq(v?.width, 160, 'cropped width');
      assertEq(v?.height, 120, 'cropped height');
    });

    await step('speed 2× → output is ~half the duration', async () => {
      const r = await runMediaOp(cwd, 'clip.mp4', { op: 'speed', factor: 2, video: true }, acc);
      const dur = await probeDurationSec(r.outputPath);
      assert(dur !== null && dur < 1.6, `sped-up duration ${dur} < original ~2s`);
    });

    await step('gain → a valid audio file', async () => {
      const r = await runMediaOp(cwd, 'a1.wav', { op: 'gain', db: -6 }, acc);
      const st = await fs.stat(r.outputPath);
      assert(st.isFile() && st.size > 0, 'gain-adjusted audio written');
    });

    await step('spectrogram → a png image of the audio', async () => {
      const r = await runMediaOp(cwd, 'a1.wav', { op: 'spectrogram', width: 640, height: 240 }, acc);
      const st = await fs.stat(r.outputPath);
      assert(st.isFile() && st.size > 0, 'spectrogram png written');
      assertEq(path.extname(r.outputPath), '.png', 'output is .png');
    });

    await step('join (audio) → concatenated duration ≈ sum of parts', async () => {
      const r = await runMediaOp(cwd, 'a1.wav', { op: 'join', extraInputs: ['a2.wav'], video: false }, acc);
      const dur = await probeDurationSec(r.outputPath);
      assert(dur !== null && dur > 1.8, `joined duration ${dur} ≈ 2s`);
    });

    await step('swap mute → output has NO audio stream', async () => {
      const r = await runMediaOp(cwd, 'clip.mp4', { op: 'swap', action: { kind: 'mute' } }, acc);
      const info = await inspectMedia({ ...acc, cwd }, path.basename(r.outputPath));
      assert(!info.streams?.some((s) => s.type === 'audio'), 'no audio stream after mute');
      assert(info.streams?.some((s) => s.type === 'video'), 'video stream survives');
    });

    await step('swap replace → output audio comes from the replacement', async () => {
      const r = await runMediaOp(cwd, 'clip.mp4', { op: 'swap', action: { kind: 'replace', audioPath: 'a2.wav' } }, acc);
      const info = await inspectMedia({ ...acc, cwd }, path.basename(r.outputPath));
      assert(info.streams?.some((s) => s.type === 'audio'), 'audio present after replace');
      assert(info.streams?.some((s) => s.type === 'video'), 'video copied through');
    });

    await step('inspect → curated stream facts, writes NO file', async () => {
      const before = (await fs.readdir(cwd)).length;
      const info = await inspectMedia({ ...acc, cwd }, 'clip.mp4');
      assert(info.ok, 'inspect ok');
      const v = info.streams?.find((s) => s.type === 'video');
      const au = info.streams?.find((s) => s.type === 'audio');
      assertEq(v?.codec, 'h264', `video codec ${v?.codec}`);
      assert(!!au?.codec, 'audio codec reported');
      assert((info.format?.duration ?? 0) > 1.5, 'format duration reported');
      const after = (await fs.readdir(cwd)).length;
      assertEq(after, before, 'inspect wrote no file');
    });

    await step('join — an out-of-cwd EXTRA input is rejected when the fence is locked', async () => {
      const stray = path.join(outside, 'stray.wav');
      await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', stray]);
      let code: string | undefined;
      try {
        await runMediaOp(cwd, 'a1.wav', { op: 'join', extraInputs: [stray], video: false }, { unconfined: false });
      } catch (e) { code = e instanceof MediaOpError ? e.code : 'other'; }
      assertEq(code, 'bad-path', 'locked fence rejects the out-of-cwd extra input');
      // And it's accepted when unconfined.
      const r = await runMediaOp(cwd, 'a1.wav', { op: 'join', extraInputs: [stray], video: false }, { unconfined: true, allowedRoots: [outside] });
      const st = await fs.stat(r.outputPath);
      assert(st.isFile() && st.size > 0, 'unconfined join across dirs runs');
    });

    // ffprobe-specific: inspect degrades cleanly if ffprobe is somehow absent.
    if (!(await ffprobeAvailable())) {
      await step('inspect degrades when ffprobe absent', async () => {
        const info = await inspectMedia({ ...acc, cwd }, 'clip.mp4');
        assertEq(info.code, 'ffprobe-missing', 'structured ffprobe-missing');
      });
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }

  summary('media-advanced-ops');
}

void main();

// ── Media ops — guarded FFmpeg audio operations (Workbench Expansion §H6) ──
//
// TYPES ONLY. The guarded wrapper lives in server/src/media/ffmpeg.ts; the HTTP
// route in server/src/http/mediaOpsRoutes.ts. These shapes are the contract the
// operator's modal POSTs and the security-critical arg builder switches on.
//
// FENCE NOTE (the director reads ffmpeg.ts line by line): the op spec is a
// TYPED discriminated union — never raw operator text. The server builds ffmpeg
// argv by exhaustively switching on `op`; the only operator-influenced values
// are NUMERIC (validated finite/ordered) or ENUM (whitelisted format/quality/
// mode). No operator string is ever concatenated into a flag or a path. This is
// what lets a clip/convert run without a shell and without flag-smuggling.

// The audio formats the convert op (and output extension) is bounded to. Each
// maps to the ffmpeg encoder + the on-disk extension. A target format the
// operator picks MUST be a key of this const — anything else is rejected before
// an arg is built.
export interface AudioFormatDef {
  // ffmpeg encoder (`-c:a <codec>`). 'copy' is never used for convert (we always
  // re-encode to the target codec); kept explicit so the arg builder is total.
  codec: string;
  // The output file extension (no leading dot).
  ext: string;
}

export const AUDIO_FORMATS = {
  wav: { codec: 'pcm_s16le', ext: 'wav' },
  mp3: { codec: 'libmp3lame', ext: 'mp3' },
  ogg: { codec: 'libvorbis', ext: 'ogg' },
  flac: { codec: 'flac', ext: 'flac' },
  m4a: { codec: 'aac', ext: 'm4a' },
  aac: { codec: 'aac', ext: 'aac' },
} as const satisfies Record<string, AudioFormatDef>;

export type AudioFormat = keyof typeof AUDIO_FORMATS;

export const AUDIO_FORMAT_NAMES = Object.keys(AUDIO_FORMATS) as AudioFormat[];

// ── Video formats (Workbench Expansion §H7) ─────────────────────────────────
//
// The container/codec set the video convert op (and output extension) is bounded
// to. Each maps to a default video + audio encoder and the on-disk container
// extension. Same fence as AUDIO_FORMATS: a target the operator picks MUST be a
// key here, and the codec NEVER comes from raw operator text — it's read from
// this const (or the bounded VIDEO_VCODECS set below). Defaults are broadly
// compatible (H.264/AAC for mp4/mov, VP9/Opus for webm).
export interface VideoFormatDef {
  // Default video encoder (`-c:v <vcodec>`) for this container.
  vcodec: string;
  // Default audio encoder (`-c:a <acodec>`) for this container.
  acodec: string;
  // The output file extension (no leading dot).
  ext: string;
}

export const VIDEO_FORMATS = {
  mp4: { vcodec: 'libx264', acodec: 'aac', ext: 'mp4' },
  webm: { vcodec: 'libvpx-vp9', acodec: 'libopus', ext: 'webm' },
  mov: { vcodec: 'libx264', acodec: 'aac', ext: 'mov' },
  mkv: { vcodec: 'libx264', acodec: 'aac', ext: 'mkv' },
} as const satisfies Record<string, VideoFormatDef>;

export type VideoFormat = keyof typeof VIDEO_FORMATS;

export const VIDEO_FORMAT_NAMES = Object.keys(VIDEO_FORMATS) as VideoFormat[];

// Bounded video-codec override set. The operator may force one of these instead
// of the container default; anything else is rejected before an arg is built. A
// bounded set (not a free string) means a malicious value can't smuggle a flag
// into `-c:v`.
export const VIDEO_VCODECS = ['libx264', 'libx265', 'libvpx-vp9'] as const;
export type VideoVcodec = (typeof VIDEO_VCODECS)[number];

// Bounded resolution presets. Each maps to a FIXED ffmpeg scale-filter string we
// control (never raw operator text into `-vf`). 'source' = no scaling. -2 keeps
// the other dimension even + aspect-correct (required by most encoders).
export const VIDEO_RES_PRESETS = ['source', '480p', '720p', '1080p'] as const;
export type VideoResPreset = (typeof VIDEO_RES_PRESETS)[number];

// The concrete scale filter each preset maps to. 'source' has none (omitted).
export const VIDEO_RES_SCALE: Record<Exclude<VideoResPreset, 'source'>, string> = {
  '480p': 'scale=-2:480',
  '720p': 'scale=-2:720',
  '1080p': 'scale=-2:1080',
};

// A resolution is EITHER a bounded preset OR an explicit {w,h} pair of validated
// positive integers (validateSpec checks integer/>0/≤ a sane cap). Both map to a
// scale filter the server BUILDS — the operator never supplies the filter string.
export type VideoResolution = VideoResPreset | { w: number; h: number };

// Upper bound on an explicit {w,h} (defense against an absurd allocation).
export const VIDEO_DIM_MAX = 7680;

// Bounded quality/bitrate set for lossy convert (mp3/m4a/aac/ogg). The operator
// picks one of these tokens; the arg builder maps it to a concrete `-b:a` value.
// A bounded set (not a free number) means a malicious value can't smuggle a flag
// and can't ask for an absurd bitrate.
export const AUDIO_BITRATES = ['96k', '128k', '192k', '256k', '320k'] as const;
export type AudioBitrate = (typeof AUDIO_BITRATES)[number];

// Bounded sample-rate set for the resample op (Hz). Same rationale as bitrate.
export const AUDIO_SAMPLE_RATES = [8000, 16000, 22050, 44100, 48000, 96000] as const;
export type AudioSampleRate = (typeof AUDIO_SAMPLE_RATES)[number];

// ── Advanced-op bounded sets + types (Part N3) ───────────────────────────────
//
// Same fence discipline as the H6/H7 sets above: every operator-influenced value
// is a whitelisted enum or a validated number — never raw text into a filter or a
// flag. A still/gif format the operator picks MUST be a key of these consts.

// Single-frame still formats (the framegrab op writes ONE image at a timestamp).
export const STILL_FORMATS = {
  png: { ext: 'png' },
  jpeg: { ext: 'jpg' },
} as const satisfies Record<string, { ext: string }>;
export type StillFormat = keyof typeof STILL_FORMATS;
export const STILL_FORMAT_NAMES = Object.keys(STILL_FORMATS) as StillFormat[];

// Animated-clip formats (the gif op writes a short looping animation).
export const ANIM_FORMATS = {
  gif: { ext: 'gif' },
  webp: { ext: 'webp' },
} as const satisfies Record<string, { ext: string }>;
export type AnimFormat = keyof typeof ANIM_FORMATS;
export const ANIM_FORMAT_NAMES = Object.keys(ANIM_FORMATS) as AnimFormat[];

// Bounds for the gif/spectrogram numeric controls. fps + dimensions are validated
// against these before any filter string is composed (the server BUILDS the
// filter from the validated numbers; the operator never supplies the string).
export const GIF_FPS_MIN = 1;
export const GIF_FPS_MAX = 50;
export const GIF_FPS_DEFAULT = 12;
// A spectrogram image size (showspectrumpic). Reuses VIDEO_DIM_MAX as the cap.
export const SPECTROGRAM_DEFAULT_W = 1280;
export const SPECTROGRAM_DEFAULT_H = 480;

// Speed-change factor bounds (1 = unchanged; >1 faster, <1 slower). Audio tempo
// is preserved (atempo, chained to cover the full range); video re-times (setpts).
export const SPEED_FACTOR_MIN = 0.25;
export const SPEED_FACTOR_MAX = 4;

// Audio gain bounds in dB (volume filter). Bounded so a malicious value can't ask
// for an absurd amplification.
export const GAIN_DB_MIN = -60;
export const GAIN_DB_MAX = 30;

// Upper bound on the number of inputs a single join may concatenate (defense
// against an unbounded filter graph / arg list).
export const JOIN_MAX_INPUTS = 24;

// A geometry transform — exactly one per op. crop carries a validated rect; rotate
// a quarter-turn enum; flip an axis enum; resize a bounded resolution (preset or
// validated {w,h}). The server maps each to a FIXED -vf filter it controls.
export type GeometryXform =
  | { kind: 'crop'; w: number; h: number; x: number; y: number }
  | { kind: 'rotate'; degrees: 90 | 180 | 270 }
  | { kind: 'flip'; axis: 'h' | 'v' }
  | { kind: 'resize'; resolution: VideoResolution };

// A swap action — mute drops the audio stream; replace maps in a separate audio
// file's track (audioPath is gated by the SAME access fence as the input).
export type SwapAction =
  | { kind: 'mute' }
  | { kind: 'replace'; audioPath: string };

// ── The typed op spec — the security-critical discriminated union ───────────
//
// clip / extract carry numeric in/out seconds (validated finite, ≥0, in ≤ out).
// convert carries a whitelisted format (+ optional bounded bitrate). normalize /
// fade / channels / resample carry only enums or bounded numerics. There is no
// free-text member.
export type MediaOpSpec =
  // Trim to [inSec, outSec], re-muxing into the SAME container (stream copy when
  // possible — fast, lossless). Output keeps the source extension.
  | { op: 'clip'; inSec: number; outSec: number }
  // Same as clip but always re-encodes (a precise segment extract, frame-accurate
  // even on lossy sources). Kept distinct so the arg builder is explicit.
  | { op: 'extract'; inSec: number; outSec: number }
  // Re-encode to a whitelisted target format; optional bounded bitrate for lossy.
  | { op: 'convert'; format: AudioFormat; bitrate?: AudioBitrate }
  // EBU R128 loudness normalization (ffmpeg `loudnorm` filter). No operator input.
  | { op: 'normalize' }
  // Fade in/out over the given milliseconds (bounded ≥0). At least one of in/out.
  | { op: 'fade'; inMs?: number; outMs?: number }
  // Down/up-mix to mono or stereo.
  | { op: 'channels'; mode: 'mono' | 'stereo' }
  // Resample to a whitelisted rate (Hz).
  | { op: 'resample'; hz: AudioSampleRate }
  // ── Video ops (§H7) — same wrapper, same fences ──
  // Clip a video span [inSec, outSec]. Stream-copy by default (`-c copy` — fast,
  // lossless, keeps the source container); re-encode when `reencode` (frame-
  // accurate on inter-frame codecs, at the cost of a transcode). Output keeps the
  // source extension.
  | { op: 'vclip'; inSec: number; outSec: number; reencode?: boolean }
  // Convert container/codec/resolution. format → container + default codecs;
  // optional vcodec override (whitelisted) + resolution (preset or validated wh).
  | { op: 'vconvert'; format: VideoFormat; resolution?: VideoResolution; vcodec?: VideoVcodec }
  // Strip the video stream (`-vn`) and encode the audio to a whitelisted audio
  // format; optional span [inSec, outSec].
  | { op: 'extract-audio'; format: AudioFormat; inSec?: number; outSec?: number }
  // ── Advanced ops (§N3) — same wrapper, same fences ──
  // Grab a SINGLE frame at a timestamp → a still image (png/jpeg). atSec ≥ 0.
  | { op: 'framegrab'; atSec: number; format: StillFormat }
  // Clip [inSec, outSec] → a short looping animation (gif/webp). fps + width are
  // bounded; the gif path builds a palette for quality. Output ext = the format.
  | { op: 'gif'; inSec: number; outSec: number; fps?: number; width?: number; format?: AnimFormat }
  // A single geometry transform (crop / rotate / flip / resize). Video only — the
  // server maps the xform to a fixed `-vf` filter built from validated numbers.
  | { op: 'geometry'; xform: GeometryXform }
  // Speed change (factor in [0.25, 4]). `video` (set by the PANEL, not free text)
  // decides the filter set: true ⇒ re-time video (setpts) + retempo audio; false
  // ⇒ audio-only (atempo). Audio tempo is pitch-preserved.
  | { op: 'speed'; factor: number; video: boolean }
  // Audio gain in dB (volume filter). Bounded ±.
  | { op: 'gain'; db: number }
  // Render an audio spectrogram → a png (showspectrumpic). Size bounded.
  | { op: 'spectrogram'; width?: number; height?: number }
  // Concatenate the primary input with N more files (filter concat, re-encoded).
  // Each extra path is gated by the SAME access fence as the primary input. Output
  // keeps the primary's container. `video` (set by the PANEL, not free text)
  // picks the stream layout: true ⇒ a/v concat, false ⇒ audio-only concat.
  | { op: 'join'; extraInputs: string[]; video: boolean }
  // Audio-track surgery on a video: mute (drop audio) OR replace it with a
  // separate audio file (gated like any input). Video stream is stream-copied.
  | { op: 'swap'; action: SwapAction };

export type MediaOpKind = MediaOpSpec['op'];

export const MEDIA_OP_KINDS: MediaOpKind[] = [
  'clip', 'extract', 'convert', 'normalize', 'fade', 'channels', 'resample',
  'vclip', 'vconvert', 'extract-audio',
  'framegrab', 'gif', 'geometry', 'speed', 'gain', 'spectrogram', 'join', 'swap',
];

// ── HTTP request / result shapes ────────────────────────────────────────────

// POST /api/media/op body. `path` is resolved server-side through the media
// access resolver (Part N2): confined to `cwd` when present, ALWAYS allowed
// inside Archon's own media-scratch dir, and — only when the operator has
// enabled `mediaUnconfined` in Settings — permitted to reach an arbitrary
// absolute path. `spec` is validated against the union above. `cwd` is now
// OPTIONAL: a general-tool op on a scratch / absolute path carries none (an
// absolute `path` is required in that case).
export interface MediaOpRequest {
  cwd?: string;
  workflowId?: string;
  // The INPUT path. Relative (resolved against `cwd`) OR absolute. An absolute
  // path outside `cwd` is gated: a scratch path is always allowed; any other
  // absolute path requires `mediaUnconfined`.
  path: string;
  spec: MediaOpSpec;
  // N2 — explicit output destination. `dir` (absolute or cwd-relative) chooses
  // where the new file lands; absent ⇒ alongside the input. `basename` chooses
  // the output filename (sanitized; the op's target extension is forced so the
  // file stays playable); absent ⇒ the derived non-clobbering name. The output
  // dir is gated by the SAME resolver as the input, and the output is still
  // uniquified so it can never overwrite the source or a prior output.
  output?: { dir?: string; basename?: string };
}

// Structured response — always HTTP 200 on an operator-visible condition
// (rejected escape, missing ffmpeg, ffmpeg failure); only an unexpected server
// bug is a 500. `code` lets the client branch (e.g. show the install pointer).
export type MediaOpErrorCode =
  | 'ffmpeg-missing'
  | 'bad-spec'
  | 'bad-path'
  | 'input-missing'
  | 'ffmpeg-failed'
  | 'cancelled'
  | 'no-cwd'
  // N2 — the chosen output dir doesn't exist / isn't a directory. (We never
  // create arbitrary directories; the operator points at one that's there.)
  | 'output-dir-missing';

export interface MediaOpResult {
  ok: boolean;
  // Absolute output path on success.
  outputPath?: string;
  // Repo-relative output path on success (for the "Reveal in Files" affordance).
  relPath?: string;
  error?: string;
  code?: MediaOpErrorCode;
}

// ── Image write — guarded raster save (Workbench Expansion §H2 part 1) ──────
//
// TYPES ONLY. The route lives in server/src/http/imageWriteRoutes.ts. This is the
// server-side foundation the H2 image editor SAVES through (the editor UI port is
// a separate later phase). The editor encodes its canvas to a `data:image/<t>;
// base64,…` URL and POSTs it; the server decodes, confines the target path to the
// workflow cwd (the SAME resolveWithinCwd fence as the Write tools / media ops),
// enforces an image extension, and writes — refusing to clobber an existing file
// unless `overwrite === true`.
//
// FENCE NOTE: there is NO subprocess here — pure fs. The load-bearing guards are
// (1) resolveWithinCwd (a `../`/absolute-outside/traversal path is rejected before
// any write), (2) overwrite-confirm (an existing file is never replaced silently),
// and (3) a decoded-size cap (a runaway data URL can't OOM the server).

// POST /api/image/write body. `path` is the relative target filename; it is
// resolved + confined to `cwd` (or the workflow's bound cwd) server-side. `dataUrl`
// is a `data:image/png|jpeg|webp;base64,…` URL — the only image source.
export interface ImageWriteRequest {
  cwd?: string;
  workflowId?: string;
  // Repo-relative (or absolute-within-cwd) target path. Must carry an image
  // extension matching the supported set.
  path: string;
  // `data:image/<png|jpeg|webp>;base64,<payload>`. The mime + payload are parsed
  // defensively; a non-image / malformed URL is rejected with code 'bad-image'.
  dataUrl: string;
  // When the resolved target already exists, the write only proceeds if this is
  // explicitly `true`. A brand-new filename writes unconditionally.
  overwrite?: boolean;
}

// Structured response — always HTTP 200 on an operator-visible condition
// (path escape, existing-file refusal, bad data URL, oversize, missing cwd); only
// an unexpected server bug is a 500. `code` lets the client branch.
export type ImageWriteErrorCode =
  | 'no-cwd'
  | 'bad-path'
  | 'path-escape'
  | 'bad-image'
  | 'bad-ext'
  | 'too-large'
  | 'exists'
  | 'write-failed';

export interface ImageWriteResult {
  ok: boolean;
  // Repo-relative written path on success (for "Reveal in Files" + checkpoint).
  relPath?: string;
  // Bytes written on success.
  bytes?: number;
  error?: string;
  code?: ImageWriteErrorCode;
}

// ── Media scratch upload (Part N2) ──────────────────────────────────────────
//
// POST /api/media/scratch?name=<basename> with the raw file bytes as the body
// streams an IMPORTED (browser-blob / drag-dropped) media file onto disk in
// Archon's own scratch area (~/.archon/media-scratch/<id>/) so ffmpeg — which
// reads files, not object URLs — can act on it. The returned absolute `path` is
// then passed straight back as a MediaOpRequest.path; the op resolver always
// permits scratch paths regardless of the `mediaUnconfined` setting (the
// operator put the file there through this endpoint). Bounded: a per-upload
// byte cap, a total-scratch size cap (oldest entries evicted), and a TTL reaper.
export type MediaScratchErrorCode =
  | 'bad-name'      // missing / unsafe ?name= basename
  | 'too-large'     // upload exceeded the per-file byte cap
  | 'write-failed'; // disk write / stream error

export interface MediaScratchResult {
  ok: boolean;
  // Absolute on-disk scratch path (feed back as MediaOpRequest.path).
  path?: string;
  // The sanitized basename the bytes were written under.
  basename?: string;
  // Bytes written on success.
  bytes?: number;
  error?: string;
  code?: MediaScratchErrorCode;
}

// ── Media inspect (Part N3) ──────────────────────────────────────────────────
//
// POST /api/media/inspect { cwd?, workflowId?, path } → MediaInspectResult.
// Read-only ffprobe metadata: it writes NO file (the result carries the data) and
// is therefore its OWN endpoint, not a MediaOpSpec (the op union is render ops
// that produce a file). `path` is gated by the SAME access fence as an op input
// (cwd | scratch | unconfined). The shape is a curated projection of ffprobe's
// `-show_format -show_streams` JSON — only the fields the panel renders.
export interface MediaInspectRequest {
  cwd?: string;
  workflowId?: string;
  path: string;
}

export interface MediaInspectStream {
  // Stream index within the container.
  index: number;
  // codec_type: 'video' | 'audio' | 'subtitle' | 'data' | …
  type: string;
  // codec_name (e.g. 'h264', 'aac'); absent if ffprobe didn't report one.
  codec?: string;
  // Video geometry.
  width?: number;
  height?: number;
  // Frames-per-second (parsed from avg_frame_rate "30000/1001"); video only.
  fps?: number;
  // Audio.
  sampleRate?: number;
  channels?: number;
  // bit_rate (bits/s) when present.
  bitrate?: number;
}

export type MediaInspectErrorCode =
  | 'ffprobe-missing'
  | 'bad-path'
  | 'input-missing'
  | 'probe-failed';

export interface MediaInspectResult {
  ok: boolean;
  // Container-level facts (format_name / duration seconds / size bytes / bit_rate).
  format?: { name?: string; duration?: number; size?: number; bitrate?: number };
  // Per-stream facts (curated).
  streams?: MediaInspectStream[];
  error?: string;
  code?: MediaInspectErrorCode;
}

// ── Stem separation (Part N4) ────────────────────────────────────────────────
//
// POST /api/media/stems runs **Demucs** (not ffmpeg) — true AI source separation
// into vocals/drums/bass/other (or a two-stems karaoke split). It's a separate
// long-running runner (`server/src/media/demucs.ts`), so it has its own request /
// result shapes rather than riding the `MediaOpSpec` union. The input + output
// dir are gated by the SAME N2 access fence as an op. Every operator value is a
// whitelisted enum (model / stem / format) — no free text reaches the argv.

// The pretrained models the runner accepts (`demucs -n <model>`). A bounded set —
// anything else is rejected before an arg is built. htdemucs is the 4-stem
// default; htdemucs_6s adds guitar+piano; mdx_extra* are the older bags.
export const STEM_MODELS = ['htdemucs', 'htdemucs_ft', 'htdemucs_6s', 'mdx_extra', 'mdx_extra_q'] as const;
export type StemModel = (typeof STEM_MODELS)[number];

// The stems a two-stems split can isolate (`demucs --two-stems <name>` → <name>
// + no_<name>). The full separation needs none of these.
export const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'] as const;
export type StemName = (typeof STEM_NAMES)[number];

// Output encodings. NOTE (N4): on a box whose torchaudio routes wav/flac writes
// through TorchCodec, only `mp3` (lameenc) works without the extra `torchcodec`
// dep — the client defaults to mp3 and the runner surfaces a clear hint on the
// wav/flac save failure. See docs/OPERATIONS.md § Demucs.
export const STEM_FORMATS = ['mp3', 'wav', 'flac'] as const;
export type StemFormat = (typeof STEM_FORMATS)[number];

export interface MediaStemsRequest {
  cwd?: string;
  workflowId?: string;
  // The INPUT track — gated by the SAME access fence as a MediaOpRequest.path.
  path: string;
  // Pretrained model (default htdemucs). Whitelisted.
  model?: StemModel;
  // Present ⇒ a two-stems split (`--two-stems <name>`): <name> + no_<name>.
  // Absent ⇒ the full set the model produces.
  twoStems?: StemName;
  // Output encoding (default mp3 — the broadly-working path; see STEM_FORMATS).
  format?: StemFormat;
  // Destination PARENT dir (gated by the fence + must exist); a FRESH uniquified
  // `<stem>.stems[-N]/` subdir is created inside it so a run never clobbers a
  // prior one. Absent ⇒ alongside the input.
  output?: { dir?: string };
}

export type MediaStemsErrorCode =
  | 'demucs-missing'
  | 'bad-spec'
  | 'bad-path'
  | 'input-missing'
  | 'output-dir-missing'
  | 'demucs-failed'
  | 'cancelled';

export interface MediaStemFile {
  // The stem name ('vocals' | 'drums' | 'bass' | 'other' | 'no_vocals' | …).
  name: string;
  // Absolute path to the written stem file.
  path: string;
  // cwd-relative path (drives REVEAL IN FILES); absent for an out-of-cwd output.
  relPath?: string;
}

export interface MediaStemsResult {
  ok: boolean;
  // The model used.
  model?: StemModel;
  // Absolute stems dir (the fresh subdir the files were flattened into).
  dir?: string;
  // cwd-relative stems dir (reveal); absent for an out-of-cwd output.
  relDir?: string;
  // The written stems.
  stems?: MediaStemFile[];
  error?: string;
  code?: MediaStemsErrorCode;
}

// Server → client broadcast after a stems run (success OR expected failure) so
// Activity/HISTORY render a marker → persisted to events.jsonl (audit trail,
// mirrors media_op_result). Stems are not a MediaOpKind, hence a sibling type.
export interface MediaStemsResultMessage {
  type: 'media_stems_result';
  workflowId: string;
  ok: boolean;
  // The model used (e.g. "htdemucs").
  model: string;
  // Number of stem files written.
  count: number;
  // Short human summary for the Activity line.
  summary: string;
  // cwd-relative stems dir on success.
  relDir?: string;
  error?: string;
  // Epoch ms.
  ts: number;
}

// Server → client broadcast after a media op (success OR expected failure), so
// Activity/HISTORY render a marker. Persisted via the standard broadcastWorkflow
// path. Mirrors GitOpResultMessage (§I3).
export interface MediaOpResultMessage {
  type: 'media_op_result';
  workflowId: string;
  // The op kind (e.g. "clip").
  op: MediaOpKind;
  ok: boolean;
  // Short human summary for the Activity line.
  summary: string;
  // Repo-relative output path on success.
  relPath?: string;
  error?: string;
  // Epoch ms.
  ts: number;
}

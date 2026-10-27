# Media studio

Modal media tools include an image viewer and editor, audio editor, and video
converter and clipper. This document describes the current implementation.

## H1, entry points + enhanced viewer (shipped)

The shared shell. Operator-facing behavior lives in the in-app manual (`media-studio` section); the client wiring is documented in `CLIENT.md § media/MediaModalHost.tsx` and `§ In-modal scoped Help`.

- **Host:** `client/src/components/media/MediaModalHost.tsx`, routes a media file to image/audio/video mode by extension, or opens empty with an Import affordance. Mounted in `App.tsx` on `appStore.mediaStudio.open`.
- **Launchers:** `client/src/components/media/launchers.ts`, `openMediaStudio(mode?)` (empty), `openMediaFile(path)` (contextual), `classifyMediaExt(filename)`.
- **Entry points:** header **⌗ MEDIA** button, command-palette `Open Media studio[...]`, and FileExplorer right-click on a media file.

**Functional now:** the image viewer (zoom/pan/fit/1:1 + dimensions; on-disk via the guarded `GET /api/file-content`, imported via browser object URL); the audio editor + FFmpeg ops (H5/H6) and the video editor + FFmpeg ops for both imported AND on-disk files (on-disk via the guarded `GET /api/media/raw` Range-able serve route).

**Honestly deferred (not faked):**
- **EXIF metadata**, needs an image-metadata dependency; deferred to H2.
- **FFmpeg ops on an imported (object-URL) file**, ffmpeg can't read a browser blob, so audio/video ops are enabled only for an on-disk (contextual) open; an imported file plays but disables the ops with an inline note. No blob upload yet.
- **Editing** (layers/brush, H2), not part of the shipped editor.

## H5, audio editor (shipped)

The audio tool: load audio (right-click in Files -> opens in audio mode with the Import affordance, or open empty + Import), see a waveform, play/scrub, and select a region. **Client-only**, the browser decodes the imported file; the ffmpeg-backed ops are H6. Operator-facing behavior lives in the `media-studio` manual section.

- **Component:** `client/src/components/media/AudioEditor/AudioEditor.tsx` (re-exported from the dir `index.ts`). Props `{ src: string; filename?: string; onRegionChange?(start, end) }`. `src` is the **same object URL** `MediaModalHost` already created for the imported file, the editor does not make a second URL and revokes nothing the host owns.
- **Dependency:** `wavesurfer.js` (v7, BSD-3-Clause), client workspace only. Waveform render + transport via the core `WaveSurfer`; region select via the regions plugin (`wavesurfer.js/dist/plugins/regions.esm.js`).
- **Waveform:** decode + render, themed to the active theme, `waveColor`/`progressColor`/`cursorColor` resolved from the `--color-*` CSS vars at init (canvas fills can't read CSS vars live). Click to seek.
- **Transport:** play/pause + a `mm:ss.mmm` current-time / total-duration readout.
- **Region select:** one region with draggable in/out handles; editable `IN`/`OUT` numeric inputs (`mm:ss.mmm`) two-way-bind to the region (typing moves the handle; dragging updates the field). Each in/out change calls `onRegionChange(start, end)`, the **clip seam H6 reads** (the host holds the latest value in a ref).
- **React lifecycle:** the `WaveSurfer` instance is created in a `useEffect` keyed on `src` and `destroy()`-ed in the cleanup. A `disposed` flag aborts late `ready`/`timeupdate`/`region-updated` handlers so a StrictMode double-mount can't touch a torn-down instance, no leaked instances, no "container already has a waveform" errors.

**H6 (below)** wires the FFmpeg ops + the on-disk serve route, so on-disk audio now plays + shows a waveform, and clip/convert/normalize run.

## H6, audio operations (FFmpeg) (shipped)

The real edits: trim/clip to the region, convert format, normalize, mono/stereo, plus fade / resample / extract, server-side via FFmpeg. Operator-facing behavior lives in the `media-studio` manual section. HTTP shapes in `HTTP_API.md`; the load-bearing invariant note is in `GOTCHAS.md § Media ops FFmpeg wrapper`.

### Server

- **Guarded wrapper:** `server/src/media/ffmpeg.ts`. **execFile with an argv array only**, the binary is the fixed literal `'ffmpeg'`/`'ffprobe'`, never a shell string, never `shell:true`. Exports:
  - `ffmpegAvailable()`, cached `ffmpeg -version` probe; a missing binary fails gracefully (`code: 'ffmpeg-missing'`), never a spawn crash.
  - `buildArgs(spec, inputPath, outputPath): string[]`, **PURE + total** over the `MediaOpSpec` union. The only operator-influenced argv values are numbers (clip/extract/fade/resample) or whitelisted enums (format/codec/bitrate/channels). No operator string is ever concatenated into a flag or path. The smoke asserts the exact argv per op.
  - `validateSpec(spec)`, rejects a malformed spec (in>=out, unknown format, empty fade, ...) before any arg is built.
  - `runAudioOp(cwd, inputRelPath, spec, { signal })`, confine input -> confirm it exists -> derive a **new, non-clobbering** output basename (`<stem>.<op>.<ext>`, uniquified) -> confine output -> preflight ffmpeg -> `execFile` with the AbortSignal -> on success return `{ outputPath, relPath }`; on error/abort **unlink the partial output** and throw a typed `MediaOpError`.
  - `probeDurationSec` / `probeAudioCodec`, ffprobe helpers (argv array) for validation + the smoke.
- **Path confinement:** both INPUT and OUTPUT go through `resolveWithinCwd` (the same guard the Write/Edit tools + `fileWriteRoutes` use). A `../`/absolute-outside/trailing-sep-sibling path is rejected. Output is **always a new file**, `uniqueBasename` + the `outputAbs === inputAbs` assertion + ffmpeg's `-n` guarantee the source is never overwritten.
- **Cancel:** the route wires `req.on('close')` -> `AbortController.abort()`; the signal SIGKILLs the ffmpeg child and `runAudioOp` unlinks the partial output. A cancelled op is `code: 'cancelled'` and is **not** broadcast as a failure (the client initiated it).
- **HTTP:** `server/src/http/mediaOpsRoutes.ts`, `POST /api/media/op` (run an op; always 200 with a structured `MediaOpResult` for operator-visible conditions) and `GET /api/media/raw` (read-only, path-confined, Range-able byte server, see below). Registered in `router.ts` after the cookbook routes (distinct `/api/media/` prefix). A successful/failed op broadcasts `media_op_result` -> persisted to `events.jsonl` (audit trail, mirrors §I3 git ops).

### Raw-media serve (deferred from H1/H5)

`GET /api/media/raw?path=&cwd=&workflowId=`, confines `path` to cwd via the **same `resolveWithinCwd` guard**, streams the file read-only with a correct `Content-Type` (by extension) and **HTTP Range support** (`206` partial content) for `<audio>`/`<video>` seeking + wavesurfer's chunked fetch. This is what lets an **on-disk** audio file render a waveform. Rejects out-of-cwd (`403`).

### Client

- **Types:** `shared/src/protocol/media.ts`, the `MediaOpSpec` discriminated union, the `AUDIO_FORMATS` whitelist (codec/ext), bounded `AUDIO_BITRATES`/`AUDIO_SAMPLE_RATES`, the request/result shapes, and `MediaOpResultMessage`.
- **On-disk audio now plays:** `MediaModalHost` points the `AudioEditor` `src` at `/api/media/raw?...` for a contextual (on-disk) audio open; imported audio still uses its object URL. The video on-disk note is kept.
- **Ops UI:** `client/src/components/media/AudioEditor/AudioOpsPanel.tsx`, CLIP (reads the region in/out the H5 editor emits), CONVERT (+ format/bitrate pickers), NORMALIZE, MONO, STEREO. POSTs to `/api/media/op`, shows a running spinner + **CANCEL** (aborts the fetch -> server kills the child), and on success the output path + **REVEAL IN FILES** (a `arco:reveal-in-files` window event the `RightPanel` listens for, flipping to FILES).

**Honest constraint (load-bearing):** FFmpeg needs an **on-disk** source, it can't read a browser object URL. So ops are enabled only for an on-disk (contextual) open; an **imported** file disables the ops with an inline note ("Open this file from the Files panel to run FFmpeg ops"). The blob is **not** uploaded in this phase.

## H7, video converter / clipper (FFmpeg) (shipped)

The video half of the FFmpeg studio: preview + scrub + in/out markers, then **clip**, **convert** (container/codec/resolution), or **extract audio**, server-side via the **same** guarded wrapper + route + serve as H6. We **extended** H6, not rebuilt it. Operator-facing behavior lives in the `media-studio` manual section.

- **Reused wrapper:** `server/src/media/ffmpeg.ts`. `runAudioOp` was renamed to **`runMediaOp`** (nothing in its body is audio-specific, it confines/derives/runs/cleans up for any `MediaOpSpec`); `runAudioOp` and `runVideoOp` are thin **aliases** to the same body (`export const runVideoOp = runMediaOp`), so there is **one** confine/cancel/cleanup path and **one** ffmpeg spawn path. `buildArgs` / `validateSpec` gained the video cases; both stay PURE + total over the grown union.
- **New op specs** (`MediaOpSpec`, in `shared/src/protocol/media.ts`):
  - `{ op: 'vclip'; inSec; outSec; reencode? }`, `-ss/-to` window after `-i`; **stream copy (`-c copy`)** by default (fast, lossless, keeps the source container) or re-encode when `reencode` (frame-accurate). Output keeps the source ext.
  - `{ op: 'vconvert'; format: VideoFormat; resolution?; vcodec? }`, `-c:v <vcodec> -c:a <acodec>` (codecs from the `VIDEO_FORMATS` whitelist or a whitelisted `vcodec` override) + optional `-vf scale=...` from the resolution, into the container ext.
  - `{ op: 'extract-audio'; format: AudioFormat; inSec?; outSec? }`, `-vn -c:a <codec>` (audio codec from `AUDIO_FORMATS`) + optional `-ss/-to` span. Output is an audio file (audio ext).
- **Whitelists / typed validation** (the new fence surface):
  - `VIDEO_FORMATS`, `mp4` (libx264/aac), `webm` (libvpx-vp9/libopus), `mov`, `mkv`. Container + default video/audio codecs; the operator's picked container MUST be a key.
  - `VIDEO_VCODECS`, `libx264 | libx265 | libvpx-vp9`. The only allowed `-c:v` override; anything else is rejected before an arg is built.
  - **Resolution = `VideoResolution`** = a bounded preset (`'source' | '480p' | '720p' | '1080p'`, each mapping to a **fixed** scale filter `scale=-2:<h>` that we control) **OR** an explicit `{ w, h }` pair of validated positive integers (<= `VIDEO_DIM_MAX = 7680`), composed by us into `scale=<w>:<h>`. **Never** raw operator text into `-vf`.
- **`deriveOutputBasename`** now picks the target ext by op: `vconvert` -> the `VIDEO_FORMATS` container ext, `extract-audio` -> the chosen `AUDIO_FORMATS` ext, `vclip` (and the audio clip ops) -> the source ext.
- **On-disk video now plays:** `MediaModalHost` points the `VideoEditor` `src` at `/api/media/raw?...` for a contextual (on-disk) video open (same Range-able serve route H6 added); imported video uses its object URL. `onDiskMediaUnsupported` no longer fires for video, it's now only the rare contextual-open-without-fileContext edge (no cwd to confine against) for either audio or video.
- **Editor:** `client/src/components/media/VideoEditor/`, `VideoEditor.tsx` (native `<video>` preview + scrub + editable `IN`/`OUT` markers in `mm:ss.mmm` + SET IN/OUT from playhead; emits `onRegionChange` the host holds in a ref) and `VideoOpsPanel.tsx` (CLIP + re-encode toggle, CONVERT + format/resolution pickers, EXTRACT AUDIO + audio-format picker; POSTs `/api/media/op`, spinner + CANCEL, success path + REVEAL IN FILES via the `arco:reveal-in-files` event). Mirrors `AudioOpsPanel` one-for-one.

**Honest constraint (load-bearing):** same as H6, FFmpeg needs an **on-disk** source, so the video ops are enabled only for an on-disk (contextual) open; an **imported** video plays but disables the ops with an inline note. No blob upload this phase.

## H2, layer-based raster editor (port Odysseus's MIT editor) (shipped)

Both parts shipped. **Part 1** is the server-side foundation, the guarded write
endpoint the editor SAVES through (below). **Part 2** is the editor-UI port, the
MIT-licensed Odysseus raster editor vendored under
`client/src/vendor/odysseus-editor/` and mounted by a thin React wrapper
(`client/src/components/media/ImageEditor/`). ALPHA-grade: a functional-but-rough
vertical slice.

### Image write endpoint (H2 part 1, shipped)

Route: `server/src/http/imageWriteRoutes.ts`. Pure-fs, **no subprocess, no shell**. The image editor encodes its canvas to a `data:image/<png|jpeg|webp>;base64,...` URL and POSTs it; this route decodes, confines the target path to the workflow cwd, enforces an image extension, and writes.

`POST /api/image/write`, body `{ cwd?, workflowId?, path, dataUrl, overwrite? }` -> `ImageWriteResult` (`{ ok:true, relPath, bytes }` on success, else `{ ok:false, code, error }`). Always HTTP 200 for an operator-visible condition; only an unexpected bug is a 500. Full request/response contract: `docs/HTTP_API.md § Image write`.

**The three load-bearing fences:**
1. **`resolveWithinCwd`**, THE confinement gate (the same guard as the Write tools / media ops). A `../` / absolute-outside / trailing-sep-sibling path throws -> rejected (`code:'path-escape'`) **before any write touches disk**. The server can never write outside the resolved cwd.
2. **Overwrite-confirm**, an existing target is **never** replaced unless the caller passes `overwrite:true`; otherwise `code:'exists'` and nothing is written. A brand-new filename writes unconditionally (creating confined parent dirs, mirroring `fileWriteRoutes`).
3. **Decoded-size cap**, a runaway data URL can't OOM the server: anything decoding past 64 MiB is rejected (`code:'too-large'`), with a cheap base64-length pre-check so no oversize Buffer is ever allocated.

The data URL is parsed defensively: a non-image mime / malformed URL / empty payload -> `code:'bad-image'`; a non-image target extension -> `code:'bad-ext'`; no resolvable cwd -> `code:'no-cwd'`. Supported types: `image/png`, `image/jpeg`, `image/webp` (extensions `.png` / `.jpg` / `.jpeg` / `.webp`).

Types: `ImageWriteRequest` / `ImageWriteResult` / `ImageWriteErrorCode` in `shared/src/protocol/media.ts`. Smoke: `npm run smoke:image-write` (drives the handler directly against a temp cwd, no server / WS).

### Editor UI (H2 part 2, shipped)

**Credit:** the editor is **vendored from the MIT-licensed Odysseus project**
(Copyright (c) 2025 Odysseus Contributors). The vendored tree
(`client/src/vendor/odysseus-editor/`) keeps the upstream `LICENSE` verbatim and a
`VENDOR.md` documenting provenance + every Arco patch. `size:check` excludes
`vendor/` (third-party, not a refactor target).

**Mount.** `MediaModalHost` image mode shows the zoom/pan viewer by default; an
**EDIT** button in the header toggles to the raster editor (and back via **VIEW**).
The wrapper (`ImageEditor.tsx`) renders a `<div id="gallery-editor-container">`,
then in a post-mount effect dynamically `import()`s the vendored `galleryEditor.js`
and calls `openEditor(src, ...)`, loading the current image (on-disk dataURL or
imported object URL) as the base layer. Unmount calls `closeEditor()`. The dynamic
import code-splits the ~3.8k-line editor into its own bundle chunk.

**Tools available** (Odysseus toolset, all client-side canvas): Move, Crop,
Transform, Brush, Eraser, Clone, Lasso, Wand (smart-ish select), per-tool
opacity/flow/softness, **Layers** (add/reorder/merge/flatten, opacity, blend),
filters (blur / edge-feather / adjustments / histogram), Undo-Redo, History panel,
Import (file / clipboard / drag-drop), keyboard shortcuts. The editor's internal
toolbar buttons live in vendored JS (no React `data-help` is possible on them), so
they are documented here rather than in the contextual-help registry.

**The ai-* exclusion (H3 deferred).** The 5 AI modules (`ai-inpaint`, `ai-rembg`,
`ai-models`, `ai-tool-runner`, `ai-tools-misc`) are **not vendored**, local image
AI (background-remove / smart-select / inpaint) is deferred. Their imports in
`galleryEditor.js` are replaced by local no-op stubs, so the **Bg Remove** /
**Inpaint** / AI-tool buttons degrade to no-ops (the Wand "Bg Remove" hits a
graceful early-return + toast, no crash, no fetch). `wire-inpaint-controls.js` is
a **core mask-UI** module and is kept. Full patch log + the H3 revival recipe:
`client/src/vendor/odysseus-editor/VENDOR.md`.

**Load / Save flow.**
- **Load**, `openEditor(imageSrc)` loads the modal's current image as the base
  layer. Contextual open (right-click a PNG in FILES) -> the on-disk dataURL;
  standalone Import -> a browser object URL.
- **Save**, the wrapper's **SAVE** button calls the vendored `exportPNG()`
  (`flatten().toDataURL('image/png')`) and POSTs the dataURL to the part-1
  `/api/image/write` endpoint. A contextual open defaults the target to the
  original path and tries `overwrite:false` first; on `code:'exists'` it prompts to
  confirm and retries with `overwrite:true`. An imported / no-disk-path image
  prompts for a new cwd-relative filename. On success the new file is revealed in
  FILES. The editor's **own** gallery/draft save paths (`/api/gallery/upload`,
  `/api/gallery/{id}/replace`, `/api/editor-drafts`) are **neutralized** in the
  vendored copy, Arco never writes through `/api/gallery/*`.

**Theme.** `editor.css` re-points Odysseus's CSS tokens (`--bg --fg --panel
--border --red --accent ...`) at Arco's vars (`--color-bg`,
`--color-accent-primary`, `--color-border-bright`, ...), scoped to
`#gallery-editor-container`, so the editor inherits the active Arco theme.

**Smoke:** `npm run smoke:image-editor-vendor`, fs + string assertions that the
vendor obeys the H2/H3 contract (no ai-* files, no live ai-* import, LICENSE +
VENDOR.md present, no live fetch to a non-existent backend, save seam intact). The
editor UI itself can't be smoked headlessly (canvas/DOM).

**Known rough edges (alpha):** the detachable History / FX popups don't dock
(modalManager is a no-op shim); the editor's own "Save to gallery" / draft /
gallery-picker buttons are inert (use the wrapper's SAVE / Import instead);
Save-As uses a plain `window.prompt`.

## H4, image generation (Codex-only route) (shipped)

**Route decided 2026-05-31:** image generation rides the **Codex app-server**
`image_generation_call` path. No local diffusion, no separate image API key, no
billing, it's the closest thing to "ChatGPT image gen through Arco," and it
piggybacks the operator's Codex subscription. (The full local-diffusion / image-AI
arc from earlier drafts is *not* this phase.)

### Prompt -> image flow (alpha)

There is no dedicated "Generate" panel for alpha. The operator generates an image
by asking a **Codex tab on the `appserver` transport** to produce one, e.g.
"generate an image of a neon cat", during a normal turn. When Codex runs an
`image_generation_call`, the app-server surfaces an `imageGeneration` thread item,
and Arco renders + persists it (below). Switch a tab to the app-server transport
in CONFIG -> TRANSPORT (or set the Codex transport default).

### Render + persist + open-in-editor

1. **Persist (server).** `server/src/providers/codex-appserver/worker.ts` handles
   the `imageGeneration` item on `item/completed` via an async
   `handleImageGeneration()` (kicked off fire-and-forget so the `tryDrainSteer()`
   drain hook still fires synchronously, see `docs/PROVIDERS.md § Codex`). The
   pure core lives in `server/src/providers/codex-appserver/imageGen.ts`
   (`resolveGeneratedImageTarget`): if the item carries a `savedPath` inside the
   workflow cwd it's surfaced as-is; otherwise the base64 `result` is decoded and
   written to a generated `codex-image-<shortId>.png` inside cwd. Every path is
   confined with `resolveWithinCwd` (an escaping `savedPath` falls back to decoding
   the bytes in-cwd, never surfaces an out-of-cwd path). Pure fs, no subprocess.
2. **Render (inline).** On success the worker emits a `primary_artifact`
   (`kind:'image'`, cwd-relative `path`, `title` = the revised prompt) that flows
   worker -> `CodexAppServerTurn` -> `WorkerManager` -> `seedWorker` -> broadcast, so it
   renders in the artifact modal and lands in `events.jsonl` (survives replay /
   resume). A `tool_use` (`image_generation`) is surfaced too so the Activity tab
   shows it.
3. **Open in editor.** The image artifact carries `openInEditor: true`; the
   `ArtifactModal` header shows an **OPEN IN EDITOR** button (`data-help`
   `artifact.open-in-editor`) that opens the H2 raster editor on the saved path
   (`openImageForEdit` -> `mediaStudio.edit`), where the operator edits and re-saves
   through the guarded `/api/image/write` path. Round-trips the studio: generate
   (Codex) -> edit -> save.

### LIVE-SHAPE CAVEAT (read before trusting this end-to-end)

The Codex `image_generation_call` RPC shape is flagged **"unproven"** in the
upstream manual. This phase is implemented against the vendored binding
(`server/src/providers/codex-appserver/bindings/v2/ThreadItem.ts`: `{ type:'imageGeneration', id, status, revisedPrompt,
result, savedPath? }`) and is **validated against a synthetic/captured fixture**
(`scripts/smoke/image-gen-codex.ts`), **not** a live Codex generation. The
render/persist/open-in-editor vertical is complete and unit-tested; **live-shape
validation still needs an operator to run a real Codex image generation** and
confirm the item arrives as the binding describes. If the live shape differs
(e.g. `result` is a data-URL or the field names drift), `decodeGeneratedImage`
tolerates a `data:...;base64,` prefix but the binding may need a regen + a paired
worker tweak.

## N2, universal file access: scratch + any-path + save dialog (shipped 2026-06-02)

The studio becomes a **general media tool**, not one fenced to a workflow folder. Two long-standing blockers, both fixed:

1. **An imported (object-URL) file could play but not be operated on**, ffmpeg reads files, not blobs. Now an imported file is **staged to Arco scratch** (`POST /api/media/scratch`) and the op runs against the on-disk copy.
2. **A file outside the workflow cwd couldn't be reached at all**, both the op route and `/raw` confined every path to the cwd. Now a tiered access fence permits arbitrary paths when the operator opts in.

Operator-facing behavior lives in the `media-studio` manual section. HTTP shapes in `HTTP_API.md § Media ops`; the load-bearing invariants are in `GOTCHAS.md § Media access fence`.

### The access fence (the security core)

`server/src/media/ffmpeg.ts::resolveMediaInput` / `resolveMediaOutputDir` replace the single `resolveWithinCwd` gate with **three tiers**, checked in order:

1. **Inside the workflow cwd** -> always allowed (the pre-N2 behavior, unchanged).
2. **Inside Arco's media-scratch** (`~/.arco/media-scratch/`) -> always allowed regardless of the setting, the operator put the file there through the upload endpoint.
3. **Anywhere else** -> allowed **only** when `mediaUnconfined !== false` (Settings -> Media; default open). Otherwise rejected with `code: 'bad-path'`.

`unconfined: false` reproduces the pre-N2 fence **exactly** (cwd + scratch only), which is why the positional `runMediaOp(cwd, path, spec)` form the audio/video smokes use, no `opts` => `unconfined` defaults to `false`, still rejects `/etc/hosts` and `../../` escapes. The setting is read per-op from the cascade (`readSettings(cwd)`), so a project `.arco/settings.json` can pin it. **Default-open matters because Arco can be tunnelled**, the operator switches to CONFINED on an exposed instance.

### Scratch storage

`server/src/media/scratch.ts`, `~/.arco/media-scratch/<uuid>/<sanitized-name>`. `saveScratchUpload` streams the request body to a fresh per-upload dir (so the write can't escape no matter what `?name=` contains), enforces a **per-upload byte cap** (4 GiB) mid-stream, and reaps on a **24h TTL** + a **total-size cap** (16 GiB, oldest evicted) after every upload. `isWithinScratch` is the read-side tier-2 gate. Scratch is disposable, the reaper clears it; the operator can delete the dir at any time.

### Output destination (save dialog)

`MediaOpRequest.output?: { dir?, basename? }`. `dir` (absolute or cwd-relative) is gated by the **same three tiers** as the input and must already exist (`code: 'output-dir-missing'` otherwise, we never `mkdir` arbitrary paths). `basename` keeps the operator's **stem** but **forces the op's target extension** (`outputBasenameFor` + `targetOutputExt`), so a convert->MP3 named `take.wav` still lands as `take.mp3`. The output is always **uniquified** and the `outputAbs === inputAbs` refusal + ffmpeg `-n` still guarantee the source is never overwritten. `relPath` is returned **only** for an in-cwd output (drives REVEAL IN FILES); a scratch / arbitrary-path output returns just the absolute `outputPath`.

### Client

- **Shared op helper:** `client/src/components/media/postMediaOp.ts`, resolves the input (on-disk path as-is, or upload the imported `File` to scratch first), then POSTs the op with the chosen output. Used by both ops panels.
- **Save controls:** `client/src/components/media/MediaSaveControls.tsx`, a collapsed "SAVE TO..." row (destination dir + filename), shared by audio + video panels.
- **Imported files now enable ops:** `AudioOpsPanel` / `VideoOpsPanel` take an `importedFile` prop; `MediaModalHost` holds the imported `File` and passes it through. `enabled` is true for an on-disk **or** imported source.
- **Settings toggle:** `SettingsPanel` -> MEDIA ACCESS (`● UNCONFINED` / `○ CONFINED`), POSTs `{ mediaUnconfined }`.

### Smoke

`scripts/smoke/media-scratch.ts` (`npm run smoke:media-scratch`, ffmpeg-optional), asserts the resolver tiers (confined rejects out-of-cwd / allows in-cwd / always allows scratch; unconfined allows arbitrary), scratch basename sanitization + upload, output-name extension forcing, and (with real ffmpeg) a CONFINED out-of-cwd op rejected vs an UNCONFINED one honored with a chosen dir/name, a scratch op running with the fence LOCKED, and `output-dir-missing`. The existing `audio-ops` / `video-ops` smokes still pass unchanged (positional signature + default-confined preserved).

## N3, Advanced ffmpeg ops

Eight new **render ops** fold into the existing typed-spec -> argv path (`buildArgs` extends exhaustively; `validateSpec` validates each), plus a read-only **inspect** that is deliberately *not* an op (it produces no file). Every operator value remains a validated number (clamped to a shared bound) or a whitelisted enum, no operator string ever reaches a filter or a flag.

| Op | Spec | ffmpeg | Output |
|---|---|---|---|
| `framegrab` | `atSec`, `format` (png/jpeg) | `-ss <t> -i ... -frames:v 1 -update 1` | a still image |
| `gif` | `inSec`,`outSec`,`fps?`,`width?`,`format?` (gif/webp) | `-ss/-t` window + `fps,scale,split->palettegen->paletteuse` (gif) | looping animation |
| `geometry` | `xform`: crop / rotate / flip / resize | a **fixed** `-vf` (`crop=...` / `transpose` / `hflip`/`vflip` / `scale=...`) | same container |
| `speed` | `factor` (0.25-4), `video` | `-af` `atempo` chain (pitch-preserved) `+ -vf setpts=PTS/factor` when `video` | same container |
| `gain` | `db` (-60...+30) | `-af volume=<db>dB` | same container |
| `spectrogram` | `width?`,`height?` | `-lavfi showspectrumpic=s=WxH` | a png of the sound |
| `join` | `extraInputs[]`, `video` | N `-i` + `-filter_complex ...concat=n=N...` (re-encode) | primary's container |
| `swap` | `action`: mute / replace | mute `-c copy -an`; replace 2 inputs + `-map 0:v:0 -map 1:a:0 -c:v copy -shortest` | same container |

**Load-bearing fences (the same ones the director reads `ffmpeg.ts` for):**

- **Multi-input ops obey the N2 fence per input.** `specExtraInputs(spec)` lifts `join.extraInputs` / `swap.replace.audioPath`; `runMediaOp` resolves + gates **each** through `resolveMediaInput` and stats it as a file *before any path reaches `buildArgs`*. So an out-of-cwd join/swap input is rejected exactly like the primary when the fence is locked (`media-advanced-ops` asserts both reject-when-locked and run-when-unconfined). `buildArgs` receives only **resolved abs paths**, never the raw spec strings.
- **Audio-vs-video is a panel-set boolean, not a probe and not free text.** `speed.video` / `join.video` decide whether a video filtergraph (`setpts`, `[i:v]` concat labels) is added. The AUDIO panel sends `false`, the VIDEO panel `true`, so an audio file never gets a `-vf`/`[:v]` it has no stream for. (A *silent* video + `speed` is the one rare edge; it surfaces as a structured `ffmpeg-failed`, not a crash.)
- **`inspect` writes no file** and so is its own endpoint (`POST /api/media/inspect` -> `inspectMedia`), not a `MediaOpSpec`. It resolves + gates the path the same way, runs `ffprobe -print_format json -show_format -show_streams`, and projects the result to a curated `MediaInspectResult` (the panel renders it inline). `buildArgs` therefore stays *total over render ops*.
- **Output naming/uniquification is unchanged**, the new media-producing ops just teach `targetOutputExt` their real extension (framegrab -> the still ext, gif -> the anim ext, spectrogram -> `.png`); everything else keeps the source container. The never-overwrite-source invariant holds across all of them.

### Client

- **`MediaAdvancedOps.tsx`**, one shared component (audio + video) for the single-input ops (framegrab / gif / geometry / speed / gain / spectrogram), `swap`-MUTE, and the inline **INSPECT** readout. It runs everything through the panel's existing `runOp(spec)` (so source-staging + SAVE TO... + status are reused); INSPECT alone goes through `postMediaInspect` (no file). Numeric inputs clamp to the shared bounds before building the spec.
- **`postMediaOp.ts`** gains `resolveServerPath` (shared on-disk/import-staging) + `postMediaInspect`.
- **Deferred:** `join` / `swap`-replace have no operator surface yet (they need a second-file picker + extra-input scratch staging). Their **server core + smoke are shipped**, only the UI wiring remains.

### Smoke

`scripts/smoke/media-advanced-ops.ts` (`npm run smoke:media-advanced-ops`, ffmpeg-optional), a PURE half (validateSpec accepts good / rejects out-of-range + bad enums + malformed multi-input; `buildArgs` emits the **exact** argv per op; `targetOutputExt` per op) and a REAL-ffmpeg half (each op produces a correct output on a generated fixture; `inspect` returns curated facts and writes no file; a join whose extra input is out-of-cwd is rejected when locked, accepted when unconfined). 20/20.

## N4, Demucs stem separation

True AI source separation (vocals / drums / bass / other, or a two-stems karaoke split) via the local **Demucs** CLI. It is **not** a `MediaOpSpec`, it's a separate runner (`server/src/media/demucs.ts`) behind `POST /api/media/stems`, because it's long-running, GPU-accelerated, and emits **multiple** output files. It reuses the **same N2 access fence** (`resolveMediaInput` / `resolveMediaOutputDir`) for the input + output-parent dir.

**Flow:** validate the whitelisted enums (`STEM_MODELS` / `STEM_NAMES` / `STEM_FORMATS`) -> gate the input -> presence-check demucs -> gate the output parent (must exist) -> create a **fresh uniquified `<track>.stems[-N]/`** dir -> `spawn('demucs', argv)` -> flatten demucs's forced `<model>/` subdir up into the stems dir -> collect the stem files (with `relPath`s for reveal). `buildDemucsArgs` is PURE (`-o <dir> -n <model> --filename {stem}.{ext} [--mp3|--flac] [--two-stems <name>] <track>`); the **track is positional and last**; no operator string reaches the argv.

**Load-bearing rules** (see also `docs/GOTCHAS.md § Demucs stem separation`):

- **Same fence, re-keyed errors.** The shared resolver throws `MediaOpError('bad-path')`; `runDemucsStems` runs it through `gateOrThrow`, which re-throws as `DemucsError('bad-path')` so the route's `instanceof DemucsError` branch returns a structured `200`, not a `500`. (The smoke asserts the out-of-cwd input is rejected when locked, accepted when unconfined.)
- **Fresh dir per run; cancel rm's it whole.** Output never clobbers a prior run or the source, we mkdir a fresh `<track>.stems[-N]/` we own, so a cancel/failure `fs.rm`s the *entire* dir (no partials). Cancel SIGKILLs the demucs child.
- **No timeout, cancel is the escape hatch.** A long separation is normal; `runDemucs` (spawn) has no timeout and bounds the stderr tail. **Device is auto** (no forced `-d` -> cuda-if-available else cpu; keeps it cross-platform).
- **Format caveat (`torchcodec`).** mp3 (lameenc) is the default and always works. wav/flac route through torchaudio's `save_with_torchcodec` on some builds, if `torchcodec` is absent the runner detects the failure and returns a clear hint (use mp3, or add torchcodec with the system package manager). See `docs/OPERATIONS.md § Demucs`.
- **Audited.** Success/failure broadcasts `media_stems_result` -> `events.jsonl` (sibling of `media_op_result`; stems aren't a `MediaOpKind`).

### Client

`MediaStemsControls.tsx` in the **audio panel**, model / target (ALL or a two-stems isolate) / format selects + a **SEPARATE ->** button with its own long-job status (running + CANCEL, done = the stem list + REVEAL, error = the structured code/hint). `postMediaStems` (in `postMediaOp.ts`) resolves the source the same way (import -> scratch) and POSTs the run.

### Smoke

`scripts/smoke/demucs.ts` (`npm run smoke:demucs`, demucs-optional) has a pure validation/argv suite and an optional real-demucs pass. The suite checks the four-stem and two-stem output layouts, fresh output directories, locked/unconfined path behavior, and missing output directories. Runtime and quality depend on the installed model and hardware.

## Operator affordances (N-series polish)

UI niceties added while testing N1-N4. All client-only; no protocol surface.

- **Movable in-modal HelpCard.** `client/src/components/help/HelpCard.tsx`, the `? HELP` button on a tool modal opens a draggable, filterable card listing just that tool's help snippets. **Load-bearing:** it is **portalled to `document.body`** at **z-index 9550** (above the media modal `9400` + cookbook `9500`, below tooltips `9600` / drag+notifications `9999`). The original `z-index:2000`-in-the-app-tree rendered it *behind* the modal, darkened by the backdrop, don't revert either the portal or the z-index.
- **UNLOAD.** `MediaModalHost.clearSource()` drops the current source back to the Import affordance without leaving the modal or switching mode (revoke the object URL, clear path + image payload, reset viewer/region). `switchMode` shares it.
- **Folder picker for save (`DirectoryPicker.tsx`).** `useDirectoryPicker()` is a promise-driven modal over `/api/list-dirs` + `/api/mkdir` (navigate, ^ up, new folder, optional filename) -> `{ dir, basename }`. Replaces the typed SAVE TO... fields. **An imported source with no destination pops it on op-run** (a real Save-As, no silent scratch); on-disk keeps "next to source". Owned by each ops panel and shared with `MediaSaveControls` + `MediaStemsControls` + each panel's `runOp`.
- **Clickable output -> load (`loadOutputPath`).** The `✓ <path>` result line is a button: it loads the output back in as the new source (classify by ext -> switch mode + point `activePath` at the absolute output). **Load-bearing serve change:** `MediaModalHost`'s `serveUrl()` builds `/api/media/raw?path=...` for an **absolute** path with **cwd optional** (the route gates it cwd | scratch | unconfined), so a result in scratch / a chosen dir streams; an absolute image path uses the raw route while a **relative** cwd path still uses `/api/file-content` (the artifacts-dir fallback path). Don't re-require `fileContext` on the serve URLs.
- **<- BACK.** `loadOutputPath` snapshots the prior source (`prevSource`: mode + activePath + the imported `File`); the header `<- BACK` restores it (an imported source is re-imported from its retained File -> fresh object URL; an on-disk one is rebound). Single-level; cleared on UNLOAD / mode switch.

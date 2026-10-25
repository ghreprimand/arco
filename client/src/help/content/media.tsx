import { C } from './shared';
import type { HelpEntry } from './shared';

// WORKBENCH_EXPANSION §H1 — contextual help for the Media studio entry points
// and enhanced image viewer. Every key here is a data-help attribute on the
// header MEDIA button, the FileExplorer media context menu, or the
// MediaModalHost controls. All link to the 'media-studio' manual section.

const S = 'media-studio';

export const mediaHelp: Record<string, HelpEntry> = {
  'header.media': {
    title: 'Media studio',
    body: (
      <p>
        Opens the <strong>Media studio</strong> — a viewer/player for images,
        audio and video. Opens <strong>empty</strong> here (then drag-drop or{' '}
        <strong>Import</strong> a file); or right-click a media file in{' '}
        <strong>FILES</strong> to open it directly.
      </p>
    ),
    manualSection: S,
  },
  'files.media-context': {
    title: 'Open in media editor',
    body: (
      <p>
        Right-clicking a media file routes it to the matching mode of the Media
        studio. Images open in the enhanced viewer; audio/video open in the right
        mode (on-disk playback ships with the dedicated audio/video tools — until
        then, Import to play).
      </p>
    ),
    manualSection: S,
  },
  'media.mode': {
    title: 'Media mode switch',
    body: (
      <p>
        Flip the studio between <C>IMAGE</C>, <C>AUDIO</C>, and <C>VIDEO</C> in
        place. Each mode has its own editor and FFmpeg ops. Switching clears the
        current source (any imported file is released) so the new mode opens
        ready to import or to receive a file opened from the Files panel.
      </p>
    ),
    manualSection: S,
  },
  'media.back': {
    title: 'Back to previous file',
    body: (
      <p>
        Appears after you click an op's output to load it (e.g. a spectrogram
        opens in image mode). <strong>← BACK</strong> restores the file you were
        working on before — so previewing a result is non-destructive. An
        imported source is re-loaded from its blob; an on-disk file is rebound.
      </p>
    ),
    manualSection: S,
  },
  'media.unload': {
    title: 'Unload the file',
    body: (
      <p>
        Drop the current source and return to the <strong>Import</strong>
        affordance — <em>without</em> closing the studio or switching mode. Any
        imported blob is released; an on-disk file is just unbound (the file on
        disk is untouched). Handy for loading a different file in the same mode.
      </p>
    ),
    manualSection: S,
  },
  'media.import': {
    title: 'Import a file',
    body: (
      <p>
        Drag-drop a file here or use <strong>IMPORT…</strong> to load one from the
        browser. Filtered to the active mode (image / audio / video). Imported
        files use a browser object URL — nothing is written to disk.
      </p>
    ),
    manualSection: S,
  },
  'media.viewport': {
    title: 'Image viewport',
    body: <p>Scroll-wheel to zoom, click-drag to pan. Use <C>FIT</C> / <C>1:1</C> in the header to reset.</p>,
    manualSection: S,
  },
  'media.zoom-in': {
    title: 'Zoom in',
    body: <p>Magnify the image (or use the mouse wheel). Caps at 800%.</p>,
    manualSection: S,
  },
  'media.zoom-out': {
    title: 'Zoom out',
    body: <p>Shrink the image (or use the mouse wheel). Floors at 10%.</p>,
    manualSection: S,
  },
  'media.fit': {
    title: 'Fit to window',
    body: <p>Reset zoom + pan so the whole image fits the viewport.</p>,
    manualSection: S,
  },
  'media.one-to-one': {
    title: 'Actual pixels (1:1)',
    body: <p>Show the image at its native pixel size — one image pixel per screen pixel.</p>,
    manualSection: S,
  },
  'media.dimensions': {
    title: 'Image dimensions',
    body: (
      <p>
        The image's natural width × height in pixels, read from the loaded image.
        EXIF metadata isn't shown yet — it's deferred to the image-editor phase.
      </p>
    ),
    manualSection: S,
  },

  // — Image editor (H2) —
  'media.edit': {
    title: 'Edit image',
    body: (
      <p>
        Switch from the viewer to the <strong>raster editor</strong> (vendored
        from the MIT-licensed Odysseus editor): layers, brush / eraser / clone,
        crop, transform, lasso / wand selection, filters, undo-redo and history.
        Click again (<C>VIEW</C>) to return to the zoom/pan viewer. The AI tools
        (background-remove / inpaint) are deferred — they degrade to no-ops.
      </p>
    ),
    manualSection: S,
  },
  'media.save': {
    title: 'Save the edited image',
    body: (
      <p>
        Flatten the layers and write the result through Arco's guarded{' '}
        <C>/api/image/write</C> endpoint (path-confined to the workflow cwd). A
        file opened from <strong>FILES</strong> saves over the original (with an
        overwrite confirm); an imported image asks for a new filename. On success
        the new file is revealed in the FILES panel.
      </p>
    ),
    manualSection: S,
  },

  // — Generated-image artifact (H4) —
  'artifact.open-in-editor': {
    title: 'Open in editor',
    body: (
      <p>
        Opens this <strong>generated image</strong> (produced by a Codex{' '}
        <C>image_generation_call</C> and saved into the workflow cwd) straight in
        the <strong>raster editor</strong> — the same H2 editor as right-click →
        Edit in <strong>FILES</strong>. From there you can edit and re-save through
        the guarded write path. The image is already on disk; no separate API key
        or billing is involved (it rides the Codex subscription).
      </p>
    ),
    manualSection: S,
  },

  // — Audio editor (H5) —
  'media.waveform': {
    title: 'Audio waveform',
    body: (
      <p>
        The decoded waveform of the imported audio (wav / mp3 / ogg / flac / m4a /
        aac). Click anywhere to <strong>seek</strong> there. Decoding happens in
        the browser — nothing is sent to the server.
      </p>
    ),
    manualSection: S,
  },
  'media.transport': {
    title: 'Playback transport',
    body: <p>Play / pause and the current-time / total-duration readout. Click the waveform to scrub.</p>,
    manualSection: S,
  },
  'media.region': {
    title: 'Region selection',
    body: (
      <p>
        One selectable region marks the in/out for a clip. Drag its handles on the
        waveform, or type exact times in the <C>IN</C> / <C>OUT</C> fields. The
        clip &amp; convert ops that consume this selection arrive with H6 (FFmpeg).
      </p>
    ),
    manualSection: S,
  },
  'media.region-in': {
    title: 'Region start (in)',
    body: <p>The selection start as <C>mm:ss.mmm</C>. Editing it moves the left handle; dragging the handle updates this. Clamped to the region end.</p>,
    manualSection: S,
  },
  'media.region-out': {
    title: 'Region end (out)',
    body: <p>The selection end as <C>mm:ss.mmm</C>. Editing it moves the right handle; dragging the handle updates this. Clamped to the clip duration.</p>,
    manualSection: S,
  },

  // — Audio FFmpeg ops (H6) —
  'media.ops-disabled': {
    title: 'FFmpeg ops need a loaded file',
    body: (
      <p>
        Clip / convert / normalize run <strong>server-side via FFmpeg</strong>.
        They need a loaded source — <strong>Import a file</strong> (it's staged to
        Arco's scratch area first) or open one from the <strong>FILES panel</strong>{' '}
        (right-click → Open in Audio editor). With nothing loaded the ops stay
        disabled.
      </p>
    ),
    manualSection: S,
  },
  'media.op-clip': {
    title: 'Clip to selection',
    body: <p>Trim the audio to the current <C>IN</C>/<C>OUT</C> region and write a new <C>.clip</C> file (stream-copied — fast and lossless). The source is never modified.</p>,
    manualSection: S,
  },
  'media.op-convert': {
    title: 'Convert format',
    body: <p>Re-encode the audio to the format chosen in the picker (wav / mp3 / ogg / flac / m4a / aac), writing a new file. Lossy formats also take a bitrate.</p>,
    manualSection: S,
  },
  'media.op-normalize': {
    title: 'Normalize loudness',
    body: <p>Apply EBU R128 loudness normalization (<C>loudnorm</C>), writing a new <C>.normalized</C> file.</p>,
    manualSection: S,
  },
  'media.op-mono': {
    title: 'Downmix to mono',
    body: <p>Mix the audio down to a single channel, writing a new file.</p>,
    manualSection: S,
  },
  'media.op-stereo': {
    title: 'Upmix to stereo',
    body: <p>Render the audio as two channels, writing a new file.</p>,
    manualSection: S,
  },
  'media.format': {
    title: 'Target format',
    body: <p>The container/codec the <strong>CONVERT</strong> op re-encodes to. One of a fixed whitelist (wav / mp3 / ogg / flac / m4a / aac).</p>,
    manualSection: S,
  },
  'media.bitrate': {
    title: 'Bitrate',
    body: <p>The encode bitrate for a lossy target (mp3 / ogg / m4a / aac). Picked from a bounded set (96k–320k). Lossless targets (wav / flac) ignore it.</p>,
    manualSection: S,
  },
  'media.op-cancel': {
    title: 'Cancel the op',
    body: <p>Abort the running FFmpeg op. The server kills the child process and deletes any partial output — nothing half-written is left behind.</p>,
    manualSection: S,
  },
  'media.op-reveal': {
    title: 'Reveal in Files',
    body: <p>Switch the right panel to the FILES explorer so you can see the newly-written output file.</p>,
    manualSection: S,
  },

  // — Video editor (H7) —
  'media.video-preview': {
    title: 'Video preview',
    body: (
      <p>
        Native <C>&lt;video&gt;</C> playback. On-disk video streams through the
        guarded <C>/api/media/raw</C> route (path-confined, Range-able so you can
        seek); imported video plays straight from the browser. Scrub with the
        built-in controls.
      </p>
    ),
    manualSection: S,
  },
  'media.video-transport': {
    title: 'Playback readout',
    body: <p>The current-time / total-duration readout. Use the video element's own controls to play/pause and scrub.</p>,
    manualSection: S,
  },
  'media.video-markers': {
    title: 'Clip markers (in/out)',
    body: (
      <p>
        The <C>IN</C> / <C>OUT</C> span a CLIP / EXTRACT AUDIO op trims to. Type
        exact times (<C>mm:ss.mmm</C>) or use <C>SET IN</C> / <C>SET OUT</C> to
        snap a marker to the current playhead.
      </p>
    ),
    manualSection: S,
  },
  'media.video-in': {
    title: 'Clip start (in)',
    body: <p>The clip start as <C>mm:ss.mmm</C>. Clamped to the out marker.</p>,
    manualSection: S,
  },
  'media.video-out': {
    title: 'Clip end (out)',
    body: <p>The clip end as <C>mm:ss.mmm</C>. Clamped to the clip duration and the in marker.</p>,
    manualSection: S,
  },
  'media.video-set-in': {
    title: 'Set in from playhead',
    body: <p>Snap the <C>IN</C> marker to the current scrub position.</p>,
    manualSection: S,
  },
  'media.video-set-out': {
    title: 'Set out from playhead',
    body: <p>Snap the <C>OUT</C> marker to the current scrub position.</p>,
    manualSection: S,
  },
  'media.video-ops-disabled': {
    title: 'FFmpeg ops need a loaded file',
    body: (
      <p>
        Clip / convert / extract-audio run <strong>server-side via FFmpeg</strong>.
        They need a loaded source — <strong>Import a file</strong> (it's staged to
        Arco's scratch area first) or open one from the <strong>FILES panel</strong>{' '}
        (right-click → Open in Video editor). With nothing loaded the ops stay
        disabled.
      </p>
    ),
    manualSection: S,
  },
  'media.video-op-clip': {
    title: 'Clip to markers',
    body: <p>Trim the video to the <C>IN</C>/<C>OUT</C> markers, writing a new file. By default this is a fast, lossless stream copy; tick RE-ENCODE for a frame-accurate cut. The source is never modified.</p>,
    manualSection: S,
  },
  'media.video-reencode': {
    title: 'Re-encode the clip',
    body: <p>Stream-copy (default) is fast and lossless but cuts at the nearest keyframe. RE-ENCODE transcodes for a frame-accurate cut at the exact in/out — slower, and re-encodes the video.</p>,
    manualSection: S,
  },
  'media.video-op-convert': {
    title: 'Convert container/codec/resolution',
    body: <p>Re-encode the video to the picked container (mp4 / webm / mov / mkv) at the chosen resolution preset, writing a new file. Codecs come from a fixed whitelist per container.</p>,
    manualSection: S,
  },
  'media.video-format': {
    title: 'Target container',
    body: <p>The output container the <strong>CONVERT</strong> op writes. One of a fixed whitelist: mp4 (H.264/AAC), webm (VP9/Opus), mov, mkv.</p>,
    manualSection: S,
  },
  'media.video-resolution': {
    title: 'Target resolution',
    body: <p>Scale the output to a bounded preset (480p / 720p / 1080p) or keep the SOURCE resolution. The preset maps to a fixed scale filter — never free text.</p>,
    manualSection: S,
  },
  'media.video-op-extract-audio': {
    title: 'Extract audio',
    body: <p>Strip the video stream and write the audio track to the chosen audio format (wav / mp3 / ogg / flac / m4a / aac). The source video is untouched.</p>,
    manualSection: S,
  },
  'media.video-audio-format': {
    title: 'Extracted-audio format',
    body: <p>The audio format the <strong>EXTRACT AUDIO</strong> op encodes to. Same whitelist as the audio editor's convert.</p>,
    manualSection: S,
  },
  'media.video-op-cancel': {
    title: 'Cancel the op',
    body: <p>Abort the running FFmpeg op. The server kills the child process and deletes any partial output — nothing half-written is left behind.</p>,
    manualSection: S,
  },
  'media.video-op-reveal': {
    title: 'Reveal in Files',
    body: <p>Switch the right panel to the FILES explorer so you can see the newly-written output file.</p>,
    manualSection: S,
  },

  // — Save destination (N2) —
  'media.save-to': {
    title: 'Save to…',
    body: <p>Opens a <strong>folder picker</strong> to choose where op output lands (navigate folders, make a new one, optionally name the file). Blank = next to the source — but an <em>imported</em> file would go to scratch, so running an op without a destination pops this picker automatically. A destination outside the workflow folder needs <strong>Unconfined media access</strong>.</p>,
    manualSection: S,
  },
  'media.op-output': {
    title: 'Output file (click to load)',
    body: <p>The freshly-written op output. <strong>Click it to load the result back into the studio</strong> as the new working file (a convert→WAV becomes the WAV you're editing; a spectrogram opens as an image). The path is shown so you know where it landed.</p>,
    manualSection: S,
  },

  // — Advanced ops (N3) —
  'media.op-speed': {
    title: 'Change speed',
    body: <p>Re-time the media by the factor in the box (0.25–4×). Audio tempo is <strong>pitch-preserved</strong> (<C>atempo</C>); a video also re-times the picture (<C>setpts</C>). Writes a new file.</p>,
    manualSection: S,
  },
  'media.op-gain': {
    title: 'Adjust gain',
    body: <p>Raise or lower the volume by the dB value in the box (−60…+30 dB), writing a new file. Negative attenuates, positive amplifies.</p>,
    manualSection: S,
  },
  'media.op-spectrogram': {
    title: 'Spectrogram',
    body: <p>Render the audio as a spectrogram image (<C>showspectrumpic</C>) — frequency over time — to a new <C>.png</C>. A picture of the sound, not an audio file.</p>,
    manualSection: S,
  },
  'media.op-inspect': {
    title: 'Inspect (ffprobe)',
    body: <p>Probe the file's streams, codecs, duration and bitrate via <C>ffprobe</C> and show them inline. <strong>Writes no file</strong> — it's a read-only readout.</p>,
    manualSection: S,
  },
  'media.video-op-framegrab': {
    title: 'Grab a frame',
    body: <p>Write the single frame at the <C>IN</C> marker to a still image (PNG / JPEG), writing a new file. A quick poster / thumbnail.</p>,
    manualSection: S,
  },
  'media.video-op-gif': {
    title: 'Make a GIF',
    body: <p>Animate the <C>IN</C>→<C>OUT</C> span to a looping <C>.gif</C> (or <C>.webp</C>) at the chosen fps and width. The GIF path builds a colour palette for quality. Writes a new file.</p>,
    manualSection: S,
  },
  'media.video-op-geometry': {
    title: 'Geometry transform',
    body: <p>Apply one geometry op — <strong>crop</strong> (w/h/x/y), <strong>rotate</strong> (90/180/270°), <strong>flip</strong> (h/v), or <strong>resize</strong> (bounded preset) — writing a new file. Every value is validated; the filter is built server-side, never from free text.</p>,
    manualSection: S,
  },
  'media.video-op-speed': {
    title: 'Change speed',
    body: <p>Re-time the video by the factor in the box (0.25–4×): the picture via <C>setpts</C> and the audio via a pitch-preserved <C>atempo</C> chain. Writes a new file.</p>,
    manualSection: S,
  },
  'media.video-op-mute': {
    title: 'Mute (drop audio)',
    body: <p>Write a copy of the video with the audio track removed (<C>-an</C>, video stream-copied — fast and lossless). The source is untouched.</p>,
    manualSection: S,
  },
  'media.video-op-inspect': {
    title: 'Inspect (ffprobe)',
    body: <p>Probe the video's streams, codecs, resolution, fps, duration and bitrate via <C>ffprobe</C> and show them inline. <strong>Writes no file.</strong></p>,
    manualSection: S,
  },

  // — Stem separation (N4, Demucs) —
  'media.op-stems': {
    title: 'Separate stems',
    body: <p>Run <strong>Demucs</strong> (GPU-accelerated AI source separation) to split the track into stems — vocals / drums / bass / other — written as new files in a fresh folder. Long-running; a progress line + CANCEL appear while it works.</p>,
    manualSection: S,
  },
  'media.stems-model': {
    title: 'Demucs model',
    body: <p>The pretrained model: <C>htdemucs</C> (default, 4 stems), <C>htdemucs_ft</C> (fine-tuned, slower/better), <C>htdemucs_6s</C> (adds guitar + piano), or the older <C>mdx_extra</C> bags. Whitelisted — never free text.</p>,
    manualSection: S,
  },
  'media.stems-target': {
    title: 'Stem target',
    body: <p><strong>ALL STEMS</strong> produces the model's full set. Picking a single stem does a <em>two-stems</em> split — that stem plus everything else (e.g. <C>VOCALS + REST</C> for a karaoke / acapella pair).</p>,
    manualSection: S,
  },
  'media.stems-format': {
    title: 'Stem format',
    body: <p>Output encoding for the stems. <strong>MP3</strong> is the default and the broadly-working path; <C>wav</C>/<C>flac</C> need the <C>torchcodec</C> package on some torchaudio builds (the server returns a clear hint if it's missing).</p>,
    manualSection: S,
  },
  'media.stems-cancel': {
    title: 'Cancel separation',
    body: <p>Abort the running Demucs job. The server kills the child process and removes the partial output folder — nothing half-written is left behind.</p>,
    manualSection: S,
  },
  'media.stems-reveal': {
    title: 'Reveal stems folder',
    body: <p>Switch the right panel to the FILES explorer to see the freshly-written stems folder.</p>,
    manualSection: S,
  },
};

import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Note } from '../../components/UserManual/components';

// WORKBENCH_EXPANSION §H1 + Arco Ops Part N (N1–N4) — Media studio manual
// section. Linked from every media.* / header.media HELP_CONTENT entry
// (docs:check enforces the link resolves). The media id below is the scoped
// target the in-modal <ModalHelpButton section="media-studio"> jumps to.

export const media: Section[] = [
  {
    id: 'media-studio',
    group: 'Power features',
    title: 'The Media studio — view, edit & convert images, audio, video',
    body: (
      <>
        <p>
          The <strong>MEDIA</strong> button in the header (and the{' '}
          <Code>Open Media studio</Code> command-palette entries) opens a modal
          tool for working with media files — a viewer/player plus real
          server-side <strong>FFmpeg</strong> editing and <strong>Demucs</strong>{' '}
          AI stem separation. Two ways in:
        </p>
        <ul>
          <li>
            <strong>Contextual</strong> — right-click a media file in the FILES
            explorer and choose <em>Open in Image / Audio / Video editor</em>. The
            studio opens with that file routed to the matching mode.
          </li>
          <li>
            <strong>Standalone</strong> — open the studio empty from the header or
            the command palette, then <strong>Import</strong> a file (drag-drop or
            the file picker). The <Code>IMAGE</Code> / <Code>AUDIO</Code> /{' '}
            <Code>VIDEO</Code> switch flips the mode in place.
          </li>
        </ul>
        <p>
          <strong>Imported files are fully editable.</strong> FFmpeg reads files
          from disk, not browser blobs — so an imported file is first staged into
          Arco's managed scratch area (<Code>~/.arco/media-scratch/</Code>),
          then every op runs against it. (An earlier version disabled ops for
          imported files; that limitation is gone.)
        </p>

        <h4>Image viewer & editor</h4>
        <p>
          Image mode is a proper viewer: <strong>zoom</strong> (the −/+ buttons or
          the mouse wheel), <strong>pan</strong> (click-drag), <strong>FIT</strong>{' '}
          and <strong>1:1</strong> (actual pixels), with a <strong>dimensions</strong>{' '}
          readout. <strong>EDIT</strong> swaps the viewer for a layer-based raster
          editor (crop / brush / filters / undo-redo); its <strong>SAVE</strong>{' '}
          writes through the guarded image-write endpoint with a Save-As path
          prompt. <em>EXIF metadata isn't shown yet</em> (needs an extra library).
        </p>

        <h4>Audio editor</h4>
        <p>
          The <strong>waveform</strong> (browser-decoded, themed) seeks on click; a{' '}
          <strong>transport</strong> plays/pauses with a time readout; a{' '}
          <strong>region</strong> with draggable in/out handles (or the{' '}
          <Code>IN</Code>/<Code>OUT</Code> fields) marks the selection a clip op
          trims to.
        </p>
        <p><strong>FFMPEG OPS:</strong></p>
        <ul>
          <li><strong>CLIP</strong> — trim to the region (fast, lossless stream copy).</li>
          <li><strong>CONVERT →</strong> — re-encode to a picked format (wav / mp3 / ogg / flac / m4a / aac); lossy targets take a bitrate.</li>
          <li><strong>NORMALIZE</strong> — EBU R128 loudness normalize.</li>
          <li><strong>MONO</strong> / <strong>STEREO</strong> — change the channel layout.</li>
        </ul>
        <p><strong>ADVANCED:</strong></p>
        <ul>
          <li><strong>SPEED ×</strong> — change tempo 0.25–4× (<em>pitch-preserved</em>).</li>
          <li><strong>GAIN dB</strong> — raise/lower volume (−60…+30 dB).</li>
          <li><strong>SPECTROGRAM</strong> — render the audio as a frequency-over-time image (a <Code>.png</Code>).</li>
          <li><strong>INSPECT</strong> — probe streams / codecs / duration / bitrate inline (writes no file).</li>
        </ul>

        <h4>Stem separation (Demucs)</h4>
        <p>
          <strong>SEPARATE →</strong> runs <strong>Demucs</strong> — GPU-accelerated
          AI source separation — into <strong>vocals / drums / bass / other</strong>,
          or a two-stems karaoke split (pick a single stem to isolate it + the rest).
          Choose the model, the target, and the output format (<strong>MP3</strong>{' '}
          is the default and broadly-working path). It's long-running: a progress
          state + <strong>CANCEL</strong> show while it works (cancel kills the job
          and removes the partial folder). Stems land in a fresh folder.
        </p>
        <Note>
          Demucs is <strong>optional</strong> — if it's not installed, SEPARATE
          returns a clear install pointer rather than failing. WAV/FLAC output
          needs the <Code>torchcodec</Code> package on some setups; MP3 always
          works. See the Operations doc.
        </Note>

        <h4>Video editor</h4>
        <p>
          Video mode gives native <Code>&lt;video&gt;</Code> playback plus clip
          markers (the <Code>IN</Code>/<Code>OUT</Code> fields or{' '}
          <Code>SET IN</Code> / <Code>SET OUT</Code> snap to the playhead).
        </p>
        <p><strong>FFMPEG OPS:</strong></p>
        <ul>
          <li><strong>CLIP</strong> — trim to the markers; lossless stream copy by default, tick <strong>RE-ENCODE</strong> for a frame-accurate cut.</li>
          <li><strong>CONVERT →</strong> — re-encode to a container (mp4 / webm / mov / mkv) at an optional resolution preset.</li>
          <li><strong>EXTRACT AUDIO →</strong> — strip the video, save the audio track to a chosen format.</li>
        </ul>
        <p><strong>ADVANCED:</strong></p>
        <ul>
          <li><strong>FRAME @ IN</strong> — grab the frame at the IN marker as a PNG/JPEG still.</li>
          <li><strong>GIF</strong> — animate the IN→OUT span to a looping gif/webp (fps + width).</li>
          <li><strong>GEOMETRY</strong> — crop / rotate / flip / resize.</li>
          <li><strong>SPEED ×</strong> — re-time the video (pitch-preserved audio).</li>
          <li><strong>MUTE</strong> — drop the audio track.</li>
          <li><strong>INSPECT</strong> — probe streams / codecs / resolution / fps (no file).</li>
        </ul>

        <h4>Where output is saved</h4>
        <p>
          Every op writes a <strong>new file</strong> — the source is never
          overwritten. <strong>SAVE TO…</strong> opens a <strong>folder picker</strong>{' '}
          (navigate folders, make a new one, optionally name the file). For an{' '}
          <em>imported</em> file (which would otherwise land in scratch), running an
          op with no destination set <strong>pops the picker automatically</strong> —
          a real Save-As. On-disk files default to writing next to the source.
        </p>
        <Note kind="warn">
          A destination <strong>outside the workflow folder</strong> needs{' '}
          outside-folder access and an explicit allowed folder in Settings,
          under MEDIA ACCESS. Access starts confined to the workflow folder,
          uploads and import scratch. Removing a folder or turning access off
          revokes the extra access on the next request.
        </Note>

        <h4>Working with results</h4>
        <ul>
          <li>
            A running op shows <strong>CANCEL</strong> (kills the FFmpeg child,
            deletes any partial output). On success the output path appears.
          </li>
          <li>
            <strong>Click the output path</strong> to load the result back into the
            studio as the new working file (a convert→WAV becomes the WAV you're
            editing; a spectrogram opens in image mode). <strong>← BACK</strong>{' '}
            restores the file you were on — previewing a result is non-destructive.
          </li>
          <li>
            <strong>REVEAL IN FILES</strong> (for an in-workflow output) jumps to the
            file in the FILES explorer.
          </li>
          <li>
            <strong>UNLOAD</strong> drops the current file back to the Import
            affordance without leaving the modal or switching mode.
          </li>
        </ul>
      </>
    ),
  },
];

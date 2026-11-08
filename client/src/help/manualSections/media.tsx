import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Note, Table, Sub} from '../../components/UserManual/components';
import { DocRef } from '../../components/help/DocRef';

// Media studio manual section. Linked from every media.* / header.media
// HELP_CONTENT entry (docs:check enforces the link resolves). The media id
// below is the scoped target the in-modal
// <ModalHelpButton section="media-studio"> jumps to.

export const media: Section[] = [
  {
    id: 'media-studio',
    group: 'Power features',
    title: 'The Media studio - view, edit & convert images, audio, video',
    body: (
      <>
        <p>
          The Media studio views, edits and converts image, audio and video
          files inside Arco. Audio and video conversions write new files. Image SAVE can replace an on-disk source after an overwrite confirmation.
        </p>
        <p>
          Edits run on the server with <strong>FFmpeg</strong>. Optional AI
          stem separation uses <strong>Demucs</strong>.
        </p>

        <Sub>Opening the studio</Sub>
        <ul>
          <li>
            <strong>From a file</strong> - right-click a media file in the
            FILES explorer and choose{' '}
            <em>Open in Image / Audio / Video editor</em>. The studio opens in
            the matching mode.
          </li>
          <li>
            <strong>Empty</strong> - choose <strong>MEDIA</strong> in the header TOOLS menu
            or run <Code>Open Media studio</Code> from the command palette.
            Then <strong>Import</strong> a file by drag-drop or the file
            picker.
          </li>
        </ul>
        <p>
          REVEAL IN FILES returns to the file's pinned workflow rather than an unrelated active tab. Absolute Windows drive and UNC outputs can be reopened without an active workflow. The <Code>IMAGE</Code> / <Code>AUDIO</Code> / <Code>VIDEO</Code>{' '}
          switch changes mode in place. Closing the studio, unloading or replacing its source, or switching editors cancels active conversion and stem-separation jobs.
        </p>
        <p>
          Imported files support every operation. Arco first copies them into
          a temporary scratch folder under <Code>~/.arco/media-scratch/</Code>. The scratch folder must be a real folder, not a link.
        </p>

        <Sub>Image viewer and editor</Sub>
        <ul>
          <li>
            <strong>Zoom</strong> with the -/+ buttons or the mouse wheel.
          </li>
          <li>
            <strong>Pan</strong> by click-dragging.
          </li>
          <li>
            <strong>FIT</strong> fits the window; <strong>1:1</strong> shows
            actual pixels. The image dimensions are shown alongside.
          </li>
          <li>
            <strong>EDIT</strong> opens a layer-based editor with crop, brush,
            filters and undo/redo. <strong>SAVE</strong> targets the original path for an image opened from FILES and asks before overwriting it. An imported image asks for a new filename. Saving requires a workflow context.
          </li>
        </ul>
        <p>EXIF metadata is not shown yet.</p>

        <Sub>Audio editor</Sub>
        <p>
          Click the <strong>waveform</strong> to seek. The transport plays and
          pauses and shows the current time.
        </p>
        <p>
          A <strong>region</strong> marks the part a clip keeps. Drag its
          handles or type into the <Code>IN</Code> and <Code>OUT</Code>{' '}
          fields.
        </p>
        <Table
          headers={['Operation', 'What it does']}
          rows={[
            [<strong key="clip">CLIP</strong>, 'Trim to the region. Fast and lossless.'],
            [<strong key="conv">CONVERT</strong>, 'Re-encode to wav, mp3, ogg, flac, m4a or aac. Lossy formats take a bitrate.'],
            [<strong key="norm">NORMALIZE</strong>, 'Normalize loudness to the EBU R128 standard.'],
            [<strong key="ch">MONO / STEREO</strong>, 'Change the channel layout.'],
            [<strong key="spd">SPEED</strong>, 'Change tempo from 0.25x to 4x. Pitch is preserved.'],
            [<strong key="gain">GAIN dB</strong>, 'Raise or lower volume, from -60 to +30 dB.'],
            [<strong key="spec">SPECTROGRAM</strong>, 'Save a frequency-over-time picture as a .png.'],
            [<strong key="insp">INSPECT</strong>, 'Show streams, codecs, duration and bitrate. Writes no file.'],
          ]}
        />
        <p>
          The first four are under <strong>FFMPEG OPS</strong>; the rest are
          under <strong>ADVANCED</strong>.
        </p>

        <Sub>Stem separation (Demucs)</Sub>
        <p>
          <strong>SEPARATE</strong> splits a track into{' '}
          <strong>vocals, drums, bass and other</strong>. A two-stem mode
          isolates one stem from the rest, for example for karaoke.
        </p>
        <p>
          Choose the model, the target and the output format.{' '}
          <strong>MP3</strong> is the default and the most reliable choice.
        </p>
        <p>
          Separation can take a while and uses the GPU when available. A
          progress state and <strong>CANCEL</strong> show while it runs.
          Cancelling stops the job and removes the partial folder. Finished
          stems go into a new folder.
        </p>
        <Note>
          Demucs is <strong>optional</strong>. On Windows, discovery recognizes the pip-installed <Code>demucs.exe</Code> through PATH and PATHEXT. When it is not installed,
          SEPARATE shows how to install it instead of failing. WAV and FLAC
          output may need the <Code>torchcodec</Code> package; MP3 always
          works. See <DocRef>docs/OPERATIONS.md</DocRef>.
        </Note>

        <Sub>Video editor</Sub>
        <p>
          Video mode plays the file and marks a clip with the{' '}
          <Code>IN</Code> and <Code>OUT</Code> fields. <Code>SET IN</Code> and{' '}
          <Code>SET OUT</Code> snap a marker to the playhead.
        </p>
        <Table
          headers={['Operation', 'What it does']}
          rows={[
            [<strong key="clip">CLIP</strong>, 'Trim to the markers. Lossless by default; tick RE-ENCODE for a frame-accurate cut.'],
            [<strong key="conv">CONVERT</strong>, 'Re-encode to mp4, webm, mov or mkv, with an optional resolution preset.'],
            [<strong key="ext">EXTRACT AUDIO</strong>, 'Save only the audio track, in a chosen format.'],
            [<strong key="frame">FRAME @ IN</strong>, 'Save the frame at the IN marker as a PNG or JPEG.'],
            [<strong key="gif">GIF</strong>, 'Turn the IN-to-OUT span into a looping gif or webp, with fps and width.'],
            [<strong key="geo">GEOMETRY</strong>, 'Crop, rotate, flip or resize.'],
            [<strong key="spd">SPEED</strong>, 'Re-time the video. Audio pitch is preserved.'],
            [<strong key="mute">MUTE</strong>, 'Remove the audio track.'],
            [<strong key="insp">INSPECT</strong>, 'Show streams, codecs, resolution and fps. Writes no file.'],
          ]}
        />
        <p>
          The first three are under <strong>FFMPEG OPS</strong>; the rest are
          under <strong>ADVANCED</strong>.
        </p>

        <Sub>Where output is saved</Sub>
        <p>
          Output from an on-disk file goes next to the source by default.{' '}
          <strong>SAVE TO</strong> opens a folder picker where a folder can be
          chosen or created and the file optionally named.
        </p>
        <p>
          For an imported file with no destination set, running an operation
          opens the picker automatically, like a normal Save-As.
        </p>
        <Note kind="warn">
          Saving <strong>outside the workflow folder</strong> needs
          outside-folder access and an allowed folder in Settings &gt; Files and
          media &gt; Media folder access. By default, access is limited to the workflow folder,
          uploads and import scratch. Removing a folder or turning access off
          takes effect on the next request. This setting controls Media Studio
          only. Browser file views and built-in file tools use separate path
          checks; shell commands follow their own execution and provider
          permission settings.
        </Note>

        <Sub>Working with results</Sub>
        <ul>
          <li>
            While an operation runs, <strong>CANCEL</strong> stops it and
            deletes any partial output. On success, the output path appears.
          </li>
          <li>
            <strong>Click the output path</strong> to open the result as the
            new working file. For example, a spectrogram opens in image mode.{' '}
            <strong>BACK</strong> returns to the previous file.
          </li>
          <li>
            <strong>REVEAL IN FILES</strong> shows an output inside the
            workflow in the FILES explorer.
          </li>
          <li>
            <strong>UNLOAD</strong> closes the current file and returns to
            Import, without leaving the studio.
          </li>
        </ul>
        <p>
          Implementation details are in <DocRef>docs/MEDIA_STUDIO.md</DocRef>.
        </p>
      </>
    ),
  },
];

import { useCallback, useRef, useState } from 'react';
import {
  VIDEO_FORMAT_NAMES,
  VIDEO_RES_PRESETS,
  AUDIO_FORMAT_NAMES,
  type VideoFormat,
  type VideoResPreset,
  type AudioFormat,
  type MediaOpSpec,
} from '@arco/shared';
import { postMediaOp, postMediaInspect } from '../postMediaOp';
import { MediaSaveControls } from '../MediaSaveControls';
import { MediaAdvancedOps } from '../MediaAdvancedOps';
import { useDirectoryPicker } from '../DirectoryPicker';

// WORKBENCH_EXPANSION §H7 (+ Part N2) — FFmpeg video-ops surface for the editor.
//
// CLIP / CONVERT / EXTRACT-AUDIO ops run through postMediaOp. CLIP reads the
// operator's in/out (lifted from the VideoEditor via `getRegion`). On success we
// show the output path + (for an in-cwd output) a "Reveal in Files" action;
// CANCEL aborts the fetch → the server SIGKILLs the ffmpeg child + cleans up the
// partial output. This mirrors AudioOpsPanel one-for-one.
//
// N2 — ffmpeg still needs an ON-DISK source, but an IMPORTED file is no longer a
// dead end: postMediaOp stages the blob in Arco's scratch area first. So ops
// are enabled for BOTH on-disk (workflow) AND imported files; SAVE TO… picks the
// output destination (gated server-side).
//
// FENCE: format / resolution / vcodec are whitelisted enums (VIDEO_FORMATS /
// VIDEO_RES_PRESETS / VIDEO_VCODECS) — never free text. The server re-validates.

interface Props {
  // The cwd-relative (or absolute-within-cwd) on-disk path, or null when the
  // source is an imported file (handled via scratch upload).
  diskPath: string | null;
  // The imported browser File (when not on disk) — staged to scratch on run.
  importedFile?: File | null;
  // Workflow context for an on-disk op (cwd + workflowId resolve the path
  // server-side + audit the op to events.jsonl). Absent for an imported op.
  fileContext?: { cwd: string; workflowId: string };
  // Read the current in/out (seconds) for the CLIP / EXTRACT-AUDIO ops.
  getRegion: () => { start: number; end: number } | null;
  // Notify the parent to reveal a freshly-written in-cwd output in the Files panel.
  onReveal?: (relPath: string) => void;
  // Load a freshly-written output file back into the studio (click the result).
  onLoadOutput?: (absPath: string) => void;
}

type Status =
  | { phase: 'idle' }
  | { phase: 'running'; op: string }
  | { phase: 'done'; relPath?: string; outputPath: string }
  | { phase: 'error'; message: string; code?: string };

export function VideoOpsPanel({ diskPath, importedFile, fileContext, getRegion, onReveal, onLoadOutput }: Props) {
  const [format, setFormat] = useState<VideoFormat>('mp4');
  const [resolution, setResolution] = useState<VideoResPreset>('source');
  const [reencode, setReencode] = useState(false);
  const [audioFormat, setAudioFormat] = useState<AudioFormat>('mp3');
  const [saveDir, setSaveDir] = useState('');
  const [saveName, setSaveName] = useState('');
  const [status, setStatus] = useState<Status>({ phase: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const { pick, pickerElement } = useDirectoryPicker();

  // On-disk needs a cwd to resolve against; an imported file just needs the blob.
  const enabled = (!!diskPath && !!fileContext) || !!importedFile;
  // Source stem to prefill the save-as filename.
  const sourceStem = (importedFile?.name || diskPath?.split('/').pop() || '').replace(/\.[^.]+$/, '');

  const runOp = useCallback(async (spec: MediaOpSpec) => {
    if (!enabled) return;
    let dir = saveDir;
    let name = saveName;
    // An IMPORTED file with no destination would silently land in scratch — pop
    // the folder picker (Save-As). On-disk keeps "next to the source".
    if (!diskPath && !dir.trim()) {
      const picked = await pick({ initialPath: fileContext?.cwd, defaultName: sourceStem, title: 'Save output to…' });
      if (!picked) return;
      dir = picked.dir; name = picked.basename;
      setSaveDir(picked.dir); setSaveName(picked.basename);
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setStatus({ phase: 'running', op: spec.op });
    try {
      const body = await postMediaOp({
        source: { diskPath, importedFile: importedFile ?? null, fileContext },
        spec,
        output: { dir, basename: name },
        signal: ac.signal,
      });
      if (body.ok) setStatus({ phase: 'done', relPath: body.relPath, outputPath: body.outputPath ?? '' });
      else setStatus({ phase: 'error', message: body.error || 'op failed', code: body.code });
    } catch (err) {
      // An abort (Cancel) lands here too; the server kills the child + cleans up.
      if (ac.signal.aborted) setStatus({ phase: 'idle' });
      else setStatus({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, [enabled, diskPath, importedFile, fileContext, saveDir, saveName, pick, sourceStem]);

  const onClip = useCallback(() => {
    const region = getRegion();
    if (!region) { setStatus({ phase: 'error', message: 'Set the in/out markers first' }); return; }
    if (region.end <= region.start) { setStatus({ phase: 'error', message: 'OUT must be after IN' }); return; }
    void runOp({ op: 'vclip', inSec: region.start, outSec: region.end, ...(reencode ? { reencode: true } : {}) });
  }, [getRegion, runOp, reencode]);

  const onConvert = useCallback(() => {
    void runOp({ op: 'vconvert', format, ...(resolution !== 'source' ? { resolution } : {}) });
  }, [runOp, format, resolution]);

  const onExtractAudio = useCallback(() => {
    void runOp({ op: 'extract-audio', format: audioFormat });
  }, [runOp, audioFormat]);

  const cancel = useCallback(() => { abortRef.current?.abort(); }, []);

  // INSPECT (read-only, no file) — its own fetch; the panel just supplies source.
  const doInspect = useCallback(() => {
    const ac = new AbortController();
    return postMediaInspect({ diskPath, importedFile: importedFile ?? null, fileContext }, ac.signal);
  }, [diskPath, importedFile, fileContext]);

  const running = status.phase === 'running';

  return (
    <div style={{ borderTop: '1px solid var(--color-border-hairline)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary)' }}>
        FFMPEG OPS
      </div>

      {!enabled ? (
        <div data-help="media.video-ops-disabled" style={{ fontSize: '11px', color: 'var(--color-warning)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
          {/* No source yet — neither an on-disk path nor an imported file. */}
          FFmpeg ops (clip / convert / extract audio) run server-side.
          <strong> Import a file</strong> or open one from the FILES panel to run them.
        </div>
      ) : (
        <>
          {/* CLIP — uses the in/out markers; stream-copy by default. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button data-help="media.video-op-clip" onClick={onClip} disabled={running} className="display-font" style={opBtn} title="Trim to the IN/OUT markers">CLIP</button>
            <label data-help="media.video-reencode" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display, monospace)' }}>
              <input type="checkbox" checked={reencode} onChange={(e) => setReencode(e.target.checked)} disabled={running} />
              RE-ENCODE
            </label>
          </div>

          {/* CONVERT — container/codec via format, optional resolution preset. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button data-help="media.video-op-convert" onClick={onConvert} disabled={running} className="display-font" style={opBtn} title="Re-encode to the chosen container + resolution">CONVERT →</button>
            <select data-help="media.video-format" value={format} onChange={(e) => setFormat(e.target.value as VideoFormat)} disabled={running} style={selStyle}>
              {VIDEO_FORMAT_NAMES.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </select>
            <select data-help="media.video-resolution" value={resolution} onChange={(e) => setResolution(e.target.value as VideoResPreset)} disabled={running} style={selStyle}>
              {VIDEO_RES_PRESETS.map((r) => <option key={r} value={r}>{r === 'source' ? 'SOURCE' : r}</option>)}
            </select>
          </div>

          {/* EXTRACT AUDIO — strip video, encode the audio track. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button data-help="media.video-op-extract-audio" onClick={onExtractAudio} disabled={running} className="display-font" style={opBtn} title="Strip video, save the audio track">EXTRACT AUDIO →</button>
            <select data-help="media.video-audio-format" value={audioFormat} onChange={(e) => setAudioFormat(e.target.value as AudioFormat)} disabled={running} style={selStyle}>
              {AUDIO_FORMAT_NAMES.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </select>
          </div>

          {/* N3 — advanced ops (framegrab / gif / geometry / speed / mute / inspect). */}
          <MediaAdvancedOps kind="video" runOp={runOp} getRegion={getRegion} doInspect={doInspect} running={running} />

          {/* N2 — where the output lands (folder picker; defaults alongside source). */}
          <MediaSaveControls dir={saveDir} setDir={setSaveDir} basename={saveName} setBasename={setSaveName} disabled={running} pick={pick} initialPath={fileContext?.cwd} />

          {/* Status line + cancel/reveal affordances. */}
          {running && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span className="display-font" style={{ fontSize: '11px', color: 'var(--color-accent-primary)', letterSpacing: '1px' }}>
                RUNNING {status.op.toUpperCase()}…
              </span>
              <button data-help="media.video-op-cancel" onClick={cancel} className="display-font" style={{ ...opBtn, color: 'var(--color-danger)' }} title="Cancel — kills the ffmpeg child">CANCEL</button>
            </div>
          )}
          {status.phase === 'done' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              {/* The output path is clickable — loads the result back into the
                  studio (a framegrab/gif/extracted-audio becomes the new file). */}
              <button
                data-help="media.op-output"
                onClick={() => onLoadOutput?.(status.outputPath)}
                disabled={!onLoadOutput || !status.outputPath}
                className="display-font"
                title="Load this output into the studio"
                style={{ background: 'transparent', border: 'none', padding: 0, textAlign: 'left', cursor: onLoadOutput ? 'pointer' : 'default', fontSize: '11px', color: 'var(--color-accent-primary)', fontFamily: 'var(--font-code)', wordBreak: 'break-all', textDecoration: onLoadOutput ? 'underline dotted' : 'none' }}
              >
                ✓ {status.relPath || status.outputPath} ↵
              </button>
              {/* Reveal only makes sense for an output inside the workflow cwd. A
                  scratch / arbitrary-path output shows its absolute path instead. */}
              {onReveal && status.relPath && (
                <button data-help="media.video-op-reveal" onClick={() => onReveal(status.relPath!)} className="display-font" style={opBtn} title="Show the output in the Files panel">REVEAL IN FILES</button>
              )}
            </div>
          )}
          {status.phase === 'error' && (
            <div style={{ fontSize: '11px', color: 'var(--color-danger)', fontFamily: 'var(--font-body)', lineHeight: 1.4 }}>
              {status.code === 'ffmpeg-missing'
                ? <>FFmpeg isn't installed. See <code>docs/OPERATIONS.md § FFmpeg</code> (or the system package manager).</>
                : status.message}
            </div>
          )}
        </>
      )}
      {pickerElement}
    </div>
  );
}

const opBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary-dim)',
  cursor: 'pointer',
  fontSize: '11px',
  letterSpacing: '1px',
  padding: '5px 12px',
};

const selStyle: React.CSSProperties = {
  background: 'var(--color-bg-input)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-fg)',
  fontSize: '11px',
  fontFamily: 'var(--font-code, monospace)',
  padding: '4px 6px',
};

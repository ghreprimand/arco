import { useCallback, useRef, useState } from 'react';
import {
  AUDIO_FORMAT_NAMES,
  AUDIO_BITRATES,
  type AudioFormat,
  type AudioBitrate,
  type MediaOpSpec,
} from '@arco/shared';
import { postMediaOp, postMediaInspect } from '../postMediaOp';
import { MediaSaveControls } from '../MediaSaveControls';
import { MediaAdvancedOps } from '../MediaAdvancedOps';
import { MediaStemsControls } from '../MediaStemsControls';
import { useDirectoryPicker } from '../DirectoryPicker';

// WORKBENCH_EXPANSION §H6 (+ Part N2) — FFmpeg audio-ops surface for the editor.
//
// CLIP / CONVERT / NORMALIZE / MONO / STEREO ops run through postMediaOp. CLIP
// reads the operator's region in/out (lifted from the AudioEditor via
// `getRegion`). On success we show the output path + (for an in-cwd output) a
// "Reveal in Files" action; CANCEL aborts the fetch → the server SIGKILLs the
// ffmpeg child + cleans up the partial output.
//
// N2 — ffmpeg still needs an ON-DISK source, but an IMPORTED file is no longer a
// dead end: postMediaOp stages the blob in Arco's scratch area first, then
// runs the op. So ops are enabled for BOTH on-disk (workflow) AND imported
// files. The SAVE TO… controls pick the output destination (gated server-side).

interface Props {
  // The cwd-relative (or absolute-within-cwd) on-disk path, or null when the
  // source is an imported file (handled via scratch upload).
  diskPath: string | null;
  // The imported browser File (when not on disk) — staged to scratch on run.
  importedFile?: File | null;
  // Workflow context for an on-disk op (cwd + workflowId resolve the path
  // server-side + audit the op to events.jsonl). Absent for an imported op.
  fileContext?: { cwd: string; workflowId: string };
  // Read the current region in/out (seconds) for the CLIP op.
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

export function AudioOpsPanel({ diskPath, importedFile, fileContext, getRegion, onReveal, onLoadOutput }: Props) {
  const [format, setFormat] = useState<AudioFormat>('mp3');
  const [bitrate, setBitrate] = useState<AudioBitrate>('192k');
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
    // the folder picker (a real Save-As) instead. On-disk files keep their sane
    // "next to the source" default and don't prompt.
    if (!diskPath && !dir.trim()) {
      const picked = await pick({ initialPath: fileContext?.cwd, defaultName: sourceStem, title: 'Save output to…' });
      if (!picked) return; // cancelled → don't run
      dir = picked.dir; name = picked.basename;
      setSaveDir(picked.dir); setSaveName(picked.basename); // reuse for later ops
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
    if (!region) { setStatus({ phase: 'error', message: 'Select a region first' }); return; }
    if (region.end <= region.start) { setStatus({ phase: 'error', message: 'Region end must be after start' }); return; }
    void runOp({ op: 'clip', inSec: region.start, outSec: region.end });
  }, [getRegion, runOp]);

  const onConvert = useCallback(() => {
    void runOp({ op: 'convert', format, ...(isLossy(format) ? { bitrate } : {}) });
  }, [runOp, format, bitrate]);

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
        <div data-help="media.ops-disabled" style={{ fontSize: '11px', color: 'var(--color-warning)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
          {/* No source yet — neither an on-disk path nor an imported file. */}
          FFmpeg ops (clip / convert / normalize) run server-side.
          <strong> Import a file</strong> or open one from the FILES panel to run them.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button data-help="media.op-clip" onClick={onClip} disabled={running} className="display-font" style={opBtn} title="Trim to the selected region">CLIP</button>
            <button data-help="media.op-normalize" onClick={() => runOp({ op: 'normalize' })} disabled={running} className="display-font" style={opBtn} title="EBU R128 loudness normalize">NORMALIZE</button>
            <button data-help="media.op-mono" onClick={() => runOp({ op: 'channels', mode: 'mono' })} disabled={running} className="display-font" style={opBtn} title="Downmix to mono">MONO</button>
            <button data-help="media.op-stereo" onClick={() => runOp({ op: 'channels', mode: 'stereo' })} disabled={running} className="display-font" style={opBtn} title="Upmix to stereo">STEREO</button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button data-help="media.op-convert" onClick={onConvert} disabled={running} className="display-font" style={opBtn} title="Re-encode to the chosen format">CONVERT →</button>
            <select data-help="media.format" value={format} onChange={(e) => setFormat(e.target.value as AudioFormat)} disabled={running} style={selStyle}>
              {AUDIO_FORMAT_NAMES.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </select>
            {isLossy(format) && (
              <select data-help="media.bitrate" value={bitrate} onChange={(e) => setBitrate(e.target.value as AudioBitrate)} disabled={running} style={selStyle}>
                {AUDIO_BITRATES.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            )}
          </div>

          {/* N3 — advanced ops (speed / gain / spectrogram / inspect). */}
          <MediaAdvancedOps kind="audio" runOp={runOp} getRegion={getRegion} doInspect={doInspect} running={running} />

          {/* N4 — Demucs stem separation (long-running; own status + cancel). */}
          <MediaStemsControls
            source={{ diskPath, importedFile: importedFile ?? null, fileContext }}
            saveDir={saveDir}
            setSaveDir={setSaveDir}
            pick={pick}
            initialPath={fileContext?.cwd}
            enabled={enabled}
            onReveal={onReveal}
          />

          {/* N2 — where the output lands (folder picker; defaults alongside source). */}
          <MediaSaveControls dir={saveDir} setDir={setSaveDir} basename={saveName} setBasename={setSaveName} disabled={running} pick={pick} initialPath={fileContext?.cwd} />

          {/* Status line + cancel/reveal affordances. */}
          {running && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span className="display-font" style={{ fontSize: '11px', color: 'var(--color-accent-primary)', letterSpacing: '1px' }}>
                RUNNING {status.op.toUpperCase()}…
              </span>
              <button data-help="media.op-cancel" onClick={cancel} className="display-font" style={{ ...opBtn, color: 'var(--color-danger)' }} title="Cancel — kills the ffmpeg child">CANCEL</button>
            </div>
          )}
          {status.phase === 'done' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              {/* The output path is clickable — loads the result back into the
                  studio (the op's output becomes the new working file). */}
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
                <button data-help="media.op-reveal" onClick={() => onReveal(status.relPath!)} className="display-font" style={opBtn} title="Show the output in the Files panel">REVEAL IN FILES</button>
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

// Lossy formats take a bitrate; lossless (wav/flac) don't.
function isLossy(f: AudioFormat): boolean {
  return f === 'mp3' || f === 'ogg' || f === 'm4a' || f === 'aac';
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

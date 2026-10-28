import { useEffect, useRef, useState, useCallback } from 'react';

// WORKBENCH_EXPANSION §H7 — Video editor: HTML5 <video> preview + scrub +
// in/out markers. The video-equivalent of H5's AudioEditor. Source is either an
// on-disk file streamed through the guarded /api/media/raw Range route (so the
// browser can seek) or an imported object URL. The ffmpeg-backed clip / convert
// / extract-audio ops are VideoOpsPanel; this surfaces the in/out the clip op
// reads via onRegionChange (mirrors AudioEditor exactly).
//
// No wavesurfer here — video has its own frame surface; the native <video>
// element gives playback + seek for free. We only own the in/out marker state.

interface Props {
  src: string;
  filename?: string;
  // The clip seam VideoOpsPanel reads. Fires when in/out change (scrub-set or
  // numeric edit) and once on metadata-load (full span by default). seconds, in ≤ out.
  onRegionChange?: (start: number, end: number) => void;
}

// mm:ss.mmm — the timestamp format the in/out inputs round-trip through.
// (Mirrors AudioEditor.fmt; kept local rather than shared — two tiny pure fns,
// not worth a shared module + the churn of re-pointing the audio editor.)
function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// Parse mm:ss.mmm (or ss.mmm, or plain seconds) back to seconds; NaN on junk.
function parse(str: string): number {
  const s = str.trim();
  if (!s) return NaN;
  const parts = s.split(':');
  if (parts.length === 1) return Number(parts[0]);
  if (parts.length === 2) {
    const min = Number(parts[0]);
    const sec = Number(parts[1]);
    if (!isFinite(min) || !isFinite(sec)) return NaN;
    return min * 60 + sec;
  }
  return NaN;
}

export function VideoEditor({ src, filename, onRegionChange }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // In/out (seconds) + their input text. Text is separate so a partial edit
  // ("1:") isn't clobbered by a re-format mid-typing.
  const [regStart, setRegStart] = useState(0);
  const [regEnd, setRegEnd] = useState(0);
  const [startText, setStartText] = useState('0:00.000');
  const [endText, setEndText] = useState('0:00.000');

  const onRegionChangeRef = useRef(onRegionChange);
  onRegionChangeRef.current = onRegionChange;

  const emit = useCallback((s: number, e: number) => {
    setRegStart(s); setRegEnd(e);
    setStartText(fmt(s)); setEndText(fmt(e));
    onRegionChangeRef.current?.(s, e);
  }, []);

  // Reset state when the source swaps (import → new file).
  useEffect(() => {
    setDuration(0); setCurrent(0); setError(null);
    setRegStart(0); setRegEnd(0);
    setStartText('0:00.000'); setEndText('0:00.000');
  }, [src]);

  const onLoadedMeta = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const dur = isFinite(v.duration) ? v.duration : 0;
    setDuration(dur);
    // Default in/out spans the whole clip — gives the operator a starting span.
    emit(0, dur);
  }, [emit]);

  const commitStart = useCallback(() => {
    let v = parse(startText);
    if (!isFinite(v)) { setStartText(fmt(regStart)); return; }
    v = Math.max(0, Math.min(v, regEnd));
    emit(v, regEnd);
  }, [startText, regStart, regEnd, emit]);

  const commitEnd = useCallback(() => {
    let v = parse(endText);
    if (!isFinite(v)) { setEndText(fmt(regEnd)); return; }
    v = Math.min(duration || v, Math.max(v, regStart));
    emit(regStart, v);
  }, [endText, regEnd, regStart, duration, emit]);

  // "Set from playhead" — snap in/out to the current scrub position. The fast way
  // to mark a span: scrub, click SET IN, scrub, click SET OUT.
  const setInFromPlayhead = useCallback(() => emit(Math.min(current, regEnd), regEnd), [current, regEnd, emit]);
  const setOutFromPlayhead = useCallback(() => emit(regStart, Math.max(current, regStart)), [current, regStart, emit]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto', padding: '16px', gap: '14px' }}>
      {/* Preview */}
      <div
        data-help="media.video-preview"
        style={{
          width: '100%', display: 'flex', justifyContent: 'center',
          background: 'var(--color-bg-sunken)',
          border: '1px solid var(--color-border-hairline)',
          borderRadius: '4px', padding: '8px',
        }}
      >
        <video
          ref={videoRef}
          src={src}
          controls
          onLoadedMetadata={onLoadedMeta}
          onTimeUpdate={(e) => setCurrent((e.target as HTMLVideoElement).currentTime)}
          onError={() => setError('the browser could not load/decode this video')}
          style={{ maxWidth: '100%', maxHeight: 'calc(46vh / var(--ui-scale, 1))' }}
        />
      </div>

      {error && (
        <div style={{ color: 'var(--color-danger)', fontSize: '12px', fontStyle: 'italic' }}>
          Could not play video: {error}
        </div>
      )}

      {/* Time readout + filename */}
      <div data-help="media.video-transport" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <span className="display-font" style={timeStyle}>
          {fmt(current)} / {fmt(duration)}
        </span>
        {filename && (
          <span className="display-font" style={{ ...timeStyle, opacity: 0.6, marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%' }}>
            {filename}
          </span>
        )}
      </div>

      {/* In/out markers — the clip seam VideoOpsPanel reads. */}
      <div data-help="media.video-markers" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <span className="display-font" style={{ ...timeStyle, opacity: 0.7, letterSpacing: '1.5px' }}>SELECTION</span>
        <label style={lblStyle}>
          IN
          <input
            data-help="media.video-in"
            value={startText}
            onChange={(e) => setStartText(e.target.value)}
            onBlur={commitStart}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            style={numInput}
          />
        </label>
        <button data-help="media.video-set-in" onClick={setInFromPlayhead} className="display-font" style={ctrlBtn} title="Set IN to the current playhead">SET IN</button>
        <label style={lblStyle}>
          OUT
          <input
            data-help="media.video-out"
            value={endText}
            onChange={(e) => setEndText(e.target.value)}
            onBlur={commitEnd}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            style={numInput}
          />
        </label>
        <button data-help="media.video-set-out" onClick={setOutFromPlayhead} className="display-font" style={ctrlBtn} title="Set OUT to the current playhead">SET OUT</button>
        <span className="display-font" style={{ ...timeStyle, opacity: 0.6 }}>
          ({fmt(Math.max(0, regEnd - regStart))})
        </span>
      </div>
    </div>
  );
}

const ctrlBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary-dim)',
  cursor: 'pointer',
  fontSize: '11px',
  letterSpacing: '1px',
  padding: '5px 12px',
};

const timeStyle: React.CSSProperties = {
  fontSize: '11px',
  letterSpacing: '1px',
  color: 'var(--color-fg-muted)',
  fontVariantNumeric: 'tabular-nums',
};

const lblStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '6px',
  fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)',
  fontFamily: 'var(--font-display, monospace)',
};

const numInput: React.CSSProperties = {
  background: 'var(--color-bg-input)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-fg)',
  fontSize: '11px',
  fontFamily: 'var(--font-code, monospace)',
  padding: '4px 6px',
  width: '92px',
  fontVariantNumeric: 'tabular-nums',
};

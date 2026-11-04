import { useEffect, useRef, useState, useCallback } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js';

// WORKBENCH_EXPANSION §H5 — Audio editor: waveform + transport + one region
// select. Replaces the bare native <audio> the H1 host rendered for IMPORTED
// audio. Browser decodes the object URL (wav/mp3/ogg/flac/m4a/aac) — no server
// decode here; the ffmpeg-backed clip/convert is H6 and reads the in/out this
// emits via onRegionChange.
//
// React lifecycle (load-bearing): wavesurfer owns a DOM canvas + a WebAudio
// graph. We create it in a useEffect keyed on `src` and destroy() it in the
// cleanup. StrictMode double-invokes effects on mount, so a naive create would
// leave two instances (and a "container already has a waveform"-class leak).
// Guard: each effect run is the sole owner of the instance it makes, and the
// cleanup nulls our ref + destroy()s it. We also abort the async ready handler
// via a `disposed` flag so a late ready/timeupdate can't touch a torn-down ws.

interface Props {
  src: string;
  filename?: string;
  // The clip seam H6 reads. Fires when the region's in/out change (drag or
  // numeric edit) and once on initial region creation. seconds, start ≤ end.
  onRegionChange?: (start: number, end: number) => void;
}

// Read app theme colors off the document so the waveform matches the active
// theme (global / matrix / …) without hard-coding hex. CSS vars don't apply to
// canvas fills, so we resolve them to concrete values at init.
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// mm:ss.mmm — the timestamp format the region inputs round-trip through.
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

export function AudioEditor({ src, filename, onRegionChange }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const regionRef = useRef<Region | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  // Region in/out (seconds) + their input text. Text is separate so a partial
  // edit ("1:") doesn't get clobbered by a re-format mid-typing.
  const [regStart, setRegStart] = useState(0);
  const [regEnd, setRegEnd] = useState(0);
  const [startText, setStartText] = useState('0:00.000');
  const [endText, setEndText] = useState('0:00.000');

  // Keep latest onRegionChange in a ref so the src-keyed effect doesn't tear
  // down/rebuild wavesurfer just because the parent passed a new callback.
  const onRegionChangeRef = useRef(onRegionChange);
  onRegionChangeRef.current = onRegionChange;

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    setReady(false);
    setError(null);
    setPlaying(false);
    setCurrent(0);

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: src,
      height: 96,
      waveColor: cssVar('--color-fg-muted', '#888'),
      progressColor: cssVar('--color-accent-primary', '#39ff14'),
      cursorColor: cssVar('--color-accent-secondary', '#00e5ff'),
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      plugins: [regions],
    });
    wsRef.current = ws;
    regionsRef.current = regions;

    const emit = (s: number, e: number) => {
      setRegStart(s); setRegEnd(e);
      setStartText(fmt(s)); setEndText(fmt(e));
      onRegionChangeRef.current?.(s, e);
    };

    ws.on('ready', (dur) => {
      if (disposed) return;
      setDuration(dur);
      setReady(true);
      // One region spanning the whole clip by default — gives the operator
      // visible drag handles to narrow from; H6 reads whatever it ends up as.
      const start = 0;
      const end = dur;
      const region = regions.addRegion({
        start, end,
        color: cssVar('--color-accent-primary-a', 'rgba(57,255,20,0.15)') || 'rgba(57,255,20,0.15)',
        drag: false,    // dragging the body would shift in+out together; we want handle resize
        resize: true,
      });
      regionRef.current = region;
      emit(region.start, region.end);
    });
    ws.on('timeupdate', (t) => { if (!disposed) setCurrent(t); });
    ws.on('play', () => { if (!disposed) setPlaying(true); });
    ws.on('pause', () => { if (!disposed) setPlaying(false); });
    ws.on('finish', () => { if (!disposed) setPlaying(false); });
    ws.on('error', (e) => { if (!disposed) setError(String(e?.message || e)); });

    // Region drag/resize → reflect into the numeric inputs + emit.
    regions.on('region-updated', (region) => {
      if (disposed || region !== regionRef.current) return;
      emit(region.start, region.end);
    });

    return () => {
      disposed = true;
      regionRef.current = null;
      regionsRef.current = null;
      wsRef.current = null;
      // destroy() tears down the canvas + WebAudio graph; safe to call once.
      ws.destroy();
    };
  }, [src]);

  const togglePlay = useCallback(() => { wsRef.current?.playPause(); }, []);

  // Commit a numeric input edit back onto the region (and clamp to bounds).
  const commitStart = useCallback(() => {
    const region = regionRef.current;
    if (!region) return;
    let v = parse(startText);
    if (!isFinite(v)) { setStartText(fmt(regStart)); return; }
    v = Math.max(0, Math.min(v, region.end));
    region.setOptions({ start: v, end: region.end });
    setRegStart(v); setStartText(fmt(v));
    onRegionChangeRef.current?.(v, region.end);
  }, [startText, regStart]);

  const commitEnd = useCallback(() => {
    const region = regionRef.current;
    if (!region) return;
    let v = parse(endText);
    if (!isFinite(v)) { setEndText(fmt(regEnd)); return; }
    v = Math.min(duration || v, Math.max(v, region.start));
    region.setOptions({ start: region.start, end: v });
    setRegEnd(v); setEndText(fmt(v));
    onRegionChangeRef.current?.(region.start, v);
  }, [endText, regEnd, duration]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto', padding: '16px', gap: '14px' }}>
      {/* Waveform */}
      <div
        data-help="media.waveform"
        ref={containerRef}
        style={{
          width: '100%', minHeight: '96px',
          background: 'var(--color-bg-sunken)',
          border: '1px solid var(--color-border-hairline)',
          borderRadius: '4px', padding: '8px',
        }}
      />

      {error && (
        <div style={{ color: 'var(--color-danger)', fontSize: '12px', fontStyle: 'italic' }}>
          Could not decode audio: {error}
        </div>
      )}

      {/* Transport */}
      <div data-help="media.transport" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button onClick={togglePlay} disabled={!ready} className="display-font" style={ctrlBtn} title={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚ PAUSE' : '▶ PLAY'}
        </button>
        <span className="display-font" style={timeStyle}>
          {fmt(current)} / {fmt(duration)}
        </span>
        {filename && (
          <span className="display-font" style={{ ...timeStyle, opacity: 0.6, marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%' }}>
            {filename}
          </span>
        )}
      </div>

      {/* Region in/out — the clip seam H6 reads. */}
      <div data-help="media.region" style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
        <span className="display-font" style={{ ...timeStyle, opacity: 0.7, letterSpacing: '1.5px' }}>SELECTION</span>
        <label style={lblStyle}>
          IN
          <input
            data-help="media.region-in"
            value={startText}
            onChange={(e) => setStartText(e.target.value)}
            onBlur={commitStart}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            disabled={!ready}
            style={numInput}
          />
        </label>
        <label style={lblStyle}>
          OUT
          <input
            data-help="media.region-out"
            value={endText}
            onChange={(e) => setEndText(e.target.value)}
            onBlur={commitEnd}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            disabled={!ready}
            style={numInput}
          />
        </label>
        <span className="display-font" style={{ ...timeStyle, opacity: 0.6 }}>
          ({fmt(Math.max(0, regEnd - regStart))})
        </span>
      </div>

      {/* H6 note — clip/convert is server-side ffmpeg, not yet wired. */}
      <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.5 }}>
        Select a region with the handles or the IN/OUT fields. Clip &amp; convert
        (trim to the selection, change format) arrives with the FFmpeg ops in H6.
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

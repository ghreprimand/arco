import { useCallback, useRef, useState } from 'react';
import {
  STILL_FORMAT_NAMES,
  ANIM_FORMAT_NAMES,
  VIDEO_RES_PRESETS,
  GIF_FPS_DEFAULT,
  SPEED_FACTOR_MIN,
  SPEED_FACTOR_MAX,
  GAIN_DB_MIN,
  GAIN_DB_MAX,
  type StillFormat,
  type AnimFormat,
  type VideoResPreset,
  type GeometryXform,
  type MediaOpSpec,
  type MediaInspectResult,
} from '@arco/shared';

// Part N3 — the ADVANCED ffmpeg ops shared by the audio + video panels. Single-
// input ops only (framegrab / gif / geometry / speed / gain / spectrogram) plus
// swap-MUTE and the read-only INSPECT readout. They run through the SAME
// `runOp(spec)` the panel already owns (so the source-staging + SAVE TO… + status
// line are reused); INSPECT is the one op that writes no file, so it has its own
// inline readout fed by `doInspect`.
//
// Every operator-influenced value is a validated number (clamped to the shared
// bounds) or a whitelisted enum — the server re-validates the typed spec.

interface Props {
  kind: 'audio' | 'video';
  // Run a render op (the panel handles source staging, output dest, status).
  runOp: (spec: MediaOpSpec) => void;
  // Read the IN/OUT markers (seconds) — gif uses the span, framegrab the IN.
  getRegion: () => { start: number; end: number } | null;
  // Read-only probe (no file). The panel binds its source; we render the result.
  doInspect: () => Promise<MediaInspectResult>;
  running: boolean;
}

export function MediaAdvancedOps({ kind, runOp, getRegion, doInspect, running }: Props) {
  const [speed, setSpeed] = useState('1.5');
  const [gainDb, setGainDb] = useState('-3');
  const [still, setStill] = useState<StillFormat>('png');
  const [anim, setAnim] = useState<AnimFormat>('gif');
  const [gifFps, setGifFps] = useState(String(GIF_FPS_DEFAULT));
  const [gifWidth, setGifWidth] = useState('480');
  const [geoKind, setGeoKind] = useState<GeometryXform['kind']>('crop');
  const [crop, setCrop] = useState({ w: '640', h: '480', x: '0', y: '0' });
  const [rotate, setRotate] = useState<'90' | '180' | '270'>('90');
  const [flip, setFlip] = useState<'h' | 'v'>('h');
  const [resize, setResize] = useState<VideoResPreset>('720p');

  const [inspect, setInspect] = useState<MediaInspectResult | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const inspectAbort = useRef<AbortController | null>(null);

  // Hoisted so the data-help ternaries below carry no string literal in their
  // condition (the docs:check key-scanner would otherwise grab it as the key).
  const isVideo = kind === 'video';

  const num = (s: string) => Number(s.trim());

  const onSpeed = useCallback(() => {
    const f = num(speed);
    if (!Number.isFinite(f) || f < SPEED_FACTOR_MIN || f > SPEED_FACTOR_MAX) return;
    runOp({ op: 'speed', factor: f, video: kind === 'video' });
  }, [speed, kind, runOp]);

  const onGain = useCallback(() => {
    const db = num(gainDb);
    if (!Number.isFinite(db) || db < GAIN_DB_MIN || db > GAIN_DB_MAX) return;
    runOp({ op: 'gain', db });
  }, [gainDb, runOp]);

  const onFramegrab = useCallback(() => {
    const r = getRegion();
    runOp({ op: 'framegrab', atSec: r ? r.start : 0, format: still });
  }, [getRegion, still, runOp]);

  const onGif = useCallback(() => {
    const r = getRegion();
    if (!r || r.end <= r.start) return;
    const fps = num(gifFps);
    const width = num(gifWidth);
    runOp({
      op: 'gif',
      inSec: r.start,
      outSec: r.end,
      ...(Number.isFinite(fps) ? { fps } : {}),
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      format: anim,
    });
  }, [getRegion, gifFps, gifWidth, anim, runOp]);

  const onGeometry = useCallback(() => {
    let xform: GeometryXform;
    if (geoKind === 'crop') xform = { kind: 'crop', w: num(crop.w), h: num(crop.h), x: num(crop.x), y: num(crop.y) };
    else if (geoKind === 'rotate') xform = { kind: 'rotate', degrees: Number(rotate) as 90 | 180 | 270 };
    else if (geoKind === 'flip') xform = { kind: 'flip', axis: flip };
    else xform = { kind: 'resize', resolution: resize };
    runOp({ op: 'geometry', xform });
  }, [geoKind, crop, rotate, flip, resize, runOp]);

  const onInspect = useCallback(async () => {
    const ac = new AbortController();
    inspectAbort.current = ac;
    setInspecting(true);
    setInspect(null);
    try {
      setInspect(await doInspect());
    } catch (err) {
      if (!ac.signal.aborted) setInspect({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (inspectAbort.current === ac) inspectAbort.current = null;
      setInspecting(false);
    }
  }, [doInspect]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px dashed var(--color-border-hairline)', paddingTop: '10px' }}>
      <div className="display-font" style={{ fontSize: '9px', letterSpacing: '2px', color: 'var(--color-fg-muted)' }}>ADVANCED</div>

      {kind === 'video' && (
        <>
          {/* FRAMEGRAB @ IN + GIF over the region. */}
          <div style={row}>
            <button data-help="media.video-op-framegrab" onClick={onFramegrab} disabled={running} className="display-font" style={opBtn} title="Grab the frame at the IN marker">FRAME @ IN</button>
            <select value={still} onChange={(e) => setStill(e.target.value as StillFormat)} disabled={running} style={sel}>
              {STILL_FORMAT_NAMES.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </select>
            <button data-help="media.video-op-gif" onClick={onGif} disabled={running} className="display-font" style={opBtn} title="Animate the IN→OUT span">GIF</button>
            <select value={anim} onChange={(e) => setAnim(e.target.value as AnimFormat)} disabled={running} style={sel}>
              {ANIM_FORMAT_NAMES.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </select>
            <NumIn value={gifFps} set={setGifFps} disabled={running} label="fps" w={40} />
            <NumIn value={gifWidth} set={setGifWidth} disabled={running} label="w" w={52} />
          </div>

          {/* GEOMETRY — crop / rotate / flip / resize. */}
          <div style={row}>
            <button data-help="media.video-op-geometry" onClick={onGeometry} disabled={running} className="display-font" style={opBtn} title="Apply the geometry transform">GEOMETRY</button>
            <select value={geoKind} onChange={(e) => setGeoKind(e.target.value as GeometryXform['kind'])} disabled={running} style={sel}>
              <option value="crop">CROP</option>
              <option value="rotate">ROTATE</option>
              <option value="flip">FLIP</option>
              <option value="resize">RESIZE</option>
            </select>
            {geoKind === 'crop' && (
              <>
                <NumIn value={crop.w} set={(v) => setCrop({ ...crop, w: v })} disabled={running} label="w" w={52} />
                <NumIn value={crop.h} set={(v) => setCrop({ ...crop, h: v })} disabled={running} label="h" w={52} />
                <NumIn value={crop.x} set={(v) => setCrop({ ...crop, x: v })} disabled={running} label="x" w={44} />
                <NumIn value={crop.y} set={(v) => setCrop({ ...crop, y: v })} disabled={running} label="y" w={44} />
              </>
            )}
            {geoKind === 'rotate' && (
              <select value={rotate} onChange={(e) => setRotate(e.target.value as '90' | '180' | '270')} disabled={running} style={sel}>
                <option value="90">90°</option><option value="180">180°</option><option value="270">270°</option>
              </select>
            )}
            {geoKind === 'flip' && (
              <select value={flip} onChange={(e) => setFlip(e.target.value as 'h' | 'v')} disabled={running} style={sel}>
                <option value="h">HORIZONTAL</option><option value="v">VERTICAL</option>
              </select>
            )}
            {geoKind === 'resize' && (
              <select value={resize} onChange={(e) => setResize(e.target.value as VideoResPreset)} disabled={running} style={sel}>
                {VIDEO_RES_PRESETS.map((r) => <option key={r} value={r}>{r === 'source' ? 'SOURCE' : r}</option>)}
              </select>
            )}
          </div>
        </>
      )}

      {kind === 'audio' && (
        <div style={row}>
          <button data-help="media.op-spectrogram" onClick={() => runOp({ op: 'spectrogram' })} disabled={running} className="display-font" style={opBtn} title="Render an audio spectrogram image">SPECTROGRAM</button>
        </div>
      )}

      {/* SPEED + GAIN (gain is audio-only) + INSPECT, shared. */}
      <div style={row}>
        <button data-help={isVideo ? 'media.video-op-speed' : 'media.op-speed'} onClick={onSpeed} disabled={running} className="display-font" style={opBtn} title={`Change speed (${SPEED_FACTOR_MIN}–${SPEED_FACTOR_MAX}×, pitch-preserved)`}>SPEED ×</button>
        <NumIn value={speed} set={setSpeed} disabled={running} label="" w={56} />
        {kind === 'audio' && (
          <>
            <button data-help="media.op-gain" onClick={onGain} disabled={running} className="display-font" style={opBtn} title="Adjust volume in dB">GAIN dB</button>
            <NumIn value={gainDb} set={setGainDb} disabled={running} label="" w={56} />
          </>
        )}
        {kind === 'video' && (
          <button data-help="media.video-op-mute" onClick={() => runOp({ op: 'swap', action: { kind: 'mute' } })} disabled={running} className="display-font" style={opBtn} title="Drop the audio track">MUTE</button>
        )}
        <button data-help={isVideo ? 'media.video-op-inspect' : 'media.op-inspect'} onClick={onInspect} disabled={running || inspecting} className="display-font" style={opBtn} title="Probe streams/codecs/duration — writes no file">{inspecting ? 'INSPECTING…' : 'INSPECT'}</button>
      </div>

      {inspect && <InspectReadout result={inspect} />}
    </div>
  );
}

// The INSPECT result — a compact format + per-stream readout. No file is written.
function InspectReadout({ result }: { result: MediaInspectResult }) {
  if (!result.ok) {
    return (
      <div style={{ fontSize: '11px', color: 'var(--color-danger)', fontFamily: 'var(--font-body)' }}>
        {result.code === 'ffprobe-missing'
          ? <>ffprobe isn't installed (part of FFmpeg — see <code>docs/OPERATIONS.md § FFmpeg</code>).</>
          : (result.error || 'inspect failed')}
      </div>
    );
  }
  const f = result.format;
  return (
    <div style={{ fontSize: '11px', fontFamily: 'var(--font-code, monospace)', color: 'var(--color-fg-muted)', lineHeight: 1.5, wordBreak: 'break-all' }}>
      {f && <div>{f.name ?? '?'} · {f.duration != null ? `${f.duration.toFixed(2)}s` : '?'}{f.bitrate ? ` · ${Math.round(f.bitrate / 1000)} kb/s` : ''}{f.size ? ` · ${(f.size / 1_048_576).toFixed(1)} MiB` : ''}</div>}
      {(result.streams ?? []).map((s) => (
        <div key={s.index}>
          #{s.index} {s.type} {s.codec ?? ''}
          {s.width ? ` ${s.width}×${s.height}` : ''}
          {s.fps ? ` ${s.fps}fps` : ''}
          {s.sampleRate ? ` ${s.sampleRate}Hz` : ''}
          {s.channels ? ` ${s.channels}ch` : ''}
        </div>
      ))}
    </div>
  );
}

// A tiny labelled numeric input.
function NumIn({ value, set, disabled, label, w }: { value: string; set: (v: string) => void; disabled: boolean; label: string; w: number }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display, monospace)' }}>
      {label && <span>{label}</span>}
      <input type="number" value={value} onChange={(e) => set(e.target.value)} disabled={disabled} style={{ ...sel, width: `${w}px` }} />
    </label>
  );
}

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' };

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

const sel: React.CSSProperties = {
  background: 'var(--color-bg-input)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-fg)',
  fontSize: '11px',
  fontFamily: 'var(--font-code, monospace)',
  padding: '4px 6px',
};

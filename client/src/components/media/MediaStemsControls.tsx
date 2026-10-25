import { useCallback, useRef, useState } from 'react';
import {
  STEM_MODELS,
  STEM_NAMES,
  STEM_FORMATS,
  type StemModel,
  type StemName,
  type StemFormat,
  type MediaStemFile,
} from '@arco/shared';
import { postMediaStems, type MediaOpSource } from './postMediaOp';
import type { PickOptions, PickResult } from './DirectoryPicker';

// Part N4 — Demucs stem separation control for the audio panel. A long-running,
// GPU-accelerated job that writes a fresh dir of stem files. Separate from the
// ffmpeg ops (different runner, different result shape, multiple outputs), so it
// owns its own status + cancel. Model / two-stems target / format are whitelisted
// enums; the server re-validates. Default format is **mp3** — the broadly-working
// output path (wav/flac need torchcodec on some boxes; the server surfaces a hint).

interface Props {
  source: MediaOpSource;
  // The panel's SAVE TO… directory (only the dir matters for stems).
  saveDir: string;
  // Persist a picked destination back to the panel (shared with the ffmpeg ops).
  setSaveDir: (v: string) => void;
  // Shared folder picker (owned by the panel).
  pick: (opts?: PickOptions) => Promise<PickResult | null>;
  // Where the picker starts browsing (the workflow cwd, usually).
  initialPath?: string;
  enabled: boolean;
  onReveal?: (relPath: string) => void;
}

type Status =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; stems: MediaStemFile[]; relDir?: string; dir?: string }
  | { phase: 'error'; message: string; code?: string };

export function MediaStemsControls({ source, saveDir, setSaveDir, pick, initialPath, enabled, onReveal }: Props) {
  const [model, setModel] = useState<StemModel>('htdemucs');
  const [twoStems, setTwoStems] = useState<StemName | 'all'>('all');
  const [format, setFormat] = useState<StemFormat>('mp3');
  const [status, setStatus] = useState<Status>({ phase: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    if (!enabled) return;
    // An imported source with no destination would land its stems in scratch —
    // pop the folder picker (Save-As) first. On-disk keeps "next to source".
    let outDir = saveDir;
    if (!source.diskPath && !outDir.trim()) {
      const picked = await pick({ initialPath, defaultName: '', withFilename: false, title: 'Save stems into…' });
      if (!picked) return; // cancelled
      outDir = picked.dir;
      setSaveDir(picked.dir);
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setStatus({ phase: 'running' });
    try {
      const r = await postMediaStems({
        source,
        model,
        ...(twoStems !== 'all' ? { twoStems } : {}),
        format,
        outputDir: outDir,
        signal: ac.signal,
      });
      if (r.ok) setStatus({ phase: 'done', stems: r.stems ?? [], relDir: r.relDir, dir: r.dir });
      else setStatus({ phase: 'error', message: r.error || 'separation failed', code: r.code });
    } catch (err) {
      if (ac.signal.aborted) setStatus({ phase: 'idle' });
      else setStatus({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, [enabled, source, model, twoStems, format, saveDir, pick, initialPath, setSaveDir]);

  const cancel = useCallback(() => { abortRef.current?.abort(); }, []);
  const running = status.phase === 'running';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px dashed var(--color-border-hairline)', paddingTop: '10px' }}>
      <div className="display-font" style={{ fontSize: '9px', letterSpacing: '2px', color: 'var(--color-fg-muted)' }}>STEMS (DEMUCS)</div>

      <div style={row}>
        <button data-help="media.op-stems" onClick={run} disabled={running} className="display-font" style={opBtn} title="AI source separation into stems (GPU)">SEPARATE →</button>
        <select data-help="media.stems-model" value={model} onChange={(e) => setModel(e.target.value as StemModel)} disabled={running} style={sel} title="Demucs model">
          {STEM_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select data-help="media.stems-target" value={twoStems} onChange={(e) => setTwoStems(e.target.value as StemName | 'all')} disabled={running} style={sel} title="Full set, or isolate one stem (karaoke split)">
          <option value="all">ALL STEMS</option>
          {STEM_NAMES.map((s) => <option key={s} value={s}>{s.toUpperCase()} + REST</option>)}
        </select>
        <select data-help="media.stems-format" value={format} onChange={(e) => setFormat(e.target.value as StemFormat)} disabled={running} style={sel} title="Output encoding (mp3 is the broadly-working default)">
          {STEM_FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
        </select>
      </div>

      {running && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className="display-font" style={{ fontSize: '11px', color: 'var(--color-accent-primary)', letterSpacing: '1px' }}>SEPARATING… (this can take a while)</span>
          <button data-help="media.stems-cancel" onClick={cancel} className="display-font" style={{ ...opBtn, color: 'var(--color-danger)' }} title="Cancel — kills the demucs child + removes the partial dir">CANCEL</button>
        </div>
      )}
      {status.phase === 'done' && (
        <div style={{ fontSize: '11px', fontFamily: 'var(--font-code, monospace)', color: 'var(--color-accent-primary)', lineHeight: 1.5, wordBreak: 'break-all', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span>✓ {status.stems.length} stem{status.stems.length === 1 ? '' : 's'} → {status.relDir || status.dir}</span>
          <span style={{ color: 'var(--color-fg-muted)' }}>{status.stems.map((s) => s.name).join(' · ')}</span>
          {onReveal && status.relDir && (
            <button data-help="media.stems-reveal" onClick={() => onReveal(status.relDir!)} className="display-font" style={{ ...opBtn, alignSelf: 'flex-start', marginTop: '4px' }} title="Show the stems folder in the Files panel">REVEAL IN FILES</button>
          )}
        </div>
      )}
      {status.phase === 'error' && (
        <div style={{ fontSize: '11px', color: 'var(--color-danger)', fontFamily: 'var(--font-body)', lineHeight: 1.4 }}>
          {status.code === 'demucs-missing'
            ? <>Demucs isn't installed. Add it with the system package manager (see <code>docs/OPERATIONS.md § Demucs</code>) — never <code>curl|sh</code>.</>
            : status.message}
        </div>
      )}
    </div>
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

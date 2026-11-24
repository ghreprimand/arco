import { useEffect, useRef, useState } from 'react';
import { WorkSurfaceControls } from './workSurface/WorkSurfaceControls';

export interface ScratchCloseTarget { id: string; name: string }
interface Measurement { exists: boolean; bytes: number; measuredAt: number; keptItems: number; busy: boolean }
interface Row { target: ScratchCloseTarget; measurement?: Measurement; error?: string; selected: boolean }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

// All callers use the same close choice and the existing EMPTY SCRATCH route.
// A failed measurement never becomes zero and a failed action never closes.
export function ScratchCloseDialog({ targets, onCancel, onContinue, onStop }: {
  targets: ScratchCloseTarget[]; onCancel: () => void; onContinue: () => void; onStop?: (workflowId: string) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [limit, setLimit] = useState(1024 ** 3);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const continued = useRef(false);
  const finish = useRef(onContinue); finish.current = onContinue;
  const targetKey = targets.map((target) => target.id).join('|');

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  async function measure() {
    setWorking(true); setError('');
    try {
      const measured = await Promise.all(targets.map(async (target): Promise<Row> => {
        try {
          const response = await fetch(`/api/storage/scratch?${new URLSearchParams({ workflowId: target.id })}`);
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Scratch could not be measured.');
          return { target, measurement: result as Measurement, selected: false };
        } catch (err) { return { target, error: err instanceof Error ? err.message : 'Scratch could not be measured.', selected: false }; }
      }));
      setRows(measured);
      if (measured.every((row) => row.measurement && !row.measurement.exists) && !continued.current) {
        continued.current = true; finish.current();
      }
    } finally { setWorking(false); }
  }
  useEffect(() => {
    void measure();
    void fetch('/api/storage/policy').then((r) => r.json()).then((policy) => {
      if (typeof policy.scratchWarningGiB === 'number') setLimit(policy.scratchWarningGiB * 1024 ** 3);
    }).catch(() => setError('The scratch warning setting could not be read.'));
    // Targets are snapshotted by each caller at the time it opens the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);
  useEffect(() => { if (rows && !working && !focused.current) { focused.current = true; keepButton.current?.focus(); } }, [rows, working]);

  async function close(empty: boolean) {
    if (!rows || working) return;
    setWorking(true); setError('');
    try {
      const selected = empty ? rows.filter((row) => targets.length === 1 ? row.measurement?.exists : row.selected) : [];
      for (const row of selected) {
        if (row.measurement?.busy && onStop) {
          onStop(row.target.id);
          let idle = false;
          for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            const status = await fetch(`/api/storage/scratch?${new URLSearchParams({ workflowId: row.target.id, busyOnly: '1' })}`);
            if (!status.ok) throw new Error(`${row.target.name}: could not check whether the turn stopped.`);
            if (!(await status.json() as Measurement).busy) { idle = true; break; }
          }
          if (!idle) throw new Error(`${row.target.name}: the turn is still running; scratch was not emptied.`);
        }
        const response = await fetch('/api/storage/empty-scratch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflowId: row.target.id, confirm: true, onClose: true }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(`${row.target.name}: ${result.message || result.error || 'Scratch could not be emptied.'}`);
      }
      continued.current = true; onContinue();
    } catch (err) { setError(err instanceof Error ? err.message : 'Scratch could not be emptied.'); }
    finally { setWorking(false); }
  }
  return <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
    <div ref={surface} role="dialog" aria-modal="true" aria-labelledby="scratch-close-title" data-help="storage.empty-scratch" onKeyDown={(event) => {
      if (event.key === 'Escape' && !working) { event.preventDefault(); onCancel(); }
      if (event.key !== 'Tab') return;
      const controls = [...(surface.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])].filter((el) => el.offsetParent !== null);
      if (!controls.length) { event.preventDefault(); return; }
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if ((event.shiftKey && index <= 0) || (!event.shiftKey && (index < 0 || index === controls.length - 1))) {
        event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus();
      }
    }} style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-fg)', border: '1px solid var(--color-border)', padding: 16, width: 'min(600px, calc(94vw / var(--ui-scale, 1)))', maxHeight: 'calc(90vh / var(--ui-scale, 1))', overflow: 'auto' }}>
      <WorkSurfaceControls surface={surface} storageKey="scratch-close" />
      <h2 id="scratch-close-title">{targets.length === 1 ? 'Empty scratch for this conversation?' : 'Empty scratch for selected members?'}</h2>
      <p>Intermediate files may be needed if you resume it. Kept files stay.</p>
      {!rows && <p>Measuring scratch...</p>}
      {rows?.map((row, index) => <div key={row.target.id} style={{ padding: '6px 0' }}>
        {targets.length > 1 && row.measurement?.exists && <input type="checkbox" style={{ width: 24, height: 24, verticalAlign: 'middle' }} checked={row.selected} aria-label={`Empty scratch for ${row.target.name}`} onChange={(e) => setRows((previous) => previous?.map((entry, i) => i === index ? { ...entry, selected: e.target.checked } : entry) ?? null)} />}
        {' '}<strong>{row.target.name}</strong>: {row.error ? <span role="alert">Measurement failed: {row.error}</span> : row.measurement ? <>
          {formatBytes(row.measurement.bytes)}; measured {new Date(row.measurement.measuredAt).toLocaleString()}; {row.measurement.keptItems} KEEP {row.measurement.keptItems === 1 ? 'mark' : 'marks'}.
          {row.measurement.bytes > limit && <span role="status"> Scratch exceeds the warning limit.</span>}
        </> : 'Measuring...'}
      </div>)}
      {rows && <p>Measurements may be stale if scratch changed. Use REFRESH to measure again.</p>}
      {error && <p role="alert">{error}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <button ref={keepButton} style={{ minHeight: 40 }} type="button" disabled={working || !rows} onClick={() => void close(false)}>KEEP SCRATCH</button>
        <button style={{ minHeight: 40 }} type="button" disabled={working || !rows || !rows.some((row) => targets.length === 1 ? row.measurement?.exists : row.selected)} onClick={() => void close(true)}>EMPTY SCRATCH AND CLOSE</button>
        <button style={{ minHeight: 40 }} type="button" disabled={working} onClick={() => void measure()}>REFRESH</button>
        <button style={{ minHeight: 40 }} type="button" disabled={working} onClick={onCancel}>CANCEL</button>
      </div>
    </div>
  </div>;
}

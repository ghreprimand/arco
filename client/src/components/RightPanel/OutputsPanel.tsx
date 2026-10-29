import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowOutput } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { DirectoryBrowser } from '../media/DirectoryPicker';
import { openImageForEdit, openMediaFile } from '../media/launchers';
import { FileViewerModal } from '../FileViewerModal';
const CATEGORIES = ['all', 'images', 'documents', 'audio', 'video', 'other'] as const;
const joinFolder = (folder: string, name: string) => folder.replace(/[\\/]+$/, '') + (folder.includes('\\') ? '\\' : '/') + name;
const paramsFor = (output: WorkflowOutput) => new URLSearchParams({ cwd: output.cwd, workflowId: output.workflowId, id: output.id });
export function OutputsPanel({ cwd, workflowId, clusterId }: { cwd: string; workflowId?: string; clusterId?: string }) {
  const [outputs, setOutputs] = useState<WorkflowOutput[]>([]);
  const [error, setError] = useState(''), [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(''), [category, setCategory] = useState<typeof CATEGORIES[number]>('all');
  const [viewerEditing, setViewerEditing] = useState(false);
  const [viewer, setViewer] = useState<WorkflowOutput | null>(null);
  const [transfer, setTransfer] = useState<{ output: WorkflowOutput; action: 'copy' | 'move'; destination?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const roots = useAppStore(s => s.settings?.projectRoots);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async (force = false) => {
    if (controller.current && !force) return;
    if (force) controller.current?.abort();
    const ac = new AbortController(); controller.current = ac;
    const attempt = ++request.current;
    try {
      const params = new URLSearchParams(clusterId ? { clusterId } : { cwd, workflowId: workflowId || '' });
      const res = await fetch(`/api/outputs?${params}`, { cache: 'no-store', signal: ac.signal });
      const body = await res.json();
      if (!res.ok || !Array.isArray(body.outputs)) throw new Error(body.error || 'Outputs could not be loaded.');
      if (request.current === attempt) { setOutputs(body.outputs); setError(''); }
    } catch (err) { if (request.current === attempt) setError(err instanceof Error ? err.message : 'Outputs could not be loaded.'); }
    finally { if (controller.current === ac) controller.current = null; if (request.current === attempt) setLoading(false); }
  }, [cwd, workflowId, clusterId]);
  useEffect(() => {
    setOutputs([]); setLoading(true); setViewer(null); setTransfer(null);
    void load(); const interval = window.setInterval(() => void load(), 5000);
    const focus = () => void load(); window.addEventListener('focus', focus);
    return () => { request.current++; controller.current?.abort(); controller.current = null; window.clearInterval(interval); window.removeEventListener('focus', focus); };
  }, [load]);
  const shown = outputs.filter(o => (category === 'all' || o.category === category) && `${o.title} ${o.name} ${o.producer} ${o.path || ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const open = (output: WorkflowOutput, edit = false) => {
    if (output.missing) return;
    if (output.path && ['images', 'audio', 'video'].includes(output.category)) {
      const context = { cwd: output.cwd, workflowId: output.workflowId };
      if (edit && output.category === 'images') openImageForEdit(output.path, context);
      else openMediaFile(output.path, context);
    } else { setViewer(output); setViewerEditing(edit); }
  };
  async function finishTransfer() {
    if (!transfer?.destination || busy) return;
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/outputs/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: transfer.output.cwd, workflowId: transfer.output.workflowId, id: transfer.output.id, destination: transfer.destination, sourcePath: transfer.output.path, action: transfer.action }) });
      const body = await res.json(); if (!res.ok || !body.ok) throw new Error(body.error || 'The file was not transferred.');
      setNote(transfer.action === 'copy' ? 'Copy saved. The original output remains available.' : 'Output moved. Existing output links still resolve.');
      setTransfer(null); await load(true);
    } catch (err) { setError(err instanceof Error ? err.message : 'The file was not transferred.'); }
    finally { setBusy(false); }
  }
  const previewable = (o: WorkflowOutput) => !!o.inline || (o.category !== 'other' && !/\.(pdf|docx?|odt)$/i.test(o.name));
  return <section data-help="rightpanel.outputs" aria-label="Workspace Outputs" className="outputs-panel" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', font: '12px/1.5 var(--font-body)' }}>
    <div style={{ padding: 10, borderBottom: '1px solid var(--color-border-hairline)', flexShrink: 0 }}>
      <div style={{ display: 'flex', gap: 6 }}><input type="search" aria-label="Search outputs" placeholder="Search outputs" value={query} onChange={e => setQuery(e.target.value)} style={{ flex: 1, minWidth: 0 }} /><button type="button" onClick={() => void load(true)}>Refresh</button></div>
      <label>Type <select aria-label="Output type" value={category} onChange={e => setCategory(e.target.value as typeof category)}>{CATEGORIES.map(kind => <option key={kind} value={kind}>{kind[0].toUpperCase() + kind.slice(1)}</option>)}</select></label>
      <p style={{ margin: '6px 0 0', color: 'var(--color-fg-muted)' }}>Generated files and explicit exports stay here after previews close.</p>
    </div>
    <div role="status" style={{ padding: '0 10px' }}>{loading ? 'Loading outputs...' : note}</div>
    {error && <p role="alert" style={{ padding: '0 10px', color: 'var(--color-warning)' }}>{error}</p>}
    <div style={{ overflowY: 'auto', minHeight: 0, flex: 1, padding: 10 }}>
      {!loading && !shown.length && <p>{outputs.length ? 'No matching outputs.' : 'No outputs yet. Generated files and explicit exports stay here. Save files into this workflow\'s artifacts folder when a tool does not report them automatically.'}</p>}
      <ul aria-label="Outputs" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{shown.map(output => <li key={`${output.workflowId}:${output.id}`} style={{ border: '1px solid var(--color-border-hairline)', borderRadius: 5, padding: 10, marginBottom: 10, overflowWrap: 'anywhere' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'start' }}>
          {output.path && output.category === 'images' && /\.(png|jpe?g|gif|webp)$/i.test(output.name) && !output.missing ? <img alt="" loading="lazy" src={`/api/outputs/file?${paramsFor(output)}&v=${Math.floor(output.updatedAt)}`} style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} /> : <span aria-hidden="true" style={{ flexShrink: 0, color: 'var(--color-accent-primary)' }}>[{output.inline ? 'TEXT' : output.category.slice(0, 3).toUpperCase()}]</span>}
          <div style={{ minWidth: 0 }}><strong>{output.title || output.name}</strong><div style={{ color: 'var(--color-fg-muted)' }}>{output.producer} / {new Date(output.updatedAt).toLocaleString()}</div></div>
        </div>
        <div title={output.path} style={{ fontFamily: 'var(--font-code)', fontSize: 10, margin: '8px 0' }}>{output.path || 'Inline artifact / no disk file'}</div>
        {output.missing && <p role="status">File missing. Its original provenance is retained.</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {previewable(output) && <button type="button" disabled={output.missing} onClick={() => open(output)}>Preview</button>}
          {output.path && previewable(output) && ['images', 'documents', 'audio', 'video'].includes(output.category) && <button type="button" disabled={output.missing} onClick={() => open(output, true)}>Open in editor</button>}
          <button type="button" disabled={output.missing} onClick={() => setTransfer({ output, action: 'copy' })}>Save a copy</button>
          {output.path && <button type="button" disabled={output.missing} onClick={() => setTransfer({ output, action: 'move' })}>Move</button>}
          {output.path && <a download href={`/api/outputs/file?${paramsFor(output)}&download=1`} aria-disabled={output.missing} onClick={e => { if (output.missing) e.preventDefault(); }}>Download</a>}
        </div>
        <details><summary>File information</summary><p>{output.name} / {output.size === undefined ? 'Inline content' : `${output.size} bytes`} / {output.source}</p><p>Produced by {output.producer} ({output.workflowId}). Created {new Date(output.createdAt).toLocaleString()}.</p>{output.originPath && <p>Original location: {output.originPath}</p>}{output.inputPath && <p>Source file: {output.inputPath}</p>}{output.derivedFrom && <p>Derived from output {output.derivedFrom}.</p>}</details>
      </li>)}</ul>
      <p style={{ color: 'var(--color-fg-muted)', fontSize: 10 }}>For files that do not appear automatically, save them in this workflow's artifacts folder and refresh. Up to 2,000 entries.</p>
    </div>
    {viewer && <FileViewerModal initialEditing={viewerEditing} path={viewer.path || viewer.name} fallback={{ cwd: viewer.cwd, workflowId: viewer.workflowId }} readUrl={`/api/outputs/content?${paramsFor(viewer)}`} editContext={viewer.path ? { cwd: viewer.cwd, workflowId: viewer.workflowId } : undefined} saveRequest={{ url: '/api/outputs/text', body: { cwd: viewer.cwd, workflowId: viewer.workflowId, id: viewer.id } }} onClose={() => { setViewer(null); void load(true); }} />}
    {transfer && <TransferDialog transfer={transfer} roots={roots} busy={busy} error={error} onDestination={destination => setTransfer({ ...transfer, destination })} onConfirm={() => void finishTransfer()} onClose={() => { if (!busy) setTransfer(null); }} />}
  </section>;
}
function TransferDialog({ transfer, roots, busy, error, onDestination, onConfirm, onClose }: {
  transfer: { output: WorkflowOutput; action: 'copy' | 'move'; destination?: string }; roots?: Array<{ name: string; path: string }>; busy: boolean; error: string;
  onDestination: (path: string) => void; onConfirm: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Tab' && !dialog.current?.contains(document.activeElement)) { event.preventDefault(); dialog.current?.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  useEffect(() => { if (transfer.destination) dialog.current?.querySelector<HTMLButtonElement>('[data-transfer-confirm]')?.focus(); }, [transfer.destination]);
  const file = transfer.output.name.replace(/[\\/:*?"<>|]/g, '_');
  return <div style={{ position: 'fixed', inset: 0, zIndex: 9800, background: '#000a', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 12 }}>
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={transfer.action === 'move' ? 'Move output' : 'Save a copy'} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') ?? [])].filter(el => el.getClientRects().length);
      if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === dialog.current)) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    }} style={{ width: 'min(640px,100%)', maxHeight: 'calc(94vh / var(--ui-scale,1))', overflowY: 'auto', padding: 14, border: '1px solid var(--color-border-hairline)', borderRadius: 6, background: 'var(--color-bg-panel)' }}>
      <h2>{transfer.action === 'move' ? 'Move output' : 'Save a copy'}</h2>
      <p style={{ overflowWrap: 'anywhere' }}>Source: {transfer.output.path || 'Inline artifact'}</p>
      {!transfer.destination ? <DirectoryBrowser inline initialPath={transfer.output.path?.replace(/[\\/][^\\/]+$/, '') || transfer.output.cwd} roots={roots} defaultName={transfer.output.inline && !file.includes('.') ? `${file}.txt` : file} title="Choose output destination" confirmLabel="Review destination" onDone={result => { if (result?.basename.trim()) onDestination(joinFolder(result.dir, result.basename.trim())); }} /> : <><p style={{ overflowWrap: 'anywhere' }}>Destination: {transfer.destination}</p><p>{transfer.action === 'move' ? 'Move removes the source only after the destination and output location are saved. Existing output links keep working.' : 'Save a copy retains the original output.'} Existing files are never overwritten.</p><button type="button" data-transfer-confirm disabled={busy} onClick={onConfirm}>{busy ? 'Saving...' : transfer.action === 'move' ? 'Move output' : 'Save copy'}</button></>}
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  </div>;
}

import { useEffect, useState } from 'react';
import { DialogShell } from '../DialogShell';
import { touchButton } from './ResearchCloseDialog';
import type { ResearchSelection } from './SendResearchDialog';

type File = { path: string; size: number };
type Prepared = { token?: string; filename?: string; mime?: string; data?: string; error?: string };

// docs/RESEARCH.md - copying and downloads are recorded only after the browser
// reports a clipboard write or starts a download.
export function ExportResearchDialog({ clusterId, selection, onClose }: { clusterId: string; selection: ResearchSelection; onClose: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    let active = true;
    void fetch(`/api/research/${clusterId}/preview-export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection }) })
      .then(async response => { const data = await response.json() as { files?: File[]; error?: string }; if (!response.ok) throw new Error(data.error || 'Could not list files.'); if (active) { setFiles(data.files ?? []); setPath(data.files?.[0]?.path ?? ''); } })
      .catch(error => { if (active) setStatus(error instanceof Error ? error.message : 'Could not list files.'); });
    return () => { active = false; };
  }, [clusterId, selection]);
  const run = async (kind: 'markdown' | 'file' | 'zip') => {
    if (busy) return; setBusy(true); setStatus('');
    try {
      const response = await fetch(`/api/research/${clusterId}/prepare-export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection, kind, ...(kind === 'file' ? { path } : {}) }) });
      const result = await response.json() as Prepared;
      if (!response.ok || !result.token || result.data === undefined || !result.filename) throw new Error(result.error || 'Could not prepare export.');
      const raw = atob(result.data); const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
      if (kind === 'markdown') {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable.');
        await navigator.clipboard.writeText(new TextDecoder().decode(bytes));
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: result.mime || 'application/octet-stream' }));
        const link = document.createElement('a'); link.href = url; link.download = result.filename; document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      const confirmed = await fetch(`/api/research/${clusterId}/confirm-export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: result.token }) });
      const done = kind === 'markdown' ? 'Markdown copied.' : 'Download started.';
      setStatus(confirmed.ok ? done : `${done} The export log could not be updated.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Export failed.'); }
    finally { setBusy(false); }
  };
  return <DialogShell title="Export research" onClose={onClose}>
    <p>Copy Markdown or download one file from the selection. ZIP includes the research folder, excluding private runtime and provider state. Wait for all rounds and catch-ups to finish before making a ZIP.</p>
    <button type="button" className="display-font" style={touchButton} disabled={busy || !files.length} onClick={() => void run('markdown')}>COPY MARKDOWN</button>
    <label>File <select className="arco-field" value={path} onChange={event => setPath(event.target.value)}>{files.map(file => <option key={file.path} value={file.path}>{file.path} ({file.size} bytes)</option>)}</select></label>
    <button type="button" className="display-font" style={touchButton} disabled={busy || !path} onClick={() => void run('file')}>DOWNLOAD FILE</button>
    <button type="button" className="display-font" style={touchButton} disabled={busy || !files.length} onClick={() => void run('zip')}>DOWNLOAD ZIP</button>
    {status && <p role="status">{status}</p>}
  </DialogShell>;
}

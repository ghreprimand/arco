import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ResearchLibraryRow } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { DialogShell } from '../DialogShell';
import { DirectoryBrowser } from '../media/DirectoryPicker';
import { ResearchReopenDialog, type ResearchReopenPayload } from '../research/ResearchReopenDialog';
import { rowButton } from '../research/researcherRow';

// docs/RESEARCH.md - the Research library on Home: every research project
// Arco knows, with OPEN, REOPEN, or LOCATE and FORGET. Nothing here creates,
// moves or deletes a research folder.

const SHOWN = 5;
const FILTER_ABOVE = 10;
const STATUS_LABEL: Record<ResearchLibraryRow['status'], string> = { open: 'Open', closed: 'Closed', missing: 'Missing' };

export function rowDetail(row: ResearchLibraryRow): string {
  const date = (iso?: string) => iso ? new Date(iso).toLocaleDateString() : '';
  return [STATUS_LABEL[row.status], `created ${date(row.createdAt)}`, ...(row.closedAt ? [`closed ${date(row.closedAt)}`] : []),
    ...(row.status === 'missing' ? [] : [`${row.researchers} researcher${row.researchers === 1 ? '' : 's'}`, `${row.rounds} round${row.rounds === 1 ? '' : 's'}`])].join(' / ');
}

export function filterRows(rows: ResearchLibraryRow[], query: string): ResearchLibraryRow[] {
  const q = query.trim().toLowerCase();
  return q ? rows.filter((r) => `${r.name}\n${r.question}\n${r.folder}`.toLowerCase().includes(q)) : rows;
}

export function ResearchLibrary({ onOpenCluster, onReopen }: { onOpenCluster?: (clusterId: string) => void; onReopen?: (payload: ResearchReopenPayload) => boolean | void }) {
  const researchFolder = useAppStore((s) => s.settings?.researchFolder);
  const openClusters = useAppStore((s) => Object.keys(s.clusters).join(','));
  const [rows, setRows] = useState<ResearchLibraryRow[] | null>(null);
  const [status, setStatus] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [reopening, setReopening] = useState<string | null>(null);
  const [locating, setLocating] = useState<ResearchLibraryRow | null>(null);
  const [forgetting, setForgetting] = useState<ResearchLibraryRow | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/research/library', { cache: 'no-store' });
      const body = await res.json().catch(() => null) as { rows?: ResearchLibraryRow[] } | null;
      if (!res.ok || !Array.isArray(body?.rows)) throw new Error();
      setRows(body.rows);
    } catch { setStatus('The research library could not be loaded.'); setRows((old) => old ?? []); }
  }, []);
  // Reload when a cluster opens or closes, so Open and Closed stay current.
  useEffect(() => { void load(); }, [load, openClusters]);
  const filtered = useMemo(() => filterRows(rows ?? [], query), [rows, query]);
  if (!rows || (rows.length === 0 && !researchFolder)) return null;
  const shown = expanded || query ? filtered : filtered.slice(0, SHOWN);

  const post = async (row: ResearchLibraryRow, action: 'locate' | 'forget', body?: unknown): Promise<{ ok: boolean; code?: string }> => {
    const res = await fetch(`/api/research/library/${row.projectId}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const reply = await res.json().catch(() => ({})) as { code?: string; error?: string };
    return { ok: res.ok, code: reply.code ?? reply.error };
  };
  const locate = async (row: ResearchLibraryRow, folder: string) => {
    const result = await post(row, 'locate', { folder }).catch(() => ({ ok: false, code: 'failed' }));
    setStatus(result.ok ? `${row.name} was found in ${folder}.` : result.code === 'not_this_project' ? `That folder does not hold ${row.name}. Choose the folder that contains its research.json.` : `${row.name} could not be located.`);
    if (result.ok) { setLocating(null); void load(); }
  };
  const forget = async (row: ResearchLibraryRow) => {
    const result = await post(row, 'forget').catch(() => ({ ok: false }));
    setForgetting(null);
    setStatus(result.ok ? `${row.name} was removed from the library. No files were changed.` : `${row.name} could not be removed from the library.`);
    void load();
  };

  return <section aria-labelledby="home-research" data-help="home.research-library">
    <div className="home-section-heading"><h2 id="home-research">Research library <span className="home-count">({rows.length})</span></h2>
      <span className="home-fine-print">Research projects and their folders.</span></div>
    {rows.length > FILTER_ABOVE && <div className="home-search"><label htmlFor="home-research-filter">Filter research</label>
      <input id="home-research-filter" type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }} placeholder="Name, question or folder" /></div>}
    {rows.length === 0 && <p className="home-fine-print">No research projects yet. Start one from New cluster, Research.</p>}
    <div role="status" aria-live="polite" className="home-feedback">{status}</div>
    <ul id="home-research-list" className="home-work-grid" aria-labelledby="home-research">{shown.map((row) => {
      const detail = rowDetail(row);
      return <li key={row.projectId} data-research-row={row.status}>
        <div className="home-work-details">
          <strong title={row.name}>{row.name}</strong>
          {row.question && <small title={row.question}>{row.question}</small>}
          <small title={`${detail}\n${row.folder}`} style={{ whiteSpace: 'normal' }}>{detail}</small>
          <small title={row.folder} style={{ fontFamily: 'var(--font-code)', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{row.folder}</small>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {row.status === 'open' && row.clusterId && <button type="button" className="home-primary" style={{ minHeight: 44 }} aria-label={`Open research project ${row.name}`} onClick={() => onOpenCluster?.(row.clusterId!)}>Open</button>}
          {row.status === 'closed' && <button type="button" className="home-primary" style={{ minHeight: 44 }} aria-label={`Reopen research project ${row.name}`} disabled={!onReopen} onClick={() => setReopening(row.projectId)}>Reopen</button>}
          {row.status === 'missing' && <>
            <button type="button" style={{ minHeight: 44 }} aria-label={`Locate research project ${row.name}`} onClick={() => setLocating(row)}>Locate</button>
            <button type="button" style={{ minHeight: 44 }} aria-label={`Forget research project ${row.name}`} onClick={() => setForgetting(row)}>Forget</button>
          </>}
        </div>
      </li>;
    })}</ul>
    {!query && filtered.length > SHOWN && <button type="button" className="home-show-all" aria-expanded={expanded} aria-controls="home-research-list" onClick={() => setExpanded((open) => !open)}>{expanded ? 'Show fewer' : `Show all ${filtered.length}`}</button>}
    {reopening && onReopen && <ResearchReopenDialog projectId={reopening} onClose={() => { setReopening(null); void load(); }} onReopen={onReopen} />}
    {locating && <DialogShell title={`Locate ${locating.name}`} size="picker" dataHelp="home.research-library" onClose={() => setLocating(null)}>
      <p className="home-fine-print" style={{ marginTop: 0 }}>Choose the folder that now holds this project's research.json. Arco only updates its record; nothing is moved.</p>
      <div role="status" className="home-feedback">{status}</div>
      <DirectoryBrowser inline withFilename={false} initialPath={researchFolder ?? ''} title="Choose the project folder" confirmLabel="Use this folder" onDone={(r) => { if (r) void locate(locating, r.dir); else setLocating(null); }} />
    </DialogShell>}
    {forgetting && <DialogShell title={`Forget ${forgetting.name}`} size="confirm" dataHelp="home.research-library" onClose={() => setForgetting(null)}
      actions={<><button type="button" style={rowButton} onClick={() => setForgetting(null)}>CANCEL</button><button type="button" style={rowButton} onClick={() => void forget(forgetting)}>FORGET</button></>}>
      <p style={{ marginTop: 0 }}>Remove {forgetting.name} from the Research library? No files are deleted. If its folder turns up in the research folder later, it is not added back.</p>
    </DialogShell>}
  </section>;
}

import { useEffect, useState } from 'react';
import { researchSearchDetails, type ClusterResearchSummary } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { usePhoneStore } from '../../stores/phoneStore';
import { DialogShell } from '../DialogShell';
import { DirectoryBrowser } from '../media/DirectoryPicker';
import { ENTRY_WORDS, elapsedLabel, searchCount } from './researchView';

function actionText(entry: { tool?: string; text?: string; input?: string }): string {
  const search = researchSearchDetails(entry.tool, entry.input);
  if (search.search) return search.query ? `Searching: ${search.query.replace(/\s+/g, ' ').trim().slice(0, 120)}` : 'Searching';
  let detail = '';
  if (entry.input) {
    try {
      const input = JSON.parse(entry.input) as Record<string, unknown>;
      const value = input.query ?? input.searchTerm ?? input.url;
      if (typeof value === 'string') detail = value.replace(/\s+/g, ' ').trim().slice(0, 120);
    } catch { /* Tool input may be plain text. */ }
  }
  return [entry.tool ?? entry.text?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? 'Working', detail].filter(Boolean).join(': ');
}

// The operator can inspect activity without opening a researcher's conversation.
export function QuickResearchOverview({ clusterId, research, onResults }: { clusterId: string; research: ClusterResearchSummary; onResults: () => void }) {
  const jobs = useAppStore(state => state.jobs);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const researchFolder = useAppStore(state => state.settings?.researchFolder);
  const roots = useAppStore(state => state.settings?.projectRoots);
  const [choosing, setChoosing] = useState(false);
  const [promotion, setPromotion] = useState<{ phase: string; message?: string }>({ phase: 'idle' });
  useEffect(() => {
    if (!selected && !choosing) return;
    const close = () => { if (choosing) setChoosing(false); else setSelected(null); };
    usePhoneStore.getState().setLocalDialog(close);
    return () => { if (usePhoneStore.getState().localDialog === close) usePhoneStore.getState().setLocalDialog(null); };
  }, [selected, choosing]);
  const refreshPromotion = async () => {
    try { const response = await fetch(`/api/research/${clusterId}/keep-as-project`, { cache: 'no-store' }); if (response.ok) setPromotion(await response.json()); }
    catch { /* The current research stays open. */ }
  };
  useEffect(() => { void refreshPromotion(); }, [clusterId]);
  useEffect(() => {
    if (!['waiting', 'copying', 'switching'].includes(promotion.phase)) return;
    const timer = setInterval(() => void refreshPromotion(), 2000);
    return () => clearInterval(timer);
  }, [clusterId, promotion.phase]);
  const keep = async (folderRoot?: string) => {
    try {
      const response = await fetch(`/api/research/${clusterId}/keep-as-project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(folderRoot ? { folderRoot } : {}) });
      const body = await response.json() as { phase?: string; message?: string; error?: string };
      if (!response.ok) throw new Error(body.error || 'Could not keep the project.');
      setPromotion({ phase: body.phase ?? 'waiting', message: body.message }); setChoosing(false);
    } catch (error) { setPromotion({ phase: 'error', message: error instanceof Error ? error.message : 'The copy did not complete. Quick research is still available.' }); }
  };
  const round = research.rounds.at(-1);
  useEffect(() => {
    if (!round || round.releasedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [round?.startedAt, round?.releasedAt]);
  const selectedResearcher = research.researchers.find(item => item.workflowId === selected);
  return <section data-help="research.quick" aria-label="Quick research" style={{ flexShrink: 0, maxHeight: '45%', display: 'flex', flexDirection: 'column', padding: 10, borderBottom: '1px solid var(--color-border-hairline)', color: 'var(--color-fg)' }}>
    <div style={{ minHeight: 0, overflowY: 'auto' }}>
    <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{research.brief}</div>
    {research.researchers.filter(item => !item.removedAt).map(item => {
      const job = jobs[item.workflowId], entry = round?.entries[item.letter];
      const latest = job?.activity?.at(-1);
      const state = entry ? ENTRY_WORDS[entry.state] : 'starting';
      const searches = searchCount(job);
      return <button type="button" key={item.workflowId} onClick={() => setSelected(item.workflowId)} style={{ display: 'block', width: '100%', minHeight: 44, textAlign: 'left', background: 'transparent', color: 'inherit', border: '1px solid var(--color-border-hairline)', marginTop: 6, padding: 8 }}>
        <strong>Researcher {item.letter}</strong> · {item.provider} · {item.model} · {state} · {searches} search{searches === 1 ? '' : 'es'}{round ? ` · ${elapsedLabel(round.startedAt, entry?.at ?? round.releasedAt, now)}` : ''}
        {(entry?.state === 'replied' || latest) && <span style={{ display: 'block', overflowWrap: 'anywhere' }}>{entry?.state === 'replied' ? 'Report received' : latest?.status === 'failed' ? `${actionText(latest)} failed` : latest ? actionText(latest) : ''}</span>}
      </button>;
    })}
    </div>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6, flexShrink: 0 }}>
      <button type="button" onClick={onResults} style={{ minHeight: 44 }}>RESULTS</button>
      <button type="button" disabled={['waiting', 'copying', 'switching'].includes(promotion.phase)} onClick={() => researchFolder ? void keep() : setChoosing(true)} style={{ minHeight: 44 }}>KEEP AS PROJECT</button>
    </div>
    {promotion.phase === 'waiting' && <div role="status">WAITING — research stays usable until the copy starts.</div>}
    {['copying', 'switching'].includes(promotion.phase) && <div role="status">COPYING — the project is being kept.</div>}
    {promotion.message && <div role="status">{promotion.message}</div>}
    {choosing && <DialogShell title="Choose the research folder" onClose={() => setChoosing(false)}>
      <p>A project folder will be created here and this location saved for future research projects.</p>
      <DirectoryBrowser inline withFilename={false} roots={roots} title="Choose research folder" confirmLabel="KEEP HERE" onDone={choice => { if (choice) void keep(choice.dir); else setChoosing(false); }} />
    </DialogShell>}
    {selectedResearcher && <DialogShell title={`Researcher ${selectedResearcher.letter} activity`} onClose={() => setSelected(null)}>
      {(jobs[selectedResearcher.workflowId]?.activity ?? []).length === 0 ? <p>No activity yet.</p> : <ul>{(jobs[selectedResearcher.workflowId]?.activity ?? []).map(item => <li key={item.id} style={{ overflowWrap: 'anywhere' }}>{actionText(item)}{item.status ? ` · ${item.status}` : ''}</li>)}</ul>}
    </DialogShell>}
  </section>;
}

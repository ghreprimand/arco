import { useEffect, useState } from 'react';
import { RESEARCH_MAX_RESEARCHERS } from '@arco/shared';
import type { ResearchStartPrefill } from '../../stores/appStore.types';
import { useAppStore } from '../../stores/appStore';
import { DialogShell } from '../DialogShell';
import { touchButton } from './ResearchCloseDialog';
import { ResearcherRowFields, useResearcherAvailability, type ResearcherRowValue } from './researcherRow';

type Preview = { name: string; brief: string; blind: boolean; sourceProject?: string; director?: ResearchStartPrefill['director']; researchers: NonNullable<ResearchStartPrefill['researchers']> };

// docs/RESEARCH.md - a new round keeps the live panel; a new project can
// edit a copy without changing the existing researchers.
export function RerunResearchDialog({ clusterId, onClose }: { clusterId: string; onClose: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [brief, setBrief] = useState('');
  const [mode, setMode] = useState<'round' | 'project'>('round');
  const [rows, setRows] = useState<ResearcherRowValue[]>([]);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState('');
  const availability = useResearcherAvailability(mode === 'project');
  useEffect(() => {
    let active = true;
    void fetch(`/api/research/${clusterId}/rerun-preview`).then(async response => {
      const data = await response.json() as Preview & { error?: string };
      if (!response.ok) throw new Error(data.error || 'Could not load the panel.');
      if (active) { setPreview(data); setBrief(data.brief); setRows(data.researchers.map(r => ({ ...r, effort: r.effort ?? '' }))); }
    }).catch(error => { if (active) setStatus(error instanceof Error ? error.message : 'Could not load the panel.'); });
    return () => { active = false; };
  }, [clusterId]);
  const start = async () => {
    if (!preview || busy || !brief.trim()) return;
    if (mode === 'project') {
      if (!rows.length || rows.some(row => !row.model || !availability.rowUsable(row))) return;
      useAppStore.getState().openCreatorWith({ mode: 'research', researchPrefill: { name: preview.name, brief, blind: preview.blind, sourceProject: preview.sourceProject, rerunFrom: clusterId, director: preview.director, researchers: rows } });
      onClose(); return;
    }
    setBusy(true); setStatus('');
    try {
      const response = await fetch(`/api/research/${clusterId}/rerun-round`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brief }) });
      const result = await response.json() as { round?: number; error?: string; receiptError?: string };
      if (!response.ok) throw new Error(result.error || 'Could not start the round.');
      setStarted(true); setStatus(`Round ${result.round} started.${result.receiptError ? ` ${result.receiptError}` : ''}`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not start the round.'); }
    finally { setBusy(false); }
  };
  return <DialogShell title="Rerun research" onClose={onClose}>
    <p>Review the brief and choose a new round or a separate project. To change the panel for a new round, edit MEMBERS first.</p>
    <label>Brief <textarea className="arco-field" value={brief} onChange={e => setBrief(e.target.value)} rows={7} maxLength={20000} /></label>
    <label><input type="radio" name="rerun-mode" checked={mode === 'round'} onChange={() => setMode('round')} /> New round with the current panel</label>
    <label><input type="radio" name="rerun-mode" checked={mode === 'project'} onChange={() => setMode('project')} /> New project with a copy of the panel</label>
    {mode === 'project' && <div>
      <p>Edit the copied panel before opening the new-project form.</p>
      {rows.map((row, index) => <div key={index} style={{ marginBottom: 8 }}><ResearcherRowFields row={row} avail={availability} label={`Researcher ${index + 1}`} onChange={next => setRows(all => all.map((r, i) => i === index ? next : r))} extra={<button type="button" className="display-font" style={touchButton} onClick={() => setRows(all => all.filter((_, i) => i !== index))}>REMOVE</button>} /></div>)}
      <button type="button" className="display-font" style={touchButton} onClick={() => { const next = availability.firstUsable(); if (next) setRows(all => [...all, next]); }} disabled={rows.length >= RESEARCH_MAX_RESEARCHERS || !availability.firstUsable()}>+ ADD RESEARCHER</button>
      {rows.some(row => !availability.rowUsable(row)) && <p role="status">A researcher is unavailable. Choose an enabled provider and model before continuing.</p>}
    </div>}
    <button type="button" className="display-font" style={touchButton} disabled={busy || started || !preview || !brief.trim() || (mode === 'project' && (!rows.length || rows.some(row => !row.model || !availability.rowUsable(row))))} onClick={() => void start()}>{busy ? 'STARTING...' : mode === 'round' ? 'START ROUND' : 'REVIEW NEW PROJECT'}</button>
    {status && <p role="status">{status}</p>}
  </DialogShell>;
}

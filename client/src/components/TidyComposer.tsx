import { describeUtilityFailure, utilityAttribution } from './utilityResult';
import { useEffect, useRef, useState } from 'react';
import type { UtilityJobResult } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useDraftStore } from '../stores/draftStore';
import { useStartupStore } from '../stores/startupStore';

type Revision = { text: string; result: UtilityJobResult };
const MAX_DIRECTIVES = 16;

export function TidyComposer({ jobId, disabled = false }: { jobId: string; disabled?: boolean }) {
  const draft = useDraftStore((s) => s.drafts[jobId] ?? '');
  const canUndo = useDraftStore((s) => Boolean(s.tidyUndo[jobId]));
  const agent = useAppStore((s) => s.settings?.utilityAgent);
  const [open, setOpen] = useState(false), [original, setOriginal] = useState('');
  const [revisions, setRevisions] = useState<Revision[]>([]), [current, setCurrent] = useState(0);
  const [directives, setDirectives] = useState<string[]>([]), [directive, setDirective] = useState(''), [refining, setRefining] = useState(false);
  const [running, setRunning] = useState(false), [slow, setSlow] = useState(false), [note, setNote] = useState('');
  const active = useRef('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancel = () => { if (active.current) void fetch('/api/utility-agent/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: active.current }) }).catch(() => undefined); };
  const close = () => { cancel(); active.current = ''; setRunning(false); setOpen(false); };
  useEffect(() => () => { cancel(); active.current = ''; }, [jobId]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, a[href]')];
      if (!controls.length) { event.preventDefault(); dialogRef.current.focus(); return; }
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); controls[controls.length - 1]?.focus(); }
      else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) { event.preventDefault(); controls[0]?.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); previous?.focus(); };
  }, [open]);
  const run = async (base: string, proposal: string, prior: string[], added = '') => {
    const next = added ? [...prior, added] : prior;
    if (next.length > MAX_DIRECTIVES) { setNote('The refinement limit has been reached.'); return; }
    const material = JSON.stringify({ original: base, proposal, directives: next });
    if (material.length > 18_000) { setNote('This draft and its refinements are too long to tidy safely. Shorten them and try again.'); return; }
    if (added) { setDirectives(next); setDirective(''); setRefining(false); }
    const job = `tidy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; active.current = job;
    setRunning(true); setSlow(false); setNote('');
    const timer = setTimeout(() => { if (active.current === job) setSlow(true); }, 4000);
    try {
      const response = await fetch('/api/utility-agent/tidy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job, workflowId: jobId, original: base, proposal, directives: next }) });
      if (!response.ok) throw new Error('request failed');
      const result = await response.json() as UtilityJobResult;
      if (active.current !== job) return;
      if (result.status === 'ok' && result.text?.trim()) {
        if (!proposal && !prior.length && !added) { setRevisions([{ text: result.text!, result }]); setCurrent(0); }
        else { setRevisions((old) => [...old.slice(0, current + 1), { text: result.text!, result }]); setCurrent(current + 1); }
        setDirective(''); setRefining(false);
      } else setNote([describeUtilityFailure(result), utilityAttribution(result)].filter(Boolean).join(' '));
    } catch { if (active.current === job) setNote('Could not tidy the draft. Try again.'); }
    finally { clearTimeout(timer); if (active.current === job) { active.current = ''; setRunning(false); } }
  };
  const start = () => {
    const source = useDraftStore.getState().drafts[jobId] ?? '';
    setOriginal(source); setRevisions([]); setCurrent(0); setDirectives([]); setDirective(''); setRefining(false); setNote(''); setOpen(true);
    if (agent && source.trim()) void run(source, '', []);
  };
  const revision = revisions[current];
  const accept = () => {
    if (!revision?.text.trim()) return;
    if (!useDraftStore.getState().applyTidy(jobId, original, revision.text)) { setNote('The composer draft changed while this dialog was open. Keep the original and try again.'); return; }
    close();
  };
  return <div data-help="composer.tidy" style={{ display: 'inline-flex', gap: '6px', flexWrap: 'wrap' }}>
    <button type="button" data-help="composer.tidy" disabled={disabled || !draft.trim()} onClick={start}>TIDY</button>
    {canUndo && <button type="button" data-help="composer.tidy" onClick={() => useDraftStore.getState().undoTidy(jobId)}>UNDO TIDY</button>}
    {open && <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Tidy draft" style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,.65)', display: 'grid', placeItems: 'center', padding: '12px' }}>
      <div style={{ width: 'min(900px, 100%)', maxHeight: 'calc(85vh / var(--ui-scale, 1))', overflow: 'auto', overflowWrap: 'anywhere', background: 'var(--color-bg-dialog)', border: '1px solid var(--color-border-hairline)', padding: '16px', display: 'grid', gap: '10px' }}>
        <h2>Tidy draft</h2>
        {!agent ? <p>No utility agent is chosen. <button type="button" data-help="composer.tidy" onClick={() => { close(); useStartupStore.getState().setSettingsSection('utility-agent'); useAppStore.getState().setShowSettings(true); }}>OPEN UTILITY AGENT SETTINGS</button></p>
          : <p>The original and refinement instructions are sent to {agent.provider.toUpperCase()} / {agent.model}. The proposal is not sent to the worker until the composer is sent.</p>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 250px), 1fr))', gap: '12px', minWidth: 0 }}>
          <div><strong>Original</strong><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '240px', overflow: 'auto' }}>{original}</pre></div>
          <label>Proposal {revision && `(revision ${current + 1} of ${revisions.length})`}
            <textarea className="arco-field" data-help="composer.tidy" aria-label="Proposed draft" disabled={!revision || running} value={revision?.text ?? ''} onChange={(e) => { const value = e.target.value; setRevisions((old) => old.map((r, i) => i === current ? { ...r, text: value } : r)); }} style={{ display: 'block', width: '100%', minHeight: '180px', maxHeight: '300px', resize: 'vertical' }} />
          </label>
        </div>
        {agent && !running && (!revision || note) && <button type="button" data-help="composer.tidy" onClick={() => void run(original, revision?.text ?? '', directives)}>TRY AGAIN</button>}
        {directives.length > 0 && <details><summary>Refinement instructions ({directives.length})</summary><ol>{directives.map((item, i) => <li key={i}>{item}</li>)}</ol></details>}
        {revision?.result.agent && <p>Answered by {revision.result.agent.provider.toUpperCase()} / {revision.result.agent.model}.</p>}
        {revision && <details><summary>Facts used ({revision.result.facts.length})</summary><ul>{revision.result.facts.map((fact, i) => <li key={i}><strong>{fact.label}:</strong> {fact.value}</li>)}</ul></details>}
        {running && <p role="status">{slow ? 'Still working. A cold start can take a while.' : 'Tidying the draft.'} <button type="button" data-help="composer.tidy" onClick={cancel}>CANCEL</button></p>}
        {note && <p role="status">{note}</p>}
        {refining && <label>Refinement directive <input className="arco-field" data-help="composer.tidy" aria-label="Refinement directive" maxLength={500} value={directive} onChange={(e) => setDirective(e.target.value)} placeholder="For example: shorter" /></label>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          <button type="button" data-help="composer.tidy" disabled={!revision?.text.trim() || running} onClick={accept}>ACCEPT</button>
          <button type="button" data-help="composer.tidy" disabled={!revision || running || directives.length >= MAX_DIRECTIVES} onClick={() => { if (!refining) setRefining(true); else if (directive.trim()) void run(original, revision?.text ?? '', directives, directive.trim()); }}>REFINE</button>
          <button type="button" data-help="composer.tidy" disabled={current === 0 || running} onClick={() => setCurrent((n) => n - 1)}>BACK</button>
          <button type="button" data-help="composer.tidy" onClick={close}>KEEP ORIGINAL</button>
        </div>
      </div>
    </div>}
  </div>;
}

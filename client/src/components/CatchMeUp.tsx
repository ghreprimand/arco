import { describeUtilityFailure, utilityAttribution } from './utilityResult';
import { useEffect, useRef, useState } from 'react';
import type { UtilityJobResult } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useStartupStore } from '../stores/startupStore';

type Scope = { kind: 'workflow' | 'cluster'; id: string };
type Result = UtilityJobResult & { from: number; to: number; empty?: boolean };
const markerKey = (scope: Scope) => `arco.last-viewed.${scope.kind}.${scope.id}`;
function readMarker(key: string): number | null { try { const n = Number(localStorage.getItem(key)); return Number.isFinite(n) && n > 0 && n <= Date.now() ? n : null; } catch { return null; } }
function writeMarker(key: string) { try { localStorage.setItem(key, String(Date.now())); } catch { /* storage unavailable */ } }

// Freeze the previous departure time for this visit. Switching tabs, hiding the
// browser and page exit record the end of a visit; reading a tab does not erase
// the interval before the operator can ask for it.
export function useCatchUpMarker(scope: Scope | null): number | null {
  const key = scope ? markerKey(scope) : '';
  const [marker, setMarker] = useState<{ key: string; from: number | null }>({ key: '', from: null });
  useEffect(() => {
    if (!key) return;
    let visible = !document.hidden;
    if (visible) setMarker({ key, from: readMarker(key) });
    const visibility = () => {
      if (document.hidden && visible) { writeMarker(key); visible = false; }
      else if (!document.hidden && !visible) { visible = true; setMarker({ key, from: readMarker(key) }); }
    };
    const leave = () => { if (visible) writeMarker(key); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', leave);
    return () => { leave(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', leave); };
  }, [key]);
  return marker.key === key ? marker.from : null;
}

export function CatchMeUp({ scope }: { scope: Scope | null }) {
  const from = useCatchUpMarker(scope);
  const agent = useAppStore((s) => s.settings?.utilityAgent);
  const [open, setOpen] = useState(false), [running, setRunning] = useState(false), [slow, setSlow] = useState(false);
  const [result, setResult] = useState<Result | null>(null), [error, setError] = useState('');
  const active = useRef('');
  const cancel = () => { const id = active.current; if (id) void fetch('/api/utility-agent/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: id }) }).catch(() => undefined); };
  const close = () => { cancel(); active.current = ''; setRunning(false); setOpen(false); };
  useEffect(() => { setOpen(false); setResult(null); setError(''); return () => { cancel(); active.current = ''; }; }, [scope?.id, scope?.kind]);
  useEffect(() => { if (!open) return; const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey); }, [open]);
  const run = async () => {
    if (!scope || running) return;
    const jobId = `catch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; active.current = jobId;
    setRunning(true); setSlow(false); setError(''); setResult(null);
    const timer = setTimeout(() => { if (active.current === jobId) setSlow(true); }, 4000);
    try {
      const body: Record<string, unknown> = { jobId, scope: scope.kind, id: scope.id };
      if (typeof from === 'number') body.from = from;
      const response = await fetch('/api/utility-agent/catch-up', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error('Activity is unavailable for this tab.');
      const payload = await response.json() as Result;
      if (active.current === jobId) setResult(payload);
    } catch { if (active.current === jobId) setError('Could not collect or summarize this activity. Try again.'); }
    finally { clearTimeout(timer); if (active.current === jobId) { active.current = ''; setRunning(false); } }
  };
  if (!scope) return null;
  return <div data-help="utility.catch-up" style={{ alignSelf: 'center', flexShrink: 0 }}>
    <button type="button" className="display-font" data-help="utility.catch-up" onClick={() => { setOpen(true); setResult(null); setError(''); }}>CATCH ME UP</button>
    {open && <div role="dialog" aria-modal="true" aria-label="Catch me up" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }} style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,.65)', display: 'grid', placeItems: 'center', padding: '12px' }}>
      <div style={{ background: 'var(--color-bg-dialog)', border: '1px solid var(--color-border-hairline)', padding: '16px', width: 'min(680px, 100%)', maxHeight: 'calc(85vh / var(--ui-scale, 1))', overflow: 'auto', overflowWrap: 'anywhere', display: 'grid', gap: '10px' }}>
        <h2>Catch me up</h2>
        {!agent ? <p>No utility agent is chosen. <button type="button" className="display-font" data-help="utility.catch-up" onClick={() => { close(); useStartupStore.getState().setSettingsSection('utility-agent'); useAppStore.getState().setShowSettings(true); }}>OPEN UTILITY AGENT SETTINGS</button></p>
          : <><p style={{ margin: 0, color: 'var(--color-fg-muted)' }}>{typeof from === 'number'
            ? <>Since {new Date(from).toLocaleString()} until the request starts. Activity is sent to {agent.provider.toUpperCase()} / {agent.model}.</>
            : <>No previous visit is recorded for this browser. Summarize covers this tab from its start, or the last 24 hours if older. Activity is sent to {agent.provider.toUpperCase()} / {agent.model}.</>}</p>
            {!running && <button type="button" className="display-font" data-help="utility.catch-up" onClick={() => void run()}>SUMMARIZE</button>}
            {running && <p role="status">{slow ? 'Still working. A cold start can take a while.' : 'Collecting and summarizing activity.'} <button type="button" className="display-font" data-help="utility.catch-up" onClick={cancel}>CANCEL</button></p>}</>}
        {error && <p role="alert">{error}</p>}
        {result && <div role="status">
          {result.empty
            ? <p>Nothing has happened in this tab yet.</p>
            : <>
              <p>Requested range: {new Date(result.from).toLocaleString()} - {new Date(result.to).toLocaleString()}</p>
              {result.status === 'ok' ? <><p>{result.text}</p><p>Answered by {result.agent?.provider.toUpperCase()} / {result.agent?.model}.</p></>
                : <p>{describeUtilityFailure(result)} {utilityAttribution(result)}</p>}
              {result.truncated && <p>Older or lengthy activity was omitted from the facts.</p>}
              <details><summary>Facts used ({result.facts.length})</summary><ul>{result.facts.map((fact, i) => <li key={i}><strong>{fact.label}:</strong> {fact.value}</li>)}</ul></details>
            </>}
        </div>}
        <button type="button" className="display-font" data-help="utility.catch-up" onClick={close}>CLOSE</button>
      </div>
    </div>}
  </div>;
}

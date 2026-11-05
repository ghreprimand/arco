import { describeUtilityFailure, utilityAttribution } from './utilityResult';
import { useEffect, useRef, useState } from 'react';
import type { UtilityJobResult } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useStartupStore } from '../stores/startupStore';
import { DialogShell } from './DialogShell';

type Scope = { kind: 'workflow' | 'cluster'; id: string };
type Result = UtilityJobResult & { from: number; to: number; empty?: boolean; lastActivity?: number | null };
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
  const run = async (range?: 'last-turn' | 'hour' | 'today') => {
    if (!scope || running) return;
    const jobId = `catch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; active.current = jobId;
    setRunning(true); setSlow(false); setError(''); setResult(null);
    const timer = setTimeout(() => { if (active.current === jobId) setSlow(true); }, 4000);
    try {
      const body: Record<string, unknown> = { jobId, scope: scope.kind, id: scope.id };
      if (range) body.range = range;
      else if (typeof from === 'number') body.marker = from;
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
    {open && <DialogShell title="Catch me up" onClose={close} dataHelp="utility.catch-up"
      status={(running || error) ? <>
        {running && <p role="status" style={{ margin: 0 }}>{slow ? 'Still working. A cold start can take a while.' : 'Collecting and summarizing activity.'} <button type="button" className="display-font" data-help="utility.catch-up" onClick={cancel}>CANCEL</button></p>}
        {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}
      </> : undefined}
      actions={<>
        {agent && !running && <button type="button" className="display-font" data-help="utility.catch-up" onClick={() => void run()}>SUMMARIZE</button>}
      </>}>
      {!agent ? <p style={{ margin: 0 }}>No utility agent is chosen. <button type="button" className="display-font" data-help="utility.catch-up" onClick={() => { close(); useStartupStore.getState().setSettingsSection('utility-agent'); useAppStore.getState().setShowSettings(true); }}>OPEN UTILITY AGENT SETTINGS</button></p>
        : <p style={{ margin: 0, color: 'var(--color-fg-muted)' }}>{typeof from === 'number'
          ? <>From the earlier of the last visit or last operator message until the request starts. Activity is sent to {agent.provider.toUpperCase()} / {agent.model}.</>
          : <>No previous visit is recorded for this browser. Summarize covers this tab from its start, or the last 24 hours if older. Activity is sent to {agent.provider.toUpperCase()} / {agent.model}.</>}</p>}
      {result && <div role="status" style={{ display: 'grid', gap: '8px' }}>
        {result.empty
          ? <>
            <p style={{ margin: 0 }}>{result.lastActivity == null ? 'Nothing has happened in this tab yet.' : `Nothing new since ${new Date(result.from).toLocaleString()}. Last activity: ${new Date(result.lastActivity).toLocaleString()}.`}</p>
            {result.truncated && <p style={{ margin: 0 }}>Earlier activity was omitted from the available history.</p>}
            {result.facts.some((fact) => fact.value === 'activity not available') && <p style={{ margin: 0 }}>Some members' activity is unavailable.</p>}
            <div>{(['last-turn', 'hour', 'today'] as const).map((range) => <button key={range} type="button" data-help="utility.catch-up" disabled={running} onClick={() => void run(range)}>{range === 'last-turn' ? 'SINCE LAST TURN' : range === 'hour' ? 'LAST HOUR' : 'TODAY'}</button>)}</div>
          </>
          : <>
            <p style={{ margin: 0 }}>Requested range: {new Date(result.from).toLocaleString()} - {new Date(result.to).toLocaleString()}</p>
            {result.status === 'ok' ? <><p style={{ margin: 0 }}>{result.text}</p><p style={{ margin: 0 }}>Answered by {result.agent?.provider.toUpperCase()} / {result.agent?.model}.</p></>
              : <p style={{ margin: 0 }}>{describeUtilityFailure(result)} {utilityAttribution(result)}</p>}
            {result.truncated && <p style={{ margin: 0 }}>Older or lengthy activity was omitted from the facts.</p>}
            <details><summary>Facts used ({result.facts.length})</summary><ul>{result.facts.map((fact, i) => <li key={i}><strong>{fact.label}:</strong> {fact.value}</li>)}</ul></details>
          </>}
      </div>}
    </DialogShell>}
  </div>;
}

import { describeUtilityFailure, utilityAttribution } from './utilityResult';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { UtilityBriefScope, UtilityJobFact, UtilityJobResult } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useStartupStore } from '../stores/startupStore';
import { clusterBriefFacts, workerBriefFacts } from '../brief/briefFromStore';
import { useUsableUtilityAgent } from './UtilityAgentPicker';

const STILL_WORKING_MS = 4000;
const menuItemStyle: CSSProperties = { padding: '7px 12px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--color-border-hairline)', color: 'var(--color-fg)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px', textAlign: 'left', whiteSpace: 'nowrap' };

type Phase = 'closed' | 'running' | 'slow' | 'done';


interface Props {
  scope: UtilityBriefScope;
  // Worker scope: the workflow id. Cluster scope: the cluster id.
  targetId: string;
  label: string;
  title: string;
  'data-help': string;
  testId: string;
  style?: CSSProperties;
  // Cluster tab composer: the button opens a choice between this worker and the whole cluster.
  clusterId?: string;
}

// BRIEF (worker, or worker/whole-cluster choice in a cluster tab): collects facts from visible state when clicked, asks
// the utility agent for a short synopsis and shows it with the facts used. It
// never sends anything to a worker.
export function BriefControl({ scope, targetId, label, title, 'data-help': helpId, testId, style, clusterId }: Props) {
  const agent = useUsableUtilityAgent();
  const saved = useAppStore((s) => s.settings?.utilityAgent) ?? null;
  const [phase, setPhase] = useState<Phase>('closed');
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuUp, setMenuUp] = useState(true);
  const [active, setActive] = useState<{ scope: UtilityBriefScope; targetId: string }>({ scope, targetId });
  const [result, setResult] = useState<UtilityJobResult | null>(null);
  const [facts, setFacts] = useState<UtilityJobFact[]>([]);
  const jobId = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; if (timer.current) clearTimeout(timer.current); }, []);

  const close = () => { if (timer.current) clearTimeout(timer.current); setPhase('closed'); setResult(null); };

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = () => setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('click', onDoc);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', onDoc); window.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  useEffect(() => {
    if (phase === 'closed') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (timer.current) clearTimeout(timer.current); setPhase('closed'); setResult(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase === 'closed']);

  const run = async (runScope: UtilityBriefScope = active.scope, runTarget: string = active.targetId) => {
    setActive({ scope: runScope, targetId: runTarget });
    setMenuOpen(false);
    if (!agent) { setResult(null); setPhase('done'); return; }
    const collected = runScope === 'worker' ? workerBriefFacts(runTarget).facts : clusterBriefFacts(runTarget);
    setFacts(collected);
    setResult(null);
    setPhase('running');
    const id = `brief-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    jobId.current = id;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (alive.current) setPhase((p) => (p === 'running' ? 'slow' : p)); }, STILL_WORKING_MS);
    try {
      const res = await fetch('/api/utility-agent/brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: id, scope: runScope, facts: collected }) });
      const body = (await res.json()) as UtilityJobResult;
      if (!alive.current || jobId.current !== id) return;
      setResult(res.ok ? body : { jobId: id, status: 'error', facts: collected, elapsedMs: 0, reason: 'request_failed' });
    } catch {
      if (!alive.current || jobId.current !== id) return;
      setResult({ jobId: id, status: 'error', facts: collected, elapsedMs: 0, reason: 'request_failed' });
    }
    if (timer.current) clearTimeout(timer.current);
    setPhase('done');
  };

  const cancel = () => {
    const id = jobId.current;
    void fetch('/api/utility-agent/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: id }) }).catch(() => undefined);
  };

  const openSetting = () => {
    useStartupStore.getState().setSettingsSection('utility-agent');
    useAppStore.getState().setShowSettings(true);
    close();
  };

  const dialogLabel = clusterId ? (active.scope === 'cluster' ? 'BRIEF: WHOLE CLUSTER' : 'BRIEF: THIS WORKER') : label;
  const shownFacts = result?.facts?.length ? result.facts : facts;
  return (
    <>
      <button
        type="button"
        className="display-font"
        data-help={helpId}
        data-testid={testId}
        title={title}
        onClick={(e) => { e.stopPropagation(); if (clusterId) { setMenuUp(e.currentTarget.getBoundingClientRect().top > window.innerHeight / 2); setMenuOpen((o) => !o); } else void run(scope, targetId); }}
        aria-haspopup={clusterId ? 'menu' : undefined}
        aria-expanded={clusterId ? menuOpen : undefined}
        onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation(); }}
        style={{
          padding: '3px 8px', background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px',
          color: 'var(--color-accent-secondary-dim)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px', whiteSpace: 'nowrap', ...style,
        }}
      >
        {label}{clusterId ? ' \u25BE' : ''}
      </button>
      {menuOpen && clusterId && (
        <div role="menu" data-testid="brief-menu" style={{ position: 'relative', width: 0, height: 0 }}>
          <div style={{ position: 'absolute', ...(menuUp ? { bottom: '6px' } : { top: '6px' }), left: 0, zIndex: 1100, display: 'flex', flexDirection: 'column', minWidth: '150px', background: 'var(--color-bg-dialog)', border: '1px solid var(--color-border-hairline)', boxShadow: '0 8px 24px rgba(0,0,0,0.45)' }}>
            <button type="button" role="menuitem" className="display-font" data-testid="brief-this-worker" onClick={(e) => { e.stopPropagation(); void run('worker', targetId); }} style={menuItemStyle}>THIS WORKER</button>
            <button type="button" role="menuitem" className="display-font" data-testid="brief-whole-cluster" onClick={(e) => { e.stopPropagation(); void run('cluster', clusterId); }} style={menuItemStyle}>WHOLE CLUSTER</button>
          </div>
        </div>
      )}
      {phase !== 'closed' && (
        <div
          role="dialog"
          aria-label={dialogLabel}
          data-testid="brief-panel"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation(); }}
          style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px' }}
        >
          <div style={{ width: 'min(calc(92vw / var(--ui-scale, 1)), 560px)', maxHeight: 'calc(86vh / var(--ui-scale, 1))', overflowY: 'auto', background: 'var(--color-bg-dialog)', border: '1px solid var(--color-border-hairline)', padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px' }}>
            <div className="display-font" style={{ letterSpacing: '1px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>{dialogLabel}</div>
            {phase === 'done' && !agent && (
              <div data-testid="brief-not-set" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <p style={{ margin: 0 }}>{saved ? 'The chosen utility agent is not connected or enabled right now.' : 'A utility agent must be chosen before BRIEF can run.'}</p>
                <button type="button" data-testid="brief-open-setting" onClick={openSetting} style={{ alignSelf: 'flex-start' }}>OPEN UTILITY AGENT SETTING</button>
              </div>
            )}
            {phase === 'running' && <p role="status" style={{ margin: 0 }}>Asking the utility agent.</p>}
            {phase === 'slow' && <p role="status" data-testid="brief-slow" style={{ margin: 0 }}>Still working. A cold start can take a while; CANCEL stops it.</p>}
            {phase === 'done' && agent && result && (
              <div role="status" data-testid="brief-result" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {result.status === 'ok'
                  ? <p style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{result.text}</p>
                  : <p style={{ margin: 0 }}>{describeUtilityFailure(result)}</p>}
                {result.agent && <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px' }}>{result.status === 'ok' && result.text?.trim() ? `Answered by ${result.agent.provider} / ${result.agent.model} in ${(result.elapsedMs / 1000).toFixed(1)}s. This is a reading of the facts below, not an instruction.` : utilityAttribution(result)}</div>}
                {result.truncated && <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px' }}>Some facts were shortened to fit the input limit.</div>}
              </div>
            )}
            {phase !== 'running' && phase !== 'slow' && agent && shownFacts.length > 0 && (
              <details data-testid="brief-facts">
                <summary style={{ cursor: 'pointer' }}>FACTS USED ({shownFacts.length})</summary>
                <ul style={{ margin: '6px 0 0', paddingLeft: '16px', fontFamily: 'var(--font-code)', fontSize: '11px', wordBreak: 'break-word' }}>
                  {shownFacts.map((f, i) => <li key={`${f.label}-${i}`}><strong>{f.label}:</strong> {f.value}</li>)}
                </ul>
              </details>
            )}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              {(phase === 'running' || phase === 'slow') && <button type="button" data-testid="brief-cancel" onClick={cancel}>CANCEL</button>}
              {phase === 'done' && agent && <button type="button" data-testid="brief-again" onClick={() => void run()}>BRIEF AGAIN</button>}
              <button type="button" data-testid="brief-close" onClick={close}>CLOSE</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

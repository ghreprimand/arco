import { useEffect, useState } from 'react';
import { DialogShell } from './DialogShell';

// P8.5: the candidates of an architecture review report, opened from the
// report in OUTPUTS. ADD TO PLAN puts a candidate into the plan attached to
// the conversation (its tab or its cluster) as one item with a reference doc;
// RECORD DECISION records why a candidate is not pursued, and later reviews do
// not suggest it again. Each asks first; nothing else in the project changes.

interface Candidate {
  id: string; title: string; files: string[]; problem: string; proposal: string;
  benefits: { locality: string; leverage: string; tests: string }; strength: 'Strong' | 'Worth exploring' | 'Speculative';
}
interface Loaded { candidates: Candidate[]; recommendation?: string; plan: { id: string; title: string } | null }

export function isArchitectureReport(name: string): boolean {
  return /^architecture-review-[A-Za-z0-9_.-]{1,80}\.md$/.test(name);
}

async function post(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/architecture-review/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : `Request failed (${res.status}).`);
  return body;
}

export function ArchitectureReviewDialog({ cwd, workflowId, report, onClose }: { cwd: string; workflowId: string; report: string; onClose: () => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<Record<string, string>>({});
  const base = { path: cwd, workflowId, report };

  useEffect(() => {
    let live = true;
    post('candidates', base).then((b) => { if (live) setData(b as unknown as Loaded); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [cwd, workflowId, report]);

  async function addToPlan(c: Candidate) {
    if (!data?.plan || !window.confirm(`Add "${c.title}" to the plan "${data.plan.title}" as one unticked item with a reference doc?`)) return;
    setBusy(true); setError(''); setStatus('');
    try {
      await post('add-to-plan', { ...base, candidateId: c.id, confirm: true });
      setDone((d) => ({ ...d, [c.id]: 'Added to the plan' }));
      setStatus(`Added "${c.title}" to ${data.plan.title}.`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function recordDecision(c: Candidate) {
    if (!data?.plan || !reason.trim()) return;
    setBusy(true); setError(''); setStatus('');
    try {
      await post('record-decision', { ...base, candidateId: c.id, reason, confirm: true });
      setDone((d) => ({ ...d, [c.id]: 'Decision recorded' }));
      setStatus(`Recorded the decision on "${c.title}" in the plan's decisions.`);
      setDeciding(null); setReason('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <DialogShell title="ARCHITECTURE REVIEW" ariaLabel="Architecture review candidates" dataHelp="architecture-review.dialog" onClose={onClose} width={760}
      status={error ? <span role="alert" style={{ color: 'var(--color-error)' }}>{error}</span> : status ? <span role="status">{status}</span> : null}>
      <p style={{ marginTop: 0 }}>{report}</p>
      {!data && !error && <p>Loading candidates...</p>}
      {data && <p data-testid="architecture-review-plan">{data.plan ? <>Plan: <strong>{data.plan.title}</strong>. ADD TO PLAN adds an unticked item there; RECORD DECISION adds to its decisions doc.</> : 'This conversation has no plan attached. Attach one with PLAN in the composer to use ADD TO PLAN and RECORD DECISION.'}</p>}
      {data && data.candidates.length === 0 && <p>The report lists no candidates.</p>}
      {data?.candidates.map((c) => (
        <section key={c.id} data-testid="architecture-candidate" style={{ borderTop: '1px solid var(--color-border-hairline)', padding: '8px 0' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong>{c.title}</strong>
            <span style={{ color: 'var(--color-fg-muted)' }}>{c.strength}{data.recommendation === c.id ? ' · recommended' : ''}</span>
            {done[c.id] && <span style={{ color: 'var(--color-accent-primary)' }}>{done[c.id]}</span>}
          </div>
          {c.files.length > 0 && <div style={{ color: 'var(--color-fg-muted)' }}>{c.files.join(', ')}</div>}
          {c.problem && <p style={{ margin: '4px 0' }}><em>Problem:</em> {c.problem}</p>}
          {c.proposal && <p style={{ margin: '4px 0' }}><em>Change:</em> {c.proposal}</p>}
          <p style={{ margin: '4px 0', color: 'var(--color-fg-muted)' }}>Locality: {c.benefits.locality || '-'} Leverage: {c.benefits.leverage || '-'} Tests: {c.benefits.tests || '-'}</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" data-help="architecture-review.add-to-plan" disabled={busy || !data.plan || !!done[c.id]} onClick={() => void addToPlan(c)}>ADD TO PLAN</button>
            <button type="button" data-help="architecture-review.record-decision" disabled={busy || !data.plan || !!done[c.id]} onClick={() => { setDeciding(deciding === c.id ? null : c.id); setReason(''); }}>RECORD DECISION</button>
          </div>
          {deciding === c.id && <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label>Why is this not pursued? Later reviews read this.
              <textarea className="arco-field" aria-label="Reason for the decision" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} style={{ width: '100%', boxSizing: 'border-box' }} />
            </label>
            <div><button type="button" disabled={busy || !reason.trim()} onClick={() => void recordDecision(c)}>RECORD</button></div>
          </div>}
        </section>
      ))}
    </DialogShell>
  );
}

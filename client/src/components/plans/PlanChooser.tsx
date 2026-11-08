import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { hasGuardrails, insertGuardrails, type PlanFull, type PlanSummary } from '@arco/shared';
import { planRowSubtitle, splitAttachments } from '../RightPanel/format';
import { PublicProjectBox } from '../PublicProjectBox';
import { rememberPublicChoice, usePublicProject } from '../../utils/publicProject';

type PlanChoice = PlanSummary & { body: string | null };

export function countPlanTasks(body: string): number {
  return body.split('\n').filter(line => /^\s*-\s+\[[ xX]\]\s+/.test(line)).length;
}

export function PlanChooser({ cwd, onAttach, onNew, onGenesis, onAllPlans, onComplete, onReopen, onDelete, refreshKey, disabled, busy }: {
  cwd: string;
  onAttach: (plan: PlanSummary) => void;
  onNew?: () => void;
  onGenesis?: () => void;
  onAllPlans: () => void;
  onComplete?: (plan: PlanSummary) => void;
  onReopen?: (plan: PlanSummary) => void;
  onDelete?: (plan: PlanSummary) => void;
  refreshKey?: string;
  disabled?: boolean;
  busy?: boolean;
}) {
  const [plans, setPlans] = useState<PlanChoice[] | null>(null);
  const [loadedCwd, setLoadedCwd] = useState('');
  const [savedRevision, setSavedRevision] = useState(0);
  const draftVersion = useRef(0);
  const currentCwd = useRef(cwd);
  if (currentCwd.current !== cwd) draftVersion.current += 1;
  currentCwd.current = cwd;
  const [error, setError] = useState('');
  const [showFinished, setShowFinished] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState('');
  const { checked: publicProject } = usePublicProject(cwd);
  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    setPlans(null); setError(''); setPreview(null);
    if (!cwd) { setLoadedCwd(cwd); setPlans([]); return () => { cancelled = true; }; }
    const load = async () => {
      const request = ++generation;
      try {
        const response = await fetch(`/api/plans?path=${encodeURIComponent(cwd)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { plans: PlanSummary[] };
        const choices = await Promise.all(data.plans.map(async plan => {
          try {
            const r = await fetch(`/api/plans/body?path=${encodeURIComponent(cwd)}&planId=${encodeURIComponent(plan.id)}`);
            if (!r.ok) return { ...plan, body: null };
            const result = await r.json() as { plan: PlanFull };
            return { ...plan, body: result.plan.body };
          } catch { return { ...plan, body: null }; }
        }));
        if (!cancelled && request === generation) { setLoadedCwd(cwd); setPlans(choices); setError(''); }
      } catch (err) {
        if (!cancelled && request === generation) { setLoadedCwd(cwd); setError(err instanceof Error ? err.message : String(err)); setPlans([]); }
      }
    };
    void load();
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [cwd, refreshKey, savedRevision]);
  const currentPlans = loadedCwd === cwd ? plans : null;
  const open = (currentPlans ?? []).filter(plan => plan.completedAt == null);
  const finished = (currentPlans ?? []).filter(plan => plan.completedAt != null);
  const rows = (choices: PlanChoice[]) => choices.map(plan => (
    <div key={plan.id} style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>{plan.title}</strong>
        <div style={{ color: 'var(--color-fg-muted)', fontSize: 10 }}>
          {planRowSubtitle(plan, splitAttachments(plan.attachments).active, splitAttachments(plan.attachments).past)} - {plan.body === null ? 'task count unavailable' : `${countPlanTasks(plan.body)} ${countPlanTasks(plan.body) === 1 ? 'task' : 'tasks'}`}
        </div>
      </div>
      <button type="button" data-help="plan.chooser-preview" aria-label={`Preview ${plan.title}`} style={buttonStyle} disabled={plan.body === null} onClick={() => setPreview(preview === plan.id ? null : plan.id)}>PREVIEW</button>
      <button type="button" data-help="plan.chooser-attach" aria-label={`Attach ${plan.title}`} style={buttonStyle} disabled={disabled || busy} onClick={() => onAttach(plan)}>ATTACH</button>
      {plan.completedAt == null && onComplete && <button type="button" data-help="plan.mark-complete" style={buttonStyle} onClick={() => onComplete(plan)}>MARK DONE</button>}
      {plan.completedAt != null && onReopen && <button type="button" data-help="plan.chooser-reopen" style={buttonStyle} onClick={() => onReopen(plan)}>REOPEN</button>}
      {onDelete && <button type="button" data-help="plan.delete" style={buttonStyle} onClick={() => onDelete(plan)}>DELETE</button>}
      {preview === plan.id && <pre style={{ flexBasis: '100%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--color-fg)', maxHeight: 240, overflowY: 'auto' }}>{plan.body}</pre>}
    </div>
  ));
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8, color: 'var(--color-fg)' }}>
    {saveNotice && <div role="status">{saveNotice}</div>}
    {error && <div role="alert" style={{ color: 'var(--color-warning)' }}>Could not load plans: {error}</div>}
    {currentPlans === null ? <span>Loading plans...</span> : <>{open.length === 0 && <span>No open plans in this folder.</span>}{rows(open)}{finished.length > 0 && <><button type="button" data-help="plan.chooser-finished" style={buttonStyle} onClick={() => setShowFinished(!showFinished)} aria-expanded={showFinished}>Show finished ({finished.length})</button>{showFinished && rows(finished)}</>}</>}
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <button type="button" data-help="plan.new" style={buttonStyle} disabled={busy} onClick={() => { draftVersion.current += 1; if (onNew) onNew(); else setCreating(true); }}>+ NEW PLAN</button>
      {onGenesis && <button type="button" data-help="plan.chooser-genesis" style={buttonStyle} onClick={onGenesis}>DRAFT IN GENESIS</button>}
      <button type="button" data-help="plan.library" style={buttonStyle} onClick={onAllPlans}>ALL PLANS</button>
    </div>
    {creating && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label data-help="plan.chooser-title" style={{ color: 'var(--color-fg)' }}>Plan title <input className="arco-field" value={newTitle} onChange={event => { draftVersion.current += 1; setNewTitle(event.target.value); }} /></label>
      <PublicProjectBox cwd={cwd} />
      {publicProject && !hasGuardrails(newBody) && <button type="button" data-help="plan.insert-guardrails" style={buttonStyle} onClick={() => { draftVersion.current += 1; setNewBody(insertGuardrails(newBody)); }}>INSERT GUARDRAILS</button>}
      <label data-help="plan.chooser-body" style={{ color: 'var(--color-fg)' }}>Plan body <textarea className="arco-field" value={newBody} onChange={event => { draftVersion.current += 1; setNewBody(event.target.value); }} rows={10} /></label>
      <div>
        <button type="button" data-help="plan.chooser-create" style={buttonStyle} disabled={saving || !newTitle.trim()} onClick={async () => {
          const submittedVersion = draftVersion.current;
          setSaving(true); setError(''); setSaveNotice('');
          try {
            await rememberPublicChoice(cwd);
            const response = await fetch(`/api/plans?path=${encodeURIComponent(cwd)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newTitle.trim(), body: newBody }) });
            if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
            const data = await response.json() as { plan: PlanFull };
            setSavedRevision(value => value + 1);
            if (currentCwd.current !== cwd) {
              setSaveNotice('The plan was saved in the previous project. Select it there to attach it.');
            } else if (draftVersion.current !== submittedVersion) {
              setSaveNotice('The submitted plan was saved. Later edits remain in the form. Choose the saved plan to attach it.');
            } else {
              setCreating(false); setNewTitle(''); setNewBody('');
              onAttach(data.plan);
            }
          } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
          finally { setSaving(false); }
        }}>{saving ? 'SAVING...' : 'CREATE AND ATTACH'}</button>
        <button type="button" data-help="plan.chooser-cancel" style={buttonStyle} onClick={() => { draftVersion.current += 1; setCreating(false); setNewTitle(''); setNewBody(''); }}>CANCEL</button>
      </div>
    </div>}
  </div>;
}

const rowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: 8, border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg)' };
const buttonStyle: CSSProperties = { border: '1px solid var(--color-border-hairline)', background: 'transparent', color: 'var(--color-fg)', cursor: 'pointer', padding: '4px 8px', fontSize: 10 };

import { useEffect, useRef, useState } from 'react';
import { CLUSTER_MESSAGE_GUARD_MAX, type ClusterMessageGuard } from '@arco/shared';

export function MessageGuardControl({ value, onChange }: { value: ClusterMessageGuard; onChange: (guard: ClusterMessageGuard) => void }) {
  const [draft, setDraft] = useState(String(value.threshold));
  const cancelled = useRef(false);
  useEffect(() => setDraft(String(value.threshold)), [value.threshold]);
  const valid = Number.isInteger(Number(draft)) && Number(draft) >= 1 && Number(draft) <= CLUSTER_MESSAGE_GUARD_MAX;
  const commit = () => {
    if (!cancelled.current && valid && Number(draft) !== value.threshold) onChange({ ...value, threshold: Number(draft) });
    else setDraft(String(value.threshold));
    cancelled.current = false;
  };
  return <div data-help="cluster.efficiency" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', alignItems: 'center', minWidth: 0, marginTop: 6 }}>
    <label className="arco-field-label">Message guard <select className="arco-field" aria-label="Message guard" value={value.mode} onChange={e => onChange({ ...value, mode: e.target.value as ClusterMessageGuard['mode'] })}>
      <option value="warn">Warn only</option><option value="hard">Hard limit</option><option value="none">No limit</option>
    </select></label>
    {value.mode !== 'none' && <label className="arco-field-label">{value.mode === 'warn' ? 'Warn after' : 'Cap'} <input className="arco-field" type="number" aria-label="Message threshold" min={1} max={CLUSTER_MESSAGE_GUARD_MAX} step={1} value={draft} aria-invalid={!valid}
      onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); }
      }} style={{ width: 65 }} /></label>}
    <span className="arco-field-help" style={{ fontSize: 10, color: 'var(--color-fg-muted)' }}>Per worker, per turn. {value.mode === 'none' ? 'No limit: messages always send. Automatic-execution limits still apply.' : value.mode === 'warn' ? 'Warn only: messages still send; the worker gets one warning after the threshold.' : 'Hard limit: messages past the threshold are not sent.'} Threshold 1 to 1000. Counts reset each turn and on restart.</span>
  </div>;
}

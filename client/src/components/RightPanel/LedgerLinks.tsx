// Ledger task links (ARCO_OPS_PLAN.md §D2, Part D).
//
// Renders a task's bidirectional references (plan items / reviews / workflows /
// urls) as clickable chips, plus an attach-link affordance and per-chip remove.
// Attach/detach flow through the EXISTING task_ledger_update sender (we send the
// full new links[] array) — D2 adds no protocol. Navigation is delegated to the
// parent via onNavigate so the link-kind→destination mapping lives next to the
// right-panel tab state it needs (LedgerTab itself can't reach it).

import { useState } from 'react';
import type { TaskLink } from '@arco/shared';

const KINDS: { id: TaskLink['kind']; label: string }[] = [
  { id: 'plan', label: 'PLAN' },
  { id: 'review', label: 'REVIEW' },
  { id: 'workflow', label: 'WORKFLOW' },
  { id: 'url', label: 'URL' },
];

function kindColor(kind: TaskLink['kind']): string {
  switch (kind) {
    case 'plan':     return 'var(--color-accent-primary)';
    case 'review':   return 'var(--color-accent-secondary)';
    case 'workflow': return '#7aa2f7';
    default:         return 'var(--color-fg-muted)'; // url
  }
}

interface Props {
  links: TaskLink[];
  onNavigate: (link: TaskLink) => void;
  onChange: (links: TaskLink[]) => void; // send the full new array via task_ledger_update
}

export function LedgerLinks({ links, onNavigate, onChange }: Props) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<TaskLink['kind']>('plan');
  const [ref, setRef] = useState('');
  const [label, setLabel] = useState('');

  const commitAdd = () => {
    const r = ref.trim();
    if (!r) return;
    const l = label.trim();
    const next: TaskLink = { kind, ref: r, ...(l ? { label: l } : {}) };
    onChange([...links, next]);
    setRef('');
    setLabel('');
    setAdding(false);
  };

  const removeAt = (i: number) => {
    onChange(links.filter((_, idx) => idx !== i));
  };

  return (
    <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {links.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {links.map((l, i) => (
            <span
              key={`${l.kind}:${l.ref}:${i}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                border: `1px solid ${kindColor(l.kind)}`,
                color: kindColor(l.kind),
                background: 'var(--color-bg)',
                fontSize: '10px',
                fontFamily: 'var(--font-display)',
                letterSpacing: '0.5px',
                padding: '1px 4px',
                borderRadius: '2px',
              }}
            >
              <button
                onClick={() => onNavigate(l)}
                title={`${l.kind}: ${l.ref}`}
                data-help="rightpanel.ledger.link"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'inherit',
                  cursor: 'pointer',
                  fontSize: '10px',
                  fontFamily: 'var(--font-display)',
                  letterSpacing: '0.5px',
                  padding: 0,
                  maxWidth: '180px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {l.label ?? l.ref}
              </button>
              <button
                onClick={() => removeAt(i)}
                title="Remove link"
                aria-label="Remove link"
                data-help="rightpanel.ledger.link"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'inherit',
                  cursor: 'pointer',
                  fontSize: '11px',
                  lineHeight: 1,
                  padding: 0,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {adding ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as TaskLink['kind'])}
            data-help="rightpanel.ledger.link"
            style={fieldStyle(false)}
          >
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>{k.label}</option>
            ))}
          </select>
          <input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitAdd(); }}
            placeholder="ref (plan id / artifact / wf id / url)"
            data-help="rightpanel.ledger.link"
            style={{ ...fieldStyle(true), flex: 1, minWidth: '120px' }}
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitAdd(); }}
            placeholder="label (optional)"
            data-help="rightpanel.ledger.link"
            style={{ ...fieldStyle(true), width: '120px' }}
          />
          <button onClick={commitAdd} style={chipBtn('var(--color-accent-primary)')}>ADD</button>
          <button onClick={() => setAdding(false)} style={chipBtn('var(--color-fg-muted)')}>CANCEL</button>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          data-help="rightpanel.ledger.link"
          style={{ ...chipBtn('var(--color-fg-muted)'), alignSelf: 'flex-start' }}
        >
          + LINK
        </button>
      )}
    </div>
  );
}

function fieldStyle(mono: boolean): React.CSSProperties {
  return {
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-hairline)',
    color: 'var(--color-fg)',
    fontSize: '10px',
    padding: '2px 4px',
    fontFamily: mono ? 'var(--font-mono)' : 'var(--font-display)',
  };
}

function chipBtn(color: string): React.CSSProperties {
  return {
    background: 'transparent',
    border: `1px solid ${color}`,
    color,
    padding: '2px 6px',
    fontSize: '10px',
    cursor: 'pointer',
    fontFamily: 'var(--font-display)',
    letterSpacing: '0.5px',
  };
}

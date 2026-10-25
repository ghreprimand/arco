import type { PlanSummary } from '@arco/shared';
import { splitAttachments, planRowSubtitle } from './format';

// Single row in the EXISTING PLANS list. Title is a click-to-attach button
// (suppressed for completed plans — operator must Reopen first); icon
// buttons handle mark-complete / reopen / delete. Subtitle squeezes in the
// "active in <name>" indicator the operator asked for so they can see
// where each plan lives without opening it.
export function PlanListRow({
  plan,
  onAttach,
  onComplete,
  onReopen,
  onDelete,
}: {
  plan: PlanSummary;
  onAttach?: () => void;
  onComplete?: () => void;
  onReopen?: () => void;
  onDelete?: () => void;
}) {
  const { active, past } = splitAttachments(plan.attachments);
  const isCompleted = plan.completedAt != null;
  return (
    <div
      style={{
        padding: '8px 10px',
        background: 'transparent',
        border: '1px solid var(--color-border-hairline)',
        color: 'var(--color-accent-primary)',
        fontFamily: 'var(--font-body)',
        fontSize: '11px',
        opacity: isCompleted ? 0.7 : 1,
      }}
    >
      <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {onAttach ? (
            <button
              onClick={onAttach}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                padding: 0,
                textAlign: 'left',
                fontWeight: 600,
                fontSize: '11px',
                fontFamily: 'inherit',
                wordBreak: 'break-word',
              }}
              title="Click to attach to this workflow"
            >
              {plan.title}
            </button>
          ) : (
            <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>{plan.title}</div>
          )}
          <div style={{ fontSize: '9px', color: 'var(--color-fg-muted)', marginTop: '2px' }}>
            {planRowSubtitle(plan, active, past)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
          {onComplete && (
            <button
              onClick={(e) => { e.stopPropagation(); onComplete(); }}
              style={planRowIconBtn}
              title="Mark complete (auto-detaches from any workflow)"
            >
              ✓
            </button>
          )}
          {onReopen && (
            <button
              onClick={(e) => { e.stopPropagation(); onReopen(); }}
              style={planRowIconBtn}
              title="Reopen this plan"
            >
              ↺
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              style={planRowIconBtnDanger}
              title="Delete plan permanently"
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const planRowIconBtn: React.CSSProperties = {
  width: '22px',
  height: '22px',
  padding: 0,
  background: 'transparent',
  border: '1px solid var(--color-accent-primary-dim)',
  color: 'var(--color-accent-primary)',
  cursor: 'pointer',
  fontSize: '11px',
  lineHeight: 1,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--font-display)',
};

const planRowIconBtnDanger: React.CSSProperties = {
  ...planRowIconBtn,
  border: '1px solid var(--color-warning, #f04a4a)',
  color: 'var(--color-warning, #f04a4a)',
};

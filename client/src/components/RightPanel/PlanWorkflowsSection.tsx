import type { PlanAttachmentSpan } from '@arco/shared';
import { splitAttachments, formatRelativeTime } from './format';

// "Workflows using this plan" — active spans inline, past spans behind a
// click so the section stays compact even after a plan has cycled through
// many tabs over a project's lifetime.
export function PlanWorkflowsSection({
  attachments,
  currentWorkflowId,
  showPast,
  onTogglePast,
}: {
  attachments: PlanAttachmentSpan[] | undefined;
  currentWorkflowId: string;
  showPast: boolean;
  onTogglePast: () => void;
}) {
  if (!attachments) return null;
  const { active, past } = splitAttachments(attachments);
  if (active.length === 0 && past.length === 0) return null;
  return (
    <div style={{ marginTop: '6px' }}>
      <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-secondary-dim)', marginBottom: '6px' }}>
        WORKFLOWS USING THIS PLAN ({active.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {active.map((span) => (
          <AttachmentRow
            key={`${span.workflowId}-${span.attachedAt}`}
            span={span}
            isCurrent={span.workflowId === currentWorkflowId}
          />
        ))}
        {active.length === 0 && (
          <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontStyle: 'italic' }}>
            None currently — past attachments below.
          </div>
        )}
      </div>
      {past.length > 0 && (
        <>
          <button
            onClick={onTogglePast}
            className="display-font"
            style={{
              marginTop: '8px',
              padding: '4px 0',
              background: 'transparent',
              border: 'none',
              color: 'var(--color-fg-muted)',
              fontSize: '10px',
              letterSpacing: '1.2px',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            {showPast ? '▼' : '▶'} {past.length} previously attached
          </button>
          {showPast && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
              {past.map((span) => (
                <AttachmentRow
                  key={`${span.workflowId}-${span.attachedAt}`}
                  span={span}
                  isCurrent={false}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AttachmentRow({ span, isCurrent }: { span: PlanAttachmentSpan; isCurrent: boolean }) {
  const detached = span.detachedAt !== null;
  return (
    <div
      style={{
        padding: '5px 8px',
        background: isCurrent ? 'var(--color-accent-primary-a08)' : 'transparent',
        border: '1px solid var(--color-accent-primary-a05)',
        fontSize: '11px',
        fontFamily: 'var(--font-body)',
        color: detached ? 'var(--color-fg-muted)' : 'var(--color-accent-primary)',
        opacity: detached ? 0.75 : 1,
      }}
    >
      <div style={{ display: 'flex', gap: '6px', alignItems: 'baseline' }}>
        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
          {span.workflowName || span.workflowId.slice(0, 8)}
        </span>
        {isCurrent && (
          <span className="display-font" style={{ fontSize: '8px', letterSpacing: '1px', color: 'var(--color-accent-secondary)' }}>
            THIS TAB
          </span>
        )}
      </div>
      <div style={{ fontSize: '9px', color: 'var(--color-fg-muted)', marginTop: '2px' }}>
        attached {formatRelativeTime(span.attachedAt)}
        {detached && span.detachedAt !== null && ` · detached ${formatRelativeTime(span.detachedAt)}`}
      </div>
    </div>
  );
}

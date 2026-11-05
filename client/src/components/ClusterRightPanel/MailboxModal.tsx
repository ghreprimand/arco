import type { ClusterStatePayload } from '@arco/shared';
import type { PeerMessage } from './types';
import { pickerSurfaceSize, WorkSurfaceControls } from '../workSurface/WorkSurfaceControls';
import { useRef } from 'react';

interface MailboxModalProps {
  cluster: ClusterStatePayload;
  wfid: string;
  messages: PeerMessage[] | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onCancel: (msgId: string) => void;
  // §10.7 P12.5 — peer→task bridge. When provided, each message row renders a
  // → TASK button that promotes the message into a durable board task.
  onMakeTask?: (content: string, fromWorkflowId: string) => void;
}

// Mailbox inspect modal — operator-only surface. Lists pending peer messages
// addressed to a specific cluster member, with a per-row CANCEL button that
// discards a message before the recipient drains it. Once delivered the
// message lives in events.jsonl forever; this modal only mutates the
// transient mailbox file layer.
export function MailboxModal({ cluster, wfid, messages, loading, error, onClose, onCancel, onMakeTask }: MailboxModalProps) {
  const surface = useRef<HTMLDivElement>(null);
  const recipient = cluster.members.find((m) => m.workflowId === wfid);
  const recipientName = recipient?.displayName ?? wfid.slice(0, 8);
  const senderName = (fromWfid: string): string => {
    if (fromWfid === wfid) return recipientName;
    const m = cluster.members.find((mm) => mm.workflowId === fromWfid);
    return m?.displayName ?? fromWfid.slice(0, 8);
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50,
        backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        ref={surface}
        onClick={(e) => e.stopPropagation()}
        data-help="cluster.mailbox-modal"
        style={{
          background: 'var(--color-bg-dialog)',
          border: '1px solid var(--color-border-hairline)',
          ...pickerSurfaceSize, overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--color-border-hairline)',
          display: 'flex', alignItems: 'center', gap: '8px',
        }}>
          <span className="display-font" style={{ color: 'var(--color-fg)', letterSpacing: '1px', fontSize: '11px' }}>
            MAILBOX · {recipientName.toUpperCase()}
          </span>
          <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px' }}>
            {messages ? `${messages.length} pending` : ''}
          </span>
          <WorkSurfaceControls surface={surface} storageKey="cluster-mailbox" />
          <button
            type="button"
            onClick={onClose}
            className="display-font"
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              color: 'var(--color-fg-muted)',
              padding: '3px 8px',
              cursor: 'pointer',
              fontSize: '9px',
              letterSpacing: '1px',
            }}
          >
            CLOSE
          </button>
        </div>
        <div style={{ overflowY: 'auto', flex: '1 1 auto', minHeight: 0, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {loading && (
            <div style={{ color: 'var(--color-fg-muted)', fontSize: '11px' }}>Loading…</div>
          )}
          {error && (
            <div style={{ color: 'var(--color-warning)', fontSize: '11px' }}>{error}</div>
          )}
          {!loading && !error && messages && messages.length === 0 && (
            <div style={{ color: 'var(--color-fg-muted)', fontSize: '11px' }}>
              Mailbox empty. Either the recipient drained it or the messages were cancelled.
            </div>
          )}
          {messages && messages.map((m) => (
            <div
              key={m.msgId}
              style={{
                border: '1px solid var(--color-border-hairline)',
                padding: '8px 10px',
                fontSize: '11px',
                display: 'flex', flexDirection: 'column', gap: '4px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="display-font" style={{ color: 'var(--color-accent-primary)', fontSize: '9px', letterSpacing: '1px' }}>
                  FROM {senderName(m.fromWorkflowId).toUpperCase()}
                </span>
                <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px' }}>
                  {new Date(m.createdAt).toLocaleString()}
                </span>
                <span style={{ marginLeft: 'auto', color: 'var(--color-fg-muted)', fontSize: '9px' }}>
                  {m.content.length} chars
                </span>
                {onMakeTask && (
                  <button
                    type="button"
                    onClick={() => onMakeTask(m.content, m.fromWorkflowId)}
                    className="display-font"
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--color-accent-primary)',
                      color: 'var(--color-accent-primary)',
                      padding: '2px 7px',
                      cursor: 'pointer',
                      fontSize: '9px',
                      letterSpacing: '1px',
                    }}
                    title="Promote this peer message into a durable board task"
                  >
                    → TASK
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onCancel(m.msgId)}
                  className="display-font"
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--color-warning)',
                    color: 'var(--color-warning)',
                    padding: '2px 7px',
                    cursor: 'pointer',
                    fontSize: '9px',
                    letterSpacing: '1px',
                  }}
                  title="Discard this message before the recipient drains it. Cannot be undone."
                >
                  CANCEL
                </button>
              </div>
              {m.recipientContext && (
                <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px', overflowWrap: 'anywhere' }}>
                  Recipient: {m.recipientContext.state} | Task: {m.recipientContext.task ? `${m.recipientContext.task.title} (${m.recipientContext.task.id.slice(0, 8)})` : 'none'} | Latest reply: {m.recipientContext.lastMessage ? `${m.recipientContext.lastMessage.firstLine} (${m.recipientContext.lastMessage.ageSeconds}s ago)` : 'none'}
                </div>
              )}
              <pre style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: 'var(--color-fg)',
                fontSize: '11px',
                maxHeight: '180px',
                overflowY: 'auto',
                background: 'var(--color-bg)',
                padding: '6px 8px',
                border: '1px solid var(--color-border-hairline)',
              }}>{m.content}</pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

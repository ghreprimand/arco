import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { JobState } from '../stores/appStore';
import type { ProviderName } from '@arco/shared';
import { linkifyText } from '../utils/linkify';

interface Props {
  job: JobState;
  onCancel: (clientMessageId: string) => void;
}

interface QueueItem {
  kind: 'steer' | 'follow-up' | 'interrupt';
  content: string;
  clientMessageId?: string;
  // Position within the kind's array. Used as a stable React key when no
  // clientMessageId is available (e.g., post-reload entries reconstructed
  // from a queue_update event whose entries had no id).
  index: number;
}

// Phase 4 — composer-adjacent queue strip. Source of truth is `job.queue`
// (kept in sync via the `queue_update` WS event). A horizontal strip above
// the composer renders one pill per queued message with a [steer] /
// [follow-up] tag, hover-for-full-text, and click-[×] to remove.
//
// Rationale (carried from the prior pre-strip indicator): inserting queued
// messages inline in chat (1) shifted around as primary text/tool_use blocks
// streamed in during the current turn, and (2) double-rendered once the
// message was actually sent (the sessionChat 5s-proximity dedup can't span
// a queue wait that's often minutes long). The strip keeps the visual
// commitment short and out-of-band from chat.
export function QueuedMessagesIndicator({ job, onCancel }: Props) {
  const [open, setOpen] = useState(false);

  const items: QueueItem[] = [
    ...(job.queue?.steering ?? []).map<QueueItem>((q, i) => ({ kind: q.interrupt ? 'interrupt' : 'steer', content: q.content, clientMessageId: q.clientMessageId, index: i })),
    ...(job.queue?.followUp ?? []).map<QueueItem>((q, i) => ({ kind: 'follow-up', content: q.content, clientMessageId: q.clientMessageId, index: i })),
  ];

  // Auto-close the modal if the queue empties while it's open (e.g., the
  // primary turn finished and all queued messages got drained, or the
  // operator cancelled the last one from inside the modal).
  useEffect(() => {
    if (open && items.length === 0) setOpen(false);
  }, [open, items.length]);

  if (items.length === 0) return null;

  const provider: ProviderName = job.config.primaryProvider ?? 'claude';
  const claudeTransport = job.config.claudeTransport;
  const codexTransport = job.config.codexTransport;
  const steerTooltip = providerSteerTooltip(provider, claudeTransport, codexTransport);

  return (
    <div
      style={{
        marginBottom: '8px',
        border: '1px solid var(--color-border-hairline)',
        borderLeft: '2px solid var(--color-accent-secondary)',
        borderRadius: '3px',
        background: 'transparent',
        padding: '6px 8px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
        <span
          className="display-font"
          style={{
            color: 'var(--color-accent-secondary)',
            fontSize: '10px',
            letterSpacing: '1px',
          }}
        >
          PENDING · {items.length}
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="display-font"
          style={{
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-fg-muted)',
            cursor: 'pointer',
            fontSize: '9px',
            letterSpacing: '1px',
            padding: '1px 6px',
          }}
        >
          PREVIEW
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {items.map((item) => (
          <QueueChip
            key={item.clientMessageId ?? `${item.kind}-${item.index}`}
            item={item}
            steerTooltip={steerTooltip}
            onCancel={item.clientMessageId ? () => onCancel(item.clientMessageId!) : undefined}
          />
        ))}
      </div>
      {open && (
        <QueuedMessagesModal
          items={items}
          onCancel={onCancel}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// Honest about delivery semantics. Mid-turn delivery happens at tool-call
// boundaries only; the provider's API doesn't accept mid-text-stream
// injection. If the model is in pure text-output mode, the steer falls
// through to the next turn.
function providerSteerTooltip(
  provider: ProviderName,
  claudeTransport?: 'cli' | 'native',
  codexTransport?: 'exec' | 'appserver',
): string {
  const midTurnSemantics =
    'Mid-turn delivery lands at the next tool-call boundary. ' +
    'If the model is already wrapping up its response, the steer becomes ' +
    'the next turn instead — neither provider API accepts mid-text-stream injection.';
  switch (provider) {
    case 'claude':
      if (claudeTransport === 'native') {
        return `STEER — ${midTurnSemantics}`;
      }
      return `STEER — delivered after the current turn (CLI transport queues input but only consumes at turn boundaries). Switch to Native transport for mid-turn delivery.`;
    case 'codex':
      if (codexTransport === 'appserver') {
        return `STEER — ${midTurnSemantics}`;
      }
      return `STEER — delivered after the current turn (exec transport is per-turn spawn, no mid-turn surface). Switch to app-server transport for mid-turn delivery.`;
    case 'ollama':
    case 'llamacpp':
      return `STEER — ${midTurnSemantics}`;
    case 'gemini':
      return `STEER — delivered after the current turn for ${provider} (single-shot transport, no mid-turn surface).`;
    default:
      return 'STEER — delivered after the current turn for this provider.';
  }
}

interface ChipProps {
  item: QueueItem;
  steerTooltip: string;
  onCancel?: () => void;
}

function QueueChip({ item, steerTooltip, onCancel }: ChipProps) {
  const isSteer = item.kind !== 'follow-up';
  const label = item.kind === 'interrupt' ? 'INTERRUPT & SEND' : item.kind === 'steer' ? 'STEER' : 'FOLLOW-UP';
  const preview = item.content.length > 60 ? item.content.slice(0, 60) + '…' : item.content;
  const tooltip = item.kind === 'interrupt' ? `INTERRUPT & SEND — waiting for cancellation to settle, then runs before other queued messages.\n\n— ${item.content}` : isSteer ? `${steerTooltip}\n\n— ${item.content}` : `FOLLOW-UP — appended after the current turn.\n\n— ${item.content}`;
  return (
    <span
      title={tooltip}
      className="display-font"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 6px',
        border: '1px solid var(--color-border-hairline)',
        borderRadius: '3px',
        background: 'var(--color-bg-sunken)',
        fontSize: '11px',
        color: 'var(--color-fg-muted)',
        maxWidth: '320px',
      }}
    >
      <span
        style={{
          fontSize: '9px',
          letterSpacing: '1px',
          padding: '0 4px',
          borderRadius: '2px',
          color: isSteer ? 'var(--color-warning)' : 'var(--color-accent-secondary)',
          border: `1px solid ${isSteer ? 'var(--color-warning)' : 'var(--color-accent-secondary-dim)'}`,
        }}
      >
        {label}
      </span>
      <span
        style={{
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontFamily: 'var(--font-body)',
          fontSize: '11px',
        }}
      >
        {preview}
      </span>
      {onCancel && (
        <button
          onClick={onCancel}
          title="Drop this queued message"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--color-fg-muted)',
            cursor: 'pointer',
            fontSize: '11px',
            padding: 0,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

interface ModalProps {
  items: QueueItem[];
  onCancel: (clientMessageId: string) => void;
  onClose: () => void;
}

function QueuedMessagesModal({ items, onCancel, onClose }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const body = typeof document !== 'undefined' ? document.body : null;
  if (!body) return null;

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '40px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glow-border"
        style={{
          width: '100%',
          maxWidth: '720px',
          maxHeight: '100%',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border-bright)',
          borderRadius: '6px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--color-border-hairline)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            flexShrink: 0,
          }}
        >
          <div
            className="display-font glow-text-cyan"
            style={{ fontSize: '12px', letterSpacing: '2px' }}
          >
            QUEUED MESSAGES · {items.length}
          </div>
          <button
            onClick={onClose}
            className="display-font"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-accent-primary-dim)',
              cursor: 'pointer',
              fontSize: '14px',
              width: '26px',
              height: '26px',
            }}
          >
            ×
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px' }}>
          <div
            className="display-font"
            style={{
              fontSize: '10px',
              color: 'var(--color-fg-muted)',
              letterSpacing: '1px',
              marginBottom: '12px',
            }}
          >
            Interrupt messages run first. Remaining steering items flush before follow-ups.
          </div>
          {items.map((item, i) => (
            <div
              key={item.clientMessageId ?? `${item.kind}-${item.index}`}
              style={{
                marginBottom: '14px',
                padding: '10px 14px',
                border: '1px solid var(--color-border-hairline)',
                borderLeft: `2px solid ${item.kind !== 'follow-up' ? 'var(--color-warning)' : 'var(--color-accent-secondary)'}`,
                borderRadius: '3px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '6px',
                  gap: '10px',
                }}
              >
                <span
                  className="display-font"
                  style={{
                    fontSize: '10px',
                    letterSpacing: '1.5px',
                    color: item.kind !== 'follow-up' ? 'var(--color-warning)' : 'var(--color-accent-secondary)',
                  }}
                >
                  #{i + 1} · {item.kind === 'interrupt' ? 'INTERRUPT & SEND' : item.kind === 'steer' ? 'STEER' : 'FOLLOW-UP'}
                </span>
                {item.clientMessageId && (
                  <button
                    onClick={() => onCancel(item.clientMessageId!)}
                    className="display-font"
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--color-accent-secondary-dim)',
                      borderRadius: '3px',
                      color: 'var(--color-accent-secondary-dim)',
                      cursor: 'pointer',
                      fontSize: '10px',
                      letterSpacing: '1.5px',
                      padding: '2px 10px',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-accent-secondary)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-accent-secondary-dim)'; }}
                  >
                    CANCEL
                  </button>
                )}
              </div>
              <div
                style={{
                  fontSize: '13px',
                  lineHeight: '1.7',
                  color: 'var(--color-accent-secondary-dim)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'var(--font-body)',
                }}
              >
                {linkifyText(item.content)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    body,
  );
}

import { AutomaticMessage } from './AutomaticMessage';
import { useAppStore } from '../stores/appStore';
import { requestQueuedMessageEdit, retryQueuedMessageEdits } from '../utils/queuedMessageEdit';
import { formSurfaceSize, WorkSurfaceControls } from './workSurface/WorkSurfaceControls';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { JobState } from '../stores/appStore';
import type { ProviderName } from '@arco/shared';
import { linkifyText } from '../utils/linkify';

const queueActionStyle = { background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: 3, color: 'var(--color-accent-secondary)', fontSize: 10, padding: '2px 6px' };

interface Props {
  job: JobState;
  onCancel: (clientMessageId: string) => void;
}

interface QueueItem {
  kind: 'steer' | 'follow-up' | 'interrupt';
  content: string;
  automaticKind?: 'nudge' | 'auto-pickup';
  clientMessageId?: string;
  // Position within the kind's array. Used as a stable React key when no
  // clientMessageId is available (e.g., post-reload entries reconstructed
  // from a queue_update event whose entries had no id).
  index: number;
  state?: 'queued' | 'delivered';
  cancellable?: boolean;
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
  const online = useAppStore(s => s.connectionState === 'online');
  useEffect(() => { if (online) retryQueuedMessageEdits(job.id); }, [job.id, online]);

  const items: QueueItem[] = [
    ...(job.queue?.steering ?? []).map<QueueItem>((q, i) => ({ kind: q.interrupt ? 'interrupt' : 'steer', content: q.content, automaticKind: q.automaticKind, clientMessageId: q.clientMessageId, index: i })),
    ...(job.queue?.followUp ?? []).map<QueueItem>((q, i) => ({ kind: 'follow-up', content: q.content, automaticKind: q.automaticKind, clientMessageId: q.clientMessageId, index: i })),
  ];

  const queuedIds = new Set(items.map((item) => item.clientMessageId));
  for (const [id, item] of Object.entries(job.turnMessages ?? {})) {
    if (!queuedIds.has(id)) items.push({ ...item, clientMessageId: id, index: items.length });
  }
  for (const item of items) {
    item.state = item.clientMessageId ? job.turnMessages?.[item.clientMessageId]?.state ?? 'queued' : 'queued';
    item.cancellable = !!item.clientMessageId && queuedIds.has(item.clientMessageId);
  }

  // Auto-close the modal if the queue empties while it's open (e.g., the
  // primary turn finished and all queued messages got drained, or the
  // operator cancelled the last one from inside the modal).
  useEffect(() => {
    if (open && items.length === 0) setOpen(false);
  }, [open, items.length]);

  if (items.length === 0) return null;

  const steerTooltip = providerSteerTooltip(job.config.primaryProvider ?? 'claude', job.config.claudeTransport, job.config.codexTransport);
  const tooltip = items.map((item) => `${item.kind.toUpperCase()} (${item.state?.toUpperCase()}): ${item.automaticKind ? `(${item.automaticKind}) Peer mail waiting` : item.content}`).join('\n') + `\n\n${steerTooltip}`;
  return (
    <span data-help="composer.turn-messages">
      <button type="button" onClick={() => setOpen(true)} title={tooltip} className="display-font">PENDING · {items.length}</button>
      {open && <QueuedMessagesModal workflowId={job.id} online={online} items={items} onCancel={onCancel} onClose={() => setOpen(false)} />}
    </span>
  );
}

function providerSteerTooltip(
  provider: ProviderName,
  claudeTransport?: 'cli' | 'native',
  codexTransport?: 'exec' | 'appserver',
): string {
  const midTurnSemantics =
    'Mid-turn delivery lands at the next tool-call boundary. ' +
    'If the model is already wrapping up its response, the steer becomes ' +
    'the next turn instead: neither provider API accepts mid-text-stream injection.';
  switch (provider) {
    case 'claude':
      if (claudeTransport === 'native') {
        return `STEER: ${midTurnSemantics}`;
      }
      return `STEER: delivered after the current turn (CLI transport queues input but only consumes at turn boundaries). Switch to Native transport for mid-turn delivery.`;
    case 'codex':
      if (codexTransport === 'appserver') {
        return `STEER: ${midTurnSemantics}`;
      }
      return `STEER: delivered after the current turn (exec transport is per-turn spawn, no mid-turn surface). Switch to app-server transport for mid-turn delivery.`;
    case 'ollama':
    case 'llamacpp':
      return `STEER: ${midTurnSemantics}`;
      return `STEER: delivered after the current turn for ${provider} (single-shot transport, no mid-turn surface).`;
    default:
      return 'STEER: delivered after the current turn for this provider.';
  }
}


interface ModalProps {
  workflowId: string;
  online: boolean;
  items: QueueItem[];
  onCancel: (clientMessageId: string) => void;
  onClose: () => void;
}

function QueuedMessagesModal({ workflowId, online, items, onCancel, onClose }: ModalProps) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const keyFor = (item: QueueItem) => item.clientMessageId ?? `${item.kind}-${item.index}`;
  const preview = items.find(item => keyFor(item) === previewId);
  const surface = useRef<HTMLDivElement>(null);
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
        ref={surface}
        onClick={(e) => e.stopPropagation()}
        className="glow-border"
        style={{
          ...formSurfaceSize(),
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
            {preview ? 'PREVIEW' : `QUEUED MESSAGES · ${items.length}`}
            {preview && <button data-help="composer.pending-preview" style={queueActionStyle} onClick={() => setPreviewId(null)}>BACK TO LIST</button>}
          </div>
          <WorkSurfaceControls surface={surface} storageKey="queued-messages" />
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
          {(preview ? [preview] : items).map((item, i) => (
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
                  #{i + 1} · {item.kind === 'interrupt' ? 'INTERRUPT & SEND' : item.kind === 'steer' ? 'STEER' : 'FOLLOW-UP'} · {item.state === 'delivered' ? 'DELIVERED' : 'QUEUED'}
                </span>
                <span style={{ display: 'flex', gap: 6 }}>
                  {!preview && <button type="button" data-help="composer.pending-preview" style={queueActionStyle} onClick={() => setPreviewId(keyFor(item))}>PREVIEW</button>}
                  <button type="button" data-help="composer.pending-edit" style={queueActionStyle}
                    disabled={!online || !item.cancellable || item.state === 'delivered'}
                    title={item.state === 'delivered' ? 'Already sent, nothing to edit' : !online ? 'Reconnect to edit this pending message' : !item.cancellable ? 'This message has no queue identifier' : 'Remove from the queue and return to the message box'}
                    onClick={() => requestQueuedMessageEdit(workflowId, item.clientMessageId!)}>EDIT</button>
                {item.cancellable && (
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
                </span>
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
                {item.automaticKind ? <AutomaticMessage kind={item.automaticKind} content={item.content} /> : linkifyText(item.content)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    body,
  );
}

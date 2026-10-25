// Operator-driven peer_send dialog. Surfaces in cluster members' composer
// row as a SEND TRANSCRIPT button. Lets the operator pick a recipient
// (another cluster member) + scope (full / last turn / last N turns) and
// fires a single operator_peer_send WS message. Server bypasses model-facing
// budget + dedupe gates and raises the content cap to 32 KB.

import { useMemo, useState } from 'react';
import type { ChatMessage, ClusterStatePayload } from '@arco/shared';

interface Props {
  cluster: ClusterStatePayload;
  fromWorkflowId: string;
  messages: ChatMessage[];
  onConfirm: (toWorkflowId: string, content: string) => void;
  onCancel: () => void;
}

type Scope = 'full' | 'last-turn' | 'last-n';

const MAX_BYTES = 32 * 1024;

// Format a chat row into a transcript line. ctx-dividers + tool pills are
// pure render noise and get dropped. System rows are filtered: pure metadata
// pills like `[TURN · 1m 49.4s]` or `[REVIEW] Running review…` are stripped
// (single-line `[TAG] short text`), but substantive system content —
// inlined review bodies, AUTH notices with detail, multi-line blocks — is
// kept so transcript-send actually carries the work product to the
// recipient. Earlier this filter was "drop ALL system rows," which silently
// stripped review bodies and left the director seeing only the reviewer's
// narration without the findings.
function formatRow(m: ChatMessage, selfName: string): string | null {
  if (m.role === 'ctx-divider') return null;
  if (m.toolUse) return null;
  if (m.role === 'system') {
    const trimmed = m.content.trim();
    // Skip single-line bracketed pills (metadata-only). Keep anything with a
    // newline or substantial content past the leading tag.
    const singleLinePill = /^\[[^\]]+\][^\n]*$/.test(trimmed) && trimmed.length < 200;
    if (singleLinePill) return null;
    return `[system] ${m.content}`;
  }
  if (m.role === 'peer-sent') {
    return `[peer-sent → ${m.senderDisplayName ?? '?'}] ${m.content}`;
  }
  if (m.role === 'peer-received') {
    return `[peer-received ← ${m.senderDisplayName ?? '?'}] ${m.content}`;
  }
  if (m.role === 'user') {
    return `[operator → ${selfName}]\n${m.content}`;
  }
  // assistant
  return `[${selfName}]\n${m.content}`;
}

// Find turn boundaries — each user message starts a new turn. Returns the
// index array of user-message positions in chronological order; turn N
// (1-indexed from end) covers boundaries[boundaries.length - N] through
// boundaries[boundaries.length - N + 1] - 1.
function turnBoundaries(messages: ChatMessage[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') out.push(i);
  }
  return out;
}

export function TranscriptSendDialog({ cluster, fromWorkflowId, messages, onConfirm, onCancel }: Props) {
  const peers = cluster.members.filter((m) => m.workflowId !== fromWorkflowId);
  const [toWfid, setToWfid] = useState<string>(peers[0]?.workflowId ?? '');
  const [scope, setScope] = useState<Scope>('last-turn');
  const [nTurns, setNTurns] = useState(3);

  const senderName = useMemo(() => {
    const m = cluster.members.find((mm) => mm.workflowId === fromWorkflowId);
    return m?.displayName ?? fromWorkflowId.slice(0, 8);
  }, [cluster.members, fromWorkflowId]);

  const content = useMemo(() => {
    const boundaries = turnBoundaries(messages);
    let startIdx = 0;
    if (scope === 'last-turn' && boundaries.length > 0) {
      startIdx = boundaries[boundaries.length - 1];
    } else if (scope === 'last-n' && boundaries.length > 0) {
      const n = Math.max(1, Math.min(nTurns, boundaries.length));
      startIdx = boundaries[boundaries.length - n];
    }
    const slice = messages.slice(startIdx);
    const lines: string[] = [];
    for (const m of slice) {
      const formatted = formatRow(m, senderName);
      if (formatted) lines.push(formatted);
    }
    return lines.join('\n\n');
  }, [messages, scope, nTurns, senderName]);

  const byteLen = new TextEncoder().encode(content).length;
  const overLimit = byteLen > MAX_BYTES;
  const canSend = toWfid && content.trim().length > 0 && !overLimit;

  const handleSend = () => {
    if (!canSend) return;
    onConfirm(toWfid, content);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50,
        backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-border-hairline)',
          width: 'min(720px, 92vw)',
          maxHeight: '85vh',
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
            SEND TRANSCRIPT · FROM {senderName.toUpperCase()}
          </span>
          <button
            type="button"
            onClick={onCancel}
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
            CANCEL
          </button>
        </div>
        <div style={{ overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {peers.length === 0 ? (
            <div style={{ color: 'var(--color-warning)', fontSize: '11px' }}>
              No other members in this cluster — add a peer first.
            </div>
          ) : (
            <>
              <div>
                <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '9px', letterSpacing: '1px', marginBottom: '4px' }}>
                  RECIPIENT
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {peers.map((p) => (
                    <label
                      key={p.workflowId}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '6px 8px',
                        border: '1px solid var(--color-border-hairline)',
                        cursor: 'pointer',
                        fontSize: '11px',
                        background: toWfid === p.workflowId ? 'var(--color-accent-primary-a06)' : 'transparent',
                      }}
                    >
                      <input
                        type="radio"
                        name="transcript-send-to"
                        checked={toWfid === p.workflowId}
                        onChange={() => setToWfid(p.workflowId)}
                      />
                      <span style={{ color: 'var(--color-fg)' }}>{p.displayName}</span>
                      <span style={{ marginLeft: 'auto', color: 'var(--color-fg-muted)', fontSize: '10px' }}>
                        {p.workflowId.slice(0, 8)}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '9px', letterSpacing: '1px', marginBottom: '4px' }}>
                  SCOPE
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
                    <input type="radio" name="transcript-scope" checked={scope === 'last-turn'} onChange={() => setScope('last-turn')} />
                    Last turn
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
                    <input type="radio" name="transcript-scope" checked={scope === 'last-n'} onChange={() => setScope('last-n')} />
                    Last
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={nTurns}
                      onChange={(e) => {
                        setNTurns(Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1)));
                        setScope('last-n');
                      }}
                      style={{
                        width: '60px',
                        background: 'var(--color-bg)',
                        color: 'var(--color-fg)',
                        border: '1px solid var(--color-border-hairline)',
                        padding: '2px 4px',
                        fontSize: '11px',
                      }}
                    />
                    turns
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
                    <input type="radio" name="transcript-scope" checked={scope === 'full'} onChange={() => setScope('full')} />
                    Full transcript
                  </label>
                </div>
              </div>
              <div>
                <div className="display-font" style={{
                  color: overLimit ? 'var(--color-warning)' : 'var(--color-fg-muted)',
                  fontSize: '9px', letterSpacing: '1px', marginBottom: '4px',
                  display: 'flex', alignItems: 'center', gap: '8px',
                }}>
                  <span>PREVIEW</span>
                  <span style={{ marginLeft: 'auto' }}>
                    {byteLen.toLocaleString()} / {MAX_BYTES.toLocaleString()} bytes
                  </span>
                </div>
                <pre style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--color-fg)',
                  fontSize: '11px',
                  maxHeight: '240px',
                  overflowY: 'auto',
                  background: 'var(--color-bg)',
                  padding: '8px 10px',
                  border: '1px solid ' + (overLimit ? 'var(--color-warning)' : 'var(--color-border-hairline)'),
                }}>{content || '(no content in this scope)'}</pre>
                {overLimit && (
                  <div style={{ color: 'var(--color-warning)', fontSize: '10px', marginTop: '4px' }}>
                    Content exceeds 32 KB cap — narrow the scope to fit.
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <div style={{
          padding: '10px 14px',
          borderTop: '1px solid var(--color-border-hairline)',
          display: 'flex', justifyContent: 'flex-end', gap: '8px',
        }}>
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="display-font"
            style={{
              background: canSend ? 'var(--color-accent-primary-a06)' : 'transparent',
              border: '1px solid ' + (canSend ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'),
              color: canSend ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              padding: '5px 12px',
              cursor: canSend ? 'pointer' : 'not-allowed',
              fontSize: '10px',
              letterSpacing: '1px',
            }}
          >
            SEND
          </button>
        </div>
      </div>
    </div>
  );
}

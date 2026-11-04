import { useMemo, useState } from 'react';
import type { ChatMessage, ClusterStatePayload } from '@arco/shared';
import { useMessageSelectionStore, EMPTY_SELECTION } from '../stores/messageSelectionStore';
import { formatRow } from '../utils/transcriptFormat';

const MAX_BYTES = 32 * 1024;

const button: React.CSSProperties = {
  padding: '3px 8px', background: 'transparent', border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px', fontSize: '10px', letterSpacing: '1px', cursor: 'pointer', color: 'var(--color-accent-secondary-dim)', whiteSpace: 'nowrap',
};

/** Selected chat messages in the composer area: FORWARD (cluster members) and CLEAR. */
export function MessageSelectionBar({ jobId, onForward, onSecondOpinion }: { jobId: string; onForward?: () => void; onSecondOpinion?: () => void }) {
  const ids = useMessageSelectionStore((s) => s.selected[jobId] ?? EMPTY_SELECTION);
  const clear = useMessageSelectionStore((s) => s.clear);
  if (ids.length === 0) return null;
  return (
    <div data-testid="message-selection-bar" data-help="chat.message-selection" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px', fontSize: '11px' }}>
      <span className="display-font" style={{ letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>{ids.length} SELECTED</span>
      {onForward && <button type="button" className="display-font" style={button} onClick={onForward} title="Send the selected messages to other cluster members">FORWARD</button>}
      {onSecondOpinion && <button type="button" className="display-font" style={button} onClick={onSecondOpinion} title="Ask several models to draft a reply to the worker about the selected messages">SECOND OPINION</button>}
      <button type="button" className="display-font" style={button} onClick={() => clear(jobId)}>CLEAR</button>
    </div>
  );
}

export function ForwardDialog({ cluster, fromWorkflowId, messages, onConfirm, onCancel }: {
  cluster: ClusterStatePayload;
  fromWorkflowId: string;
  messages: ChatMessage[];
  /** One delivery per recipient, all with the same text. */
  onConfirm: (toWorkflowIds: string[], content: string) => void;
  onCancel: () => void;
}) {
  const ids = useMessageSelectionStore((s) => s.selected[fromWorkflowId] ?? EMPTY_SELECTION);
  const peers = cluster.members.filter((m) => m.workflowId !== fromWorkflowId);
  const [to, setTo] = useState<string[]>(peers.length === 1 ? [peers[0].workflowId] : []);
  const [note, setNote] = useState('');
  const senderName = cluster.members.find((m) => m.workflowId === fromWorkflowId)?.displayName ?? fromWorkflowId.slice(0, 8);
  const content = useMemo(() => {
    const picked = new Set(ids);
    const lines: string[] = [];
    for (const m of messages) {
      if (!picked.has(m.id)) continue;
      const row = formatRow(m, senderName);
      if (row) lines.push(row);
    }
    const body = lines.join('\n\n');
    const covering = note.trim();
    const header = `Forwarded by the operator from ${senderName}:`;
    return body ? `${covering ? `${covering}\n\n---\n\n` : ''}${header}\n\n${body}` : '';
  }, [ids, messages, senderName, note]);
  const bytes = new TextEncoder().encode(content).length;
  const over = bytes > MAX_BYTES;
  const canSend = to.length > 0 && content.length > 0 && !over;
  return (
    <div role="dialog" aria-modal="true" aria-label="Forward messages" onClick={onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} data-help="chat.forward"
        style={{ background: 'var(--color-bg-dialog, var(--color-bg-panel))', border: '1px solid var(--color-border-hairline)', width: 'min(640px, calc(92vw / var(--ui-scale, 1)))', maxHeight: 'calc(85vh / var(--ui-scale, 1))', display: 'flex', flexDirection: 'column', padding: '12px 14px', gap: '10px', overflowY: 'auto' }}>
        <span className="display-font" style={{ letterSpacing: '1px', fontSize: '11px' }}>FORWARD {ids.length} MESSAGE{ids.length === 1 ? '' : 'S'} · FROM {senderName.toUpperCase()}</span>
        {peers.length === 0 ? <div style={{ color: 'var(--color-warning)', fontSize: '11px' }}>No other members in this cluster.</div> : (
          <>
            <div>
              <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '9px', letterSpacing: '1px', marginBottom: '4px' }}>RECIPIENTS</div>
              {peers.map((p) => (
                <label key={p.workflowId} style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '11px', padding: '2px 0' }}>
                  <input type="checkbox" aria-label={`Forward to ${p.displayName}`} checked={to.includes(p.workflowId)}
                    onChange={(e) => setTo((cur) => (e.target.checked ? [...cur, p.workflowId] : cur.filter((id) => id !== p.workflowId)))} />
                  {p.displayName}
                </label>
              ))}
            </div>
            <textarea aria-label="Covering note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note placed above the forwarded messages"
              style={{ width: '100%', boxSizing: 'border-box', background: 'var(--color-bg)', color: 'var(--color-fg)', border: '1px solid var(--color-border-hairline)', padding: '6px 8px', fontSize: '11px', fontFamily: 'inherit', resize: 'vertical' }} />
            <div className="display-font" style={{ color: over ? 'var(--color-warning)' : 'var(--color-fg-muted)', fontSize: '9px', letterSpacing: '1px' }}>
              PREVIEW · {bytes.toLocaleString()} / {MAX_BYTES.toLocaleString()} bytes{over ? ' - too long, select fewer messages' : ''}
            </div>
            <pre data-testid="forward-preview" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '11px', maxHeight: '220px', overflowY: 'auto', background: 'var(--color-bg)', padding: '8px 10px', border: '1px solid var(--color-border-hairline)' }}>{content || '(nothing to forward in the selection)'}</pre>
          </>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button type="button" className="display-font" style={button} onClick={onCancel}>CANCEL</button>
          <button type="button" className="display-font" disabled={!canSend} style={{ ...button, opacity: canSend ? 1 : 0.4, cursor: canSend ? 'pointer' : 'not-allowed' }}
            onClick={() => { if (canSend) onConfirm(to, content); }}>{to.length > 1 ? `SEND TO ${to.length}` : 'SEND'}</button>
        </div>
      </div>
    </div>
  );
}

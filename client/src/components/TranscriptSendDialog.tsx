// Operator-driven peer_send dialog. Surfaces in cluster members' composer
// row as a SEND TRANSCRIPT button. Lets the operator pick a recipient
// (another cluster member) + scope (full / last turn / last N turns) and
// fires a single operator_peer_send WS message. Server bypasses model-facing
// budget + dedupe gates and raises the content cap to 32 KB.

import { DialogShell } from './DialogShell';
import { useMemo, useState } from 'react';
import type { ChatMessage, ClusterStatePayload } from '@arco/shared';
import { DEFAULT_TRANSCRIPT_INCLUDE, formatRow, turnBoundaries, type TranscriptInclude } from '../utils/transcriptFormat';

interface Props {
  cluster: ClusterStatePayload;
  fromWorkflowId: string;
  messages: ChatMessage[];
  /** One delivery per recipient, all with the same text. */
  onConfirm: (toWorkflowIds: string[], content: string) => void;
  onCancel: () => void;
}

type Scope = 'full' | 'last-turn' | 'last-n';

const MAX_BYTES = 32 * 1024;

export function TranscriptSendDialog({ cluster, fromWorkflowId, messages, onConfirm, onCancel }: Props) {
  const peers = cluster.members.filter((m) => m.workflowId !== fromWorkflowId);
  const [toWfids, setToWfids] = useState<string[]>(peers.length === 1 ? [peers[0].workflowId] : []);
  const [note, setNote] = useState('');
  const [include, setInclude] = useState<TranscriptInclude>(DEFAULT_TRANSCRIPT_INCLUDE);
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
      const formatted = formatRow(m, senderName, include);
      if (formatted) lines.push(formatted);
    }
    const body = lines.join('\n\n');
    const covering = note.trim();
    return covering && body ? `${covering}\n\n---\n\n${body}` : body;
  }, [messages, scope, nTurns, senderName, include, note]);

  const byteLen = new TextEncoder().encode(content).length;
  const overLimit = byteLen > MAX_BYTES;
  const canSend = toWfids.length > 0 && content.trim().length > 0 && !overLimit;

  const handleSend = () => {
    if (!canSend) return;
    onConfirm(toWfids, content);
  };

  return (
    <DialogShell title={`Send transcript - from ${senderName}`} ariaLabel="Send transcript" onClose={onCancel} closeOnBackdrop width={720} zIndex={50}
      actions={<>
        <button type="button" onClick={onCancel} className="display-font" style={{ background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-muted)', padding: '5px 12px', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px' }}>CANCEL</button>
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
          {toWfids.length > 1 ? `SEND TO ${toWfids.length}` : 'SEND'}
        </button>
      </>}>
      {peers.length === 0 ? (
        <div style={{ color: 'var(--color-warning)', fontSize: '11px' }}>
          No other members in this cluster: add a peer first.
        </div>
      ) : (
        <>
          <div>
            <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '9px', letterSpacing: '1px', marginBottom: '4px' }}>
              RECIPIENTS
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
                    background: toWfids.includes(p.workflowId) ? 'var(--color-accent-primary-a06)' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    aria-label={`Send to ${p.displayName}`}
                    checked={toWfids.includes(p.workflowId)}
                    onChange={(e) => setToWfids((cur) => (e.target.checked ? [...cur, p.workflowId] : cur.filter((id) => id !== p.workflowId)))}
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
            <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '9px', letterSpacing: '1px', marginBottom: '4px' }}>
              INCLUDE
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: '11px' }}>
              <label><input type="checkbox" checked={include.operator} onChange={(e) => setInclude({ ...include, operator: e.target.checked })} /> Operator messages</label>
              <label><input type="checkbox" checked={include.agent} onChange={(e) => setInclude({ ...include, agent: e.target.checked })} /> Agent replies</label>
              <label><input type="checkbox" checked={include.mail} onChange={(e) => setInclude({ ...include, mail: e.target.checked })} /> Mail lines</label>
              <label title="The chat keeps only a shortened copy of mail this member sent." style={{ opacity: include.mail ? 1 : 0.5 }}>
                <input type="checkbox" disabled={!include.mail} checked={include.mail && include.sentEchoes} onChange={(e) => setInclude({ ...include, sentEchoes: e.target.checked })} /> Shortened copies of mail sent
              </label>
            </div>
          </div>
          <div>
            <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '9px', letterSpacing: '1px', marginBottom: '4px' }}>
              NOTE (OPTIONAL)
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-label="Covering note"
              rows={2}
              placeholder="A line or two for the recipients, placed above the transcript"
              style={{ width: '100%', boxSizing: 'border-box', background: 'var(--color-bg)', color: 'var(--color-fg)', border: '1px solid var(--color-border-hairline)', padding: '6px 8px', fontSize: '11px', fontFamily: 'inherit', resize: 'vertical' }}
            />
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
                Content exceeds 32 KB cap: narrow the scope to fit.
              </div>
            )}
          </div>
        </>
      )}
    </DialogShell>
  );
}

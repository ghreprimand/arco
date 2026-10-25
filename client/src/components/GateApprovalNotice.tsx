// DEBAG — Durable Edit-Before-Approve Gate (docs/DEBAG_PLAN.md).
//
// Inline approval card for a parked sensitive tool call. The worker emits a
// `gate_required` broadcast which handleServerMessage anchors as a synthetic
// `gate::<gateId>` message carrying the structured proposal in toolUse.input;
// this card reads that input directly and lets the operator approve or reject.
// Resolution sends a `gate_reply` over the raw WS sender; the server's
// `gate_resolved` broadcast flips `status` in the store so the card reflects the
// outcome (survives re-render + cross-tab). Sub-phase 2 renders the args
// read-only; edit-then-approve lands in sub-phase 3.

import { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { buildGateFinalArgs, renderGateArgs } from '../utils/gateArgs';

interface Props {
  workflowId: string;
  input: Record<string, unknown>;
}

const CATEGORY_LABEL: Record<string, string> = {
  bash: 'SHELL COMMAND',
  'git-destructive': 'DESTRUCTIVE GIT',
  'write-outside-cwd': 'WRITE OUTSIDE PROJECT',
  'kill-shell': 'KILL BACKGROUND SHELL',
};

export function GateApprovalNotice({ workflowId, input }: Props) {
  const sendRaw = useAppStore((s) => s.wsSendRaw);
  const [submitting, setSubmitting] = useState<null | 'approve' | 'reject'>(null);

  const gateId = String(input.gateId ?? '');
  const toolName = String(input.toolName ?? 'tool');
  const category = String(input.category ?? '');
  const reason = String(input.reason ?? '');
  const proposedArgs = (input.proposedArgs ?? {}) as Record<string, unknown>;
  const status = String(input.status ?? 'pending') as 'pending' | 'approve' | 'reject';

  // Sub-phase 3 — edit-then-approve. The textarea is pre-filled with the
  // proposed call (the Bash command line, or pretty JSON for other tools). If
  // the operator changes it, approve sends `finalArgs` and the server records
  // wasEdited; otherwise it's a plain approve of the original proposal.
  const original = renderGateArgs(toolName, proposedArgs);
  const [text, setText] = useState(original);
  const [parseError, setParseError] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);

  const resolved = status === 'approve' || status === 'reject';
  const edited = text !== original;
  const accent = status === 'reject' ? 'var(--color-error, #e0524f)' : 'var(--color-accent-primary)';

  const resolve = (decision: 'approve' | 'reject') => {
    if (resolved || submitting || !sendRaw || !gateId) return;
    let finalArgs: Record<string, unknown> | undefined;
    if (decision === 'approve') {
      try {
        finalArgs = buildGateFinalArgs(toolName, original, text, proposedArgs);
      } catch (err) {
        setParseError(err instanceof Error ? err.message : 'invalid edited args');
        return;
      }
    }
    setParseError(null);
    setSubmitting(decision);
    // "approve all like this" only on an UNEDITED approve — the server stores
    // the signature of what runs, and an edit is a one-off.
    const rememberThis = decision === 'approve' && remember && !edited;
    sendRaw({
      type: 'gate_reply',
      workflowId,
      gateId,
      decision,
      ...(finalArgs !== undefined ? { finalArgs } : {}),
      ...(rememberThis ? { remember: true } : {}),
    });
  };

  // Resolved state — compact one-liner.
  if (resolved) {
    return (
      <div style={{ marginBottom: '10px', maxWidth: '100%' }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            padding: '4px 8px',
            borderLeft: `2px solid ${accent}`,
            background: 'var(--color-bg-sunken)',
            color: 'var(--color-fg-muted)',
            fontSize: '11px',
            fontFamily: 'var(--font-body)',
          }}
        >
          <span className="display-font" style={{ color: accent, letterSpacing: '1px' }}>[GATE]</span>
          <span>
            {status === 'approve' ? 'Approved' : 'Rejected'} {toolName}
            {input.wasEdited ? ' (edited)' : ''}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ animation: 'fade-in-up 0.3s ease-out', marginBottom: '16px', maxWidth: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '4px',
          fontSize: '11px',
          fontFamily: 'var(--font-display)',
          letterSpacing: '1px',
          color: 'var(--color-accent-primary)',
        }}
      >
        <span>[GATE: REVIEW SAFE-MODE]</span>
        {category && (
          <span style={{ color: 'var(--color-fg-muted)', letterSpacing: '0.5px' }}>{CATEGORY_LABEL[category] ?? category}</span>
        )}
      </div>
      <div
        style={{
          padding: '10px 12px',
          borderLeft: '2px solid var(--color-accent-primary)',
          marginLeft: '4px',
          background: 'var(--color-bg-sunken)',
        }}
      >
        <div style={{ color: 'var(--color-text-primary)', fontSize: '12px', fontFamily: 'var(--font-body)', lineHeight: '1.5', marginBottom: '8px' }}>
          {reason} Review and edit the call below, then approve or reject.
        </div>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); if (parseError) setParseError(null); }}
          spellCheck={false}
          rows={Math.min(12, Math.max(2, text.split('\n').length))}
          style={{
            display: 'block',
            width: '100%',
            boxSizing: 'border-box',
            margin: '0 0 6px 0',
            padding: '8px 10px',
            background: 'var(--color-bg-base, #11131a)',
            border: `1px solid ${text !== original ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
            borderRadius: '3px',
            fontSize: '12px',
            fontFamily: 'var(--font-code)',
            color: 'var(--color-text-primary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: '260px',
            overflow: 'auto',
            outline: 'none',
            resize: 'vertical',
          }}
        />
        {text !== original && (
          <div style={{ fontSize: '10px', color: 'var(--color-accent-primary)', fontFamily: 'var(--font-body)', marginBottom: '6px' }}>
            edited — approving will run your edited {toolName === 'Bash' ? 'command' : 'args'}
          </div>
        )}
        {parseError && (
          <div style={{ fontSize: '10px', color: 'var(--color-error, #e0524f)', fontFamily: 'var(--font-body)', marginBottom: '6px' }}>
            {parseError}
          </div>
        )}
        {!edited && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px', fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', cursor: 'pointer' }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ cursor: 'pointer' }} />
            approve all identical {toolName === 'Bash' ? 'commands' : `${toolName} calls`} this session (skip the gate for an exact match)
          </label>
        )}
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={() => resolve('approve')}
            disabled={!!submitting}
            className="display-font glow-border"
            style={{
              padding: '4px 12px',
              fontSize: '10px',
              letterSpacing: '2px',
              background: submitting ? 'transparent' : 'var(--color-accent-primary-a10, var(--color-accent-primary-dim))',
              border: '1px solid var(--color-accent-primary)',
              color: 'var(--color-accent-primary)',
              borderRadius: '3px',
              cursor: submitting ? 'default' : 'pointer',
              opacity: submitting && submitting !== 'approve' ? 0.5 : 1,
            }}
          >
            {submitting === 'approve' ? 'APPROVING…' : 'APPROVE'}
          </button>
          <button
            onClick={() => resolve('reject')}
            disabled={!!submitting}
            className="display-font"
            style={{
              padding: '4px 12px',
              fontSize: '10px',
              letterSpacing: '2px',
              background: 'transparent',
              border: '1px solid var(--color-error, #e0524f)',
              color: 'var(--color-error, #e0524f)',
              borderRadius: '3px',
              cursor: submitting ? 'default' : 'pointer',
              opacity: submitting && submitting !== 'reject' ? 0.5 : 1,
            }}
          >
            {submitting === 'reject' ? 'REJECTING…' : 'REJECT'}
          </button>
        </div>
      </div>
    </div>
  );
}

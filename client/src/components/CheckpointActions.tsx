import { useState } from 'react';
import { createPortal } from 'react-dom';
import { WORKTREE_REV } from '@arco/shared';
import type { HistoryEventEntry } from '../stores/appStore';
import { useAppStore } from '../stores/appStore';
import { ChangesPanel } from './diff/ChangesPanel';

// Workbench Expansion A4 — checkpoint marker actions for the HISTORY tab.
//
// Pulled out of HistoryTab.tsx (kept under the 2000-line cap) because it owns
// three pieces of self-contained state: the "view diff vs now" modal, the
// confirm-before-revert dialog, and the busy flag while the revert WS round
// trips. The actual revert is a single `revert_to_checkpoint` WS send; the
// server takes the safety snapshot + restores and broadcasts back
// checkpoint_reverted, which lands on the timeline like any other marker.

interface Props {
  // The selected CHECKPOINT row. `reverted` rows (the "REVERTED ↩" markers)
  // are passed too but the caller only renders this for non-reverted rows.
  entry: HistoryEventEntry;
  workflowId: string;
  cwd?: string;
  busy: boolean;
}

export function CheckpointActions({ entry, workflowId, cwd, busy }: Props) {
  const wsSendRaw = useAppStore((s) => s.wsSendRaw);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const ref = entry.checkpointRef;
  const seq = entry.checkpointSeq;
  const fileLabel = entry.summary ?? '';

  const doRevert = () => {
    if (wsSendRaw == null || seq == null) return;
    setSubmitting(true);
    // Server takes the safety snapshot FIRST, then restores; it broadcasts
    // checkpoint_created (safety) + checkpoint_reverted (or an error) back.
    wsSendRaw({ type: 'revert_to_checkpoint', workflowId, seq });
    setConfirmOpen(false);
    // Brief local debounce; the authoritative state is the broadcast.
    setTimeout(() => setSubmitting(false), 400);
  };

  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
      <ActionBtn
        disabled={ref == null}
        onClick={() => setDiffOpen(true)}
        dataHelp="rightpanel.history.checkpoint"
      >
        VIEW DIFF VS NOW
      </ActionBtn>
      <ActionBtn
        disabled={seq == null || busy || submitting}
        onClick={() => setConfirmOpen(true)}
        title={busy ? 'Cancel the in-flight turn before reverting' : undefined}
        dataHelp="rightpanel.history.checkpoint"
      >
        REVERT TO HERE
      </ActionBtn>

      {confirmOpen && createPortal(
        <Overlay onClose={() => setConfirmOpen(false)}>
          <div
            className="display-font glow-text-cyan"
            style={{ fontSize: '12px', letterSpacing: '1px', marginBottom: '12px' }}
          >
            REVERT WORKING TREE TO CHECKPOINT {seq}
          </div>
          <div
            style={{
              fontSize: '12px',
              lineHeight: 1.6,
              color: 'var(--color-fg)',
              fontFamily: 'var(--font-body)',
              marginBottom: '16px',
            }}
          >
            <p style={{ margin: '0 0 10px' }}>
              This restores your working tree to <strong>{fileLabel || `checkpoint ${seq}`}</strong>.
              Files created after the checkpoint are removed; modified files are
              reset to their checkpoint contents.
            </p>
            <p style={{ margin: 0, opacity: 0.85 }}>
              A <strong>pre-revert safety snapshot</strong> of the current tree is
              taken first, so this is reversible — you can undo the revert by
              reverting to that snapshot (it appears on the timeline). Your git
              HEAD / branch / staged index are not moved.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <ActionBtn onClick={() => setConfirmOpen(false)}>CANCEL</ActionBtn>
            <ActionBtn onClick={doRevert} danger disabled={submitting}>
              {submitting ? 'REVERTING…' : 'REVERT'}
            </ActionBtn>
          </div>
        </Overlay>,
        document.body,
      )}

      {diffOpen && createPortal(
        <Overlay onClose={() => setDiffOpen(false)} wide>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '10px',
            }}
          >
            <div className="display-font glow-text-cyan" style={{ fontSize: '12px', letterSpacing: '1px' }}>
              DIFF — CHECKPOINT {seq} VS NOW
            </div>
            <ActionBtn onClick={() => setDiffOpen(false)}>CLOSE</ActionBtn>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <ChangesPanel wfid={workflowId} cwd={cwd} from={ref} to={WORKTREE_REV} />
          </div>
        </Overlay>,
        document.body,
      )}
    </div>
  );
}

function Overlay({
  children,
  onClose,
  wide,
}: {
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
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
          maxWidth: wide ? '1100px' : '520px',
          maxHeight: '100%',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border-bright)',
          borderRadius: '6px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          padding: '18px',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ActionBtn({
  onClick,
  disabled,
  danger,
  title,
  dataHelp,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  dataHelp?: string;
  children: React.ReactNode;
}) {
  const accent = danger ? 'var(--color-danger)' : 'var(--color-accent-primary)';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-help={dataHelp}
      className="display-font"
      style={{
        padding: '6px 10px',
        background: disabled ? 'transparent' : danger ? 'transparent' : 'var(--color-accent-primary-a10)',
        border: `1px solid ${disabled ? 'var(--color-border-hairline)' : accent}`,
        borderRadius: '3px',
        color: disabled ? 'var(--color-fg-muted)' : accent,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '10px',
        letterSpacing: '1.5px',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

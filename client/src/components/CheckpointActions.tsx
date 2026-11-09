import { confirmationSurfaceSize, contentSurfaceSize, WorkSurfaceControls } from './workSurface/WorkSurfaceControls';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { WORKTREE_REV, type CheckpointRevertPreview } from '@arco/shared';
import { describeRestoreChanges, restoreChangesNothing } from '../utils/checkpointChanges';
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
  turn?: { endRef: string; fileCount: number; added: number; removed: number; binaryFiles?: number; paths: string[]; pathsTruncated: boolean; otherWriters?: boolean; skippedLargeFiles?: number };
}

export function CheckpointActions({ entry, workflowId, cwd, busy, turn }: Props) {
  const wsSendRaw = useAppStore((s) => s.wsSendRaw);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [resultDiffOpen, setResultDiffOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<CheckpointRevertPreview | null>(null);
  // When this tab sent a revert: the result row that arrives after it is shown here.
  const [sentAt, setSentAt] = useState<number | null>(null);
  const inCluster = useAppStore((s) => Object.values(s.clusters).some((c) => c.members.some((m) => m.workflowId === workflowId)));

  const ref = entry.checkpointRef;
  const seq = entry.checkpointSeq;
  // A turn whose checkpoint was restored shows as undone; a second undo cannot run.
  const undone = useAppStore((s) => turn != null && seq != null && (s.jobs[workflowId]?.historyEvents ?? []).some((e) => e.reverted && e.revertedCheckpointSeq === seq));
  const fileLabel = entry.summary ?? '';
  // The REVERTED row this tab's last revert produced (newest first).
  const result = useAppStore((s) => sentAt == null || seq == null ? undefined
    : [...(s.jobs[workflowId]?.historyEvents ?? [])].reverse().find((e) => e.reverted && e.revertedCheckpointSeq === seq && (e.at ?? 0) >= sentAt - 1000));

  // Ask the server what the revert would change while the dialog is open.
  useEffect(() => {
    if (!confirmOpen || seq == null) return;
    let cancelled = false;
    setPreview(null);
    fetch(`/api/workflows/checkpoint-preview?${new URLSearchParams({ wfid: workflowId, seq: String(seq) }).toString()}`)
      .then(async (r) => (r.ok ? (await r.json()) as CheckpointRevertPreview : { ok: false as const, error: (await r.text()) || `HTTP ${r.status}` }))
      .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
      .then((p) => { if (!cancelled) setPreview(p); });
    return () => { cancelled = true; };
  }, [confirmOpen, seq, workflowId]);

  const doRevert = () => {
    if (wsSendRaw == null || seq == null || undone) return;
    setSubmitting(true);
    // Server takes the safety snapshot FIRST, then restores; it broadcasts
    // checkpoint_created (safety) + checkpoint_reverted (or an error) back.
    wsSendRaw({ type: 'revert_to_checkpoint', workflowId, seq });
    setSentAt(Date.now());
    setConfirmOpen(false);
    // Brief local debounce; the authoritative state is the broadcast.
    setTimeout(() => setSubmitting(false), 400);
  };

  // A REVERTED row: what that restore changed, as a diff.
  if (entry.reverted) {
    const revertDiff = entry.revertDiff;
    return (
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <ActionBtn disabled={!revertDiff} onClick={() => setResultDiffOpen(true)} dataHelp="rightpanel.history.checkpoint"
          title={revertDiff ? undefined : 'This revert was recorded before Arco kept its diff'}>
          VIEW CHANGES
        </ActionBtn>
        {entry.checkpointLimitation && <span style={{ color: 'var(--color-fg-muted)', fontSize: '11px' }}>{entry.checkpointLimitation}</span>}
        {resultDiffOpen && revertDiff && <DiffOverlay title="DIFF: WHAT THE REVERT CHANGED" onClose={() => setResultDiffOpen(false)}
          wfid={workflowId} cwd={cwd} from={revertDiff.from} to={revertDiff.to} emptyText="The revert changed no file." />}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
      <ActionBtn
        disabled={ref == null}
        onClick={() => setDiffOpen(true)}
        dataHelp={turn ? 'chat.turn-changes' : 'rightpanel.history.checkpoint'}
      >
        {turn ? turn.otherWriters ? 'VIEW DIFF' : `Changed ${turn.fileCount} ${turn.fileCount === 1 ? 'file' : 'files'} (+${turn.added} -${turn.removed}${turn.binaryFiles ? `, ${turn.binaryFiles} binary` : ''})` : 'VIEW DIFF VS NOW'}
      </ActionBtn>
      {!turn?.otherWriters && <ActionBtn
        disabled={seq == null || busy || submitting || undone}
        onClick={() => setConfirmOpen(true)}
        title={undone ? 'This turn has already been undone' : busy ? 'Cancel the in-flight turn before reverting' : undefined}
        dataHelp={turn ? 'chat.turn-changes' : 'rightpanel.history.checkpoint'}
      >
        {turn ? 'UNDO THIS TURN' : 'REVERT TO HERE'}
      </ActionBtn>}
      {result && <span data-testid="revert-result" role="status" style={{ color: 'var(--color-fg)', fontSize: '11px' }}>
        Reverted: {result.revertChanges ? describeRestoreChanges(result.revertChanges) : result.summary}.
        {result.revertDiff && <> <ActionBtn onClick={() => setResultDiffOpen(true)} dataHelp="rightpanel.history.checkpoint">VIEW CHANGES</ActionBtn></>}
      </span>}
      {resultDiffOpen && result?.revertDiff && <DiffOverlay title="DIFF: WHAT THE REVERT CHANGED" onClose={() => setResultDiffOpen(false)}
        wfid={workflowId} cwd={cwd} from={result.revertDiff.from} to={result.revertDiff.to} emptyText="The revert changed no file." />}
      {undone && <span data-testid="turn-undone" className="display-font" style={{ color: 'var(--color-accent-secondary)', fontSize: '10px', letterSpacing: '1.5px' }}>Undone</span>}

      {(result?.checkpointLimitation ?? entry.checkpointLimitation) && <span data-testid="checkpoint-scope" style={{ color: 'var(--color-fg-muted)', fontSize: '11px' }}>{result?.checkpointLimitation ?? entry.checkpointLimitation}</span>}
      {turn?.otherWriters && <span style={{ color: 'var(--color-fg-muted)', fontSize: '11px' }}>{turn.fileCount} {turn.fileCount === 1 ? 'file' : 'files'} changed in this folder during this turn (other agents were also working here).</span>}
      {turn && <span style={{ color: 'var(--color-fg-muted)', fontSize: '11px' }}>{turn.paths.join(', ')}{turn.pathsTruncated ? ' ...' : ''}{turn.skippedLargeFiles ? ` (at least ${turn.skippedLargeFiles} large ${turn.skippedLargeFiles === 1 ? 'file' : 'files'} skipped)` : ''}</span>}

      {confirmOpen && createPortal(
        <Overlay onClose={() => setConfirmOpen(false)} dataHelp={turn ? 'chat.turn-changes' : 'rightpanel.history.checkpoint'}>
          <div
            className="display-font glow-text-cyan"
            style={{ fontSize: '12px', letterSpacing: '1px', marginBottom: '12px' }}
          >
            {turn ? 'UNDO THIS TURN' : `REVERT WORKING TREE TO CHECKPOINT ${seq}`}
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
            <p data-testid="revert-preview" style={{ margin: '0 0 10px', color: preview && !preview.ok ? 'var(--color-danger)' : 'var(--color-fg)' }}>
              {preview == null ? 'Comparing the checkpoint with the folder...'
                : !preview.ok ? preview.error
                : restoreChangesNothing(preview.changes) ? `Nothing would change: the folder already matches this checkpoint (${describeRestoreChanges(preview.changes)}).`
                : <>This would change: <strong>{describeRestoreChanges(preview.changes)}</strong>.</>}
            </p>
            {preview?.ok && preview.limitation && <p data-testid="revert-scope" style={{ color: 'var(--color-fg-muted)', fontSize: '12px' }}>{preview.limitation}</p>}
            {preview?.ok && preview.changes.paths.length > 0 && (
              <ul style={{ margin: '0 0 10px', paddingLeft: '18px', fontSize: '11px', color: 'var(--color-fg-muted)', maxHeight: '120px', overflow: 'auto' }}>
                {preview.changes.paths.map((p) => <li key={p.path}>{p.change === 'changed' ? 'changed back' : p.change === 'removed' ? 'removed' : 'restored'}: {p.path}</li>)}
                {preview.changes.pathsTruncated && <li>and more</li>}
              </ul>
            )}
            {turn && <p>Changes made after this turn in the same working tree are also reverted. The safety snapshot can restore them.</p>}
            <p style={{ margin: '0 0 10px' }}>
              Only files are restored. The conversation and the task board stay as they are{inCluster ? ', and so do the other members\' conversations' : ''}; to take the conversation back, use REWIND CONVERSATION in HISTORY.
            </p>
            {inCluster && <p style={{ margin: '0 0 10px' }}>The checkpoint covers the whole project folder, so files other cluster members changed since then are reverted too.</p>}
            <p style={{ margin: 0, opacity: 0.85 }}>
              A <strong>pre-revert safety snapshot</strong> of the current tree is
              taken first, so this is reversible: you can undo the revert by
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

      {diffOpen && <DiffOverlay
        title={turn ? (undone ? 'DIFF: UNDONE TURN CHANGES' : 'DIFF: TURN CHANGES') : `DIFF: CHECKPOINT ${seq} VS NOW`}
        dataHelp={turn ? 'chat.turn-changes' : 'rightpanel.history.checkpoint'}
        onClose={() => setDiffOpen(false)} wfid={workflowId} cwd={cwd} from={ref} to={turn?.endRef ?? WORKTREE_REV}
        emptyText={turn ? 'This turn changed no file.' : 'No changes since this checkpoint.'} />}
    </div>
  );
}

function DiffOverlay({ title, onClose, wfid, cwd, from, to, emptyText, dataHelp = 'rightpanel.history.checkpoint' }: {
  title: string; onClose: () => void; wfid: string; cwd?: string; from?: string; to: string; emptyText: string; dataHelp?: string;
}) {
  return createPortal(
    <Overlay onClose={onClose} dataHelp={dataHelp} wide>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div className="display-font glow-text-cyan" style={{ fontSize: '12px', letterSpacing: '1px' }}>{title}</div>
        <ActionBtn onClick={onClose}>CLOSE</ActionBtn>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <ChangesPanel wfid={wfid} cwd={cwd} from={from} to={to} emptyText={emptyText} />
      </div>
    </Overlay>,
    document.body,
  );
}

function Overlay({
  children,
  onClose,
  wide,
  dataHelp,
}: {
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  dataHelp?: string;
}) {
  const surface = useRef<HTMLDivElement>(null);
  return (
    <div
      data-help={dataHelp}
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
          ...(wide ? contentSurfaceSize : confirmationSurfaceSize),
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border-bright)',
          borderRadius: '6px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          padding: '18px',
        }}
      >
        <WorkSurfaceControls surface={surface} storageKey={wide ? 'checkpoint-viewer' : 'checkpoint-confirm'} />
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

import { useEffect, useMemo, useRef, useState } from 'react';
import { createTwoFilesPatch } from 'diff';
import { DialogShell } from './DialogShell';
import { DiffView } from './diff/DiffView';
import { useMdTuneupStore, type MdTuneupEditor } from '../stores/mdTuneupStore';
import { useAppStore } from '../stores/appStore';

// Agent-instruction-file tune-up review modal — see shared/src/protocol/mdTuneup.ts.
//
// Two phases:
//   1. SELECT — on open we ask the server which instruction files exist
//      (CLAUDE.md / CLAUDE.local.md / AGENTS.md, root + nested) and
//      show a checklist. The file the tab's provider reads is pre-checked.
//   2. REVIEW — the operator's picks become a queue; each file is tuned in turn
//      by a READ-ONLY worker that PROPOSES a compacted version. We show the
//      agent's NOTES + an A3 diff with ACCEPT / REJECT, then advance to the next
//      file. ACCEPT fires md_tuneup_accept (server backs up the original, then
//      writes); REJECT skips without touching disk.
//
// FENCE: the agent only proposes text. Nothing is written until the operator
// clicks ACCEPT, and even then the server backs up first → reversible.

interface Props {
  workflowId: string;
  editor: MdTuneupEditor;
  onClose: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function pct(originalBytes?: number, proposedBytes?: number): string {
  if (!originalBytes || proposedBytes === undefined) return '';
  const delta = originalBytes - proposedBytes;
  if (delta <= 0) return '';
  return ` (−${Math.round((delta / originalBytes) * 100)}%)`;
}

export function MdTuneupDialog({ workflowId, editor, onClose }: Props) {
  const entry = useMdTuneupStore((s) => s.byWorkflow[workflowId]);
  const cand = useMdTuneupStore((s) => s.candidatesByWorkflow[workflowId]);
  const requestCandidates = useMdTuneupStore((s) => s.requestCandidates);
  const dispatch = useMdTuneupStore((s) => s.dispatch);
  const accept = useMdTuneupStore((s) => s.accept);
  const undo = useMdTuneupStore((s) => s.undo);
  const clearUndoConflict = useMdTuneupStore((s) => s.clearUndoConflict);
  const clear = useMdTuneupStore((s) => s.clear);
  const cwd = useAppStore((s) => s.jobs[workflowId]?.config.workingDirectory ?? '');

  // null = still selecting; array = committed queue of repo-relative paths.
  const [queue, setQueue] = useState<string[] | null>(null);
  const [qIndex, setQIndex] = useState(0);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<{ path: string; text?: string; error?: string } | null>(null);
  const previewGeneration = useRef(0);

  const viewFile = async (filePath: string) => {
    const generation = ++previewGeneration.current;
    if (preview?.path === filePath) { setPreview(null); return; }
    setPreview({ path: filePath });
    const params = new URLSearchParams({ cwd, workflowId, path: filePath });
    try {
      const response = await fetch(`/api/file-content?${params.toString()}`);
      const result = await response.json() as { type?: string; content?: string; error?: string };
      if (!response.ok || result.type !== 'text' || typeof result.content !== 'string') throw new Error(result.error || 'This file cannot be previewed as text.');
      if (previewGeneration.current === generation) setPreview({ path: filePath, text: result.content });
    } catch (error) {
      if (previewGeneration.current === generation) setPreview({ path: filePath, error: error instanceof Error ? error.message : String(error) });
    }
  };

  // Ask the server for candidates once on open.
  useEffect(() => { requestCandidates(workflowId); }, [workflowId, requestCandidates]);

  // Pre-check the provider's default file once candidates land.
  useEffect(() => {
    if (cand?.loaded && Object.keys(checked).length === 0 && cand.candidates.length > 0) {
      const seed: Record<string, boolean> = {};
      for (const c of cand.candidates) seed[c.path] = c.path === cand.defaultPath;
      // If the provider default isn't present, pre-check the first candidate.
      if (!cand.defaultPath) seed[cand.candidates[0].path] = true;
      setChecked(seed);
    }
  }, [cand?.loaded, cand?.candidates, cand?.defaultPath, checked]);

  const patch = useMemo(() => {
    if (!entry?.original && !entry?.proposed) return '';
    const name = entry?.baseName ?? 'CLAUDE.md';
    return createTwoFilesPatch(name, name, entry?.original ?? '', entry?.proposed ?? '', 'current', 'tuned-up');
  }, [entry?.original, entry?.proposed, entry?.baseName]);

  const dismiss = () => { clear(workflowId); onClose(); };

  // Move to the next queued file, or close when the queue is exhausted.
  const advance = () => {
    if (!queue) { dismiss(); return; }
    clear(workflowId);
    const next = qIndex + 1;
    if (next < queue.length) { setQIndex(next); dispatch(workflowId, editor, queue[next]); }
    else { onClose(); }
  };

  const startQueue = () => {
    const picks = (cand?.candidates ?? []).map((c) => c.path).filter((p) => checked[p]);
    if (picks.length === 0) return;
    setQueue(picks);
    setQIndex(0);
    dispatch(workflowId, editor, picks[0]);
  };

  const inReview = queue !== null;
  const more = queue !== null && qIndex < queue.length - 1;
  const title = inReview
    ? `✦ TUNE UP ${entry?.baseName ?? (queue ? queue[qIndex].split('/').pop() : 'CLAUDE.md')}`
    : '✦ TUNE UP AGENT FILES';

  const actions = !inReview
    ? (cand?.loaded && cand.candidates.length === 0 ? (
      <>                  <button className="display-font" onClick={dismiss} style={btnStyle('var(--color-border-hairline)', 'var(--color-fg-muted)')}>CLOSE</button>
                </>
    ) : cand?.loaded ? (
      <>                  <button className="display-font" onClick={dismiss} style={btnStyle('var(--color-border-hairline)', 'var(--color-fg-muted)')}>CANCEL</button>
                  <button
                    className="display-font"
                    onClick={startQueue}
                    disabled={Object.values(checked).every((v) => !v)}
                    style={btnStyle('var(--color-accent-primary)', 'var(--color-accent-primary)')}
                  >
                    TUNE SELECTED ({Object.values(checked).filter(Boolean).length})
                  </button>
                </>
    ) : null)
    : entry?.status === 'error' ? (
      <>              <button className="display-font" onClick={more ? advance : dismiss} style={btnStyle('var(--color-border-hairline)', 'var(--color-fg-muted)')}>{more ? 'SKIP → NEXT' : 'CLOSE'}</button>
            </>
    ) : entry?.status === 'applied' ? (
      <>              {entry.undoConflictHash ? <>
                <button className="display-font" onClick={() => clearUndoConflict(workflowId)} style={btnStyle('var(--color-border-hairline)', 'var(--color-fg-muted)')}>KEEP CURRENT</button>
                <button className="display-font" onClick={() => undo(workflowId, true)} style={btnStyle('var(--color-warning)', 'var(--color-warning)')}>CONFIRM UNDO</button>
              </> : entry.undoId && <button className="display-font" onClick={() => undo(workflowId)} style={btnStyle('var(--color-warning)', 'var(--color-warning)')}>UNDO</button>}
              <button className="display-font" onClick={more ? advance : dismiss} style={btnStyle('var(--color-accent-primary)', 'var(--color-accent-primary)')}>{more ? `NEXT: ${queue[qIndex + 1].split('/').pop()} →` : 'DONE'}</button>
            </>
    ) : entry?.status === 'undone' ? (
      <><button className="display-font" onClick={more ? advance : dismiss} style={btnStyle('var(--color-accent-primary)', 'var(--color-accent-primary)')}>{more ? `NEXT: ${queue[qIndex + 1].split('/').pop()} →` : 'DONE'}</button></>
    ) : entry?.status === 'proposed' ? (
      <>              <button className="display-font" onClick={more ? advance : dismiss} style={btnStyle('var(--color-border-hairline)', 'var(--color-fg-muted)')}>{more ? 'REJECT → NEXT' : 'REJECT'}</button>
              <button className="display-font" onClick={() => accept(workflowId)} style={btnStyle('var(--color-accent-primary)', 'var(--color-accent-primary)')}>ACCEPT &amp; BACK UP</button>
            </>
    ) : null;

  return (
    <DialogShell
      size="viewer"
      title={inReview && queue.length > 1 ? `${title} - file ${qIndex + 1} of ${queue.length}` : title}
      dataHelp="composer.tuneup"
      onClose={dismiss}
      closeOnBackdrop
      width={900}
      zIndex={1000}
      actions={actions}
    >
        {/* ── SELECT PHASE ── */}
        {!inReview && (
          <>
            {!cand?.loaded && (
              <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)' }}>Scanning the project for agent-instruction files…</div>
            )}
            {cand?.loaded && cand.candidates.length === 0 && (
              <>
                <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
                  No CLAUDE.md / CLAUDE.local.md / AGENTS.md found in this project. Nothing to tune up.
                </div>
              </>
            )}
            {cand?.loaded && !!cand.skippedLinks?.length && (
              <div style={{ fontSize: '11px', color: 'var(--color-warning)', lineHeight: 1.5 }}>
                Skipped linked instruction files:
                {cand.skippedLinks.map((link) => <div key={link.path}>{link.path}: {link.reason}</div>)}
              </div>
            )}
            {cand?.loaded && cand.candidates.length > 0 && (
              <>
                <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', lineHeight: 1.4 }}>
                  Pick the instruction files to compact. Each is reviewed as a diff before anything is written; the original is backed up first.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: 'calc(46vh / var(--ui-scale, 1))', overflow: 'auto', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', padding: '8px' }}>
                  {cand.candidates.map((c) => (
                    <div key={c.path} style={{ padding: '3px 4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', minWidth: 0, overflowWrap: 'anywhere', fontSize: '12px', color: 'var(--color-fg)', cursor: 'pointer', flex: 1 }}>
                      <input
                        type="checkbox"
                        checked={!!checked[c.path]}
                        onChange={(e) => setChecked((prev) => ({ ...prev, [c.path]: e.target.checked }))}
                      />
                      <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{c.path}</span>
                      <span style={{ color: 'var(--color-fg-muted)', fontSize: '11px' }}>{fmtBytes(c.bytes)}</span>
                      <span style={{ color: 'var(--color-fg-muted)', fontSize: '11px' }}>{c.lines === undefined ? 'lines unavailable' : `${c.lines} lines`}{c.approximateTokens === undefined ? '' : `, ~${c.approximateTokens} tokens`}</span>
                      {c.path === cand.defaultPath && (
                        <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-accent-secondary-dim)' }}>THIS TAB</span>
                      )}
                    </label>
                    <button type="button" className="display-font" onClick={() => void viewFile(c.path)} style={btnStyle('var(--color-border-hairline)', 'var(--color-fg-muted)')}>{preview?.path === c.path ? 'HIDE' : 'VIEW'}</button>
                    </div>
                    {!!c.alsoReadAs?.length && <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', paddingLeft: '24px' }}>Also read as {c.alsoReadAs.join(', ')}</div>}
                    {c.hints?.map((hint) => <div key={hint} style={{ fontSize: '11px', color: 'var(--color-warning)', paddingLeft: '24px' }}>{hint}</div>)}
                    {preview?.path === c.path && !!c.alsoReadAs?.length && <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)' }}>Also read as {c.alsoReadAs.join(', ')}</div>}
                    {preview?.path === c.path && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 'calc(24vh / var(--ui-scale, 1))', overflowY: 'auto' }}>{preview.error ?? preview.text ?? 'Loading...'}</pre>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* ── REVIEW PHASE ── */}
        {inReview && (!entry || entry.status === 'pending') && (
          <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
            Reading <strong style={{ color: 'var(--color-fg)' }}>{queue[qIndex]}</strong> and proposing a compacted version… (read-only: nothing is written yet)
          </div>
        )}

        {inReview && entry?.status === 'applying' && (
          <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>Backing up the original and writing the tuned-up file…</div>
        )}

        {inReview && entry?.status === 'undoing' && (
          <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)' }}>Checking and restoring the backup...</div>
        )}

        {inReview && entry?.status === 'error' && (
          <>
            <div style={{ fontSize: '12px', color: 'var(--color-warning)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{entry.error ?? 'Tune-up failed.'}</div>
          </>
        )}

        {inReview && entry?.status === 'applied' && (
          <>
            <div style={{ fontSize: '12px', color: 'var(--color-fg)', lineHeight: 1.5 }}>
              ✓ <strong>{entry.baseName}</strong> tuned up{pct(entry.originalBytes, entry.proposedBytes)}.
            </div>
            {entry.backupPath && (
              <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.5, wordBreak: 'break-all' }}>
                Original backed up to <code style={{ color: 'var(--color-accent-secondary-dim)' }}>{entry.backupPath}</code>.
              </div>
            )}
            {entry.undoError && <div role="alert" style={{ color: 'var(--color-warning)', fontSize: '11px' }}>{entry.undoError}</div>}
            {entry.undoConflictHash && <div role="alert" style={{ color: 'var(--color-warning)', fontSize: '11px' }}>The file changed after ACCEPT. Confirm to replace the current text with the saved original. Arco backs up the current text first and checks it again.</div>}
          </>
        )}

        {inReview && entry?.status === 'undone' && <>
          <div style={{ fontSize: '12px', color: 'var(--color-fg)' }}>Original instruction file restored.</div>
          {entry.safetyBackupPath && <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', wordBreak: 'break-all' }}>The replaced text was backed up to <code>{entry.safetyBackupPath}</code>.</div>}
        </>}

        {inReview && entry?.status === 'proposed' && (
          <>
            <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px' }}>
              {entry.originalBytes ?? 0} → {entry.proposedBytes ?? 0} bytes{pct(entry.originalBytes, entry.proposedBytes)} · review the diff before accepting
            </div>
            {entry.notes && entry.notes.trim() && (
              <div style={{
                fontSize: '12px', color: 'var(--color-fg)', lineHeight: 1.5, whiteSpace: 'pre-wrap',
                background: 'var(--color-bg-elevated, rgba(255,255,255,0.03))', border: '1px solid var(--color-border-hairline)',
                borderRadius: '4px', padding: '10px 12px', maxHeight: 'calc(22vh / var(--ui-scale, 1))', overflow: 'auto',
              }}>
                <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-accent-secondary-dim)', marginBottom: '6px' }}>WHAT CHANGED</div>
                {entry.notes.trim()}
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--color-border-hairline)', borderRadius: '4px' }}>
              <DiffView patch={patch} defaultViewType="split" emptyText="No changes proposed: the file is already tight." />
            </div>
          </>
        )}
    </DialogShell>
  );
}

function btnStyle(border: string, color: string): React.CSSProperties {
  return {
    padding: '5px 12px', background: 'transparent', border: `1px solid ${border}`, borderRadius: '3px',
    color, cursor: 'pointer', fontSize: '11px', letterSpacing: '1px', whiteSpace: 'nowrap',
  };
}

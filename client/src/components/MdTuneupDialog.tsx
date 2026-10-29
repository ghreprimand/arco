import { useEffect, useMemo, useState } from 'react';
import { createTwoFilesPatch } from 'diff';
import { DiffView } from './diff/DiffView';
import { useMdTuneupStore, type MdTuneupEditor } from '../stores/mdTuneupStore';

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
  const clear = useMdTuneupStore((s) => s.clear);

  // null = still selecting; array = committed queue of repo-relative paths.
  const [queue, setQueue] = useState<string[] | null>(null);
  const [qIndex, setQIndex] = useState(0);
  const [checked, setChecked] = useState<Record<string, boolean>>({});

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

  return (
    <div
      onClick={dismiss}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(900px, calc(94vw / var(--ui-scale, 1)))', maxHeight: 'calc(88vh / var(--ui-scale, 1))', background: 'var(--color-bg)', border: '1px solid var(--color-border-bright)',
          borderRadius: '6px', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '12px', overflow: 'hidden',
        }}
      >
        <div className="display-font glow-text-bright" style={{ fontSize: '13px', letterSpacing: '2px', color: 'var(--color-accent-primary)' }}>
          {title}
          {inReview && queue.length > 1 && (
            <span style={{ marginLeft: '10px', fontSize: '10px', color: 'var(--color-fg-muted)', letterSpacing: '1px' }}>
              FILE {qIndex + 1} OF {queue.length}
            </span>
          )}
        </div>

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
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="display-font" onClick={dismiss} style={btnStyle('var(--color-border-hairline)', 'var(--color-fg-muted)')}>CLOSE</button>
                </div>
              </>
            )}
            {cand?.loaded && cand.candidates.length > 0 && (
              <>
                <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', lineHeight: 1.4 }}>
                  Pick the instruction files to compact. Each is reviewed as a diff before anything is written; the original is backed up first.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: 'calc(46vh / var(--ui-scale, 1))', overflow: 'auto', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', padding: '8px' }}>
                  {cand.candidates.map((c) => (
                    <label key={c.path} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--color-fg)', cursor: 'pointer', padding: '3px 4px' }}>
                      <input
                        type="checkbox"
                        checked={!!checked[c.path]}
                        onChange={(e) => setChecked((prev) => ({ ...prev, [c.path]: e.target.checked }))}
                      />
                      <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{c.path}</span>
                      <span style={{ color: 'var(--color-fg-muted)', fontSize: '11px' }}>{fmtBytes(c.bytes)}</span>
                      {c.path === cand.defaultPath && (
                        <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-accent-secondary-dim)' }}>THIS TAB</span>
                      )}
                    </label>
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                  <button className="display-font" onClick={dismiss} style={btnStyle('var(--color-border-hairline)', 'var(--color-fg-muted)')}>CANCEL</button>
                  <button
                    className="display-font"
                    onClick={startQueue}
                    disabled={Object.values(checked).every((v) => !v)}
                    style={btnStyle('var(--color-accent-primary)', 'var(--color-accent-primary)')}
                  >
                    TUNE SELECTED ({Object.values(checked).filter(Boolean).length})
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {/* ── REVIEW PHASE ── */}
        {inReview && (!entry || entry.status === 'pending') && (
          <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
            Reading <strong style={{ color: 'var(--color-fg)' }}>{queue[qIndex]}</strong> and proposing a compacted version… (read-only — nothing is written yet)
          </div>
        )}

        {inReview && entry?.status === 'applying' && (
          <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>Backing up the original and writing the tuned-up file…</div>
        )}

        {inReview && entry?.status === 'error' && (
          <>
            <div style={{ fontSize: '12px', color: 'var(--color-warning)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{entry.error ?? 'Tune-up failed.'}</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="display-font" onClick={more ? advance : dismiss} style={btnStyle('var(--color-border-hairline)', 'var(--color-fg-muted)')}>{more ? 'SKIP → NEXT' : 'CLOSE'}</button>
            </div>
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
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="display-font" onClick={more ? advance : dismiss} style={btnStyle('var(--color-accent-primary)', 'var(--color-accent-primary)')}>{more ? `NEXT: ${queue[qIndex + 1].split('/').pop()} →` : 'DONE'}</button>
            </div>
          </>
        )}

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
              <DiffView patch={patch} defaultViewType="split" emptyText="No changes proposed — the file is already tight." />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button className="display-font" onClick={more ? advance : dismiss} style={btnStyle('var(--color-border-hairline)', 'var(--color-fg-muted)')}>{more ? 'REJECT → NEXT' : 'REJECT'}</button>
              <button className="display-font" onClick={() => accept(workflowId)} style={btnStyle('var(--color-accent-primary)', 'var(--color-accent-primary)')}>ACCEPT &amp; BACK UP</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function btnStyle(border: string, color: string): React.CSSProperties {
  return {
    padding: '5px 12px', background: 'transparent', border: `1px solid ${border}`, borderRadius: '3px',
    color, cursor: 'pointer', fontSize: '11px', letterSpacing: '1px', whiteSpace: 'nowrap',
  };
}

// GOAL_NORTHSTAR_PLAN.md G3 — an always-visible, inline-editable strip directly
// above the composer for this tab's standing north-star. The operator sets and
// sees the objective here without opening CONFIG: click the strip (empty or set)
// to edit in place, Enter to save, Esc to cancel. Empty ⇒ a muted "set a
// north-star…" affordance so the feature is discoverable rather than invisible.
// Writes go through the same onUpdatePrimary({ goal }) dispatch as the CONFIG
// field and the /goal command; the server caps to 2048 B and echoes the stored
// value back via goal_set, which re-syncs `saved` here.
import { useEffect, useRef, useState } from 'react';
import type { JobState } from '../stores/appStore';

// Mirror the server cap (goalBlock.ts GOAL_MAX_BYTES) + the CONFIG field's soft
// warn, so inline edits get the same feedback before the server trims on save.
const GOAL_MAX_BYTES = 2048;
const GOAL_SOFT_WARN_BYTES = 1536;

export function NorthStarBar({
  job,
  onUpdatePrimary,
}: {
  job: JobState;
  onUpdatePrimary?: (update: { goal?: string; goalRun?: { enabled: boolean; total?: number } }) => void;
}) {
  const saved = job.config.goal?.trim() ?? '';
  const run = job.config.goalRun;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(saved);
  const inputRef = useRef<HTMLInputElement>(null);
  const canEdit = Boolean(onUpdatePrimary);

  // Reflect external changes (rehydrate, the /goal command, another observer's
  // goal_set, a server-side cap/clear) into the draft — but never yank the text
  // out from under an active edit.
  useEffect(() => { if (!editing) setDraft(saved); }, [saved, editing]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const commit = () => {
    const next = draft.trim();
    if (next !== saved) onUpdatePrimary?.({ goal: next }); // '' clears
    setEditing(false);
  };
  const cancel = () => { setDraft(saved); setEditing(false); };

  const byteLen = editing ? new TextEncoder().encode(draft).length : 0;
  const overCap = byteLen > GOAL_MAX_BYTES;
  const nearCap = byteLen > GOAL_SOFT_WARN_BYTES;

  return (
    <div
      data-help="composer.north-star"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '3px 12px',
        borderTop: '1px solid var(--color-border-hairline)',
        fontSize: '11px',
        lineHeight: 1.4,
        color: 'var(--color-fg-muted)',
        minWidth: 0,
      }}
    >
      <span
        className="display-font"
        style={{ flexShrink: 0, fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-accent-secondary-dim)' }}
      >
        🎯 NORTH STAR
      </span>
      {editing ? (
        <>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            }}
            onBlur={cancel}
            spellCheck={false}
            placeholder="What is this whole session ultimately for?"
            style={{
              flex: 1,
              minWidth: 0,
              padding: '2px 6px',
              fontSize: '11px',
              fontFamily: 'var(--font-body)',
              color: 'var(--color-fg)',
              background: 'var(--color-bg-elevated, rgba(255,255,255,0.04))',
              border: '1px solid ' + (overCap ? 'var(--color-accent-danger, #e06c75)' : 'var(--color-border-hairline)'),
              borderRadius: '2px',
              outline: 'none',
            }}
          />
          <span style={{ flexShrink: 0, fontFamily: 'var(--font-code)', fontSize: '9px', color: overCap ? 'var(--color-accent-danger, #e06c75)' : nearCap ? 'var(--color-accent-warning, #d19a66)' : 'var(--color-fg-muted)' }}>
            {byteLen}/{GOAL_MAX_BYTES}
          </span>
          <span style={{ flexShrink: 0, opacity: 0.6, fontSize: '9px' }}>⏎ save · esc cancel</span>
        </>
      ) : (
        <button
          type="button"
          onClick={() => { if (canEdit) setEditing(true); }}
          disabled={!canEdit}
          title={
            canEdit
              ? (saved
                  ? `${saved}\n\nClick to edit. Also: /goal <text> to set, /goal clear to remove.`
                  : 'Click to set a standing objective for this tab (or type /goal <objective> in the composer).')
              : (saved || 'No north-star set')
          }
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: 'left',
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: 'var(--color-fg-muted)',
            fontSize: '11px',
            fontFamily: 'var(--font-body)',
            fontStyle: saved ? 'normal' : 'italic',
            cursor: canEdit ? 'text' : 'default',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            opacity: saved ? 0.9 : 0.5,
          }}
        >
          {saved ? saved.replace(/\s+/g, ' ') : 'set a north-star…'}
        </button>
      )}
      {/* GOAL_RUN_PLAN.md — live run chip. Present ONLY while a run is armed,
          so an unattended loop can never be running without a visible counter
          and a one-click stop sitting right above the composer. */}
      {run?.enabled && !editing && (
        <button
          type="button"
          onClick={() => onUpdatePrimary?.({ goalRun: { enabled: false } })}
          disabled={!canEdit}
          title={`Goal run: ${run.total - run.remaining}/${run.total} iterations used, ${run.remaining} left · ${formatTokens(run.tokensUsed)} spent.\n\nClick to stop (or type /goal run stop).`}
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            padding: '1px 7px',
            fontSize: '9px',
            fontFamily: 'var(--font-code)',
            letterSpacing: '0.5px',
            color: 'var(--color-accent-warning, #d19a66)',
            background: 'var(--color-bg-elevated, rgba(255,255,255,0.04))',
            border: '1px solid var(--color-accent-warning, #d19a66)',
            borderRadius: '2px',
            cursor: canEdit ? 'pointer' : 'default',
          }}
        >
          <span>▶ RUN {run.total - run.remaining}/{run.total}</span>
          <span style={{ opacity: 0.7 }}>{formatTokens(run.tokensUsed)}</span>
          <span style={{ opacity: 0.7 }}>✕</span>
        </button>
      )}
    </div>
  );
}

// Compact spend readout for the run chip — mirrors the server's notice format.
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

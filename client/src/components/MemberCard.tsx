// docs/CLIENT.md - compact ~120px card per cluster member.
//
// Read-only-with-click; no composer, no primitive bar (those live in the
// detail MemberPane). Rendered inside ClusterTab's grid; click anywhere
// → setClusterFocusedMember. Status dot derives from job.busy. The
// focused card gets a same-thickness accent outline so swapping focus
// never shifts neighbouring cards' layout (docs/PROTOCOL_CLUSTER.md
// invariant from slice 6a).

import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { turnStep } from '../utils/turnStep';
import type { JobState } from '../stores/appStore';
import { hasWaitingQuestion } from '../questions/waitingQuestion';
import { presetForText } from '@arco/shared';
import { BriefControl } from './BriefControl';

const CARD_PREVIEW_CHARS = 1200;

interface Props {
  job: JobState | undefined;
  displayName: string;
  status: 'idle' | 'busy';
  // Free-form role hint (≤120 chars) plumbed from ClusterMember.role. When
  // it matches a known preset, the card shows the preset's UPPERCASE label;
  // any other non-empty value falls back to "CUSTOM" so the chip never blows
  // out the card width. Empty / missing → no chip at all.
  role?: string;
  pendingMail?: number;
  // Click on the mail mark of an idle member with waiting mail: nudge that member.
  onNudge?: () => void;
  // Director card only: a finished reply the operator has not looked at yet.
  newReply?: boolean;
  focused: boolean;
  onClick: () => void;
  // drag-to-reorder: the ClusterTab grid wires HTML5 drag
  // handlers through here (spread on the root div) and flags the current
  // drop target for the dashed outline.
  dragProps?: HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  dragOver?: boolean;
}

function lastAssistantText(job: JobState | undefined): string | null {
  if (!job) return null;
  for (let i = job.messages.length - 1; i >= 0; i--) {
    const m = job.messages[i];
    if (m.role === 'assistant' && !m.toolUse && m.content && m.content.trim().length > 0) {
      const text = m.content.trim();
      return text.length > CARD_PREVIEW_CHARS
        ? `${text.slice(0, CARD_PREVIEW_CHARS).trimEnd()}\n[preview truncated]`
        : text;
    }
  }
  return null;
}

export function MemberCard({ job, displayName, status, role, pendingMail = 0, onNudge, newReply = false, focused, onClick, dragProps, dragOver }: Props) {
  const wfid = job?.id ?? '';
  const wfidShort = wfid.slice(0, 8);
  const busy = status === 'busy';
  const waitingQuestion = hasWaitingQuestion(job);
  const assistantPreview = lastAssistantText(job);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [busy]);
  const step = turnStep(job?.activity ?? [], job?.turnStartedAt, now);
  const bodyText = busy ? `${step.label} · ${step.time}${step.longRunning ? ' · LONG-RUNNING' : ''}` : (assistantPreview ?? '[no turns]');
  const bodyDim = !busy && assistantPreview === null;

  // Role chip label: matching preset → its short label; non-empty free-form
  // text → "CUSTOM" (avoids 120-char overflow on the card); empty → null
  // (no chip rendered).
  const trimmedRole = role?.trim() ?? '';
  const roleChipLabel = (() => {
    if (!trimmedRole) return null;
    const preset = presetForText(trimmedRole);
    return preset ? preset.label.toUpperCase() : 'CUSTOM';
  })();

  // Auto-stick to bottom: as the body grows (assistant streams tokens, or
  // activity ticks while busy), keep the latest line visible. Card is small
  // enough that "always tail" matches operator intent — no manual-scroll
  // detection. Resets to 0 on focus swap because the new card mounts fresh.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bodyText]);

  return (
    <div
      {...dragProps}
      onClick={onClick}
      className="display-font"
      role="button"
      tabIndex={0}
      data-help="cluster.member-card"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        minHeight: '120px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        cursor: 'pointer',
        background: focused ? 'var(--color-accent-primary-a06)' : 'var(--color-bg-panel)',
        border: waitingQuestion
          ? '1px solid var(--color-warning)'
          : focused ? '1px solid var(--color-accent-primary)'
          : '1px solid var(--color-border-hairline)',
        transition: 'background 0.12s',
        ...(dragOver ? { outline: '2px dashed var(--color-accent-secondary)', outlineOffset: '-2px' } : {}),
      }}
      onMouseEnter={(e) => {
        if (!focused) {
          (e.currentTarget as HTMLDivElement).style.background = 'var(--color-bg-panel-hover, var(--color-bg-panel))';
        }
      }}
      onMouseLeave={(e) => {
        if (!focused) {
          (e.currentTarget as HTMLDivElement).style.background = 'var(--color-bg-panel)';
        }
      }}
    >
      {/* Line 1 — dot · friendly name (bold) · STATUS */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', letterSpacing: '1px' }}>
        <span
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: busy ? 'var(--color-accent-primary)' : 'transparent',
            border: busy ? 'none' : '1px solid var(--color-fg-muted)',
            animation: busy ? 'pulse-glow 1.5s ease-in-out infinite' : 'none',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            color: focused ? 'var(--color-accent-primary)' : 'var(--color-fg)',
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: '0 1 auto',
            minWidth: 0,
          }}
          title={displayName}
        >
          {displayName.toUpperCase()}
        </span>
        {waitingQuestion && <span data-help="cluster.member-question" role="status" aria-label={`${displayName} has a question`} style={{ color: 'var(--color-warning)', fontSize: '9px', whiteSpace: 'nowrap' }}>? QUESTION</span>}
        {newReply && <span data-help="cluster.member-new-reply" data-testid="member-new-reply" role="status" aria-live="off" aria-label={`${displayName} has a new reply`} style={{ flexShrink: 0, color: 'var(--color-accent-primary)', border: '1px solid var(--color-accent-primary)', padding: '1px 3px', fontSize: '9px', letterSpacing: 0, whiteSpace: 'nowrap' }}>NEW REPLY</span>}
        {pendingMail > 0 && (() => {
          const noun = pendingMail === 1 ? 'message' : 'messages';
          const idle = !busy;
          const label = `${pendingMail} ${noun} waiting; delivered at this worker's next turn${idle && onNudge ? '. Click to nudge.' : ''}`;
          const style: CSSProperties = { flexShrink: 0, color: idle ? 'var(--color-warning)' : 'var(--color-fg-muted)', border: `1px solid ${idle ? 'var(--color-warning)' : 'var(--color-border-hairline)'}`, background: 'transparent', padding: '2px 8px', fontSize: '12px', fontWeight: 600, letterSpacing: 0, whiteSpace: 'nowrap', opacity: idle ? 1 : 0.7, fontFamily: 'inherit' };
          const text = `\u2709 ${pendingMail}`;
          return idle && onNudge
            ? <button type="button" data-help="cluster.member-mail" data-mail-state="idle" aria-label={label} title={label} onClick={(e) => { e.stopPropagation(); onNudge(); }} style={{ ...style, cursor: 'pointer' }}>{text}</button>
            : <span data-help="cluster.member-mail" data-mail-state={idle ? 'idle' : 'busy'} role="status" aria-live="off" aria-label={label} title={label} style={style}>{text}</span>;
        })()}
        <span style={{ marginLeft: 'auto', color: busy ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)', fontSize: '10px', flexShrink: 0 }}>
          {status.toUpperCase()}
        </span>
        {wfid && <BriefControl scope="worker" targetId={wfid} label="BRIEF" data-help="cluster.member-brief" testId="member-brief" title="A short synopsis of this member from facts Arco can see. Read-only; sends nothing." style={{ padding: '1px 5px', fontSize: '9px', flexShrink: 0 }} />}
      </div>
      {/* Line 2 — wfid prefix · role chip (when set) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', letterSpacing: '1px' }}>
        <span
          style={{
            color: 'var(--color-fg-muted)',
            fontFamily: 'var(--font-code)',
            flexShrink: 0,
          }}
        >
          {wfidShort}
        </span>
        {roleChipLabel && (
          <span
            data-help="cluster.member-card.role-chip"
            title={trimmedRole}
            style={{
              padding: '1px 6px',
              border: '1px solid var(--color-accent-secondary-a40, var(--color-accent-secondary-dim))',
              color: 'var(--color-accent-secondary)',
              letterSpacing: '1.5px',
              fontSize: '9px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '100%',
              minWidth: 0,
            }}
          >
            {roleChipLabel}
          </span>
        )}
      </div>
      <div
        ref={bodyRef}
        style={{
          flex: 1,
          minHeight: 0,
          fontFamily: 'var(--font-code)',
          fontSize: '12px',
          lineHeight: 1.4,
          color: bodyDim ? 'var(--color-fg-muted)' : 'var(--color-fg)',
          overflowY: 'auto',
          overflowX: 'hidden',
          whiteSpace: busy ? 'nowrap' : 'pre-wrap',
          textOverflow: busy ? 'ellipsis' : undefined,
          wordBreak: 'break-word',
          fontStyle: busy ? 'italic' : 'normal',
        }}
      >
        {busy ? <span style={{ display: 'flex', gap: '4px', minWidth: 0 }}><span title={step.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{step.label}</span><span style={{ flexShrink: 0 }}>· {step.time}{step.longRunning ? ' · LONG-RUNNING' : ''}</span></span> : bodyText}
      </div>
    </div>
  );
}

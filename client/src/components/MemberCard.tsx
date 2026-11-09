// docs/CLIENT.md - compact ~120px card per cluster member.
//
// Read-only-with-click; no composer, no primitive bar (those live in the
// detail MemberPane). Rendered inside ClusterTab's grid; click anywhere
// → setClusterFocusedMember. Status dot derives from job.busy. The
// focused card gets a same-thickness accent outline so swapping focus
// never shifts neighbouring cards' layout (docs/PROTOCOL_CLUSTER.md
// invariant from slice 6a).

import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { settledCardItem } from '../utils/activityPresentation';
import type { JobState } from '../stores/appStore';
import { hasWaitingQuestion } from '../questions/waitingQuestion';
import { presetForText } from '@arco/shared';
import { BriefControl } from './BriefControl';

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
  // The member was nudged and has not started its turn yet.
  nudged?: boolean;
  // Director card only: a finished reply the operator has not looked at yet.
  newReply?: boolean;
  focused: boolean;
  onClick: () => void;
  // drag-to-reorder: the ClusterTab grid wires HTML5 drag
  // handlers through here (spread on the root div) and flags the current
  // drop target for the dashed outline.
  dragProps?: HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  dragOver?: boolean;
  // Window-size layout (client/src/layout/layoutRange.ts). standard: the
  // original card, at least 120 px tall, filling its grid cell. compact
  // (the compact layout and narrow member list): one row with the id in the
  // tooltip and a
  // one-line reply.
  density?: 'standard' | 'compact';
}

function useSettledPreview(job: JobState | undefined): string {
  const candidate = settledCardItem(job);
  const [shown, setShown] = useState(() => candidate?.text ?? '[no turns]');
  const lastUpdate = useRef(Date.now());
  const latestAt = useRef(candidate?.at ?? 0);
  useEffect(() => {
    if (!candidate || candidate.at < latestAt.current) return;
    if (candidate.text === shown) { latestAt.current = candidate.at; return; }
    const delay = Math.max(0, 1000 - (Date.now() - lastUpdate.current));
    const timer = setTimeout(() => { lastUpdate.current = Date.now(); latestAt.current = candidate.at; setShown(candidate.text); }, delay);
    return () => clearTimeout(timer);
  }, [candidate?.at, candidate?.text, shown]);
  return shown;
}

export function MemberCard({ job, displayName, status, role, pendingMail = 0, onNudge, nudged = false, newReply = false, focused, onClick, dragProps, dragOver, density = 'standard' }: Props) {
  const clamp = density === 'compact' ? 1 : 0;
  const wfid = job?.id ?? '';
  const wfidShort = wfid.slice(0, 8);
  const busy = status === 'busy';
  const waitingQuestion = hasWaitingQuestion(job);
  const bodyText = useSettledPreview(job);
  const bodyDim = bodyText === '[no turns]';

  // Role chip label: matching preset → its short label; non-empty free-form
  // text → "CUSTOM" (avoids 120-char overflow on the card); empty → null
  // (no chip rendered).
  const trimmedRole = role?.trim() ?? '';
  const roleChipLabel = (() => {
    if (!trimmedRole) return null;
    const preset = presetForText(trimmedRole);
    return preset ? preset.label.toUpperCase() : 'CUSTOM';
  })();

  // Auto-stick to bottom when the settled summary changes. Card is small
  // enough that "always tail" matches operator intent — no manual-scroll
  // detection. Resets to 0 on focus swap because the new card mounts fresh.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && !clamp) el.scrollTop = el.scrollHeight;
  }, [bodyText, clamp]);

  return (
    <div
      {...dragProps}
      onClick={onClick}
      className="display-font"
      role="button"
      tabIndex={0}
      data-help="cluster.member-card"
      data-density={density}
      title={density === 'compact' && wfidShort ? `${displayName} · ${wfidShort}${trimmedRole ? ` · ${trimmedRole}` : ''}` : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        minHeight: density === 'standard' ? '120px' : 0,
        padding: density === 'compact' ? '6px 10px' : '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: density === 'compact' ? '3px' : '6px',
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
          if (idle && nudged) return <span data-help="cluster.member-mail" data-mail-state="nudged" role="status" aria-label={`${displayName} was nudged and will start its turn shortly`} title="Nudged: this member should start its turn shortly and read its mail." style={{ ...style, color: 'var(--color-accent-secondary)', borderColor: 'var(--color-accent-secondary)' }}>Nudged</span>;
          return idle && onNudge
            ? <button type="button" data-help="cluster.member-mail" data-mail-state="idle" aria-label={label} title={label} onClick={(e) => { e.stopPropagation(); onNudge(); }} style={{ ...style, cursor: 'pointer' }}>{text}</button>
            : <span data-help="cluster.member-mail" data-mail-state={idle ? 'idle' : 'busy'} role="status" aria-live="off" aria-label={label} title={label} style={style}>{text}</span>;
        })()}
        {density === 'compact' && roleChipLabel && <span data-help="cluster.member-card.role-chip" title={trimmedRole} style={{ padding: '0 4px', border: '1px solid var(--color-accent-secondary-a40, var(--color-accent-secondary-dim))', color: 'var(--color-accent-secondary)', fontSize: '9px', letterSpacing: '1px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: '0 1 auto' }}>{roleChipLabel}</span>}
        <span style={{ marginLeft: 'auto', color: busy ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)', fontSize: '10px', flexShrink: 0 }}>
          {status === 'busy' ? 'WORKING' : 'IDLE'}
        </span>
        {wfid && <BriefControl scope="worker" targetId={wfid} label="BRIEF" data-help="cluster.member-brief" testId="member-brief" title="A short synopsis of this member from facts Arco can see. Read-only; sends nothing." style={{ padding: '1px 5px', fontSize: '9px', flexShrink: 0 }} />}
      </div>
      {/* Line 2 — wfid prefix · role chip (when set). Folded into the
          tooltip and line 1 in the compact density. */}
      {density !== 'compact' && <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', letterSpacing: '1px' }}>
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
      </div>}
      <div
        ref={bodyRef}
        style={{
          flex: 1,
          minHeight: 0,
          fontFamily: 'var(--font-code)',
          fontSize: '12px',
          lineHeight: 1.4,
          color: bodyDim ? 'var(--color-fg-muted)' : 'var(--color-fg)',
          overflowY: clamp ? 'hidden' : 'auto',
          overflowX: 'hidden',
          whiteSpace: density === 'compact' ? 'nowrap' : 'pre-wrap',
          ...(clamp ? { display: '-webkit-box', WebkitBoxOrient: 'vertical' as const, WebkitLineClamp: clamp, flex: '0 0 auto' } : {}),
          textOverflow: clamp ? 'ellipsis' : undefined,
          wordBreak: 'break-word',
          fontStyle: 'normal',
        }}
      >
        {bodyText}
      </div>
    </div>
  );
}

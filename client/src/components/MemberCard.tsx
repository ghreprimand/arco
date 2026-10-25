// CLUSTER_GRID_PLAN.md §3 — compact ~120px card per cluster member.
//
// Read-only-with-click; no composer, no primitive bar (those live in the
// detail MemberPane). Rendered inside ClusterTab's grid; click anywhere
// → setClusterFocusedMember. Status dot derives from job.busy. The
// focused card gets a same-thickness accent outline so swapping focus
// never shifts neighbouring cards' layout (CLUSTER_MODE_PLAN.md §13
// invariant from slice 6a).

import { useEffect, useRef, type HTMLAttributes } from 'react';
import type { JobState } from '../stores/appStore';
import { presetForText } from '@arco/shared';

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
  focused: boolean;
  onClick: () => void;
  // 2026-07-17 — drag-to-reorder: the ClusterTab grid wires HTML5 drag
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

function activitySummary(job: JobState | undefined): string {
  const acts = job?.activity ?? [];
  for (let i = acts.length - 1; i >= 0; i--) {
    const a = acts[i];
    if (a.kind === 'tool_use' && a.tool) return `tool: ${a.tool}`;
    if (a.kind === 'thinking') return 'thinking…';
  }
  return 'running…';
}

export function MemberCard({ job, displayName, status, role, focused, onClick, dragProps, dragOver }: Props) {
  const wfid = job?.id ?? '';
  const wfidShort = wfid.slice(0, 8);
  const busy = status === 'busy';
  const assistantPreview = lastAssistantText(job);
  const bodyText = busy ? activitySummary(job) : (assistantPreview ?? '[no turns]');
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
        border: focused
          ? '1px solid var(--color-accent-primary)'
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
            flex: 1,
            minWidth: 0,
          }}
          title={displayName}
        >
          {displayName.toUpperCase()}
        </span>
        <span style={{ color: busy ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)', fontSize: '10px', flexShrink: 0 }}>
          {status.toUpperCase()}
        </span>
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
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontStyle: busy ? 'italic' : 'normal',
        }}
      >
        {bodyText}
      </div>
    </div>
  );
}

// CLUSTER_MODE_PLAN.md Phase 5 — unified cluster-scoped event feed,
// extended (2026-05-11) with per-member tool activity so an operator can
// see READ / BASH / TodoWrite etc. without drilling into each member tab.
//
// Sources:
//   - peer-sent / peer-received chat rows on each member's messages[]
//     (peer_message_sent / peer_message_received translate to these via
//     useWebSocket).
//   - cluster_member_added / removed / role_set events: derived from the
//     incoming cluster_state diffs (best-effort — we don't keep a server-
//     side audit log for membership today).
//   - cluster_plan_changed: same derivation from cluster.plan.updatedAt.
//   - cluster_member_nudged: surfaced via NotificationToasts + appears here.
//   - per-member tool_use / thinking activity sourced from each member's
//     job.activity[] (already populated by primary_tool_use /
//     primary_thinking WS handlers — REUSE that path; no parallel sub).
//
// Pill row at top: [ ALL · MEMBER1 · MEMBER2 · … ]. ALL interleaves
// everything; single-member mode shows only that member's tool activity
// plus cluster events that involve them (peer-sent FROM, peer-received TO,
// role-set ON, member-nudged ON). Cluster-wide events like plan-changed,
// member-added/removed only appear in ALL mode.
//
// Oldest first, newest at bottom (2026-05-11) — the unified feed sits
// next to the chat panel and operators read it as chat-shaped, so newest-
// at-bottom matches their expectation. Auto-scroll snaps to scrollHeight
// when the row count grows AND the operator was near-bottom (mirrors the
// MemberCard auto-scroll pattern). Burst-mitigation: per-member colour-
// tagged leading chip (hash-of-wfid → palette index), and runs of ≥3
// identical tools from one member within 30s collapse into a `READ × N`
// row that click-expands. Pure client-side aggregator; the events already
// flow through workflow + cluster broadcast channels.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, type ActivityEntry } from '../stores/appStore';
import type { ClusterStatePayload, ClusterMember } from '@archon/shared';
import { presetForText } from '@archon/shared';
import { coalesceThinkingRuns } from './clusterActivity.helpers';

type ActivityKind =
  | 'peer-sent'
  | 'peer-received'
  | 'plan-changed'
  | 'member-added'
  | 'member-removed'
  | 'role-set'
  | 'member-nudged'
  | 'tool-use'
  | 'thinking';

// Cluster-scoped vs per-member rows. Cluster-wide kinds (plan-changed,
// member-added, member-removed) suppress in single-member mode; the rest
// either originate from or target a specific member and survive filtering.
const CLUSTER_WIDE_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
  'plan-changed',
  'member-added',
  'member-removed',
]);

interface ActivityItem {
  id: string;
  ts: number;
  kind: ActivityKind;
  label: string;          // leading chip text (member name for tool-use, original label for cluster events)
  summary: string;
  // Member this row is attached to (for filtering + colour tagging).
  // Cluster-wide rows (plan-changed) leave this undefined.
  memberId?: string;
  // For tool-use rows only — used by the compact-runs collapser.
  tool?: string;
  // Free-form role at the time of rendering (for the role chip). Pulled
  // fresh from cluster.members on each render via the memberById map; the
  // item itself doesn't need to carry it.

  // When the row originated from a sub-worker (Review / Task / Spawn-from-
  // here) rather than the member's primary turn, this carries a short tag
  // (the worker's task description, truncated) so the operator can tell
  // which sub-process produced it. Absent on rows from `job.activity[]`.
  subWorker?: string;
}

// Per-member colour palette. Six muted accents — small enough to remain
// glanceable, big enough to disambiguate 4–6 members at once. Hash-of-
// wfid-character-sum mod palette length so the same member lands on the
// same colour across sessions (stable; survives reload).
const MEMBER_PALETTE: ReadonlyArray<string> = [
  '#7aa2f7', // blue
  '#9ece6a', // green
  '#e0af68', // amber
  '#bb9af7', // violet
  '#f7768e', // red
  '#7dcfff', // cyan
];

function memberColour(wfid: string): string {
  let sum = 0;
  for (let i = 0; i < wfid.length; i++) sum += wfid.charCodeAt(i);
  return MEMBER_PALETTE[sum % MEMBER_PALETTE.length] ?? MEMBER_PALETTE[0]!;
}

// Compact-runs window — 30 s, ≥3 identical (memberId, tool) rows in a
// row collapse to one. We walk the sorted-ascending feed and group from
// the oldest forward; the rendered "× N" sits on the most recent row of
// the burst (the lead of the visual block, since newer-at-bottom means
// the last row of the burst is what the operator sees most prominently).
// The compact-row's `primary` therefore points to the LAST item in the
// run (the newest), and `hiddenItems` contains the older ones.
const COMPACT_WINDOW_MS = 30_000;
const COMPACT_MIN_RUN = 3;

interface CompactedRow {
  primary: ActivityItem;
  // 0 when this is a singleton; >0 when ≥3 identical rows collapsed.
  collapsedCount: number;
  hiddenItems: ActivityItem[];
}

export function ClusterActivityTab({ cluster }: { cluster: ClusterStatePayload }) {
  const memberJobs = useAppStore(useShallow((s) =>
    cluster.members.map((m) => s.jobs[m.workflowId]),
  ));

  // Phase 5 — capture derived membership / role / plan / nudge events as
  // they arrive. The store doesn't keep a cluster-scoped audit log, so we
  // diff cluster_state against the previous snapshot here.
  const [audit, setAudit] = useState<ActivityItem[]>([]);
  const prevCluster = useRef<ClusterStatePayload | null>(null);

  // Pill row state — which member's lane is selected. `'all'` is the
  // default and never goes away. Specific selections survive until the
  // operator clicks another pill or the member is removed (in which case
  // we fall back to 'all' so the body isn't an empty screen).
  const [selected, setSelected] = useState<string>('all');
  useEffect(() => {
    if (selected === 'all') return;
    if (!cluster.members.some((m) => m.workflowId === selected)) setSelected('all');
  }, [cluster.members, selected]);

  // Expand state for compact-runs rows. Keyed by the lead item's id.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Auto-scroll-to-bottom on new items. Feed is sorted oldest-first so
  // "most recent" lives at scrollHeight. We snap to the bottom whenever
  // the row count grows, BUT only when the operator was already near the
  // bottom — if they've scrolled up to read older activity, leave them
  // there (snap-yank is worse than a stale scroll position). Mirrors the
  // MemberCard / chat-panel auto-scroll-to-bottom pattern.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevRowCountRef = useRef(0);
  const prevSelectedRef = useRef(selected);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const prev = prevCluster.current;
    prevCluster.current = cluster;
    if (!prev || prev.clusterId !== cluster.clusterId) return;
    const additions: ActivityItem[] = [];
    const now = Date.now();
    const prevIds = new Set(prev.members.map((m) => m.workflowId));
    const nextIds = new Set(cluster.members.map((m) => m.workflowId));
    for (const m of cluster.members) {
      if (!prevIds.has(m.workflowId)) {
        additions.push({
          id: `member-added-${m.workflowId}-${now}`,
          ts: now,
          kind: 'member-added',
          label: 'MEMBER ADDED',
          summary: m.displayName,
          memberId: m.workflowId,
        });
      }
    }
    for (const m of prev.members) {
      if (!nextIds.has(m.workflowId)) {
        additions.push({
          id: `member-removed-${m.workflowId}-${now}`,
          ts: now,
          kind: 'member-removed',
          label: 'MEMBER REMOVED',
          summary: m.displayName,
          memberId: m.workflowId,
        });
      }
    }
    // Role changes — match on workflowId, diff the `role` field.
    const prevRoleByWfid = new Map(prev.members.map((m) => [m.workflowId, m.role]));
    for (const m of cluster.members) {
      const prevRole = prevRoleByWfid.get(m.workflowId);
      if (prevRole !== m.role) {
        additions.push({
          id: `role-set-${m.workflowId}-${now}`,
          ts: now,
          kind: 'role-set',
          label: 'ROLE',
          summary: `${m.displayName} → ${m.role ? `"${m.role.slice(0, 60)}"` : '(cleared)'}`,
          memberId: m.workflowId,
        });
      }
    }
    if (prev.plan?.updatedAt !== cluster.plan?.updatedAt) {
      additions.push({
        id: `plan-changed-${cluster.plan?.updatedAt ?? 0}`,
        ts: cluster.plan?.updatedAt ?? now,
        kind: 'plan-changed',
        label: 'PLAN',
        summary: cluster.plan?.body
          ? `${cluster.plan.body.length} chars`
          : '(cleared)',
      });
    }
    if (additions.length > 0) {
      setAudit((prevAudit) => [...prevAudit, ...additions].slice(-400));
    }
  }, [cluster]);

  // Map wfid → member record for quick lookup during render (display name
  // + role chip resolution). Cluster state is the live source of truth;
  // a member rename rolls through here on the next cluster_state push.
  const memberById = useMemo(() => {
    const m = new Map<string, ClusterMember>();
    for (const mem of cluster.members) m.set(mem.workflowId, mem);
    return m;
  }, [cluster.members]);

  // Combine cluster-scoped audit events with peer messages and per-member
  // tool activity. Read each member's job.activity directly — same shape
  // the per-workflow ACTIVITY tab consumes (see RightPanel.ActivityTab).
  const items = useMemo<ActivityItem[]>(() => {
    const out: ActivityItem[] = [];
    for (let i = 0; i < cluster.members.length; i++) {
      const m = cluster.members[i]!;
      const job = memberJobs[i];
      if (!job) continue;
      // Peer messages (chat-side rows).
      for (const msg of job.messages) {
        if (msg.role === 'peer-sent') {
          out.push({
            id: `peer-sent-${m.workflowId}-${msg.id}`,
            ts: msg.timestamp ?? 0,
            kind: 'peer-sent',
            label: `→ ${m.displayName}`,
            summary: (msg.content ?? '').slice(0, 200),
            memberId: m.workflowId,
          });
        } else if (msg.role === 'peer-received') {
          out.push({
            id: `peer-received-${m.workflowId}-${msg.id}`,
            ts: msg.timestamp ?? 0,
            kind: 'peer-received',
            label: `← ${m.displayName}`,
            summary: (msg.content ?? '').slice(0, 200),
            memberId: m.workflowId,
          });
        }
      }
      // Per-member tool / thinking activity. Defensive on shape: older
      // hydrated jobs might not carry .activity (see appStore §1937).
      const activity = Array.isArray(job.activity) ? job.activity : [];
      for (const e of activity) {
        if (e.kind === 'tool_use') {
          out.push({
            id: `tool-use-${m.workflowId}-${e.id}`,
            ts: e.at,
            kind: 'tool-use',
            label: m.displayName,
            summary: toolSummary(e),
            memberId: m.workflowId,
            tool: e.tool,
          });
        } else if (e.kind === 'thinking') {
          out.push({
            id: `thinking-${m.workflowId}-${e.id}`,
            ts: e.at,
            kind: 'thinking',
            label: m.displayName,
            // Keep raw chunk whitespace until the globally-sorted coalescing
            // pass below. Cursor/Kimi often sends separators as their own ACP
            // chunks; trimming here glues words together.
            summary: e.text ?? '',
            memberId: m.workflowId,
          });
        }
      }
      // Sub-worker tool activity: Reviews, Task children, and any other
      // spawned worker fire worker_tool_use against the parent's
      // workers[workerId].toolCalls (NOT primary_tool_use against .activity).
      // Without this loop, the operator sees the bookend [REVIEW] / [TASK]
      // markers but none of the sub-worker's actual tool calls — the cluster
      // ACTIVITY feed looks empty while the review/task is grinding. Tag
      // these rows with a `subWorker` marker so the operator can tell they
      // came from a sub-process rather than the member's primary turn.
      const workers = job.workers ?? {};
      for (const [workerId, w] of Object.entries(workers)) {
        if (!w || !Array.isArray(w.toolCalls)) continue;
        // The task field (e.g. "Review: last 3 turns" / "Spawn from here:
        // <prompt>") is what `runReviewer` / `Task` set when dispatching.
        // Trim aggressively for the row label.
        const subLabel = (w.task ?? '').trim().slice(0, 40) || workerId.slice(0, 8);
        for (const call of w.toolCalls) {
          out.push({
            id: `worker-tool-${m.workflowId}-${workerId}-${call.timestamp}-${call.tool}`,
            ts: call.timestamp,
            kind: 'tool-use',
            label: m.displayName,
            summary: toolSummary({ kind: 'tool_use', tool: call.tool, input: call.input } as ActivityEntry),
            memberId: m.workflowId,
            tool: call.tool,
            subWorker: subLabel,
          });
        }
      }
    }
    for (const a of audit) out.push(a);
    // Oldest first → newest at the bottom of the rendered feed (chat shape).
    out.sort((a, b) => a.ts - b.ts);
    return coalesceThinkingRuns(out);
  }, [cluster.members, memberJobs, audit]);

  // Filter by pill, then compact runs of ≥3 same-(memberId, tool) within
  // a 30-second sliding window. Filtering before compacting keeps the
  // compacted counts honest for the selected lane.
  const visible = useMemo(() => {
    if (selected === 'all') return items;
    return items.filter((it) => {
      if (CLUSTER_WIDE_KINDS.has(it.kind)) return false;
      return it.memberId === selected;
    });
  }, [items, selected]);

  const compacted = useMemo<CompactedRow[]>(() => {
    const rows: CompactedRow[] = [];
    let i = 0;
    // `visible` is sorted oldest → newest. Walk forward; for each run of
    // identical (memberId, tool) tool-use rows where (lastTs - firstTs)
    // ≤ COMPACT_WINDOW_MS and length ≥ COMPACT_MIN_RUN, the LAST item is
    // the rendered primary (newest at bottom — operator sees it as the
    // "× N reads just finished" pin); the earlier items go into hiddenItems.
    while (i < visible.length) {
      const head = visible[i]!;
      if (head.kind !== 'tool-use' || !head.tool || !head.memberId) {
        rows.push({ primary: head, collapsedCount: 0, hiddenItems: [] });
        i++;
        continue;
      }
      let j = i + 1;
      while (j < visible.length) {
        const next = visible[j]!;
        if (
          next.kind !== 'tool-use' ||
          next.memberId !== head.memberId ||
          next.tool !== head.tool ||
          // Don't collapse a primary-turn row into a sub-worker row (or
          // across different sub-workers) — different processes, even if
          // same tool name. Keeps the operator's mental separation intact.
          next.subWorker !== head.subWorker
        ) break;
        if (next.ts - head.ts > COMPACT_WINDOW_MS) break;
        j++;
      }
      const runLen = j - i;
      if (runLen >= COMPACT_MIN_RUN) {
        const primary = visible[j - 1]!;
        const hiddenItems = visible.slice(i, j - 1);
        rows.push({ primary, collapsedCount: runLen, hiddenItems });
        i = j;
      } else {
        rows.push({ primary: head, collapsedCount: 0, hiddenItems: [] });
        i++;
      }
    }
    return rows;
  }, [visible]);

  // Cap the rendered window — the unified feed can outrun the prior 200
  // when N members are all busy. 600 rows is the wall before we'd reach
  // for virtualization (per the plan: only add it if ≥500 is routine).
  // Keep the tail (newest) so the bottom-anchored feed shows recent rows.
  const cappedRows =
    compacted.length > 600 ? compacted.slice(compacted.length - 600) : compacted;

  // Snap to bottom on feed updates IFF the operator was already near the bottom.
  // "Near bottom" = scrollHeight - scrollTop - clientHeight < 80px so a
  // one-row buffer scroll doesn't lock them out of autoscroll. Also runs
  // on initial mount (prev=0, count>0) so the first render lands at the
  // latest item, not wherever the browser parked the scrollbar. This keys on
  // the row array, not only its length: a coalesced thinking row grows in
  // place while its row count remains constant.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grew = cappedRows.length > prevRowCountRef.current;
    const firstFill = prevRowCountRef.current === 0 && cappedRows.length > 0;
    const selectedChanged = selected !== prevSelectedRef.current;
    prevRowCountRef.current = cappedRows.length;
    prevSelectedRef.current = selected;
    if (selectedChanged) {
      el.scrollTop = el.scrollHeight;
      stickToBottomRef.current = true;
      return;
    }
    if ((grew || cappedRows.length > 0) && (firstFill || stickToBottomRef.current)) {
      el.scrollTop = el.scrollHeight;
    }
  }, [cappedRows, selected]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PillRow
        members={cluster.members}
        selected={selected}
        onSelect={setSelected}
      />
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '6px 0',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
        }}
      >
        {cappedRows.length === 0 ? (
          <div
            style={{
              color: 'var(--color-fg-muted)',
              fontSize: '11px',
              padding: '6px 8px',
            }}
          >
            {selected === 'all'
              ? 'No cluster activity yet. Peer messages, role edits, plan changes, member adds/removes, and per-member tool calls will land here.'
              : 'No activity for this member yet.'}
          </div>
        ) : (
          cappedRows.map((row) => (
            <ActivityRowView
              key={row.primary.id}
              row={row}
              memberById={memberById}
              expanded={!!expanded[row.primary.id]}
              onToggleExpand={() =>
                setExpanded((prev) => ({
                  ...prev,
                  [row.primary.id]: !prev[row.primary.id],
                }))
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

// Pill row — ALL on the left, then one pill per member. Horizontally
// scrollable so 8+ members don't wrap mid-row.
function PillRow({
  members,
  selected,
  onSelect,
}: {
  members: ReadonlyArray<ClusterMember>;
  selected: string;
  onSelect: (next: string) => void;
}) {
  return (
    <div
      data-help="cluster.activity.pill"
      style={{
        display: 'flex',
        gap: '4px',
        padding: '4px 2px 6px',
        borderBottom: '1px solid var(--color-border-hairline)',
        overflowX: 'auto',
        flexShrink: 0,
      }}
    >
      <Pill
        active={selected === 'all'}
        onClick={() => onSelect('all')}
        label="ALL"
      />
      {members.map((m) => (
        <Pill
          key={m.workflowId}
          active={selected === m.workflowId}
          onClick={() => onSelect(m.workflowId)}
          label={m.displayName}
          accent={memberColour(m.workflowId)}
        />
      ))}
    </div>
  );
}

function Pill({
  active,
  onClick,
  label,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  accent?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="display-font"
      style={{
        flex: '0 0 auto',
        padding: '4px 8px',
        background: active ? 'var(--color-accent-primary-a08)' : 'transparent',
        border: active
          ? '1px solid var(--color-accent-primary)'
          : '1px solid var(--color-border-hairline)',
        color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: 'pointer',
        fontSize: '10px',
        letterSpacing: '1px',
        // Tiny stable colour dot left of the label for non-ALL pills so the
        // mapping pill ↔ chip is obvious without staring at borders.
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
      }}
    >
      {accent && (
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: accent,
            flexShrink: 0,
          }}
        />
      )}
      {label.toUpperCase()}
    </button>
  );
}

function ActivityRowView({
  row,
  memberById,
  expanded,
  onToggleExpand,
}: {
  row: CompactedRow;
  memberById: Map<string, ClusterMember>;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const it = row.primary;
  const member = it.memberId ? memberById.get(it.memberId) : undefined;
  const memberName = member?.displayName ?? it.label;
  const accent = it.memberId ? memberColour(it.memberId) : undefined;
  const roleChip = roleChipText(member?.role);
  const collapsible = row.collapsedCount >= COMPACT_MIN_RUN;

  // Cluster-wide rows (plan-changed, member-added/removed) use the original
  // label as the leading chip and skip the member-name + role chip. Member-
  // scoped rows use the member name (colour-tagged) + role chip + the kind
  // tag in the right gutter.
  const showMemberLane = !!it.memberId && !CLUSTER_WIDE_KINDS.has(it.kind);

  return (
    <div
      style={{
        padding: '6px 8px',
        border: '1px solid var(--color-border-hairline)',
        fontSize: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        background:
          it.kind === 'member-nudged'
            ? 'var(--color-warning-a06, transparent)'
            : 'transparent',
      }}
    >
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        {showMemberLane ? (
          <>
            <span
              className="display-font"
              style={{
                color: accent ?? 'var(--color-fg)',
                fontWeight: 600,
                letterSpacing: '0.5px',
              }}
            >
              {memberName.toUpperCase()}
            </span>
            {roleChip && (
              <span
                className="display-font"
                style={{
                  fontSize: '9px',
                  letterSpacing: '1px',
                  color: 'var(--color-fg-muted)',
                  border: '1px solid var(--color-border-hairline)',
                  padding: '0 4px',
                }}
              >
                {roleChip}
              </span>
            )}
            {it.subWorker && (
              <span
                className="display-font"
                style={{
                  fontSize: '9px',
                  letterSpacing: '1px',
                  color: 'var(--color-accent-secondary)',
                  border: '1px solid var(--color-accent-secondary-a40, var(--color-accent-secondary-dim))',
                  padding: '0 4px',
                }}
                title={`Sub-worker: ${it.subWorker}`}
              >
                ↳ {it.subWorker.length > 16 ? `${it.subWorker.slice(0, 16)}…` : it.subWorker}
              </span>
            )}
            <span
              className="display-font"
              style={{
                color: kindColor(it.kind),
                fontSize: '9px',
                letterSpacing: '1.5px',
              }}
            >
              {kindLabel(it)}
            </span>
          </>
        ) : (
          <span style={{ color: kindColor(it.kind) }} className="display-font">
            {it.label}
          </span>
        )}
        <span
          style={{
            marginLeft: 'auto',
            color: 'var(--color-fg-muted)',
          }}
        >
          {new Date(it.ts).toLocaleTimeString()}
        </span>
      </div>
      <div style={{ color: 'var(--color-fg)', whiteSpace: 'pre-wrap' }}>
        {it.summary}
        {collapsible && (
          <>
            {' '}
            <button
              onClick={onToggleExpand}
              className="display-font"
              style={{
                background: 'transparent',
                border: '1px solid var(--color-border-hairline)',
                color: 'var(--color-fg-muted)',
                fontSize: '9px',
                letterSpacing: '1px',
                padding: '0 6px',
                cursor: 'pointer',
                marginLeft: '4px',
              }}
            >
              × {row.collapsedCount}
              {expanded ? ' ▴' : ' ▾'}
            </button>
          </>
        )}
      </div>
      {collapsible && expanded && (
        <div
          style={{
            marginTop: '4px',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            paddingLeft: '8px',
            borderLeft: `2px solid ${accent ?? 'var(--color-border-hairline)'}`,
          }}
        >
          {row.hiddenItems.map((hidden) => (
            <div
              key={hidden.id}
              style={{
                fontSize: '10px',
                color: 'var(--color-fg-muted)',
                whiteSpace: 'pre-wrap',
              }}
            >
              <span style={{ marginRight: '6px' }}>
                {new Date(hidden.ts).toLocaleTimeString()}
              </span>
              {hidden.summary}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function kindLabel(it: ActivityItem): string {
  if (it.kind === 'tool-use') return (it.tool ?? '?').toUpperCase();
  if (it.kind === 'thinking') return 'THINKING';
  if (it.kind === 'peer-sent') return 'PEER →';
  if (it.kind === 'peer-received') return '← PEER';
  if (it.kind === 'role-set') return 'ROLE';
  if (it.kind === 'member-nudged') return 'NUDGE';
  return it.kind.toUpperCase();
}

function roleChipText(role: string | undefined): string | null {
  if (!role) return null;
  const preset = presetForText(role);
  return (preset?.label.toUpperCase() ?? 'CUSTOM') || null;
}

// Tool-call → one-line summary. Mirrors RightPanel.abbreviateToolInput
// but inlined (lighter — we don't need every shape) so the cluster tab
// doesn't import a private helper. Falls through to truncated raw JSON
// for unknown tools so nothing is lost.
function toolSummary(e: ActivityEntry): string {
  const tool = e.tool;
  const raw = e.input;
  if (!raw) return '';
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return truncate(raw, 160); }
  if (parsed === null || typeof parsed !== 'object') return truncate(String(parsed), 160);
  const obj = parsed as Record<string, unknown>;
  switch (tool) {
    case 'ReadFile':
    case 'Read':
      return String(obj.file_path ?? obj.path ?? '');
    case 'WriteFile':
    case 'Write':
      return String(obj.file_path ?? obj.path ?? '');
    case 'Edit':
    case 'edit_file':
    case 'search_replace':
      return String(obj.file_path ?? obj.path ?? '');
    case 'NotebookEdit':
      return String(obj.notebook_path ?? obj.file_path ?? '');
    case 'Grep':
      return `${String(obj.pattern ?? '')}${obj.path ? ` in ${String(obj.path)}` : ''}`;
    case 'Glob':
      return String(obj.pattern ?? '');
    case 'Bash':
      return truncate(String(obj.command ?? ''), 140);
    case 'WebFetch':
      return String(obj.url ?? '');
    case 'WebSearch':
      return String(obj.query ?? '');
    case 'PermissionRequest':
      return `${String(obj.tool ?? 'tool')} · ${String(obj.request ?? '')}`;
    case 'waiting_unbridged_tool':
    case 'waiting_permission':
    case 'timed_out':
      return String(obj.detail ?? '');
    case 'TodoWrite': {
      const todos = Array.isArray(obj.todos) ? obj.todos : [];
      return `${todos.length} todo${todos.length === 1 ? '' : 's'}`;
    }
    default: {
      if (typeof obj.path === 'string' || typeof obj.file_path === 'string') {
        return String(obj.file_path ?? obj.path);
      }
      const preview = Object.entries(obj)
        .slice(0, 2)
        .map(([k, v]) => `${k}=${truncate(typeof v === 'string' ? v : JSON.stringify(v), 40)}`)
        .join(' · ');
      return preview || truncate(raw, 160);
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function kindColor(kind: ActivityKind): string {
  switch (kind) {
    case 'peer-sent':
      return 'var(--color-accent-secondary)';
    case 'peer-received':
      return 'var(--color-accent-primary)';
    case 'plan-changed':
      return 'var(--color-accent-primary)';
    case 'member-added':
      return 'var(--color-accent-primary)';
    case 'member-removed':
      return 'var(--color-warning)';
    case 'role-set':
      return 'var(--color-fg-muted)';
    case 'member-nudged':
      return 'var(--color-warning)';
    case 'tool-use':
      return 'var(--color-accent-secondary)';
    case 'thinking':
      return 'var(--color-fg-muted)';
  }
}

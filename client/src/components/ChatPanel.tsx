import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessage as ChatMessageType } from '@arco/shared';
import { ChatMessage } from './ChatMessage';
import { PriorSessionsSection } from './PriorSessionsSection';
import { isHandoffSeed } from './HandoffSeedPill';
import { useAppStore, type JobState } from '../stores/appStore';
import { useChatFollowStore } from '../stores/chatFollowStore';

// One virtualized row. Either a real chat message, or the synthetic
// "prior sessions" collapse pill. Stored as a discriminated union so the
// virtualizer can size/key/render each kind without role-sniffing at
// render time.
type ChatRow =
  | { kind: 'message'; key: string; message: ChatMessageType }
  | { kind: 'prior-sessions-pill'; key: 'prior-sessions' };

const SESSION_ASSISTANT_DEDUP_CHAR_CAP = 512 * 1024;

interface Props {
  job: JobState;
  onCancelQueued?: (clientMessageId: string) => void;
  onLoadEarlier?: () => void;
  // Present when this chat is a cluster member pane — enables the transcript
  // peer→task bridge (§10.7 follow-up). Only clusterId is needed; the rest of
  // the cluster is read lazily from the store at click time.
  clusterContext?: { clusterId: string; name: string };
  presentation?: 'workbench' | 'chat';
  // Chat-presentation row actions (ChatModeView). Both must be referentially
  // stable — ChatMessage is memoised and every prop it takes has to be.
  onEditMessage?: (text: string, attachments?: string[]) => void;
  onRetryMessage?: (text: string, attachments?: string[]) => void;
}

export function ChatPanel({ job, onCancelQueued, onLoadEarlier, clusterContext, presentation = 'workbench', onEditMessage, onRetryMessage }: Props) {
  // Debounce the pill click so a double-tap doesn't fire two pages.
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Prior-sessions collapse state. Default collapsed so the chat window
  // starts pinned to the current agent's transcript — prior sessions only
  // reveal when the operator explicitly opts in.
  const [priorSessionsExpanded, setPriorSessionsExpanded] = useState(false);
  // Jump-to-bottom button visibility. Separate from the pinned-to-bottom
  // ref (which is load-bearing for auto-scroll and can't trigger renders
  // per scroll event) — this state only flips on threshold crossings, so
  // the scroll handler stays cheap.
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // ResizeObserver target — the inner wrapper whose height equals
  // `virtualizer.getTotalSize()`. When it grows (new message OR streaming
  // delta OR row re-measure), the observer pins scroll to bottom if the
  // operator was already there. Replaces per-render scrollToIndex effects.
  const innerRef = useRef<HTMLDivElement>(null);
  // Track whether the user is pinned to the bottom. If so, new content
  // auto-scrolls; if they've scrolled up to read history, we leave them alone.
  const pinnedToBottom = useRef(true);
  const followRequest = useChatFollowStore((s) => s.request?.workflowId === job.id ? s.request.seq : 0);

  // Phase 1 context robustness — for Claude sessions, render from sessionChat
  // (populated by the session JSONL watcher). System notices + active streaming
  // from job.messages are layered on top. For non-Claude or sessions without
  // JSONL data yet, fall back to job.messages unchanged.
  //
  // Memoized so the reference is stable across parent re-renders (e.g. the
  // composer auto-growing on keystroke). Without the memo, every keystroke
  // produces a new `displayMessages` array, the auto-scroll effects downstream
  // fire, and the virtualizer's scroll recalc causes one-line jitter in chat.
  const displayMessages = useMemo(() => {
    const visibleInPresentation = (m: ChatMessageType) =>
      presentation !== 'chat' || !(m.role === 'system' && m.content.startsWith('[TURN ·'));
    const sessionChat = Array.isArray(job.sessionChat) ? job.sessionChat : [];
    // Queued optimistic entries must stay hidden even in the early-return
    // path — the main extras pipeline filters them at line ~146, but that
    // branch is only reached when sessionChat is populated. Without this
    // filter, a queued message leaks into chat for the window between send
    // and the first session_entry arrival (fresh workflow first turn, after
    // page reload before replay settles, or non-Claude providers that never
    // emit session_entry at all).
    if (sessionChat.length === 0) {
      // Sort by timestamp so frames that arrive out of order on the wire
      // (long pauses between text chunks, reconnect replay) render in
      // chronological order. Matches the sort applied to the merged
      // sessionChat+extras path below; without it, this branch (non-Claude
      // providers and Claude's first-turn window before the JSONL is
      // populated) would render in arrival order.
      return job.messages
        .filter(visibleInPresentation)
        .filter((m) => !(m.role === 'user' && m.queued))
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    }
    // Dedup optimistic user messages against sessionChat *only when the JSONL
    // version is within a few seconds of the optimistic add* — otherwise a
    // re-sent "go" or "continue" (same 120-char prefix) from minutes earlier
    // would collide and the new message would disappear entirely until the
    // JSONL catches up. Map content-prefix → array of sessionChat timestamps
    // so each optimistic send can match against its own JSONL echo.
    const userContentKey = (m: { content: string }) =>
      m.content.slice(0, 120).replace(/\s+/g, ' ');
    const sessionUserTimestamps = new Map<string, number[]>();
    let sessionAssistantConcat = '';
    let lastSessionTs = 0;
    let earliestSessionTs = Infinity;
    for (const m of sessionChat) {
      const ts = m.timestamp ?? 0;
      if (ts > lastSessionTs) lastSessionTs = ts;
      if (ts < earliestSessionTs) earliestSessionTs = ts;
      if (m.role === 'assistant' && !m.toolUse) {
        if (sessionAssistantConcat.length < SESSION_ASSISTANT_DEDUP_CHAR_CAP) {
          const remaining = SESSION_ASSISTANT_DEDUP_CHAR_CAP - sessionAssistantConcat.length;
          sessionAssistantConcat += m.content.length > remaining ? m.content.slice(0, remaining) : m.content;
        }
      } else if (m.role === 'user' && !m.toolUse) {
        const key = userContentKey(m);
        const arr = sessionUserTimestamps.get(key);
        if (arr) arr.push(ts);
        else sessionUserTimestamps.set(key, [ts]);
      }
    }
    const DEDUP_WINDOW_MS = 5000;
    const hasRecentSessionEcho = (m: { content: string; timestamp?: number }) => {
      const arr = sessionUserTimestamps.get(userContentKey(m));
      if (!arr) return false;
      const myTs = m.timestamp ?? 0;
      return arr.some((ts) => Math.abs(ts - myTs) < DEDUP_WINDOW_MS);
    };
    // The streaming primary_text bubble in job.messages is a single accumulator
    // over the whole turn — text_deltas from every text block concat into one
    // entry. sessionChat stores the same content split at tool_use boundaries
    // (one entry per text block, with tool_use entries in between). If we
    // layer the streaming bubble as-is, it renders the full concatenation
    // next to the properly-split sessionChat bubbles — visible duplication,
    // with the streaming bubble sorted above because its timestamp is the
    // turn's start. So: trim the prefix sessionChat has already materialized,
    // and pin whatever's left to the bottom.
    // Pin a streaming bubble to "after sessionChat" only if its natural ts
    // is older. Without the max, an in-flight Native turn rebuilt on reload
    // gets its bubble timestamp set to lastSessionTs+1 of the *prior* CLI
    // session (sessionChat carries that session's JSONL even after a handoff
    // moved us to Native), shoving the bubble before the post-handoff user
    // message and hiding it under the PRIOR SESSIONS collapse. The live case
    // is unaffected: sessionChat updates as the turn progresses, so
    // lastSessionTs is always >= the bubble's first-delta ts.
    const pinStreamingTs = (m: ChatMessageType): number =>
      Math.max(lastSessionTs + 1, m.timestamp ?? 0);
    // Earliest sessionChat timestamp marks the start of the *current* native
    // session's transcript. Any finalized assistant text in job.messages with
    // a timestamp before this belongs to a prior (archived) session — Handoff
    // rotates the JSONL watcher onto the new session so sessionChat no longer
    // carries pre-rotation content. Without re-admitting those messages, the
    // PRIOR SESSIONS expand shows only user bubbles and system notices; every
    // agent reply from before the handoff is invisible.
    // System notices (handoff markers, worker events, error notices, etc.),
    // actively-streaming assistant messages, and user messages that haven't
    // landed in the JSONL yet (queued mid-turn interjections) come from
    // job.messages. Without this overlay, operator interjections stay
    // invisible until the current turn finishes and Claude writes them out.
    const extras = job.messages.flatMap((m) => {
      if (m.role === 'system') return [m];
      // Phase 7b — synthetic Task tool_use rows (injected by
      // recordTaskStarted) live on job.messages, not sessionChat. Admit
      // them unconditionally; their stable id (`task::<toolUseId>`) and
      // sessionChat tool_use's separate `tool::<toolUseId>` namespace
      // keep them from colliding on dedup.
      if (m.toolUse) return [m];
      if (m.isStreaming) {
        if (sessionAssistantConcat.length > 0 && m.content.startsWith(sessionAssistantConcat)) {
          const suffix = m.content.slice(sessionAssistantConcat.length).replace(/^\s+/, '');
          if (suffix.length === 0) return [];
          return [{ ...m, content: suffix, timestamp: pinStreamingTs(m) }];
        }
        // Exact-prefix match failed. This usually means whitespace drift
        // between stream deltas and JSONL (e.g. a trailing "\n" Claude wrote
        // to disk that the delta stream didn't emit) or a tool_use-split
        // boundary that collapsed a gap when sessionChat concat'd. Re-check
        // with whitespace normalized — if sessionChat has effectively caught
        // up, drop the streaming bubble instead of pinning a full duplicate
        // below the finalized entries. Losing a few in-flight tokens for
        // one frame (until primary_complete flips isStreaming off and the
        // bubble is excluded entirely) is far better than rendering the
        // whole turn twice, which is what the pin-to-bottom fallback did.
        if (sessionAssistantConcat.length > 0) {
          const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
          const streamNorm = norm(m.content);
          const sessionNorm = norm(sessionAssistantConcat);
          if (
            streamNorm.length > 0 &&
            (sessionNorm === streamNorm ||
              sessionNorm.startsWith(streamNorm) ||
              (streamNorm.startsWith(sessionNorm) &&
                sessionNorm.length >= streamNorm.length * 0.9))
          ) {
            return [];
          }
        }
        // Genuine divergence (no sessionChat assistant content yet, or the
        // two strings disagree on more than whitespace) — keep the bubble
        // and pin to bottom so it doesn't leapfrog finalized entries.
        return [{ ...m, timestamp: pinStreamingTs(m) }];
      }
      // Queued user messages stay out of the scrolling chat log entirely —
      // they surface in the composer-adjacent QueuedMessagesIndicator until
      // the server pulls them from the queue and emits `user_message_echo`,
      // at which point `useWebSocket` flips `queued: false` on the existing
      // store entry and they fall through to the normal-user branch below.
      // Prior behavior rendered queued entries inline with a [QUEUED] badge
      // and then double-rendered them when the echo arrived minutes later
      // (the 5s sessionChat-proximity dedup could not span a long queue
      // wait). Keeping them out of `extras` fixes both problems.
      if (m.role === 'user' && m.queued) return [];
      if (m.role === 'user' && !hasRecentSessionEcho(m)) return [m];
      // Finalized assistant text (`isStreaming === false`). The streaming
      // branch above runs the same content-prefix / norm-match dedup against
      // sessionChat to avoid duplication; we mirror that here so a bubble
      // whose isStreaming was flipped to false (by primary_complete, the
      // partialize handler at appStore.ts:1402, or applyWorkflowSnapshot on
      // a busy=false snapshot) still gets the same dedup treatment.
      //
      // Without this, two scenarios break:
      //
      //  - Native turn after a CLI handoff: sessionChat is pinned to the
      //    prior CLI session's JSONL (rehydrated via cliSessions[0] at
      //    index.ts:5713), so its content doesn't cover the Native bubble.
      //    Falling through to "outside-window admit" includes the bubble.
      //
      //  - Pre-rotation reply: from before the most recent handoff. The
      //    post-rotation sessionChat doesn't carry it — same admit.
      //
      //  - CLI live, primary_complete just fired but session_entry events
      //    haven't fully caught up: bubble.content briefly exceeds what
      //    sessionAssistantConcat covers. The trim-prefix branch shows
      //    only the suffix until sessionChat catches up; once it does,
      //    norm-match drops the bubble entirely.
      //
      // tool_use rows from prior sessions stay missing — those only ever
      // lived in sessionChat — but the conversational replies do not.
      if (m.role === 'assistant' && !m.toolUse && !m.isStreaming) {
        if (sessionAssistantConcat.length > 0 && m.content.startsWith(sessionAssistantConcat)) {
          const suffix = m.content.slice(sessionAssistantConcat.length).replace(/^\s+/, '');
          if (suffix.length === 0) return [];
          return [{ ...m, content: suffix }];
        }
        if (sessionAssistantConcat.length > 0) {
          const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
          const messageNorm = norm(m.content);
          const sessionNorm = norm(sessionAssistantConcat);
          if (
            messageNorm.length > 0 &&
            (sessionNorm === messageNorm ||
              sessionNorm.startsWith(messageNorm) ||
              (messageNorm.startsWith(sessionNorm) &&
                sessionNorm.length >= messageNorm.length * 0.9))
          ) {
            return [];
          }
        }
        // Content not covered by sessionChat. Admit if outside sessionChat's
        // window (pre-rotation or post-window — see scenarios above) or if
        // there's no sessionChat at all (pure Native workflow).
        if (
          sessionAssistantConcat.length === 0 ||
          (m.timestamp ?? 0) < earliestSessionTs ||
          (m.timestamp ?? 0) > lastSessionTs
        ) {
          return [m];
        }
        // In-window with content sessionChat doesn't yet cover. Drop rather
        // than render a hard-to-explain duplicate; sessionChat will catch
        // up within a frame or two.
        return [];
      }
      return [];
    });
    // Carry two pieces of optimistic-message state onto the sessionChat echo
    // when they dedup together:
    //
    // 1. `attachments` — the JSONL only stores text blocks, so without this
    //    the file chips flash then disappear the instant the echo arrives.
    //
    // 2. `timestamp` — the optimistic add uses client Date.now() at send;
    //    the sessionChat echo uses Claude's JSONL wall-clock, which can
    //    land milliseconds to seconds later and differ from the client's
    //    clock. If we sort by the later JSONL timestamp, a long paste can
    //    visually jump to a position *after* messages that were displayed
    //    above it (e.g. a streaming assistant bubble whose ts was stamped
    //    between send and JSONL write). Pinning the echo to the optimistic
    //    ts keeps the operator message in the visual slot it first occupied.
    //
    // Match on the same content-prefix key used for dedup above so repeated
    // sends don't cross-contaminate — each optimistic send keys by its own
    // 120-char prefix, and we only merge onto the echo closest in time.
    const optimisticUserMetaByKey = new Map<string, { ts: number; attachments?: string[] }>();
    for (const m of job.messages) {
      if (m.role !== 'user') continue;
      const key = userContentKey(m);
      const ts = m.timestamp ?? 0;
      const existing = optimisticUserMetaByKey.get(key);
      // Keep the most recent optimistic entry per key; if two sends share a
      // prefix the newer one wins (older ones already had their echoes
      // merged in a prior render pass).
      if (!existing || ts > existing.ts) {
        optimisticUserMetaByKey.set(key, { ts, attachments: m.attachments });
      }
    }
    const enrichedSession = optimisticUserMetaByKey.size === 0
      ? sessionChat
      : sessionChat.map((m) => {
          if (m.role !== 'user' || m.toolUse) return m;
          const hit = optimisticUserMetaByKey.get(userContentKey(m));
          if (!hit) return m;
          // Only merge if the optimistic send is within the dedup window of
          // this session echo — otherwise an unrelated later send with the
          // same prefix would attach its files (and its ts) to an old
          // message above.
          if (Math.abs((m.timestamp ?? 0) - hit.ts) > DEDUP_WINDOW_MS) return m;
          return {
            ...m,
            timestamp: hit.ts,
            attachments: hit.attachments ?? m.attachments,
          };
        });
    // NOTE: no final seen-set dedup. Extras are already filtered against
    // sessionChat (user messages via proximity-window check above; the
    // streaming bubble via prefix-trim above). A content-prefix seen-set
    // would collapse legitimately-distinct repeats — two "go" messages in a
    // row, or two assistant text blocks starting with the same sentence —
    // so the second one disappears entirely. Don't reintroduce it.
    return [...enrichedSession, ...extras].filter(visibleInPresentation).sort(
      (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
    );
  }, [job.sessionChat, job.messages, presentation]);

  // RETRY anchor for the chat presentation: the id of the last assistant row
  // and the operator message that produced it. Only that row gets the action,
  // so the transcript isn't littered with retry buttons for answers that have
  // already been built on. Both values are primitives, keeping ChatMessage's
  // memo intact.
  const retryAnchor = useMemo(() => {
    if (presentation !== 'chat' || !onRetryMessage) return null;
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      const m = displayMessages[i];
      if (m.role !== 'assistant' || m.toolUse || m.isStreaming) continue;
      for (let j = i - 1; j >= 0; j--) {
        const prior = displayMessages[j];
        // An image-only prompt is still the prompt: skipping empty-text rows
        // made RETRY resend an older, unrelated message.
        if (prior.role === 'user' && !prior.toolUse && (prior.content.trim() || (prior.attachments?.length ?? 0) > 0)) {
          return { messageId: m.id, text: prior.content, attachments: prior.attachments };
        }
      }
      return null;
    }
    return null;
  }, [displayMessages, presentation, onRetryMessage]);

  // Filename → absolute path index built from every Read/Write/Edit tool call
  // in the workflow. Powers the chat-text "click any filename to open" feature
  // in ChatMessage: if the agent writes `# project-shape-audit.md` in its reply,
  // we resolve to whichever path the worker last touched. Last-write-wins so
  // a renamed-then-rewritten file points at the new location. Only basenames
  // are indexed; full paths are looked up by prefix-match too so an agent
  // writing `reports/audit.md` matches a Write to `<cwd>/reports/audit.md`.
  const writtenFiles = useMemo(() => {
    const byBasename = new Map<string, string>();
    const byTail = new Map<string, string>();
    for (const m of displayMessages) {
      const fp = m.toolUse?.filePath;
      if (typeof fp !== 'string' || !fp) continue;
      const base = fp.split('/').pop() || '';
      if (base) byBasename.set(base, fp);
      // Index "trailing-N-segments" → full path so a chat reference like
      // `reports/audit.md` resolves even when the recorded path is absolute.
      const segs = fp.split('/').filter(Boolean);
      for (let i = 1; i <= Math.min(segs.length, 4); i++) {
        byTail.set(segs.slice(-i).join('/'), fp);
      }
    }
    return { byBasename, byTail };
  }, [displayMessages]);

  // §10.7 follow-up — transcript peer→task bridge. The MAILBOX modal's → TASK
  // only catches the undelivered window; once a peer message is delivered it
  // lives here in the transcript, so cluster members get the same promote path.
  // Subscribe to just this cluster's board mode (cheap) to decide whether the
  // affordance shows; read members / boardKey / wsSendRaw lazily at click time
  // so the chat doesn't re-render on every cluster_state push. Same shape as
  // ClusterRightPanel.onMakeTaskFromMessage — first member is the cwd anchor,
  // sender tagged via a workflow link for provenance.
  const clusterId = clusterContext?.clusterId;
  const boardAttached = useAppStore((s) =>
    clusterId ? (s.clusters[clusterId]?.taskBoardMode ?? 'none') !== 'none' : false,
  );
  const onMakeTaskFromPeer = useMemo(() => {
    if (!clusterId || !boardAttached) return undefined;
    return (content: string, fromWorkflowId: string) => {
      const st = useAppStore.getState();
      const cluster = st.clusters[clusterId];
      if (!cluster || cluster.taskBoardMode === 'none' || !st.wsSendRaw) return;
      const anchor = cluster.members[0]?.workflowId;
      if (!anchor) return;
      const fromName = cluster.members.find((m) => m.workflowId === fromWorkflowId)?.displayName ?? fromWorkflowId.slice(0, 8);
      const firstLine = content.split('\n').map((s) => s.trim()).find(Boolean) ?? content.trim();
      const title = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
      st.wsSendRaw({
        type: 'task_ledger_create',
        workflowId: anchor,
        ...(cluster.taskBoardKey ? { boardKey: cluster.taskBoardKey } : {}),
        title,
        notes: `From peer ${fromName}:\n\n${content}`,
        links: [{ kind: 'workflow', ref: fromWorkflowId }],
      });
    };
  }, [clusterId, boardAttached]);

  // Handoff-aware row composition. If any HandoffSeedPill markers appear in
  // the transcript, everything up to and including the most recent one is
  // collapsed into a single "PRIOR SESSIONS" pill at the top — the default
  // chat view is just the current agent's conversation. Expanding the pill
  // re-inlines the full history (intermediate seeds still render as their
  // own pills inside, so stacked handoffs remain navigable).
  //
  // Detection is the same stable prefix `HandoffSeedPill` uses; if the
  // server changes that seed string this grouping silently goes dormant and
  // the chat falls back to the pre-compression flat view.
  const { visibleRows, priorMessageCount, handoffCount } = useMemo(() => {
    const seedIdxs: number[] = [];
    for (let i = 0; i < displayMessages.length; i++) {
      const m = displayMessages[i];
      if (m.role === 'user' && !m.toolUse && isHandoffSeed(m.content)) {
        seedIdxs.push(i);
      }
    }
    if (seedIdxs.length === 0) {
      const rows: ChatRow[] = displayMessages.map((m) => ({
        kind: 'message',
        key: m.id,
        message: m,
      }));
      return { visibleRows: rows, priorMessageCount: 0, handoffCount: 0 };
    }
    const lastSeedIdx = seedIdxs[seedIdxs.length - 1];
    // Prior region includes the last seed itself — the seed marks the
    // boundary, not the first message of the new session.
    const prior = displayMessages.slice(0, lastSeedIdx + 1);
    const current = displayMessages.slice(lastSeedIdx + 1);
    const pillRow: ChatRow = { kind: 'prior-sessions-pill', key: 'prior-sessions' };
    const rows: ChatRow[] = [
      pillRow,
      ...(priorSessionsExpanded
        ? prior.map<ChatRow>((m) => ({ kind: 'message', key: m.id, message: m }))
        : []),
      ...current.map<ChatRow>((m) => ({ kind: 'message', key: m.id, message: m })),
    ];
    return {
      visibleRows: rows,
      // Human-meaningful count — exclude tool_use pills from the label so
      // "12 messages" reflects conversational turns, not the raw row total
      // that would inflate on a turn with many Read/Grep calls.
      priorMessageCount: prior.filter((m) => !m.toolUse).length,
      handoffCount: seedIdxs.length,
    };
  }, [displayMessages, priorSessionsExpanded]);

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    // Per-row estimates. The old flat `() => 120` was badly wrong for most
    // rows — assistant markdown bubbles are typically 250–600px and tool
    // pills are ~36px, so scrolling an off-screen row into view caused a
    // `getTotalSize()` jump of hundreds of pixels that shifted every row's
    // `vi.start` mid-scroll (the jitter). Role-specific estimates shrink
    // the estimate-vs-real delta, which together with a higher `overscan`
    // lets most rows be pre-measured before the operator sees them.
    estimateSize: (index) => {
      const row = visibleRows[index];
      if (!row) return 120;
      if (row.kind === 'prior-sessions-pill') return 44;
      const m = row.message;
      if (m.toolUse) return 36;
      if (m.role === 'system') return 44;
      if (m.role === 'user') return 80;
      // Assistant: coarse heuristic on content length. Clamped so a one-
      // liner isn't estimated at 0px (causing overlap) and a giant dump
      // isn't estimated at screen height (causing huge blank gaps).
      const len = m.content?.length ?? 0;
      return Math.max(90, Math.min(640, 70 + Math.floor(len / 3)));
    },
    // Bumped from 6 to 16 so more off-screen rows get their real size
    // recorded before they enter the viewport during scroll-back, which
    // reduces residual jitter when the estimator is still off for a
    // particular row (long assistant answer, unexpectedly tall markdown).
    overscan: 16,
    // Stable key so measurement caches follow the logical row even when a
    // sort re-orders the array. Without this, new `session_entry` insertions
    // (common post-handoff: seed bubble + tool_uses + assistant reply all
    // land at once) shift every item's index and attribute stale heights to
    // the wrong rows, leaving ghost gaps in the render.
    getItemKey: (index) => visibleRows[index]?.key ?? index,
  });

  // Phase 8 — HISTORY → ChatPanel scroll-and-flash. HistoryTab calls
  // store.flashChatMessage when the operator selects a row mapped to a chat
  // message id; we react by scrolling that row into view + applying a 2s
  // accent border. Effect re-runs when `at` is bumped so a second click on
  // the same row re-fires the flash.
  const flashTarget = useAppStore((s) => s.flashTarget);
  const [flashedKey, setFlashedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!flashTarget || flashTarget.jobId !== job.id) return;
    const idx = visibleRows.findIndex(
      (r) => r.kind === 'message' && r.message.id === flashTarget.messageId,
    );
    if (idx < 0) return;
    virtualizer.scrollToIndex(idx, { align: 'center' });
    pinnedToBottom.current = false;
    setFlashedKey(visibleRows[idx].key);
    const t = window.setTimeout(() => setFlashedKey(null), 2000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flashTarget, job.id]);

  // Track scroll-position mode (pinned vs. detached). 40px slack so small
  // jitter doesn't flip us out of pinned-mode. The jump-to-bottom button
  // uses a separate, larger threshold (200px) so it only appears once the
  // operator has meaningfully scrolled up to read history, not on a few
  // pixels of drift from a re-measure.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottom.current = distanceFromBottom < 40;
    setShowJumpToBottom(distanceFromBottom > 200);
  };

  const handleJumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight - el.clientHeight, behavior: 'smooth' });
    // Pre-set pinned and hide the button so the UI reflects intent
    // immediately; onScroll will re-confirm once the smooth scroll lands.
    pinnedToBottom.current = true;
    setShowJumpToBottom(false);
  };

  // Preserve scroll position when earlier pages prepend content above. Capture
  // scrollHeight before the click; after the new messages land and re-render,
  // shift scrollTop by the growth delta so the operator stays anchored on
  // whatever they were reading. Without this the view snaps to the top.
  const preScrollHeight = useRef<number | null>(null);
  const handleLoadEarlier = () => {
    if (!onLoadEarlier || loadingEarlier) return;
    preScrollHeight.current = scrollRef.current?.scrollHeight ?? null;
    pinnedToBottom.current = false;
    setLoadingEarlier(true);
    onLoadEarlier();
    // Self-clear after a second — responses are fast (local file read / in-mem
    // queue pop) and a stuck spinner would hide a legit retry opportunity.
    window.setTimeout(() => setLoadingEarlier(false), 1000);
  };

  useLayoutEffect(() => {
    if (preScrollHeight.current === null) return;
    const el = scrollRef.current;
    if (!el) return;
    const delta = el.scrollHeight - preScrollHeight.current;
    if (delta > 0) el.scrollTop = el.scrollTop + delta;
    preScrollHeight.current = null;
  }, [job.sessionChat, job.messages]);

  // Auto-scroll pinned-to-bottom. Keyed on `virtualizer.getTotalSize()` (which
  // changes on new messages AND on row re-measurements — including streaming
  // deltas inside an existing row, because @tanstack/react-virtual's internal
  // ResizeObserver re-measures and bumps totalSize, forcing a re-render) plus
  // `displayMessages.length` as belt-and-suspenders. Uses imperative
  // `scrollTop = scrollHeight - clientHeight` rather than
  // `virtualizer.scrollToIndex`, because the latter computes a target offset
  // from cached row sizes that can be stale while `measureElement` is still
  // settling on the growing row's real height — that stale-offset jump is the
  // streaming-jitter we saw before. `scrollHeight` is always the DOM's real
  // current content height, so the scroll correction is atomic with the paint.
  // Belt: a ResizeObserver catches any height change that didn't round-trip
  // through React state (defensive — shouldn't be necessary in practice).
  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    if (!followRequest) return;
    // Voice selection/send is the same intent as JUMP TO BOTTOM, including
    // when this panel was already mounted and detached while reading history.
    preScrollHeight.current = null;
    pinnedToBottom.current = true;
    setShowJumpToBottom(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight - el.clientHeight;
  }, [job.id, followRequest]);
  useLayoutEffect(() => {
    if (!pinnedToBottom.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight - el.clientHeight;
  }, [totalSize, visibleRows.length]);

  useEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (!pinnedToBottom.current) return;
      el.scrollTop = el.scrollHeight - el.clientHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // Unpin the instant the operator starts a scroll-up gesture. `onScroll`
  // alone races with the streaming-content ResizeObserver: within the same
  // frame the observer can read `pinnedToBottom=true` and yank the scroll
  // back to bottom before the browser's scroll event has fired to flip the
  // flag. Wheel / touchstart / key-based scroll intents arrive *before* the
  // scroll itself, so unpinning here wins the race. We only unpin on upward
  // intent (negative wheel delta, scrolling keys) — downward wheel that
  // lands back at the bottom is then re-pinned by onScroll's < 40px check.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) pinnedToBottom.current = false;
    };
    const onTouchStart = () => {
      pinnedToBottom.current = false;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') {
        pinnedToBottom.current = false;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-help="chat.panel"
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px 20px',
        position: 'relative',
        zIndex: 5,
      }}
    >
      {displayMessages.length === 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <span className="display-font" style={{ fontSize: '12px', color: 'var(--color-fg-muted)', letterSpacing: '2px' }}>
            Send a message to begin
          </span>
        </div>
      )}
      {job.hasEarlierSessionHistory && onLoadEarlier && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 12px' }}>
          <span data-help="chat.load-earlier" style={{ display: 'inline-flex' }}>
          <button
            onClick={handleLoadEarlier}
            disabled={loadingEarlier}
            className="display-font"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-fg-muted)',
              color: 'var(--color-fg-muted)',
              padding: '6px 14px',
              fontSize: '11px',
              letterSpacing: '1.5px',
              cursor: loadingEarlier ? 'default' : 'pointer',
              opacity: loadingEarlier ? 0.5 : 1,
            }}
          >
            {loadingEarlier ? 'LOADING…' : '↑ LOAD EARLIER MESSAGES'}
          </button>
          </span>
        </div>
      )}
      <div ref={innerRef} style={{ height: virtualizer.getTotalSize(), width: '100%', maxWidth: presentation === 'chat' ? '860px' : undefined, margin: presentation === 'chat' ? '0 auto' : undefined, position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = visibleRows[vi.index];
          if (!row) return null;
          return (
            <div
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={vi.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
                // Phase 8 — flash highlight when HistoryTab selected the
                // matching event. Border-only so layout doesn't shift.
                ...(flashedKey === row.key
                  ? {
                      outline: '2px solid var(--color-accent-primary)',
                      outlineOffset: '-2px',
                      transition: 'outline-color 0.4s ease',
                    }
                  : {}),
              }}
            >
              {row.kind === 'prior-sessions-pill' ? (
                <PriorSessionsSection
                  messageCount={priorMessageCount}
                  handoffCount={handoffCount}
                  expanded={priorSessionsExpanded}
                  onToggle={() => setPriorSessionsExpanded((v) => !v)}
                />
              ) : (
                <ChatMessage
                  message={row.message}
                  jobId={job.id}
                  jobCwd={presentation === 'chat' ? undefined : job.config.workingDirectory}
                  writtenFiles={writtenFiles}
                  onCancelQueued={onCancelQueued}
                  onMakeTask={onMakeTaskFromPeer}
                  presentation={presentation}
                  onEditMessage={onEditMessage}
                  onRetryMessage={onRetryMessage}
                  retryText={retryAnchor?.messageId === row.message.id ? retryAnchor.text : undefined}
                  retryAttachments={retryAnchor?.messageId === row.message.id ? retryAnchor.attachments : undefined}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
      {showJumpToBottom && (
        <button
          type="button"
          onClick={handleJumpToBottom}
          data-help="chat.jump-to-bottom"
          title="Jump to latest message"
          className="display-font"
          style={{
            position: 'absolute',
            bottom: '16px',
            right: '20px',
            padding: '6px 12px',
            border: '1px solid var(--color-accent-primary-dim)',
            borderRadius: '3px',
            background: 'var(--color-bg)',
            color: 'var(--color-accent-primary)',
            cursor: 'pointer',
            fontSize: '10px',
            letterSpacing: '1.5px',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
            zIndex: 10,
          }}
        >
          ↓ NEWEST
        </button>
      )}
      {/* NATIVE_COMPACTION_PLAN Phase 3 — CLI-grade compaction takeover. While
          the Native worker is mid-summarization (native_compacting → cleared on
          native_compacted / failure / cancel), the whole chat area dims behind a
          prominent "Compacting conversation…" overlay so the tab reads as "busy
          compacting, not working on your task" — distinct from the small
          ctx_action divider. Composer send is greyed separately in TerminalInput. */}
      {job.compacting && (
        <div
          data-help="chat.compacting"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '14px',
            background: 'color-mix(in srgb, var(--color-bg) 82%, transparent)',
            backdropFilter: 'blur(2px)',
          }}
        >
          <div
            className="display-font"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              fontSize: '14px',
              letterSpacing: '2px',
              color: 'var(--color-accent-primary)',
            }}
          >
            <span
              aria-hidden
              style={{
                width: '16px',
                height: '16px',
                border: '2px solid var(--color-accent-primary-dim)',
                borderTopColor: 'var(--color-accent-primary)',
                borderRadius: '50%',
                animation: 'arco-spin 0.8s linear infinite',
              }}
            />
            COMPACTING CONVERSATION…
          </div>
          <div style={{ fontSize: '11px', letterSpacing: '1px', color: 'var(--color-fg-muted)', textAlign: 'center', maxWidth: '320px' }}>
            {typeof job.compactingFoldedTurns === 'number'
              ? `Folding ${job.compactingFoldedTurns} turn${job.compactingFoldedTurns === 1 ? '' : 's'} into a summary. This tab is busy compacting — not working on your task.`
              : 'Folding earlier history into a summary. This tab is busy compacting — not working on your task.'}
          </div>
        </div>
      )}
    </div>
  );
}

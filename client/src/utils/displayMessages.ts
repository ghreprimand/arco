import type { ChatMessage as ChatMessageType } from '@arco/shared';
import type { JobState } from '../stores/appStore.types';
import { orderConversation, reconcileEventTranscript } from './eventTranscript';

const SESSION_ASSISTANT_DEDUP_CHAR_CAP = 512 * 1024;

export function projectChatMessages(job: JobState, presentation: 'workbench' | 'chat' = 'workbench'): ChatMessageType[] {
    const visibleInPresentation = (m: ChatMessageType) =>
      presentation !== 'chat' || !(m.role === 'system' && m.content.startsWith('[TURN ·'));
    const { sessionChat, canonicalIds } = reconcileEventTranscript(job);
    // Queued optimistic entries must stay hidden even in the early-return
    // path - the main extras pipeline filters them at line ~146, but that
    // branch is only reached when sessionChat is populated. Without this
    // filter, a queued message leaks into chat for the window between send
    // and the first session_entry arrival (fresh workflow first turn, after
    // page reload before replay settles, or non-Claude providers that never
    // emit session_entry at all).
    if (sessionChat.length === 0) {
      // Workflow sequence anchors preserve causal order; legacy rows keep
      // their timestamp placement when no event provenance is available.
      return orderConversation(job.messages
        .filter(visibleInPresentation)
        .filter((m) => !(m.role === 'user' && m.queued)));
    }
    // Dedup optimistic user messages against sessionChat *only when the JSONL
    // version is within a few seconds of the optimistic add* - otherwise a
    // re-sent "go" or "continue" (same 120-char prefix) from minutes earlier
    // would collide and the new message would disappear entirely until the
    // JSONL catches up. Map content-prefix -> array of sessionChat timestamps
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
    // over the whole turn - text_deltas from every text block concat into one
    // entry. sessionChat stores the same content split at tool_use boundaries
    // (one entry per text block, with tool_use entries in between). If we
    // layer the streaming bubble as-is, it renders the full concatenation
    // next to the properly-split sessionChat bubbles - visible duplication,
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
    // a timestamp before this belongs to a prior (archived) session - Handoff
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
      if (m.role === 'system' || m.role === 'peer-sent' || m.role === 'peer-received' || canonicalIds.has(m.id)) return [m];
      // Phase 7b - synthetic Task tool_use rows (injected by
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
        // with whitespace normalized - if sessionChat has effectively caught
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
        // two strings disagree on more than whitespace) - keep the bubble
        // and pin to bottom so it doesn't leapfrog finalized entries.
        return [{ ...m, timestamp: pinStreamingTs(m) }];
      }
      // Queued user messages stay out of the scrolling chat log entirely -
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
      //    post-rotation sessionChat doesn't carry it - same admit.
      //
      //  - CLI live, primary_complete just fired but session_entry events
      //    haven't fully caught up: bubble.content briefly exceeds what
      //    sessionAssistantConcat covers. The trim-prefix branch shows
      //    only the suffix until sessionChat catches up; once it does,
      //    norm-match drops the bubble entirely.
      //
      // tool_use rows from prior sessions stay missing - those only ever
      // lived in sessionChat - but the conversational replies do not.
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
        // window (pre-rotation or post-window - see scenarios above) or if
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
    // 1. `attachments` - the JSONL only stores text blocks, so without this
    //    the file chips flash then disappear the instant the echo arrives.
    //
    // 2. `timestamp` - the optimistic add uses client Date.now() at send;
    //    the sessionChat echo uses Claude's JSONL wall-clock, which can
    //    land milliseconds to seconds later and differ from the client's
    //    clock. If we sort by the later JSONL timestamp, a long paste can
    //    visually jump to a position *after* messages that were displayed
    //    above it (e.g. a streaming assistant bubble whose ts was stamped
    //    between send and JSONL write). Pinning the echo to the optimistic
    //    ts keeps the operator message in the visual slot it first occupied.
    //
    // Match on the same content-prefix key used for dedup above so repeated
    // sends don't cross-contaminate - each optimistic send keys by its own
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
          // this session echo - otherwise an unrelated later send with the
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
    // would collapse legitimately-distinct repeats - two "go" messages in a
    // row, or two assistant text blocks starting with the same sentence -
    // so the second one disappears entirely. Don't reintroduce it.
    return orderConversation([...enrichedSession, ...extras].filter(visibleInPresentation));
}

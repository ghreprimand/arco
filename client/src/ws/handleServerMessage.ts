import { PRIMARY_PROVIDERS } from '@arco/shared';
import { useAppUpdateStore } from '../stores/appUpdateStore';
import { receiveComputerActivityChanged } from '../voice/activity';
import { useComputerStore } from '../stores/computerStore';
import { useVoiceStore } from '../voice/store';
import { dispatchVoiceToolCall } from '../voice/toolBridge';
import { applyOperatorQuestion, reconcileOperatorQuestions, questionMessageId } from './operatorQuestions';
import { useAppStore } from '../stores/appStore';
import { applyWorkspace, sendWorkspaceSync } from './workspaceSync';
import { useTerminalStore } from '../stores/terminalStore';
import { useRecallStore } from '../stores/recallStore';
import { useDocEditStore } from '../stores/docEditStore';
import { useMdTuneupStore } from '../stores/mdTuneupStore';
import { useKnowledgeDistillStore } from '../stores/knowledgeDistillStore';
import { useCookbookStore } from '../stores/cookbookStore';
import { useCompareStore } from '../stores/compareStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useHubLinkStore } from '../stores/hubLinkStore';
import { useOrchestrationAssistStore } from '../stores/orchestrationAssistStore';
import { useLiveChangesStore } from '../stores/liveChangesStore';
import { useClusterSnapshotsStore } from '../stores/clusterSnapshotsStore';
import type { ServerMessage, ChatMessage, ModelName, EffortLevel, GenerationSpeed } from '@arco/shared';
import { formatTokPerSec, tokensPerSecond } from '../utils/format';
import { narrativeEventFromMessage, trim80 } from '../utils/historyEvents';
import { getStreamRef, streamingMsgs, looksLikePlan } from './streamState';
import { takePendingResearch } from '../components/terminalInput/research';
import { takePendingTemplateApply } from '../components/WorkflowCreator/pendingTemplateApply';
import type { MutableRefObject } from 'react';

export interface WsDeps {
  wsRef: MutableRefObject<WebSocket | null>;
  scheduleReconnect: (immediate?: boolean) => void;
}

// NATIVE_COMPACTION_PLAN Phase 3 — a compaction-failure system_notice is the
// terminal signal on the no-`native_compacted` path (an empty/failed summary
// leaves history untouched and never emits `native_compacted`). The takeover
// flag must clear on it or the "Compacting…" overlay strands. Matches the
// manual ("Compact failed") and auto ("Compaction skipped") failure copy.
// Exported so a unit test can pin the wording↔regex contract — a drift either
// way (notice reworded, or regex tightened) would re-strand the overlay.
export function isCompactionFailureNotice(content: string): boolean {
  return /compact(ion)?\s+(failed|skipped)/i.test(content);
}

// primary_complete precedes primary_turn_token_usage in both live delivery and
// replay. Older events didn't copy lastPromptTokens onto the token-usage row,
// so keep a tiny handoff map to let Activity show the same CTX figure the
// footer uses after a reload.
const pendingLastPromptTokens = new Map<string, number>();
// Ollama/Strata genSpeed from this turn's primary_complete, consumed by the
// [TURN · …] stamp on primary_turn_ended. Per-turn, not sticky — a turn that
// reported no timing must not re-stamp the previous turn's speed.
const pendingGenSpeed = new Map<string, GenerationSpeed>();

// Chat mode receives very small provider deltas. Coalesce them to one store
// update per animation frame so Markdown/layout work tracks the display rate
// instead of token rate. Agent tabs keep their existing immediate semantics.
const chatDeltaBatches = new Map<string, { workflowId: string; messageId: string; text: string; frame: number }>();
function queueChatDelta(workflowId: string, phase: string, messageId: string, text: string): void {
  if (typeof requestAnimationFrame !== 'function') {
    useAppStore.getState().appendToStreamingMessage(workflowId, messageId, text);
    return;
  }
  const key = `${workflowId}:${phase}`;
  const prior = chatDeltaBatches.get(key);
  if (prior) {
    prior.text += text;
    return;
  }
  const entry = { workflowId, messageId, text, frame: 0 };
  entry.frame = requestAnimationFrame(() => {
    chatDeltaBatches.delete(key);
    useAppStore.getState().appendToStreamingMessage(entry.workflowId, entry.messageId, entry.text);
  });
  chatDeltaBatches.set(key, entry);
}
function flushChatDelta(workflowId: string, phase: string): void {
  const key = `${workflowId}:${phase}`;
  const entry = chatDeltaBatches.get(key);
  if (!entry) return;
  cancelAnimationFrame(entry.frame);
  chatDeltaBatches.delete(key);
  useAppStore.getState().appendToStreamingMessage(entry.workflowId, entry.messageId, entry.text);
}

// A cluster member the client renders (roster from cluster_state) but has no
// local job for — a never-run member after a server restart, whose job was
// never persisted and so couldn't ride the reconnect rehydrate_workflows (the
// client lacks its config). Ask the server to materialize it; otherwise the
// member's transcript pane is stuck on "AWAITING REHYDRATE…" forever. Deduped by
// workflowId (cleared in the workflow_created handler once the job lands) so
// repeated cluster_state pushes don't re-request before materialization.
const requestedMemberRehydrate = new Set<string>();
function requestMissingMemberJobs(
  clusterId: string,
  state: { members?: Array<{ workflowId: string }> },
  deps: WsDeps,
): void {
  const ws = deps.wsRef.current;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const jobs = useAppStore.getState().jobs;
  for (const m of state.members ?? []) {
    if (jobs[m.workflowId]) continue;
    if (requestedMemberRehydrate.has(m.workflowId)) continue;
    requestedMemberRehydrate.add(m.workflowId);
    ws.send(JSON.stringify({ type: 'cluster_member_rehydrate', clusterId, workflowId: m.workflowId }));
  }
}

function appendNativeActivity(workflowId: string, label: string, text: string): void {
  useAppStore.getState().appendActivity(workflowId, {
    id: crypto.randomUUID(),
    kind: 'native_event',
    tool: label,
    text,
    at: Date.now(),
  });
}

// Phase 6 extraction — the entire ws.onmessage body lifted verbatim from
// useWebSocket.ts. `msg` arrives already-parsed (the JSON.parse + try/catch
// stays in the connect() wrapper). Every former `wsRef.current` reference now
// reads `deps.wsRef.current`; nothing else changed. The `const store`
// snapshot semantics (one snapshot per message) are preserved exactly.
export function handleServerMessage(msg: ServerMessage, deps: WsDeps): void {
      const store = useAppStore.getState();

      // Slot 5 — advance lastSeq for any workflow-scoped message carrying a
      // server-stamped seq (live broadcasts AND replayed historical events on
      // reconnect). Math.max in the reducer is robust to out-of-order delivery
      // (e.g., a live event arriving during replay); the snapshot message
      // clamps to its authoritative lastSeq separately below.
      {
        const seq = (msg as { seq?: number }).seq;
        const wfid = (msg as { workflowId?: string }).workflowId;
        if (typeof seq === 'number' && typeof wfid === 'string') {
          store.updateLastSeq(wfid, seq);
          // Phase 8 — fan out narrative events into the per-workflow
          // HISTORY timeline. Returns null for non-narrative kinds so the
          // store is only touched for the small set the timeline renders.
          const histEntry = narrativeEventFromMessage(msg);
          if (histEntry) {
            // primary_complete carries no text on the wire; lift the
            // just-finalized assistant text + its chat-message id off the
            // streamRef so the timeline row shows a meaningful summary
            // and selecting it can scroll/flash the matching bubble.
            if (msg.type === 'primary_complete' && msg.phase === 'passthrough') {
              const ref = streamingMsgs.get(wfid);
              const passthroughId = ref?.passthrough ?? null;
              if (passthroughId) {
                const job = store.jobs[wfid];
                const m = job?.messages.find((x) => x.id === passthroughId);
                if (m && m.content.trim().length > 0) {
                  histEntry.summary = trim80(m.content);
                  histEntry.chatMessageId = passthroughId;
                } else {
                  histEntry.summary = '(no text)';
                }
              }
            }
            store.appendHistoryEvent(wfid, histEntry);
          }
        }
      }

      switch (msg.type) {
        case 'hub_link_status': {
          useHubLinkStore.getState().setStatus({ connected: msg.connected, hubUrl: msg.hubUrl, monitoredCount: msg.monitoredCount, connectedSince: msg.connectedSince });
          break;
        }
        case 'connected': {
          store.setConnected(true, msg.sessionId);
          // Clear any sticky shutdown flag — a fresh `connected` means the
          // server is alive (either never went down, or this is the post-
          // restart reconnect). Lets the ShutdownOverlay auto-dismiss once
          // the restarted process rebinds the port and the WS reconnects.
          if (useAppStore.getState().shutdown) {
            useAppStore.getState().setShutdown(false, null);
          }
          // The server owns the open-tab set (server/src/workspace.ts). Sync
          // first; the `workspace_snapshot` reply reconciles local tabs to it
          // and THEN sends rehydrate_workflows (with lastSeq, for replay of the
          // gap) + cluster_subscribe. Rehydrating before reconciling would
          // resurrect tabs another browser closed while this one was away.
          if (deps.wsRef.current?.readyState === WebSocket.OPEN) {
            sendWorkspaceSync(deps.wsRef.current);
          }
          // Pull the saved cluster-snapshot list so the SAVED CLUSTERS surfaces
          // (WorkflowCreator + cluster right panel) populate on (re)connect.
          if (deps.wsRef.current?.readyState === WebSocket.OPEN) {
            deps.wsRef.current.send(JSON.stringify({ type: 'cluster_snapshot_list' }));
          }
          break;
        }

        case 'workspace_snapshot':
        case 'workspace_changed':
          applyWorkspace(deps.wsRef.current, msg.workspace, msg.type === 'workspace_snapshot');
          break;

        case 'workflow_config_synced':
          store.replaceJobConfig(msg.workflowId, msg.config);
          break;

        case 'app_update_available':
          useAppUpdateStore.getState().receive(msg);
          break;

        case 'settings_updated':
          // Global settings carry the shared tab order — refetch so a reorder
          // in another browser lands live instead of on next reconnect.
          if (msg.scope === 'global') {
            fetch('/api/settings')
              .then((r) => (r.ok ? r.json() : null))
              .then((next) => { if (next) store.setSettings(next); })
              .catch(() => { /* next connect refetches */ });
          }
          break;

        case 'live_changes_snapshot': {
          useLiveChangesStore.getState().onSnapshot(msg);
          break;
        }

        case 'workflow_created': {
          // A member job just materialized — clear its rehydrate-request guard
          // so a future genuine gap (e.g. re-add) can request again.
          const restored = requestedMemberRehydrate.delete(msg.workflowId);
          store.createJob(
            msg.workflowId,
            msg.config,
            msg.resumedVia,
            msg.parentWorkflowId,
            msg.backgroundCreated,
            restored,
          );
          if (msg.claudeSessionId) store.setClaudeSessionId(msg.workflowId, msg.claudeSessionId);
          // docs/ARCHITECTURE.md - a research run dispatched to a
          // fresh tab carries a one-shot spawn token on its config. When the
          // tab materializes here, fire the deferred research_request against
          // its real workflow id.
          {
            const pendingResearch = takePendingResearch(msg.config.researchSpawnToken);
            if (pendingResearch && deps.wsRef.current?.readyState === WebSocket.OPEN) {
              deps.wsRef.current.send(JSON.stringify({
                type: 'research_request',
                workflowId: msg.workflowId,
                researcher: pendingResearch.researcher,
                topic: pendingResearch.topic,
                maxRounds: pendingResearch.maxRounds,
              }));
            }
          }
          // docs/ARCHITECTURE.md - a tab minted from a template
          // carries a one-shot spawn token. When the tab materializes, apply
          // the deferred seedPrompt (composer pre-fill — NOT auto-sent) + plan
          // (create + attach via REST) against its real workflow id. Pre-fill
          // only; auto-sending would breach the operator-initiated fence.
          {
            const pendingTemplate = takePendingTemplateApply(msg.config.templateSpawnToken);
            if (pendingTemplate) {
              if (pendingTemplate.seedPrompt) {
                store.setDraft(msg.workflowId, pendingTemplate.seedPrompt);
              }
              if (pendingTemplate.plan && msg.config.workingDirectory) {
                const wfId = msg.workflowId;
                const cwd = msg.config.workingDirectory;
                const body = pendingTemplate.plan;
                // First markdown H1, else first non-empty line, else fallback.
                const title = (body.match(/^#\s+(.+)$/m)?.[1]
                  ?? body.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
                  ?? 'Plan').slice(0, 120);
                void fetch(`/api/plans?path=${encodeURIComponent(cwd)}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ title, body, attach: true, workflowId: wfId }),
                }).catch(() => { /* best-effort pre-fill; operator can retry from PLAN tab */ });
              }
            }
          }
          if (msg.sessionMetadata) {
            store.setSessionMetadata(msg.workflowId, msg.sessionMetadata);
          }
          // Phase 7b — parented Task children skip the [RESUMED]/transcript
          // hydration banners. The parent's chat already has the inline
          // card; the child's chat is read-only-from-the-parent until the
          // operator promotes it, at which point the child's events.jsonl
          // replay + cliSessions chain rebuild the chat from scratch.
          if (msg.parentWorkflowId) break;
          // Hydration branches:
          //   hydrationSource === 'events' — server is streaming events.jsonl
          //     replay on this same socket right after this message. Every
          //     broadcast (worker_spawn, worker_text, orchestrator_text,
          //     user_message_echo, dispatch_mode, artifacts, …) flows through
          //     the normal onmessage handlers and rebuilds chat in seq order.
          //     Do NOT fetch the Claude JSONL — it would duplicate user
          //     prompts (already covered by user_message_echo) and overlay
          //     raw dispatch-JSON blobs that chat already resolves into
          //     proper assistant streams via orchestrator_text.
          //   hydrationSource === 'transcript' — legacy / empty-event-log
          //     fallback. Pre-Slot-5 workflows or anything that pre-dates the
          //     Slot-12-resume fix where events.jsonl has no entries.
          //   undefined — brand-new workflow, nothing to hydrate.
          if (msg.hydrationSource === 'events') {
            // Event-log replay incoming; no transcript fetch. Emit a small
            // system notice so the operator sees that history is being
            // replayed rather than thinking the workflow is blank while the
            // stream is still arriving.
            useAppStore.getState().addMessage(msg.workflowId, {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[RESUMED${msg.resumedVia ? ` (${msg.resumedVia})` : ''}] Replaying event log…`,
              isStreaming: false,
              timestamp: Date.now(),
            });
            break;
          }
          const cwd = msg.config.workingDirectory;
          const transcriptSessionId = msg.priorSessionId ?? msg.priorClaudeSessionId ?? msg.config.resumeSessionId;
          // priorProvider lands on newer server builds; on older ones we fall
          // back to assuming Claude (matches prior behavior since only Claude
          // used to have a transcript endpoint).
          const transcriptProvider = msg.priorProvider ?? 'claude';
          if (msg.hydrationSource === 'transcript' && transcriptSessionId && cwd) {
            const q = new URLSearchParams({ path: cwd, sessionId: transcriptSessionId, provider: transcriptProvider });
            fetch(`/api/transcript?${q.toString()}`)
              .then((r) => r.ok ? r.json() : Promise.reject(r.statusText))
              .then((d: { messages?: ChatMessage[]; hasEarlier?: boolean; earlierCursor?: number; total?: number }) => {
                if (d.messages && d.messages.length > 0) {
                  useAppStore.getState().prependMessages(msg.workflowId, d.messages);
                  const viaLabel = msg.resumedVia === 'bootstrapped'
                    ? ' (bootstrapped from build-log)'
                    : msg.resumedVia === 'native'
                      ? ' (native)'
                      : '';
                  const earlierNote = d.hasEarlier && typeof d.total === 'number'
                    ? ` (${d.total - d.messages.length} earlier available)`
                    : '';
                  useAppStore.getState().addMessage(msg.workflowId, {
                    id: crypto.randomUUID(),
                    role: 'system',
                    content: `[RESUMED${viaLabel}] Loaded ${d.messages.length} prior message(s)${earlierNote}.`,
                    isStreaming: false,
                    timestamp: Date.now(),
                  });
                  if (d.hasEarlier && typeof d.earlierCursor === 'number') {
                    useAppStore.getState().setEarlierState(msg.workflowId, {
                      hasEarlierSessionHistory: true,
                      earlierSource: 'transcript',
                      earlierTranscriptCursor: d.earlierCursor,
                      transcriptFetch: { sessionId: transcriptSessionId, provider: transcriptProvider as 'claude' | 'codex', cwd },
                    });
                  }
                } else {
                  // Hydration fetched zero rows (rollout not found, or empty).
                  // Fall back to the old blank-chat notice so the operator
                  // isn't left wondering whether anything is replaying.
                  useAppStore.getState().addMessage(msg.workflowId, {
                    id: crypto.randomUUID(),
                    role: 'system',
                    content: '[RESUMED (native)] No prior messages hydrated; CLI session context is still live for the next turn.',
                    isStreaming: false,
                    timestamp: Date.now(),
                  });
                }
              })
              .catch(() => { /* nothing to hydrate → just start fresh */ });
          } else if (msg.resumedVia) {
            // Resumed with no hydration source — e.g. a provider we don't
            // parse transcripts for yet. CLI still has context via its own
            // resume mechanism; chat just starts blank here.
            useAppStore.getState().addMessage(msg.workflowId, {
              id: crypto.randomUUID(),
              role: 'system',
              content: '[RESUMED (native)] Prior turns live in the CLI session; they\'re not shown here, but new turns will continue the conversation.',
              isStreaming: false,
              timestamp: Date.now(),
            });
          }
          break;
        }

        case 'bakeoff_list_result': {
          store.setBakeoffs(msg.workflowId, msg.bakeoffs);
          break;
        }

        case 'bakeoff_state': {
          store.upsertBakeoff(msg.workflowId, msg.bakeoff);
          break;
        }

        case 'bakeoff_error': {
          store.pushNotification('error', `Bake-off: ${msg.error}`);
          break;
        }

        case 'bakeoff_attempts_removed': {
          for (const workflowId of msg.workflowIds) store.removeJob(workflowId);
          store.pushNotification(
            'info',
            `Removed ${msg.attemptIds.length} bake-off worktree${msg.attemptIds.length === 1 ? '' : 's'}; branches were preserved.`,
          );
          break;
        }

        case 'queued_message_cancelled': {
          useAppStore.getState().removeMessage(msg.workflowId, msg.clientMessageId);
          break;
        }

        case 'queue_update': {
          // Phase 4 — server-authoritative queue snapshot. Set on every
          // mutation (enqueue / drain / cancel-one / cancel-all) and replayed
          // from events.jsonl on reconnect, so the queue strip survives both
          // a server restart and a client reload. The optimistic
          // ChatMessage.queued path still runs on the originating tab for
          // immediate echo; this is the source of truth for the strip.
          useAppStore.setState((s) => {
            const job = s.jobs[msg.workflowId];
            if (!job) return s;
            return {
              jobs: {
                ...s.jobs,
                [msg.workflowId]: {
                  ...job,
                  queue: { steering: msg.steering, followUp: msg.followUp },
                },
              },
            };
          });
          break;
        }

        case 'queued_messages_drained': {
          // Server pulled the interjection queue and merged it into the next
          // turn's prompt. Flip queued:false on each matching optimistic
          // message so the QueuedMessagesIndicator empties, and rebase the
          // timestamp to drainedAt — for Claude this puts the optimistic
          // entry inside ChatPanel's 5s sessionChat dedup window when the
          // JSONL echo lands shortly. Without this rebase, a queue wait of
          // minutes would put the optimistic ts and the session_entry ts
          // far enough apart that both would render. Non-Claude providers
          // never get a session_entry; the optimistic stays as the
          // canonical chat render with queued:false.
          const store = useAppStore.getState();
          // Stagger timestamps by 1 ms per id so multiple queued messages
          // sort in their original queue order — the server merges them
          // into one prompt anyway, but the chat view keeps the individual
          // bubbles, and identical timestamps would let them shuffle.
          //
          // Phase 4 follow-up: the mid-turn steer split already pre-settles
          // the optimistic (queued:false + timestamp pinned at echo arrival)
          // so it sits between the before-/after-halves of the split
          // assistant block. Skip the drainedAt rebase in that case —
          // overwriting would push the steer past the after-half.
          msg.clientMessageIds.forEach((id, i) => {
            const job = useAppStore.getState().jobs[msg.workflowId];
            const existing = job?.messages.find((m) => m.id === id);
            if (existing && existing.queued === false) return;
            store.updateMessage(msg.workflowId, id, { queued: false, timestamp: msg.drainedAt + i });
          });
          break;
        }

        case 'user_message_echo': {
          const store = useAppStore.getState();
          const ref = getStreamRef(msg.workflowId);
          const echoSeq = (msg as { seq?: number }).seq;
          const splitFromStreaming = msg.kind === 'steer' && ref.passthrough !== null;
          const splitTimestamp = Date.now();
          if (splitFromStreaming) {
            const oldId = ref.passthrough!;
            // First split of this turn mints a stable parentTurnId derived
            // from the steer's seq (replay-deterministic). Subsequent splits
            // in the same turn keep the same id so all halves stay grouped.
            if (!ref.parentTurnId) {
              ref.parentTurnId = `turn-split-${echoSeq ?? splitTimestamp}`;
            }
            store.updateMessage(msg.workflowId, oldId, {
              isStreaming: false,
              parentTurnId: ref.parentTurnId,
            });
            ref.passthrough = null;
          }

          const job = store.jobs[msg.workflowId];
          if (job && msg.clientMessageId && job.messages.some((m) => m.id === msg.clientMessageId)) {
            if (splitFromStreaming) {
              store.updateMessage(msg.workflowId, msg.clientMessageId, {
                queued: false,
                timestamp: splitTimestamp,
              });
            }
            break;
          }
          store.addMessage(msg.workflowId, {
            id: msg.clientMessageId ?? crypto.randomUUID(),
            role: 'user',
            content: msg.content,
            isStreaming: false,
            attachments: msg.attachments,
            // For mid-turn splits, ts pins between the before/after halves
            // (Date.now() at echo arrival sits between first-delta-time and
            // next-delta-time). Otherwise keep the server-stamped ts so
            // post-turn drains still flow through the regular dedup path.
            timestamp: splitFromStreaming ? splitTimestamp : msg.timestamp,
            // Phase 4 — replay path: a remote tab (or post-reload originating
            // tab whose optimistic was pruned) gets the kind from the echo so
            // the chat-side queue indicator can still tell steer from
            // follow-up. Mid-turn splits skip the queued flag — the bubble
            // is already settled at echo time on this path too.
            ...(msg.kind
              ? splitFromStreaming
                ? { queueKind: msg.kind }
                : { queueKind: msg.kind, queued: true }
              : {}),
          });
          break;
        }

        case 'primary_text': {
          // §C1 — primary is emitting; refresh the stuck clock.
          store.bumpPrimaryEvent(msg.workflowId, Date.now());
          const ref = getStreamRef(msg.workflowId);
          const key = msg.phase;
          // Late-text guard: a primary_text can arrive AFTER primary_turn_ended
          // because the server's `settled.then(...)` resolution is a microtask —
          // any worker_text dispatched between the `result` event and that
          // microtask broadcasts after primary_turn_ended has already cleared
          // isStreaming and busy on the client. Without this guard, the late
          // chunk creates a fresh streaming message that nothing will ever
          // finalize (primary_complete already fired), and the composer stays
          // pinned in interjection mode (b0·w0·s1) until the next turn.
          //
          // But a late burst is rarely a single chunk — the final answer can
          // stream as dozens of deltas after primary_turn_ended. The original
          // guard minted one finalized bubble *per delta*, so the whole answer
          // fragmented into a stack of "< ARCO :: PASSTHROUGH" rows (one per
          // token-ish chunk). That fragmented state then persisted to
          // localStorage and reappeared on reload, while a clean seq-ordered
          // RESUME replay (where the text sits before primary_turn_ended) showed
          // it coalesced — the exact divergence operators hit. Fix: reuse
          // ref[key] as a coalesce target here too, so the burst lands as ONE
          // finalized bubble. The same path also covers a rehydrate replay whose
          // window opens mid-turn (clientLastSeq fell between turn start/end, so
          // the bracketing primary_turn_started was never re-sent). ref[key] is
          // cleared on the (eventual / replayed) primary_complete or
          // primary_turn_ended, so the next turn starts clean.
          const job = useAppStore.getState().jobs[msg.workflowId];
          const turnInProgress = job?.busy === true || job?.turnStartedAt !== undefined;
          if (!turnInProgress) {
            if (!ref[key]) {
              const id = crypto.randomUUID();
              ref[key] = id;
              store.addMessage(msg.workflowId, {
                id,
                role: 'assistant',
                content: msg.text,
                // Finalized, not streaming: late/replayed text is historical, and
                // leaving it streaming would re-pin the composer in interjection
                // mode (the bug the original guard fixed) since nothing will
                // finalize it.
                isStreaming: false,
                phase: msg.phase,
                timestamp: Date.now(),
              });
            } else {
              if (job?.config.kind === 'chat') queueChatDelta(msg.workflowId, key, ref[key]!, msg.text);
              else store.appendToStreamingMessage(msg.workflowId, ref[key]!, msg.text);
            }
            break;
          }
          if (!ref[key]) {
            // Mid-turn-split continuation: derive a deterministic id from the
            // current event seq so reload/replay reconstructs the same chat
            // row instead of minting a fresh random id each time. Tag with
            // parentTurnId so the before/after halves of the split turn can
            // be regrouped by future code (Review, HISTORY, etc.).
            const primarySeq = (msg as { seq?: number }).seq;
            const id = ref.parentTurnId
              ? `${ref.parentTurnId}::cont-${primarySeq ?? Date.now()}`
              : crypto.randomUUID();
            ref[key] = id;
            store.addMessage(msg.workflowId, {
              id,
              role: 'assistant',
              content: '',
              isStreaming: true,
              phase: msg.phase,
              timestamp: Date.now(),
              ...(ref.parentTurnId ? { parentTurnId: ref.parentTurnId } : {}),
            });
          }
          if (job?.config.kind === 'chat') queueChatDelta(msg.workflowId, key, ref[key]!, msg.text);
          else store.appendToStreamingMessage(msg.workflowId, ref[key]!, msg.text);
          break;
        }

        case 'primary_complete': {
          // §C1 — completion is a primary signal too (keeps lastPrimaryEventAt
          // fresh through the turn boundary).
          store.bumpPrimaryEvent(msg.workflowId, Date.now());
          const ref = getStreamRef(msg.workflowId);
          const key = msg.phase;
          flushChatDelta(msg.workflowId, key);
          if (ref[key]) {
            store.finalizeMessage(msg.workflowId, ref[key]!);
            ref[key] = null;
          }
          if (msg.costUsd > 0) {
            store.addCost(msg.workflowId, msg.costUsd);
          }
          if (msg.tokens) {
            store.addTokens(msg.workflowId, msg.tokens);
            store.setLastTurnTokens(msg.workflowId, msg.tokens);
          }
          // Provider-reported context window (Codex emits this; Claude
          // doesn't). When set, the CTX-bar denominator uses it directly
          // instead of the client's hardcoded codexModelWindow() fallback.
          if (typeof msg.modelContextWindow === 'number' && msg.modelContextWindow > 0) {
            store.setModelContextWindow(msg.workflowId, msg.modelContextWindow);
          }
          if (typeof msg.lastPromptTokens === 'number' && msg.lastPromptTokens > 0) {
            pendingLastPromptTokens.set(msg.workflowId, msg.lastPromptTokens);
          }
          // Always overwrite: a turn with no timing (error / cancel / untimed-provider
          // passthrough) must clear the footer rather than leave the previous
          // turn's speed labelled "Last turn".
          store.setLastGenSpeed(msg.workflowId, msg.genSpeed);
          if (msg.genSpeed) pendingGenSpeed.set(msg.workflowId, msg.genSpeed);
          // PLAN-button capture: if the operator pre-armed this turn, snapshot
          // the just-finalized assistant reply into the planCandidate slot.
          // The composer banner picks it up and either offers Save/Discard or
          // (autosave mode) self-fires the save.
          //
          // Detection-based fallback: if pendingPlanCapture was NOT set but the
          // reply is clearly plan-shaped (H1 + ≥3 markdown checkboxes), still
          // surface the banner in review mode. This catches the cases where
          // (a) the operator asked for a plan via free-form prompt without
          // clicking the PLAN composer button, or (b) the pre-arm flag was
          // dropped before primary_complete (page reload mid-turn, etc.).
          // The conservative heuristic avoids false positives on normal
          // replies — operator can DISCARD if they don't want it.
          if (msg.phase === 'passthrough') {
            const job = useAppStore.getState().jobs[msg.workflowId];
            const pending = job?.pendingPlanCapture;
            const lastAssistant = [...(job?.messages ?? [])]
              .reverse()
              .find((m) => m.role === 'assistant' && !m.toolUse && !m.isStreaming);
            const body = lastAssistant?.content?.trim() ?? '';
            const memberClusterId = Object.values(store.clusters)
              .find((cluster) => cluster.members.some((m) => m.workflowId === msg.workflowId))
              ?.clusterId;
            if (pending && body.length > 0) {
              if (memberClusterId && deps.wsRef.current?.readyState === WebSocket.OPEN) {
                deps.wsRef.current.send(JSON.stringify({ type: 'cluster_plan_set', clusterId: memberClusterId, body }));
              } else {
                store.setPlanCandidate(msg.workflowId, {
                  body,
                  mode: pending,
                  capturedAt: Date.now(),
                });
              }
              store.setPendingPlanCapture(msg.workflowId, null);
            } else if (!pending && body.length > 0 && !job?.planCandidate && looksLikePlan(body)) {
              if (memberClusterId && deps.wsRef.current?.readyState === WebSocket.OPEN) {
                deps.wsRef.current.send(JSON.stringify({ type: 'cluster_plan_set', clusterId: memberClusterId, body }));
              } else {
                store.setPlanCandidate(msg.workflowId, {
                  body,
                  mode: 'review',
                  capturedAt: Date.now(),
                });
              }
            }
          }
          break;
        }

        case 'primary_turn_token_usage':
          // docs/PROVIDERS.md - append the per-turn telemetry frame
          // to the job's sliding window. The Activity tab reads it for the
          // "Token usage" section. Capped server-side via the store reducer.
          store.appendTurnTokenUsage(msg.workflowId, {
            ...msg,
            lastPromptTokens: msg.lastPromptTokens ?? pendingLastPromptTokens.get(msg.workflowId),
          });
          pendingLastPromptTokens.delete(msg.workflowId);
          break;

        case 'tool_filtered':
          // docs/PROVIDERS.md - store the per-tool filter annotation
          // keyed by toolUseId so ToolCallPill can render the chip with raw-
          // bytes recovery. No-op when the original/filtered byte counts
          // match; the chip is still mounted (operators sometimes want to
          // see which packs ran even on passthroughs).
          store.recordToolFiltered(msg.workflowId, {
            toolUseId: msg.toolUseId,
            filterName: msg.filterName,
            originalBytes: msg.originalBytes,
            filteredBytes: msg.filteredBytes,
            ...(msg.rawArtifactPath ? { rawArtifactPath: msg.rawArtifactPath } : {}),
          });
          appendNativeActivity(
            msg.workflowId,
            'FILTER',
            `${msg.toolName} · ${msg.filterName} · ${msg.originalBytes}B -> ${msg.filteredBytes}B${msg.rawArtifactPath ? ` · raw: ${msg.rawArtifactPath}` : ''}`,
          );
          break;

        case 'primary_tool_counter':
          // docs/PROVIDERS.md - worker-authoritative tool-call
          // counter. Mirrored onto JobState so the composer chip can read
          // it instead of recounting events. Resets land as count=0.
          store.setToolCallsSinceCompact(msg.workflowId, msg.toolCallsSinceCompact);
          break;

        case 'sandbox_chunk_added':
          // docs/PROVIDERS.md - best-effort live counter for
          // the Files-tab sub-section. The server is the source of truth
          // via /api/workflows/:wfId/sandbox/stats; this just makes the
          // chip update without a refetch on every chunk insert.
          store.bumpSandboxChunkCount(msg.workflowId);
          appendNativeActivity(msg.workflowId, 'SANDBOX', `${msg.language} chunk stored · ${msg.byteLen}B`);
          break;

        case 'sandbox_db_cleared':
          store.resetSandboxChunkCount(msg.workflowId);
          break;

        case 'diagnostics':
          // §C3 — LSP diagnostics for one file. Replaces the per-file entry
          // (empty items[] clears it). Surfaced as a count badge + list on the
          // Activity tab. Native-only; other transports never emit it.
          store.setDiagnostics(msg.workflowId, msg.file, msg.items);
          break;

        case 'hook_rewrote_input':
          appendNativeActivity(
            msg.workflowId,
            'HOOK',
            `${msg.toolName} input rewritten by ${msg.hookCommand}`,
          );
          break;

        case 'tool_gate_triggered':
          appendNativeActivity(
            msg.workflowId,
            msg.decision === 'blocked' ? 'GATE' : 'CHECK',
            `${msg.toolName} · ${msg.gate} · ${msg.decision}${msg.reason ? ` · ${msg.reason}` : ''}`,
          );
          break;

        case 'model_resolved':
          // Opus-5 plan Phase 2 — the alias tab's explicit release signal:
          // Anthropic resolved e.g. `opus` → `claude-opus-5` this session.
          // The chat header already upgraded via primary_model; this makes
          // the resolution reviewable in Activity + events.jsonl.
          appendNativeActivity(
            msg.workflowId,
            'MODEL',
            `${msg.requested} → ${msg.served}`,
          );
          break;

        case 'primary_refusal':
          // Opus-5 plan Phase 3 — classifier decline (HTTP 200). The paired
          // system_notice carries the operator-facing copy in chat; this is
          // the Activity/transcript-review trace.
          appendNativeActivity(
            msg.workflowId,
            'REFUSAL',
            `${msg.category ?? 'uncategorized'}${msg.hadPartialOutput ? ' · partial output kept' : ' · no output'}${msg.explanation ? ` · ${msg.explanation}` : ''}`,
          );
          break;

        case 'ctx_action': {
          // `strip_trailing_thinking` is a routine per-round protocol-
          // conformance normalization for interleaved-thinking models (Opus
          // 4.8 ends nearly every round on a thinking block; Anthropic forbids
          // resending an assistant message that ends in one — see
          // docs/GOTCHAS.md). It fires on most multi-round turns, so rendering
          // it as a chat divider is noise, not signal. Still persisted to
          // events.jsonl server-side (broadcastWorkflow) for the audit trail —
          // we just don't clutter the conversation with it. The genuinely-rare
          // recovery actions (prune_orphan_tool_use, scrub_empty_text_blocks)
          // keep their divider.
          if (msg.action === 'strip_trailing_thinking') break;
          appendNativeActivity(
            msg.workflowId,
            'CTX',
            `${msg.action} (${msg.trigger})${msg.detail ? ` · ${msg.detail}` : ''}`,
          );
          // docs/PROVIDERS.md - context-management ledger.
          // Render as a horizontal-rule divider in the chat so transcript
          // review sees when context was reshaped. The synthetic message
          // uses role='ctx-divider' (early-return in ChatMessage.tsx) so
          // it bypasses every other rendering branch including markdown.
          // docs/PROVIDERS.md - `turn_notice` fires on every
          // cluster turn with mail waiting / every armed plan-mode turn; the
          // Activity row above is its surface, a divider per turn is noise.
          if (msg.action === 'turn_notice') break;
          const triggerLabel: Record<string, string> = {
            'operator': 'operator',
            'auto-threshold': 'auto-threshold',
            'model': 'model',
            'recovery': 'recovery',
            'api': 'anthropic',
          };
          const actionLabel: Record<string, string> = {
            'clear_thinking': 'clear thinking',
            'clear_tool_uses': 'clear tool uses',
            'compact': 'compact',
            'sandbox_redirect': 'sandbox redirect',
            'first_edit_gate': 'first edit gate',
            'prune_orphan_tool_use': 'prune orphan tool_use',
            'scrub_empty_text_blocks': 'scrub empty text blocks',
            'strip_trailing_thinking': 'strip trailing thinking',
            'system_delta': 'system prompt update appended',
            'tool_set_change': 'tool set change appended',
            'thinking_dropped_by_api': 'thinking dropped by API',
            'strip_thinking_binding_mismatch': 'strip thinking (binding mismatch)',
          };
          const action = actionLabel[msg.action] ?? msg.action;
          const trigger = triggerLabel[msg.trigger] ?? msg.trigger;
          const detail = msg.detail ? ` · ${msg.detail}` : '';
          store.addMessage(msg.workflowId, {
            id: crypto.randomUUID(),
            role: 'ctx-divider',
            content: `${action} (${trigger})${detail}`,
            isStreaming: false,
            timestamp: Date.now(),
          });
          break;
        }

        case 'native_compacting':
          // NATIVE_COMPACTION_PLAN Phase 3 — pre-compaction marker. Flip the
          // per-workflow takeover so ChatPanel renders the prominent
          // "Compacting conversation…" overlay (distinct from the small
          // ctx_action divider) and the composer greys its send. Cleared on
          // native_compacted (success) / a compaction-failure system_notice /
          // the turn boundary so it can never stick on.
          store.beginCompacting(msg.workflowId, msg.foldedTurns);
          appendNativeActivity(msg.workflowId, 'COMPACT', `started · folding ${msg.foldedTurns} turn${msg.foldedTurns === 1 ? '' : 's'}`);
          break;

        case 'context_folded':
          // Fold / Server Fold settled (the durable reseed is server-side).
          // A Server Fold's summarization call is billed outside any turn, so
          // add its usage.iterations spend to the tab's token total here — on
          // live AND replay, same as primary_complete.
          if (msg.compactionUsage) {
            store.addTokens(msg.workflowId, {
              input: msg.compactionUsage.input,
              output: msg.compactionUsage.output,
              cacheRead: msg.compactionUsage.cacheRead,
              cacheCreate: msg.compactionUsage.cacheCreate,
            });
          }
          appendNativeActivity(
            msg.workflowId,
            msg.engine === 'server' ? 'S-FOLD' : 'FOLD',
            `${msg.foldedTurns ?? 0} turn(s) folded${typeof msg.byteDelta === 'number' ? ` · ~${Math.round(msg.byteDelta / 1024)} KB` : ''}${msg.engine === 'server' ? ` · kept ${msg.keptTurns ?? 0} verbatim${msg.compactionUsage ? ` · ${msg.compactionUsage.input + msg.compactionUsage.cacheRead + msg.compactionUsage.cacheCreate} in / ${msg.compactionUsage.output} out tok` : ''}` : ''}`,
          );
          break;

        case 'native_compacted':
          // NATIVE_COMPACTION_PLAN Phase 3 — compaction settled. Clear the
          // takeover and open the post-compaction "Continue" affordance
          // (compactedResume) the composer surfaces. Note: the durable summary
          // re-seed is server-side (replay re-applies it via compactSummarySeed);
          // the client only tracks the live UX here. When the operator opted into
          // `nativeCompactAutoContinue`, the server auto-sends a continuance turn
          // and the next primary_turn_started clears this banner anyway.
          store.endCompacting(msg.workflowId, msg.foldedTurns);
          appendNativeActivity(msg.workflowId, 'COMPACT', `completed · folded ${msg.foldedTurns} turn${msg.foldedTurns === 1 ? '' : 's'}`);
          break;

        case 'primary_model':
          store.setPrimaryModel(msg.workflowId, msg.resolvedModel);
          break;

        case 'tool_posture_set':
          store.setToolPosture(msg.workflowId, msg.posture);
          appendNativeActivity(msg.workflowId, 'POSTURE', `tool posture → ${msg.posture}`);
          break;

        case 'goal_set':
          store.setWorkflowGoal(msg.workflowId, msg.goal);
          appendNativeActivity(msg.workflowId, 'GOAL', msg.goal ? `north-star set · ${msg.byteLen}B` : 'north-star cleared');
          break;

        case 'goal_run_state':
          store.setGoalRun(
            msg.workflowId,
            msg.enabled
              ? {
                  enabled: true,
                  total: msg.total,
                  remaining: msg.remaining,
                  tokensUsed: msg.tokensUsed,
                  ...(typeof msg.tokenBudget === 'number' ? { tokenBudget: msg.tokenBudget } : {}),
                }
              : undefined,
          );
          appendNativeActivity(
            msg.workflowId,
            'GOAL',
            msg.enabled
              ? `goal run ${msg.total - msg.remaining}/${msg.total} · ${msg.tokensUsed} tok`
              : 'goal run off',
          );
          break;

        case 'pinned_skills_set':
          store.updateJobPrimary(msg.workflowId, {
            pinnedSkills: msg.skills.map((s) => ({ scope: s.scope, slug: s.slug })),
          });
          appendNativeActivity(
            msg.workflowId,
            'SKILLS',
            `${msg.skills.length} pinned · ${msg.bytes}B` +
              (msg.missing.length ? ` · skipped ${msg.missing.join(', ')}` : ''),
          );
          break;

        case 'project_trust_prompt':
          store.setProjectTrustPrompt(msg.workflowId, { cwd: msg.cwd, resources: msg.resources });
          appendNativeActivity(msg.workflowId, 'TRUST', `prompt · suppressed: ${msg.resources.join(', ')}`);
          break;

        case 'project_trust_set':
          // Decision recorded — dismiss any pending prompt for this tab.
          store.setProjectTrustPrompt(msg.workflowId, undefined);
          appendNativeActivity(msg.workflowId, 'TRUST', `recorded → ${msg.decision}`);
          break;

        case 'primary_turn_started': {
          useAppStore.setState((s) => {
            const job = s.jobs[msg.workflowId];
            return job?.config.voiceOperator ? { jobs: { ...s.jobs, [job.id]: { ...job, computerTurnActive: true } } } : s;
          });
          store.beginPrimaryTurn(msg.workflowId, msg.startedAt);
          // NATIVE_COMPACTION_PLAN Phase 3 — a real operator turn starting means
          // the compaction is over and any post-compaction Continue banner has
          // been consumed (the operator clicked Continue or sent a message, or
          // the opt-in auto-continue fired). Clear both so neither sticks.
          store.clearCompacting(msg.workflowId);
          // §C1 — first signal of the turn; seeds the stuck-vs-busy clock so a
          // turn that starts but never emits content reads as stuck after the
          // threshold rather than staying "busy" forever.
          store.bumpPrimaryEvent(msg.workflowId, msg.startedAt ?? Date.now());
          // Drop any phase ref a prior turn left dangling so this turn's first
          // delta mints a fresh bubble. Normally primary_turn_ended already
          // nulled these; the exception is the late-text coalesce branch in
          // primary_text, which sets ref[key] *after* primary_turn_ended fired
          // (the settled.then microtask race). Without this clear, that stale
          // ref would survive into the new turn and the new turn's text would
          // append onto the previous turn's late bubble.
          const ref = getStreamRef(msg.workflowId);
          ref.planning = null;
          ref.synthesis = null;
          ref.passthrough = null;
          break;
        }

        case 'primary_turn_ended': {
          flushChatDelta(msg.workflowId, 'planning');
          flushChatDelta(msg.workflowId, 'synthesis');
          flushChatDelta(msg.workflowId, 'passthrough');
          // Capture turnStartedAt before endPrimaryTurn clears it, so we can
          // stamp the turn's duration into the chat as a persistent record.
          // Without this, the only sense of how long a turn took is the live
          // PrimaryStatus elapsed counter, which vanishes the moment the turn
          // ends. Reading from store.jobs is fine here — useWebSocket runs
          // outside the React render cycle so there's no stale-closure risk.
          const job = useAppStore.getState().jobs[msg.workflowId];
          const startedAt = job?.turnStartedAt;
          const endedAt = msg.endedAt ?? Date.now();
          if (startedAt && endedAt > startedAt) {
            const totalS = (endedAt - startedAt) / 1000;
            const m = Math.floor(totalS / 60);
            const remS = totalS - m * 60;
            const label = m > 0 ? `${m}m ${remS.toFixed(1)}s` : `${remS.toFixed(1)}s`;
            const speed = pendingGenSpeed.get(msg.workflowId);
            const decode = speed ? tokensPerSecond(speed.decodeTokens, speed.decodeMs) : null;
            store.addMessage(msg.workflowId, {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[TURN · ${label}${decode !== null ? ` · ${formatTokPerSec(decode)} tok/s` : ''}]`,
              isStreaming: false,
              timestamp: endedAt,
            });
          }
          pendingGenSpeed.delete(msg.workflowId);
          store.endPrimaryTurn(msg.workflowId);
          // Drop the streamRef so any in-flight refs (e.g. a primary_complete
          // that finalized passthrough but left planning/synthesis dangling)
          // don't survive the turn boundary. Pairs with the late-text guard
          // in primary_text — together they guarantee no streaming message
          // can outlive primary_turn_ended.
          {
            const ref = getStreamRef(msg.workflowId);
            ref.planning = null;
            ref.synthesis = null;
            ref.passthrough = null;
            // Render-layer split state is per-turn — drop so the next turn's
            // first delta mints a fresh parentTurnId on demand.
            ref.parentTurnId = null;
          }
          break;
        }

        case 'primary_tool_use':
          // §C1 — tool activity is a primary signal; refresh the stuck clock.
          store.bumpPrimaryEvent(msg.workflowId, Date.now());
          // docs/PROVIDERS.md - count only settled tool calls.
          // The 'completed'/'failed' filter avoids double-counting Codex's
          // 'started'/'in_progress' deltas (which fire multiple times per
          // call). When status is absent (Native + most paths) the row
          // represents a single dispatched call → also counts.
          if (!msg.status || msg.status === 'completed' || msg.status === 'failed') {
            store.bumpToolCallsSinceHandoff(msg.workflowId);
          }
          store.appendActivity(msg.workflowId, {
            id: crypto.randomUUID(),
            kind: 'tool_use',
            tool: msg.tool,
            input: msg.input,
            status: msg.status,
            provider: msg.provider,
            itemType: msg.itemType,
            itemId: msg.itemId,
            output: msg.output,
            exitCode: msg.exitCode,
            toolUseId: msg.toolUseId,
            at: Date.now(),
          });
          break;

        case 'task_started':
          store.recordTaskStarted(msg.workflowId, {
            taskId: msg.taskId,
            childWorkflowId: msg.childWorkflowId,
            toolUseId: msg.toolUseId,
            description: msg.description,
            startedAt: msg.startedAt,
          });
          break;

        case 'task_status':
          store.recordTaskStatus(msg.workflowId, {
            taskId: msg.taskId,
            toolUseId: msg.toolUseId,
            phase: msg.phase,
            elapsedMs: msg.elapsedMs,
            summary: msg.summary,
          });
          break;

        case 'primary_activity':
          // §C1 — change-gated heartbeat (fires only when the descendant set
          // changes), so it's a weak liveness signal, not a true heartbeat —
          // but it's still primary activity, so refresh the clock here. The
          // deriver does NOT rely on this as a heartbeat (see GOTCHAS §C1).
          store.bumpPrimaryEvent(msg.workflowId, Date.now());
          store.setPrimaryBackgroundJobs(msg.workflowId, msg.jobs);
          break;

        case 'primary_thinking':
          // Old unsupported-provider reasoning remains hidden during replay.
          if (store.jobs[msg.workflowId] && !PRIMARY_PROVIDERS.includes(store.jobs[msg.workflowId].config.primaryProvider ?? 'claude')) break;
          // §C1 — thinking deltas are primary signal; refresh the stuck clock.
          store.bumpPrimaryEvent(msg.workflowId, Date.now());

          store.appendActivity(msg.workflowId, {
            id: crypto.randomUUID(),
            kind: 'thinking',
            text: msg.text,
            at: Date.now(),
          });
          break;

        case 'ultracode_fleet_progress':
          // docs/PROVIDERS.md - live background-fleet snapshot for the FLEET
          // panel atop the Activity tab. Refresh the stuck-clock too: the fleet
          // churning IS turn progress even when the parent stream is quiet.
          store.bumpPrimaryEvent(msg.workflowId, Date.now());
          store.setUltracodeFleet(msg.workflowId, {
            total: msg.total,
            running: msg.running,
            done: msg.done,
            agents: msg.agents,
          });
          break;

        case 'worker_spawned':
          store.spawnWorker(msg.workflowId, msg.workerId, msg.model as ModelName, msg.effort as EffortLevel, msg.task, msg.provider);
          break;

        case 'worker_text':
          store.appendWorkerOutput(msg.workflowId, msg.workerId, msg.text);
          break;

        case 'worker_thinking':
          store.appendWorkerThinking(msg.workflowId, msg.workerId, msg.text);
          break;

        case 'worker_tool_use':
          store.recordWorkerToolCall(msg.workflowId, msg.workerId, msg.tool, msg.input);
          break;

        case 'worker_model':
          store.setWorkerModel(msg.workflowId, msg.workerId, msg.resolvedModel);
          break;

        case 'worker_complete':
          store.completeWorker(msg.workflowId, msg.workerId, msg.costUsd, msg.durationMs, msg.tokens, msg.permissionDenials);
          if (msg.permissionDenials && msg.permissionDenials.length > 0) {
            const tools = Array.from(new Set(msg.permissionDenials.map((d) => d.tool))).join(', ');
            store.addMessage(msg.workflowId, {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[SAFE] Worker ${msg.workerId} had ${msg.permissionDenials.length} tool call(s) blocked (${tools}). Add the required directory to ADDITIONAL DIRECTORIES or switch to AUTO mode to unblock.`,
              isStreaming: false,
              timestamp: Date.now(),
            });
          }
          break;

        case 'worker_activity':
          store.setWorkerActivity(msg.workflowId, msg.workerId, {
            alive: msg.alive,
            cpuActive: msg.cpuActive,
            descendantCount: msg.descendantCount,
            rssBytes: msg.rssBytes,
          });
          break;

        case 'worker_error':
          store.failWorker(msg.workflowId, msg.workerId);
          break;

        case 'primary_artifact': {
          const { type: _t, ...rest } = msg;
          store.enqueueArtifact(rest);
          break;
        }

        case 'turn_cancelled':
          store.recordTurnCancelled(msg.workflowId, msg.reason);
          // NATIVE_COMPACTION_PLAN Phase 3 — a cancel during the compaction lock
          // must release the takeover too (belt-and-suspenders; compactInPlace
          // refuses to run mid-turn, but a cancel racing the lock shouldn't
          // strand the overlay).
          store.clearCompacting(msg.workflowId);
          store.addMessage(msg.workflowId, {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[TURN CANCELLED — ${msg.reason}]`,
            isStreaming: false,
            timestamp: Date.now(),
          });
          // Drop a pending plan capture — the cancelled turn's reply (if any)
          // shouldn't seed a plan, and the flag would otherwise capture an
          // unrelated next turn.
          store.setPendingPlanCapture(msg.workflowId, null);
          {
            const ref = getStreamRef(msg.workflowId);
            ref.passthrough = null;
            ref.parentTurnId = null;
          }
          break;

        case 'quota_status':
          // Slot 4 — per-provider throttle snapshot. Broadcast on every state
          // change and on fresh WS connection, so the QuotaBadge reflects the
          // server's current truth immediately.
          store.setQuotaState(msg.providers);
          break;

        case 'workflow_state_snapshot': {
          useAppStore.setState((s) => {
            const job = s.jobs[msg.workflowId];
            return job?.config.voiceOperator ? { jobs: { ...s.jobs, [job.id]: { ...job, computerTurnActive: msg.busy } } } : s;
          });
          // Slot 1 — server is telling us what's actually running. Clear any
          // ghost workers and unstick the cancel button by finalizing
          // streaming messages when the server isn't busy.
          store.applyWorkflowSnapshot(msg.workflowId, msg.workers, msg.busy, msg.transcriptTail);
          // Slot 2 — snapshot arrival is the signal that dismisses the
          // per-job SYNCING gate; no-op until a disconnect resets it.
          store.markSnapshotReceived(msg.workflowId);
          if (msg.operatorQuestions) reconcileOperatorQuestions(msg.workflowId, msg.operatorQuestions);
          // Slot 5 — the snapshot's lastSeq is the server's head seq at
          // snapshot time. On the rotation fallback (snapshotOnly=true) the
          // client's saved lastSeq may have been far behind; force-set so
          // future events line up with the authoritative server counter.
          if (typeof msg.lastSeq === 'number') {
            store.updateLastSeq(msg.workflowId, msg.lastSeq, msg.snapshotOnly === true);
          }
          if (msg.lastTurnTokens) store.setLastTurnTokens(msg.workflowId, msg.lastTurnTokens);
          if (typeof msg.modelContextWindow === 'number' && msg.modelContextWindow > 0) {
            store.setModelContextWindow(msg.workflowId, msg.modelContextWindow);
          }
          if (msg.claudeSessionId) store.setClaudeSessionId(msg.workflowId, msg.claudeSessionId);
          if (msg.sessionMetadata) {
            store.setSessionMetadata(msg.workflowId, msg.sessionMetadata);
          }
          if (!msg.busy) {
            const ref = getStreamRef(msg.workflowId);
            ref.passthrough = null;
            ref.parentTurnId = null;
          }
          break;
        }

        case 'replay_batch': {
          // Cluster-snapshot restore: a member's whole compacted history in
          // one message. Re-dispatch each inner event through this same
          // reducer — chat rows, activity, lastSeq, HISTORY fan-out all reuse
          // the live-event logic. The loop runs in ONE synchronous task, so
          // the ingest is all-or-nothing (persisted lastSeq can never outrun
          // persisted chat — the 2026-06-12 blank-workers bug), React batches
          // it into one render, and the debounced persist flushes once.
          for (const ev of msg.events) {
            const inner = ev as ServerMessage;
            // Defense-in-depth: the server filters embedded workflow_created
            // lines, but a replayed one here would clobber the freshly-built
            // JobState (createJob resets messages).
            if (inner?.type === 'workflow_created') continue;
            try {
              handleServerMessage(inner, deps);
            } catch (err) {
              // One malformed historical event must not abort the rest of the
              // member's history.
              console.error('[arco] replay_batch event failed:', err);
            }
          }
          break;
        }

        case 'workflow_session_metadata':
          store.setSessionMetadata(msg.workflowId, msg.sessionMetadata);
          break;

        case 'computer_context_updated': {
          if (msg.fresh && useComputerStore.getState().activeId === msg.workflowId) useComputerStore.setState((s) => ({ contextEpoch: s.contextEpoch + 1 }));
          if (msg.discardTranscript) useVoiceStore.setState({ lastHeard: '', status: 'Computer context cleared.', commandText: null });
          useAppStore.setState((s) => {
            const job = s.jobs[msg.workflowId];
            if (!job) return s;
            return { jobs: { ...s.jobs, [msg.workflowId]: { ...job,
              config: { ...job.config, computerContext: msg.state },
              ...(msg.settled ? { computerTurnActive: false } : {}),
              ...(msg.discardTranscript ? { messages: [], sessionChat: [], hasEarlierSessionHistory: false, earlierTranscriptCursor: undefined, earlierSource: undefined, transcriptFetch: undefined } : {}),
              ...(msg.fresh ? { lastTurnTokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, contextUsage: undefined } : {}),
            } } };
          });
          break;
        }
        case 'conversation_changed': {
          store.changeWorkflowSession(msg.workflowId, msg.newSessionId);
          store.addMessage(msg.workflowId, {
            id: crypto.randomUUID(),
            role: 'system',
            content: msg.note,
            isStreaming: false,
            timestamp: Date.now(),
          });
          const ref = getStreamRef(msg.workflowId);
          ref.passthrough = null;
          ref.parentTurnId = null;
          break;
        }

        case 'shutdown':
          useAppStore.getState().setShutdown(true, msg.reason);
          // On restart, the server is coming back up — keep the tab open
          // so the existing reconnect loop can land on the new process,
          // and clear the shutdown flag once we reconnect. On quit, try
          // to close the tab (browsers block this for user-opened tabs,
          // in which case the ShutdownOverlay stays visible).
          if (msg.reason === 'server_restarting') {
            // No window.close; overlay shows "RESTARTING" until reconnect
            // arrives, at which point the `connected` handler below clears
            // the shutdown flag.
          } else {
            setTimeout(() => {
              try { window.close(); } catch { /* ignore */ }
            }, 800);
          }
          break;

        case 'capabilities_changed':
          store.setCliChanges(msg.changes);
          break;

        case 'capabilities_updated':
          store.setCapabilities(msg.capabilities);
          if (msg.updated && msg.previousVersion) {
            const activeId = store.activeJobId;
            if (activeId) {
              store.addMessage(activeId, {
                id: crypto.randomUUID(),
                role: 'system',
                content: `[CLI] Updated ${msg.previousVersion} → ${msg.capabilities.cliVersion}`,
                isStreaming: false,
                timestamp: Date.now(),
              });
            }
          }
          break;

        case 'error':
          // Phase 2.5.1 — surface server-side rejections as a top-right toast
          // regardless of which tab is focused. The pre-2.5.1 behavior of
          // appending [ERROR] to chat is kept as a secondary record. Provider
          // failures carry workflowId and MUST land on that workflow even when
          // another tab is focused; truly global errors retain the active-tab
          // fallback. Without the toast, cluster-action rejections (e.g.
          // member_not_native from spawn-into-cluster with non-Native provider)
          // were invisible to the operator.
          store.pushNotification('error', msg.message);
          {
            const targetWorkflowId = msg.workflowId ?? store.activeJobId;
            if (!targetWorkflowId || !store.jobs[targetWorkflowId]) break;
            store.addMessage(targetWorkflowId, {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[ERROR] ${msg.message}`,
              isStreaming: false,
              timestamp: Date.now(),
            });
          }
          break;

        case 'review_started':
          store.upsertReview(msg.workflowId, msg.reviewId, {
            reviewer: msg.reviewer,
            startedAt: msg.startedAt,
          });
          // Mirror Handoff's chat-row pattern so the operator gets visible
          // feedback that a review fired (otherwise the dialog closes and
          // the verdict only surfaces in REVIEW + HISTORY tabs).
          store.addMessage(msg.workflowId, {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[REVIEW] Running review (${msg.reviewer.provider}:${msg.reviewer.model}@${msg.reviewer.effort})…`,
            isStreaming: false,
            timestamp: msg.startedAt,
          });
          break;

        case 'research_started':
          store.upsertResearch(msg.workflowId, msg.researchId, {
            researcher: msg.researcher,
            topic: msg.topic,
            maxRounds: msg.maxRounds,
            isFollowUp: msg.isFollowUp,
            artifactName: msg.artifactName,
            startedAt: msg.startedAt,
          });
          store.addMessage(msg.workflowId, {
            id: crypto.randomUUID(),
            role: 'system',
            content: msg.isFollowUp
              ? `[RESEARCH] Dig-deeper follow-up running (${msg.researcher.provider}:${msg.researcher.model}@${msg.researcher.effort})…`
              : `[RESEARCH] Researching "${trim80(msg.topic)}" (${msg.researcher.provider}:${msg.researcher.model}@${msg.researcher.effort}, ≤${msg.maxRounds} rounds)…`,
            isStreaming: false,
            timestamp: msg.startedAt,
          });
          break;

        case 'research_progress':
          // Coarse live progress — update the RESEARCH tab's note. No chat row;
          // the per-turn ACTIVITY stream is the authoritative tool log.
          store.upsertResearch(msg.workflowId, msg.researchId, {
            progressNote: msg.note,
          });
          break;

        case 'research_complete': {
          store.upsertResearch(msg.workflowId, msg.researchId, {
            artifactName: msg.artifactName,
            roundsUsed: msg.roundsUsed,
            sourceCount: msg.sourceCount,
            isFollowUp: msg.isFollowUp,
            completedAt: msg.completedAt,
            ...(msg.error ? { error: msg.error } : {}),
          });
          store.addMessage(msg.workflowId, {
            id: crypto.randomUUID(),
            role: 'system',
            content: msg.error
              ? `[RESEARCH] Failed — ${msg.error}`
              : `[RESEARCH DONE] ${msg.artifactName} — ${msg.sourceCount} source(s), ${msg.roundsUsed} round(s). Open the RESEARCH tab to read it.`,
            isStreaming: false,
            timestamp: msg.completedAt,
          });
          break;
        }

        // §B1 — Compare primitive lifecycle. Routed into the standalone
        // compareStore the globally-mounted CompareOverlay reads (a transient
        // grid, not a chat row / per-tab session state). events.jsonl already
        // carries the audit trail (the server send() persists every compare_*).
        case 'compare_started':
          useCompareStore.getState().onStarted({
            workflowId: msg.workflowId,
            compareId: msg.compareId,
            prompt: msg.prompt,
            legs: msg.legs,
            blind: msg.blind,
          });
          break;
        case 'compare_leg_delta':
          useCompareStore.getState().onLegDelta(msg.compareId, msg.legIndex, msg.text);
          break;
        case 'compare_leg_complete':
          useCompareStore.getState().onLegComplete(msg.compareId, msg.legIndex, msg.text, msg.durationMs, msg.error);
          break;
        case 'compare_complete':
          useCompareStore.getState().onComplete(msg.compareId);
          break;
        case 'compare_vote_recorded':
          useCompareStore.getState().onVoteRecorded(msg.compareId, msg.winnerLegIndex);
          break;

        // §A7 — AI doc-edit lifecycle. Not a chat row; routed into the
        // standalone docEditStore the editor affordance reads. The agent
        // returned text only; Accept/Reject + the diff preview live in the
        // editor modal.
        case 'doc_edit_started':
          useDocEditStore.getState().onStarted(msg.docEditId, msg.filePath);
          break;

        case 'doc_edit_proposed':
          useDocEditStore.getState().onProposed(msg.docEditId, {
            replacement: msg.replacement,
            error: msg.error,
            selectionFrom: msg.selectionFrom,
            selectionTo: msg.selectionTo,
            filePath: msg.filePath,
          });
          break;

        // Agent-instruction-file tune-up lifecycle. Not a chat row; routed into
        // the standalone mdTuneupStore the composer button + modal read. The
        // agent returned a proposal only; the backup + write happen server-side
        // on accept (md_tuneup_accept → md_tuneup_applied).
        case 'md_tuneup_started':
          useMdTuneupStore.getState().onStarted(msg.workflowId, {
            tuneupId: msg.tuneupId,
            filePath: msg.filePath,
            baseName: msg.baseName,
            originalBytes: msg.originalBytes,
          });
          break;
        case 'md_tuneup_proposed':
          useMdTuneupStore.getState().onProposed(msg.workflowId, {
            tuneupId: msg.tuneupId,
            filePath: msg.filePath,
            baseName: msg.baseName,
            original: msg.original,
            proposed: msg.proposed,
            notes: msg.notes,
            originalBytes: msg.originalBytes,
            proposedBytes: msg.proposedBytes,
            error: msg.error,
          });
          break;
        case 'md_tuneup_applied':
          useMdTuneupStore.getState().onApplied(msg.workflowId, {
            tuneupId: msg.tuneupId,
            filePath: msg.filePath,
            ok: msg.ok,
            backupPath: msg.backupPath,
            error: msg.error,
          });
          break;
        case 'md_tuneup_candidates':
          useMdTuneupStore.getState().onCandidates(msg.workflowId, msg.candidates, msg.defaultPath);
          break;

        // Director/workers Stage K — operator-armed orchestration assist
        // proposals. Proposal creation is visible and durable; only the later
        // apply message changes task state through normal task ledger events.
        case 'cluster_orchestration_assist_started':
        case 'cluster_orchestration_proposal_started':
          break;
        case 'cluster_orchestration_proposals_snapshot':
          useOrchestrationAssistStore.getState().replaceClusterProposals(msg.clusterId, msg.proposals);
          break;
        case 'cluster_orchestration_proposal_proposed':
          useOrchestrationAssistStore.getState().upsertProposal(msg.proposal);
          break;
        case 'cluster_orchestration_proposal_applied':
          useOrchestrationAssistStore.getState().markApplied(msg.clusterId, msg.proposalId, msg.itemIds);
          break;
        case 'cluster_orchestration_proposal_rejected': {
          useOrchestrationAssistStore.getState().markRejected(msg.clusterId, msg.proposalId);
          break;
        }

        // §B3 — knowledge "distill from session" DRAFT lifecycle. Routed into
        // the standalone knowledgeDistillStore the wizard reads. The agent
        // drafted text only; the operator edits + Saves (POST /api/knowledge).
        case 'knowledge_distill_started':
          useKnowledgeDistillStore.getState().onStarted(msg.workflowId, msg.distillId);
          break;
        case 'knowledge_distill_proposed':
          useKnowledgeDistillStore.getState().onProposed(msg.workflowId, {
            distillId: msg.distillId,
            title: msg.title,
            body: msg.body,
            tags: msg.tags,
            error: msg.error,
          });
          break;

        // §G4 — Cookbook download lifecycle. Routed into the global cookbookStore
        // (the modal renders the active-download progress / refusal / success).
        // Not a chat row; the operator watches the Cookbook modal. events.jsonl
        // already carries the audit trail (the server send() persists it).
        case 'cookbook_download_progress':
          useCookbookStore.getState().onDownloadProgress({
            downloadId: msg.downloadId,
            source: msg.source,
            phase: msg.phase,
            receivedBytes: msg.receivedBytes,
            totalBytes: msg.totalBytes,
            freeBytes: msg.freeBytes,
            message: msg.message,
            alias: msg.alias,
          });
          break;

        // §F2 — Recall conversation summary settled. Not workflow-scoped (no
        // chat row); routed to the global recall store so the Recall view's
        // row flips Summarize → Open summary. `ok=false` is a degraded
        // (deterministic-fallback) summary, NOT an error — it still exists.
        case 'recall_summary_ready': {
          void useRecallStore.getState().onSummaryReady(msg.wfid, msg.summaryRef, msg.ok, msg.error);
          break;
        }

        case 'plan_attached':
          store.setPlan(msg.workflowId, {
            id: msg.planId,
            title: msg.title,
            updatedAt: msg.updatedAt,
          });
          break;

        case 'plan_candidate_ready':
          // Cluster-member plan-creation choice point. Server intercepted
          // EnterPlanMode (or autosave) and is asking the operator whether
          // the plan should land on the worker or the cluster's shared PLAN.
          // Lands in JobState.planCandidate (mode: 'review') so the existing
          // PlanCandidateBanner renders the three-button choice without any
          // banner-side changes.
          store.setPlanCandidate(msg.workflowId, {
            body: msg.body,
            mode: 'review',
            capturedAt: Date.now(),
          });
          break;

        case 'plan_detached':
          store.setPlan(msg.workflowId, null);
          break;

        case 'preview_set':
          store.setPreview(
            msg.workflowId,
            { port: msg.port, framework: msg.framework, manual: msg.manual },
            msg.freshlyBound,
          );
          break;

        case 'preview_cleared':
          store.setPreview(msg.workflowId, null);
          break;

        case 'preview_history':
          store.setPreviewHistory(msg.workflowId, msg.entries);
          break;

        case 'preview_capture_started':
          store.setPreviewCapturing(msg.workflowId, true);
          break;

        case 'preview_capture_ready':
          store.addPreviewCapture(msg.workflowId, {
            captureId: msg.captureId,
            ok: msg.ok,
            ...(msg.error ? { error: msg.error } : {}),
            ...(msg.reportName ? { reportName: msg.reportName } : {}),
            ...(msg.imageName ? { imageName: msg.imageName } : {}),
            ...(msg.summary ? { summary: msg.summary } : {}),
            // The started message carried the requested facets; the ready message
            // doesn't echo them, so default to all three for display scoping.
            captures: ['screenshot', 'console', 'network'],
            completedAt: msg.completedAt,
          });
          break;

        case 'review_artifact_ready': {
          store.upsertReview(msg.workflowId, msg.reviewId, {
            artifactName: msg.artifactName,
            completedAt: msg.completedAt,
            ...(msg.verdict ? { verdict: msg.verdict } : {}),
            ...(msg.error ? { error: msg.error } : {}),
          });
          // Seed the chat with a header row so the operator sees something
          // immediately, then fetch the artifact body and update the row to
          // inline the full review. Burying the review behind a filename
          // ref makes it invisible — both to the operator scrolling chat AND
          // to peers receiving an operator-forwarded transcript. The header
          // + body land in the same row so transcript-send naturally carries
          // the full review to whoever it's sent to.
          const reviewRowId = crypto.randomUUID();
          const header = msg.error
            ? `[REVIEW] Failed — ${msg.error}`
            : `[REVIEW ${msg.verdict ?? 'DONE'}] ${msg.artifactName}`;
          store.addMessage(msg.workflowId, {
            id: reviewRowId,
            role: 'system',
            content: header,
            isStreaming: false,
            timestamp: msg.completedAt,
          });
          if (!msg.error && msg.artifactName) {
            const job = store.jobs[msg.workflowId];
            const cwd = job?.config.workingDirectory ?? '';
            if (cwd) {
              const q = new URLSearchParams({ path: cwd, workflowId: msg.workflowId, name: msg.artifactName });
              fetch(`/api/workflows/artifact?${q.toString()}`)
                .then((r) => r.ok ? r.json() as Promise<{ contents: string }> : Promise.reject(r.statusText))
                .then((d) => {
                  if (!d.contents) return;
                  useAppStore.getState().updateMessage(msg.workflowId, reviewRowId, {
                    content: `${header}\n\n${d.contents}`,
                  });
                })
                .catch(() => {
                  // Body fetch is best-effort. The header + REVIEWS tab still
                  // surface the artifact even if the inline body fails.
                });
            }
          }
          break;
        }

        case 'handoff_started':
          store.upsertHandoff(msg.workflowId, msg.handoffId, {
            mode: msg.mode,
            startedAt: msg.startedAt,
          });
          store.addMessage(msg.workflowId, {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[HANDOFF] Generating handoff document (${msg.mode})…`,
            isStreaming: false,
            timestamp: msg.startedAt,
          });
          break;

        case 'handoff_artifact_ready':
          store.upsertHandoff(msg.workflowId, msg.handoffId, {
            artifactName: msg.artifactName,
            ...(!msg.error ? { error: undefined } : {}),
            ...(msg.cancelled ? { cancelled: true, completedAt: msg.completedAt } : {}),
            ...(msg.error ? { error: msg.error } : {}),
          });
          // Mirror the review-artifact pattern: emit a clickable chat row so
          // the operator can open the handoff doc without flipping to the
          // HANDOFFS tab. Skipped on error/cancel — `handoff_complete` still
          // narrates the rotation either way.
          if (!msg.error && !msg.cancelled) {
            store.addMessage(msg.workflowId, {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[HANDOFF SAVED] ${msg.artifactName}`,
              isStreaming: false,
              timestamp: Date.now(),
            });
          }
          break;

        case 'handoff_complete':
          // docs/PROVIDERS.md - handoff is the natural
          // checkpoint where context resets. Reset the chip counter so
          // the operator doesn't immediately see the nudge again. Phase D
          // §8b also resets the worker-authoritative mirror; the worker
          // itself rebuilds with counter=0 after disposeProviderResources,
          // but mirroring eagerly here avoids a stale paint between
          // handoff_complete and the next primary_tool_counter push.
          store.resetToolCallsSinceHandoff(msg.workflowId);
          store.setToolCallsSinceCompact(msg.workflowId, 0);
          // 2026-05-12 — also clear the per-turn usage state so the CTX
          // bar drops the pre-handoff readout. Critical when the handoff
          // swaps providers (e.g. Opus → GPT-5.5): without this the
          // composer keeps rendering the Claude-side estimator's stale
          // window + cache TTL until a Claude turn that will never come.
          store.clearTurnUsageState(msg.workflowId);
          store.upsertHandoff(msg.workflowId, msg.handoffId, {
            completedAt: msg.completedAt,
            archivedSessionId: msg.archived.sessionId || undefined,
            newSessionId: msg.newSessionId || undefined,
            turnCount: msg.archived.turnCount,
          });
          store.addMessage(msg.workflowId, {
            id: crypto.randomUUID(),
            role: 'system',
            content: `[HANDOFF] Session rotated — previous session archived (${msg.archived.turnCount} turn${msg.archived.turnCount === 1 ? '' : 's'}). New session ready.`,
            isStreaming: false,
            timestamp: msg.completedAt,
          });
          break;

        case 'handoff_lock_snapshot':
          store.setHandoffLocks(msg.cwd, msg.locks);
          break;

        case 'session_entry': {
          // When Claude writes a user turn to its JSONL — which happens only
          // after the server has drained the queued prompt(s) and Claude has
          // actually processed them — drop every queued optimistic entry
          // whose 120-char content prefix appears as a substring in the
          // drained prompt. The server now merges the whole queue into one
          // follow-up turn (`\n\n` joined), so a single session_entry can
          // resolve multiple queued optimistic entries at once. "Contains"
          // rather than "equals" is the key change — both single-send and
          // multi-merge paths work with the same rule. Scanning is queued-
          // only, so non-queued user turns (a regular send that happens to
          // quote an old queued prefix) never match.
          // Carry forward any attachments from optimistic queued messages
          // whose content this session_entry is about to absorb. The server
          // merges the whole queue into one prompt, so attachments from all
          // matched optimistic messages are concatenated in order.
          let inheritedAttachments: string[] | undefined;
          if (msg.entry.kind === 'message' && msg.entry.role === 'user') {
            const job = store.jobs[msg.workflowId];
            if (job) {
              const norm = (s: string) => s.replace(/\s+/g, ' ');
              const haystack = norm(msg.entry.content);
              const idsToRemove: string[] = [];
              const attsToCarry: string[] = [];
              for (const m of job.messages) {
                if (m.role !== 'user' || !m.queued) continue;
                const needle = norm(m.content.slice(0, 120));
                if (needle.length > 0 && haystack.includes(needle)) {
                  idsToRemove.push(m.id);
                  if (m.attachments && m.attachments.length > 0) {
                    attsToCarry.push(...m.attachments);
                  }
                }
              }
              for (const id of idsToRemove) store.removeMessage(msg.workflowId, id);
              if (attsToCarry.length > 0) inheritedAttachments = attsToCarry;
            }
          }
          store.upsertSessionChat(msg.workflowId, msg.entry, inheritedAttachments);
          break;
        }

        case 'session_history_status':
          store.setEarlierState(msg.workflowId, {
            hasEarlierSessionHistory: msg.hasEarlier,
            earlierSource: msg.hasEarlier ? 'ws' : undefined,
          });
          break;

        case 'gate_required':
          // DEBAG (docs/PROVIDERS.md) - a parked sensitive tool call. Render
          // an inline approval card by anchoring a synthetic message keyed
          // `gate::<gateId>`; the structured proposal rides toolUse.input so the
          // card reads it directly. addMessage dedupes by id, so a rehydrate
          // re-emit (sub-phase 4) is idempotent.
          store.addMessage(msg.workflowId, {
            id: `gate::${msg.gateId}`,
            role: 'system',
            content: '',
            isStreaming: false,
            timestamp: msg.createdAt,
            toolUse: {
              tool: 'Gate',
              toolUseId: msg.gateId,
              input: {
                gateId: msg.gateId,
                toolName: msg.toolName,
                category: msg.category,
                reason: msg.reason,
                proposedArgs: msg.proposedArgs,
                signature: msg.signature,
                status: 'pending',
              },
            },
          });
          break;

        case 'gate_resolved':
          // DEBAG — the gate was approved/rejected (here or in another tab, or
          // by cancel). Flip the card to its resolved state.
          store.resolveGate(msg.workflowId, msg.gateId, {
            status: msg.decision,
            wasEdited: msg.wasEdited,
            ...(msg.finalArgs !== undefined ? { finalArgs: msg.finalArgs } : {}),
          });
          break;

        case 'gate_standing':
          // DEBAG sub-phase 5 — full snapshot of the workflow's standing review
          // approvals (rehydrate + on add/revoke). Drives the CONFIG list.
          store.setStandingGateApprovals(msg.workflowId, msg.approvals);
          break;

        case 'operator_question': {
          const known = store.jobs[msg.workflowId]?.messages.some((m) => m.id === questionMessageId(msg.question.requestId));
          applyOperatorQuestion(msg.workflowId, msg.question);
          if (msg.question.status === 'pending' && !known && Date.now() - msg.question.createdAt < 10_000) store.pushNotification('info', `${msg.question.provider.toUpperCase()} has a question for you.`);
          break;
        }
        case 'computer_activity_changed':
          receiveComputerActivityChanged(msg.workflowId);
          break;
        case 'voice_tool_call':
          // docs/VOICE.md - only the window owning the hands-free
          // session answers; see voice/toolBridge.ts.
          void dispatchVoiceToolCall(msg, (result) => store.wsSendRaw?.(result));
          break;
        case 'operator_question_reply_result':
          if (!msg.ok) store.updateMessage(msg.workflowId, questionMessageId(msg.requestId), { operatorQuestionError: msg.error || 'The answer could not be delivered.' });
          break;
        case 'system_notice':
          // NATIVE_COMPACTION_PLAN Phase 3 — a compaction-failure notice is the
          // terminal signal on the no-native_compacted path (empty/failed
          // summary leaves history untouched and never emits native_compacted).
          // Clear the takeover so it can't get stuck on. Matches the manual
          // ("Compact failed") and auto ("Compaction skipped") failure copy.
          if (isCompactionFailureNotice(msg.content)) {
            store.clearCompacting(msg.workflowId);
          }
          store.addMessage(msg.workflowId, {
            id: crypto.randomUUID(),
            role: 'system',
            content: msg.content,
            isStreaming: false,
            timestamp: Date.now(),
          });
          break;

        case 'provider_fell_back':
          // §C2 — a BOUNDED job (reviewer / research leg) was throttled on one
          // provider and advanced to the next configured leg. Surface as an
          // inline chat system-notice so the operator can see the swap. Never
          // fires for a live primary turn (that path fails closed).
          store.addMessage(msg.workflowId, {
            id: crypto.randomUUID(),
            role: 'system',
            content: msg.note
              ?? `Provider fell back: ${msg.from.provider}/${msg.from.model} → ${msg.to.provider}/${msg.to.model} (${msg.reason})`,
            isStreaming: false,
            timestamp: Date.now(),
          });
          break;

        case 'codex_token_snapshot':
          // Override the inflated lastTurnTokens that primary_complete just
          // broadcast (codex exec --json's turn.completed.usage aggregates
          // across all internal LLM calls within an operator turn — fine for
          // billing, wrong for context-window-fill display). The rollout's
          // last_token_usage is the per-call reality; use it for the CTX
          // bar. totalTokens (cumulative billing) intentionally untouched.
          store.setLastTurnTokens(msg.workflowId, msg.tokens);
          if (typeof msg.modelContextWindow === 'number' && msg.modelContextWindow > 0) {
            store.setModelContextWindow(msg.workflowId, msg.modelContextWindow);
          }
          break;

        case 'context_usage':
          store.setContextUsage(msg.workflowId, {
            estimatedTokens: msg.estimatedTokens,
            percentOfWindow: msg.percentOfWindow,
            windowSize: msg.windowSize,
            method: msg.method,
            messagesTokens: msg.messagesTokens,
            overheadTokens: msg.overheadTokens,
            jsonlBytes: msg.jsonlBytes,
            receivedAt: Date.now(),
            calibratedAt: msg.calibratedAt,
          });
          if (msg.claudeSessionId) store.setClaudeSessionId(msg.workflowId, msg.claudeSessionId);
          break;

        case 'spawn_from_here_complete':
          if (msg.error) {
            store.addMessage(msg.parentWorkflowId, {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[SPAWN] Failed: ${msg.error}`,
              isStreaming: false,
              timestamp: msg.completedAt,
            });
          } else {
            store.addMessage(msg.parentWorkflowId, {
              id: crypto.randomUUID(),
              role: 'system',
              content: `[SPAWN] Forked into new tab (${msg.newWorkflowId.slice(0, 8)}).`,
              isStreaming: false,
              timestamp: msg.completedAt,
            });
            // Auto-switch to the spawned tab. The tab was added by the
            // workflow_created event that arrived at the start of the spawn;
            // createJob already made it active, but a mid-flight operator
            // click on the parent could have pulled focus back, so we
            // re-activate here defensively.
            store.setActiveJob(msg.newWorkflowId);
          }
          break;

        // docs/PROTOCOL_CLUSTER.md - peer messages from the Phase 1
        // substrate become synthetic chat-row injections. Each member's
        // transcript renders the colored block via ChatMessage's
        // peer-sent / peer-received branch. The events still live in
        // events.jsonl as their original peer_message_* form (per-workflow
        // persistence is unchanged); the synthetic ChatMessage entries
        // here are render-layer only and survive reload via the persisted
        // job.messages array.
        case 'peer_message_sent': {
          const id = `peer-sent-${msg.msgId}`;
          // Dedupe — rehydrate-on-subscribe + tsx-watch restarts re-fire the
          // same peer_message_sent event multiple times. The id is
          // deterministic per msgId so a present-in-messages check makes the
          // handler idempotent. Without this the chat grows unboundedly
          // every restart.
          const existing = store.jobs[msg.workflowId]?.messages.some((m) => m.id === id);
          if (existing) break;
          const sentEntry: ChatMessage = {
            id,
            role: 'peer-sent',
            content: msg.contentPreview,
            isStreaming: false,
            timestamp: 'ts' in msg && typeof (msg as { ts?: number }).ts === 'number' ? (msg as { ts: number }).ts : Date.now(),
            senderWorkflowId: msg.from,
            senderDisplayName: msg.to.slice(0, 8),    // fallback label; renderer prefers cluster-store lookup
            targetWorkflowId: msg.to,                 // full recipient wfid for cluster-store lookup
          };
          store.addMessage(msg.workflowId, sentEntry);
          break;
        }
        case 'peer_message_received': {
          const id = `peer-recv-${msg.msgId}`;
          const existing = store.jobs[msg.workflowId]?.messages.some((m) => m.id === id);
          if (existing) break;
          const recvEntry: ChatMessage = {
            id,
            role: 'peer-received',
            content: msg.content,
            isStreaming: false,
            timestamp: 'ts' in msg && typeof (msg as { ts?: number }).ts === 'number' ? (msg as { ts: number }).ts : Date.now(),
            senderWorkflowId: msg.from,
            senderDisplayName: msg.fromName,
          };
          store.addMessage(msg.workflowId, recvEntry);
          break;
        }
        case 'peer_send_rejected':
          // Surface as a system-notice row on the sender's transcript so
          // operator-visible: budget exhausted, unknown peer, etc. Plan
          // §6.2 forbids silent budget violations — and we already get the
          // event for free, just need to render it in chat.
          store.addMessage(msg.workflowId, {
            id: `peer-rejected-${Math.random().toString(36).slice(2, 10)}`,
            role: 'system',
            content: `[PEER] Send rejected → ${msg.targetRef.slice(0, 8)} (${msg.reason})`,
            isStreaming: false,
            timestamp: Date.now(),
          });
          break;

        // docs/PROTOCOL_CLUSTER.md - server pushes cluster_state on
        // subscribe + on member busy/mailbox-depth changes. cluster_created
        // wraps the same payload + auto-subscribes the creating WS so the
        // new cluster tab opens with state already available.
        case 'cluster_state':
          store.setClusterState(msg.clusterId, msg.state);
          requestMissingMemberJobs(msg.clusterId, msg.state, deps);
          break;
        case 'cluster_not_found':
          // The browser can outlive a server-side cluster deletion (or point
          // at another machine's localStorage). Prune only that stale mirror
          // so reconnect does not produce an immortal "Unknown cluster"
          // toast. Live persisted clusters can be reopened from +NEW.
          store.clearCluster(msg.clusterId);
          break;
        case 'cluster_created':
          store.setClusterState(msg.clusterId, msg.state);
          requestMissingMemberJobs(msg.clusterId, msg.state, deps);
          store.setActiveCluster(msg.clusterId);
          // A snapshot restore completes as a cluster_created with a brand-new
          // clusterId (fork semantics — there's no dedicated restored message).
          // Clearing the spinner here is harmless for non-restore creations
          // (restoringId is already null in that case).
          useClusterSnapshotsStore.getState().clearRestoring();
          break;
        case 'cluster_deleted':
          store.clearCluster(msg.clusterId);
          break;
        case 'cluster_member_added':
        case 'cluster_member_removed':
          // Phase 2 ships fixed-membership-at-create. The wire types exist
          // for forward-compat (Phase 5 polish: model-proposes-sibling,
          // member detach), but no emitter today. Server pushes a fresh
          // cluster_state on real membership changes.
          break;
        case 'cluster_member_replaced':
          store.removeJob(msg.oldWorkflowId);
          store.pushNotification(
            'info',
            `Replaced ${msg.oldWorkflowId.slice(0, 8)} with ${msg.newWorkflowId.slice(0, 8)} (${msg.accessMode.toUpperCase()})`,
          );
          break;
        case 'cluster_plan_changed':
          // Phase 2.6 — plan body propagates via the cluster_state push
          // that fires alongside this event; the dedicated message is the
          // audit shape (timestamp + body length) that lands in
          // events.jsonl. The client doesn't need to mutate the store
          // here — setClusterState handles it — but the case stays so the
          // exhaustive switch survives.
          break;
        case 'cluster_member_nudged': {
          // docs/PROTOCOL_CLUSTER.md - operator-facing toast. The
          // event also rides through broadcastWorkflow → events.jsonl;
          // the toast is the live surface. NEVER addressed at the model.
          const display = msg.workflowId.slice(0, 8);
          store.pushNotification(
            'info',
            `[CLUSTER] ${display} idle ${msg.idleSeconds}s · ${msg.pendingCount} pending`,
          );
          break;
        }
        case 'cluster_auto_turn_fired': {
          // docs/PROTOCOL_CLUSTER.md - auto-turn audit event. Toast-
          // only, mirroring cluster_member_nudged: the dispatch happens
          // server-side, the event is for operator visibility. Both fires
          // and skips surface so the operator can see the guards working
          // (rate_capped / depth_capped / cooldown / recipient_busy).
          const display = msg.workflowId.slice(0, 8);
          if (msg.fired) {
            store.pushNotification(
              'info',
              `[CLUSTER] AUTO-PICKUP ${display} (depth ${msg.chainDepth})`,
            );
          } else {
            store.pushNotification(
              'info',
              `[CLUSTER] AUTO-PICKUP ${display} skipped: ${msg.reason}`,
            );
          }
          break;
        }
        // Cluster snapshots — whole-cluster save/restore artifacts. The list is
        // re-pushed by the server after every successful save/delete (and as the
        // reply to an explicit list request), so the store just replaces it
        // wholesale. Restore lands as a cluster_created above; this case only
        // needs to handle the error path's spinner clear.
        case 'cluster_snapshot_list':
          useClusterSnapshotsStore.getState().onList(msg.snapshots);
          break;
        case 'cluster_snapshot_saved':
          useClusterSnapshotsStore.getState().onSaved(msg.snapshot);
          store.pushNotification('info', `[CLUSTER] Saved snapshot "${msg.snapshot.name}"`);
          break;
        case 'cluster_snapshot_conflict':
          useClusterSnapshotsStore.getState().onConflict(msg.clusterId, msg.requestedName, msg.existing);
          break;
        case 'cluster_snapshot_error':
          useClusterSnapshotsStore.getState().onError(msg.message, msg.op, msg.snapshotId);
          store.pushNotification('error', `[CLUSTER] Snapshot ${msg.op} failed — ${msg.message}`);
          break;

        case 'codebase_memory_state':
          // docs/PROVIDERS.md - mirror onto job.config.codebaseMemory.
          store.setCodebaseMemoryState(msg.workflowId, {
            attached: msg.attached,
            indexPath: msg.indexPath,
            lastIndexedAt: msg.lastIndexedAt,
            fileCount: msg.fileCount,
          });
          break;
        case 'workflow_renamed':
          // MASTER_REFACTOR §3.3 F5 — update jobs[wfid].config.name. The
          // server re-emits cluster_state separately so members[].displayName
          // doesn't lag the rename in the cluster grid.
          store.setWorkflowName(msg.workflowId, msg.name);
          break;
        case 'terminal_opened': {
          // WORKBENCH_EXPANSION §K1/§K2 — a PTY session opened. Add it to the
          // workflow's session list (for the switcher) and bind it to whichever
          // window was waiting on a spawn. Lifecycle only; the raw byte stream
          // never touches this dispatch (separate `/terminal` channel).
          const ts = useTerminalStore.getState();
          ts.addSession(msg.workflowId, {
            sessionId: msg.sessionId,
            label: msg.label ?? msg.sessionId.slice(0, 8),
            cwd: msg.cwd,
            createdAt: msg.ts,
          });
          ts.bindSpawnedSession(msg.workflowId, msg.sessionId);
          break;
        }
        case 'terminal_killed':
          useTerminalStore.getState().removeSession(msg.workflowId, msg.sessionId);
          break;
        // §J1 — workbench notifications. The server already applied mute
        // suppression, so any notice that arrives is one to surface: record it
        // in the notice-center history AND raise a transient toast via the
        // existing app strip (error/warning → 'error' styling, else 'info').
        case 'workbench_notice': {
          useNotificationStore.getState().pushNotice(msg.notice);
          const level = (msg.notice.severity === 'error' || msg.notice.severity === 'warning') ? 'error' : 'info';
          const line = msg.notice.body ? `${msg.notice.title} — ${msg.notice.body}` : msg.notice.title;
          useAppStore.getState().pushNotification(level, line);
          break;
        }
        case 'notification_mutes':
          useNotificationStore.getState().setMutedFromServer(msg.muted);
          break;
        case 'terminal_sessions':
          // §K2 — live session list (reply to terminal_list, and re-emitted on
          // rehydrate). Replaces the workflow's list so a reconnect recovers
          // the switcher and drops sessions that died with a server restart.
          useTerminalStore.getState().setSessions(
            msg.workflowId,
            msg.sessions.map((s) => ({ sessionId: s.sessionId, label: s.label, cwd: s.cwd, createdAt: s.createdAt })),
          );
          break;
        case 'terminal_command_logged':
          // Persisted command-line echo. Visibility-only; nothing to render
          // live (the window already showed the command). HISTORY/Activity can
          // mine events.jsonl for these later.
          break;
        case 'cluster_broadcast_dispatched':
          // §7c handles the toast in the composer's submit-promise; the
          // dispatcher is just here so the exhaustive switch stays clean
          // and a future "broadcast led to errors" surface (failed[]) has
          // a place to land. Don't dispatch a store action — toast lives
          // in the composer to keep it co-located with the operator click.
          break;
        case 'cluster_dispatch_result':
          // Director/workers Stage F — the board button is the live surface;
          // this reply keeps the dispatcher exhaustive and gives a future
          // per-sweep audit panel fired/skipped counts without re-folding
          // task_ledger_event rows.
          break;
        case 'cluster_swarm_created':
          // Director/workers Stage I — task_ledger_snapshot carries the new
          // graph; this result is kept for future audit/toast surfaces.
          break;
        case 'task_ledger_snapshot':
          // docs/ARCHITECTURE.md - full cwd-scoped task list. Replace-in-
          // place keyed by cwd; the server re-snapshots after every mutation
          // so the client never has to fold deltas.
          store.setTaskLedger(msg.cwd, msg.tasks, msg.boardKey);
          break;
        case 'task_ledger_event':
          // The durable per-mutation event (the projection's source on disk).
          // The snapshot above carries the resulting state, so live clients
          // need no action here — it's present for events.jsonl replay +
          // rebuildFromEvents. No-op on the wire.
          break;
        case 'mcp_registry_snapshot':
          // docs/ARCHITECTURE.md - global registry (machine-wide). Replace
          // wholesale; CRUD broadcasts re-snapshot every client.
          store.setMcpRegistry(msg.defs);
          break;
        case 'mcp_probe_result':
          store.setMcpProbeResult(msg.serverId, {
            ok: msg.ok,
            tools: msg.tools,
            ...(msg.error ? { error: msg.error } : {}),
            at: Date.now(),
          });
          break;
        case 'mcp_allow_snapshot':
          store.setMcpAllow(msg.workflowId, msg.allow);
          break;
        case 'mcp_malware_warning':
          // H21 — registry-add blocked pending operator override. Surfaced as a
          // dialog in the MCP config section (proceed re-sends with override).
          store.setMcpMalwareWarning({ pending: msg.pending, packages: msg.packages });
          break;
        // docs/ARCHITECTURE.md - Genesis.
        case 'genesis_seed_updated':
          store.setGenesisSeed(msg.workflowId, { seed: msg.seed, readiness: msg.readiness, nextPrompt: msg.nextPrompt });
          break;
        case 'genesis_assist_started':
          store.setGenesisAssistStarted(msg.workflowId, { requestId: msg.requestId, field: msg.field, intent: msg.intent });
          break;
        case 'genesis_assist_proposed':
          store.setGenesisAssistProposed(msg.workflowId, {
            requestId: msg.requestId,
            field: msg.field,
            intent: msg.intent,
            suggestion: msg.suggestion,
            ...(msg.rationale ? { rationale: msg.rationale } : {}),
            ...(msg.options ? { options: msg.options } : {}),
            ...(msg.error ? { error: msg.error } : {}),
          });
          break;
        case 'workflow_cwd_bound':
          // A from-nothing genesis scaffolded + rebound to a real project dir.
          // Repoint the persisted config so reload resumes the real project.
          store.setWorkflowCwd(msg.workflowId, msg.cwd);
          break;
        case 'genesis_scaffolded':
          store.setGenesisScaffold(msg.workflowId, {
            cwd: msg.cwd,
            written: msg.written,
            ...(msg.planId ? { planId: msg.planId } : {}),
            ...(msg.repoUrl ? { repoUrl: msg.repoUrl } : {}),
            ...(msg.repoError ? { repoError: msg.repoError } : {}),
            ...(msg.creative ? { creative: true } : {}),
            ...(msg.suggestSpawn ? { suggestSpawn: true } : {}),
          });
          store.pushNotification(
            msg.repoError ? 'error' : 'info',
            msg.creative
              ? `Genesis: alternative scaffolded into ${msg.cwd}/ALTERNATIVE — existing project untouched. Use Spawn-from-here to fork it.`
              : msg.repoError
                ? `Genesis scaffold created ${msg.cwd} (repo creation failed: ${msg.repoError})`
                : `Genesis scaffold created ${msg.cwd}${msg.repoUrl ? ` · ${msg.repoUrl}` : ''}`,
          );
          break;
        // docs/ARCHITECTURE.md - in-workflow Creative mode arm/disarm echo.
        case 'genesis_creative_armed':
          store.setGenesisCreative(msg.workflowId, {
            armed: msg.armed,
            seed: msg.seed,
            readiness: msg.readiness,
            nextPrompt: msg.nextPrompt,
            codebase: msg.codebase,
          });
          break;
      }
}

// `compact_workflow` handler — operator-triggered native compaction. One WS
// message, provider-routed:
//   - Codex/Z.ai (app-server): fires `thread/compact/start` against the live
//     thread; the provider summarizes earlier history server-side. The next
//     turn continues against the compacted thread (CTX bar drops).
//   - Cursor (ACP): sends the advertised `/compress` command as an unprefixed
//     prompt against the live session. Cursor owns + persists the summary.
//   - Claude/Z.ai (native transport): the worker runs ONE summarization round,
//     REPLACES retained native history with the summary, and persists a
//     `native_compacted` marker so replay re-seeds it on restart.
// Both are the in-Arco equivalent of the provider's CLI `/compact`, far
// cheaper than a Handoff (no fresh worker, no portable doc, no resume re-feed).
//
// Passes the four-question test: operator-initiated (button), deterministic
// (gated on provider+transport+idle), visible (ctx_action / native_compacted
// persisted to events.jsonl), and reversible (Handoff remains the heavier
// escape hatch; Codex keeps the pre-compact rollout).

import { WebSocket } from 'ws';
import { publishActivity } from '../voice/activityBus.js';
import type { CompactWorkflowMessage, FoldWorkflowMessage } from '@arco/shared';
import type { Session } from '../workflows/types.js';
import {
  claimBusy,
  drainQueueIfIdle,
  maybeAutoContinueAfterCompact,
  releaseBusy,
  refreshCodexTokenSnapshot,
  resetCodexContextAfterCompact,
} from './turnEngine.js';
import { send, broadcastWorkflow, broadcastTransient, notifyClusterStateForWorkflow } from '../server/broadcast.js';
import { workflows, workflowCwds } from '../server/state.js';
import { compactCodexAppServerThread } from '../providers/codex-appserver/index.js';
import { compactClaudeNativeWorker, foldClaudeNativeWorker, serverFoldClaudeNativeWorker } from '../providers/claude-native/index.js';
import { isChatWorkflow } from '../chatMode.js';
import { compactZaiNativeWorker } from '../providers/zai-native/index.js';
import { compactCursorAcpThread } from '../providers/cursor/index.js';
import { armOllamaForceCompact } from '../providers/ollamaForceCompact.js';
import { resolveProviderAccount } from '../providerAccounts.js';
import { readSettings } from '../settings.js';
import * as clusterStore from '../clusterStore.js';

export async function handleCompactWorkflow(ws: WebSocket, session: Session, msg: CompactWorkflowMessage,
  claimGuard?: (claim: () => number) => Promise<number | false>): Promise<void> {
  const workflowId = msg.workflowId;
  const wf = workflows.get(workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${workflowId.slice(0, 8)}` });
    return;
  }
  const provider = wf.primary.provider;
  if (provider !== 'codex' && provider !== 'zai' && provider !== 'claude' && provider !== 'ollama' && provider !== 'cursor') {
    send(ws, { type: 'error', message: 'Native compact is available on Codex/Z.ai, Cursor, Claude Native, and Ollama — use Handoff on other providers.' });
    return;
  }
  if (wf.busy) {
    send(ws, { type: 'error', message: 'Agent is busy — wait for the turn to finish, then compact.' });
    return;
  }

  // WP3 — Ollama: the worker is stateless per turn (it rebuilds its messages
  // from the replayed transcript each run()), so there is no resident session to
  // compact in place between turns like Claude Native / Codex app-server. Instead
  // arm a one-shot "compact at the front of the next turn" flag and tell the
  // operator honestly that it'll fire on their next message. No busy-lock / no
  // worker round-trip here — there's no worker running. The forced compaction's
  // own ollama_compacted / nothing-to-compact notice lands in events.jsonl when
  // the next turn runs (the durable, reversible record).
  if (provider === 'ollama') {
    if (claimGuard && await claimGuard(() => 0) === false) return;
    armOllamaForceCompact(workflowId);
    wf.ollamaForceCompactNextTurn = true;
    broadcastWorkflow(workflowId, {
      type: 'ctx_action',
      workflowId,
      action: 'compact',
      trigger: 'operator',
      detail: 'Ollama force-compact armed for next turn (worker is stateless between turns)',
    });
    broadcastWorkflow(workflowId, {
      type: 'system_notice',
      workflowId,
      content: '[ollama] Compaction armed — it will run at the start of your next message. The local model has no resident session to compact between turns, so the cut happens on the next turn rather than immediately.',
    });
    void notifyClusterStateForWorkflow(workflowId);
    return;
  }

  const cwd = workflowCwds.get(workflowId) ?? wf.config.workingDirectory;

  // Claude must be on the native transport — the CLI transport has no in-process
  // history for us to summarize/replace (it lives in the Claude CLI session).
  if (provider === 'claude') {
    const cascade = await readSettings(cwd).catch(() => null);
    const claudeTransport = wf.config.claudeTransport
      ?? (cascade?.claude?.transport === 'native' ? 'native' : 'cli');
    if (claudeTransport !== 'native') {
      send(ws, { type: 'error', message: 'Compact needs the Claude Native transport (CONFIG → TRANSPORT). On CLI Claude, use Handoff.' });
      return;
    }
  }

  // Lock the tab for the duration. Flipping wf.busy keeps a queued operator
  // message from firing into the compaction; the transient primary_turn_started
  // /ended pair drives the client's composer lock WITHOUT writing a phantom turn
  // into events.jsonl (replay parsers like initHubLink / reviewContent walk real
  // start→text→complete turns). The durable record is the ctx_action below (plus
  // the worker's own native_compacted marker on native provider paths).
  // Re-check: the busy gate above ran before the readSettings await, and an
  // operator message can have claimed the tab in between — compacting under a
  // live turn rewrites the history it is appending to.
  if (wf.busy) {
    send(ws, { type: 'error', message: 'Agent is busy — wait for the turn to finish, then compact.' });
    return;
  }
  const startedAt = Date.now();
  const busyToken = claimGuard ? await claimGuard(() => claimBusy(wf)) : claimBusy(wf);
  if (busyToken === false) return;
  if (!wf.config.incognito && !wf.config.voiceOperator) publishActivity({kind:'worker_compaction_started',workflowId,clusterId:clusterStore.getClusterIdForWorkflow(workflowId)});
  broadcastTransient(workflowId, { type: 'primary_turn_started', workflowId, startedAt });
  const tag = provider === 'codex' ? '[codex]' : provider === 'zai' ? '[zai]' : provider === 'cursor' ? '[cursor]' : '[claude]';
  broadcastWorkflow(workflowId, {
    type: 'system_notice',
    workflowId,
    content: provider === 'cursor'
      ? `${tag} Compressing conversation… (native /compress)`
      : `${tag} Compacting conversation… (native /compact)`,
  });
  broadcastWorkflow(workflowId, {
    type: 'ctx_action',
    workflowId,
    action: 'compact',
    trigger: 'operator',
    detail: provider === 'codex'
      ? 'Codex app-server thread/compact/start'
      : provider === 'zai'
        ? 'Z.ai compact (native in-place or appserver thread/compact/start, resolved by transport)'
        : provider === 'cursor'
          ? 'Cursor ACP native /compress'
        : 'Claude Native in-place compact',
  });

  let result: { ok: boolean; error?: string; foldedTurns?: number };
  let compactedVia: 'codex-appserver' | 'zai-appserver' | 'zai-native' | 'cursor-acp' | 'claude-native' = 'claude-native';
  try {
    if (provider === 'codex') {
      const cascade = await readSettings(cwd).catch(() => null);
      const codexTransport = wf.config.codexTransport === 'appserver' || wf.config.codexTransport === 'exec'
        ? wf.config.codexTransport
        : cascade?.codex?.transport === 'appserver' ? 'appserver' : 'exec';
      compactedVia = 'codex-appserver';
      if (codexTransport !== 'appserver') {
        result = { ok: false, error: 'Compact needs the Codex app-server transport (CONFIG → TRANSPORT). On Codex exec, use Handoff.' };
      } else if (!wf.primarySessionId) {
        result = { ok: false, error: 'no saved Codex thread for this workflow — run a turn first' };
      } else {
        const account = await resolveProviderAccount('codex', wf.config.providerAccountRef, cwd).catch(() => null);
        const turnClusterId = clusterStore.getClusterIdForWorkflow(workflowId);
        result = await compactCodexAppServerThread(workflowId, {
          model: wf.primary.model,
          effort: wf.primary.effort,
          provider,
          tools: wf.primary.tools,
          cwd,
          workflowId,
          skipPermissions: wf.primary.skipPermissions,
          additionalDirectories: wf.primary.additionalDirectories,
          fallbackModel: wf.primary.fallbackModel,
          codexTransport: 'appserver',
          codexContextPolicy: wf.config.codexContextPolicy,
          providerAccountRef: account?.profile.id,
          codexHome: account?.codexHome,
          resumeSessionId: wf.primarySessionId,
          clusterId: turnClusterId,
          codebaseMemoryAttached: wf.config.codebaseMemory?.attached === true,
          codebaseMemoryIndexPath: wf.config.codebaseMemory?.attached === true
            ? (wf.config.codebaseMemory.indexPath || cwd)
            : undefined,
        }, wf.primarySessionId);
      }
    } else if (provider === 'zai') {
      const cascade = await readSettings(cwd).catch(() => null);
      const zaiTransport = wf.config.zaiTransport === 'appserver' || wf.config.zaiTransport === 'native'
        ? wf.config.zaiTransport
        : cascade?.zai?.transport === 'appserver' ? 'appserver' : 'native';
      if (zaiTransport === 'appserver') {
        compactedVia = 'zai-appserver';
        if (!wf.primarySessionId) {
          result = { ok: false, error: 'no saved Z.ai app-server thread for this workflow — run a turn first' };
        } else {
          const turnClusterId = clusterStore.getClusterIdForWorkflow(workflowId);
          result = await compactCodexAppServerThread(workflowId, {
            model: wf.primary.model,
            effort: wf.primary.effort,
            provider,
            tools: wf.primary.tools,
            cwd,
            workflowId,
            skipPermissions: wf.primary.skipPermissions,
            additionalDirectories: wf.primary.additionalDirectories,
            fallbackModel: wf.primary.fallbackModel,
            codexTransport: 'appserver',
            resumeSessionId: wf.primarySessionId,
            clusterId: turnClusterId,
            codebaseMemoryAttached: wf.config.codebaseMemory?.attached === true,
            codebaseMemoryIndexPath: wf.config.codebaseMemory?.attached === true
              ? (wf.config.codebaseMemory.indexPath || cwd)
              : undefined,
          }, wf.primarySessionId);
        }
      } else {
        compactedVia = 'zai-native';
        const turnClusterId = clusterStore.getClusterIdForWorkflow(workflowId);
        result = await compactZaiNativeWorker(workflowId, {
          provider: 'zai',
          model: wf.primary.model,
          effort: wf.primary.effort,
          tools: wf.primary.tools,
          cwd,
          workflowId,
          skipPermissions: wf.primary.skipPermissions,
          additionalDirectories: wf.primary.additionalDirectories,
          fallbackModel: wf.primary.fallbackModel,
          zaiTransport: 'native',
          outputStyle: wf.config.outputStyle === 'normal' || wf.config.outputStyle === 'lite' || wf.config.outputStyle === 'terse'
            ? wf.config.outputStyle
            : undefined,
          clusterId: turnClusterId,
          codebaseMemoryAttached: wf.config.codebaseMemory?.attached === true,
          codebaseMemoryIndexPath: wf.config.codebaseMemory?.attached === true
            ? (wf.config.codebaseMemory.indexPath || cwd)
            : undefined,
        });
      }
    } else if (provider === 'cursor') {
      compactedVia = 'cursor-acp';
      if (!wf.primarySessionId) {
        result = { ok: false, error: 'no saved Cursor session for this workflow — run a turn first' };
      } else {
        const turnClusterId = clusterStore.getClusterIdForWorkflow(workflowId);
        result = await compactCursorAcpThread(workflowId, {
          provider: 'cursor',
          model: wf.primary.model,
          effort: wf.primary.effort,
          tools: wf.primary.tools,
          cwd,
          workflowId,
          skipPermissions: wf.primary.skipPermissions,
          additionalDirectories: wf.primary.additionalDirectories,
          fallbackModel: wf.primary.fallbackModel,
          resumeSessionId: wf.primarySessionId,
          clusterId: turnClusterId,
          clusterTaskBoardAttached: turnClusterId
            ? clusterStore.isTaskBoardAttached(turnClusterId)
            : false,
          goal: wf.config.goal,
        }, wf.primarySessionId);
      }
    } else {
      compactedVia = 'claude-native';
      result = await compactClaudeNativeWorker(workflowId, {
        provider: 'claude',
        model: wf.primary.model,
        effort: wf.primary.effort,
        tools: wf.primary.tools,
        cwd,
        workflowId,
        skipPermissions: wf.primary.skipPermissions,
        additionalDirectories: wf.primary.additionalDirectories,
        fallbackModel: wf.primary.fallbackModel,
        claudeTransport: 'native',
        claudeNativeCompact: wf.config.claudeNativeCompact === true,
        claudeNativeForceInterleavedThinkingBeta: wf.config.claudeNativeForceInterleavedThinkingBeta === true,
        claudeNativeThinkingDisplay: wf.config.claudeNativeThinkingDisplay,
        efficiencyAutoCompact: wf.config.efficiencyAutoCompact,
        efficiencyToolFilter: wf.config.efficiencyToolFilter,
        efficiencyFactForce: wf.config.efficiencyFactForce,
        efficiencyConfigProtection: wf.config.efficiencyConfigProtection,
        efficiencySandbox: wf.config.efficiencySandbox,
        outputStyle: wf.config.outputStyle === 'normal' || wf.config.outputStyle === 'lite' || wf.config.outputStyle === 'terse'
          ? wf.config.outputStyle
          : undefined,
        codebaseMemoryAttached: wf.config.codebaseMemory?.attached === true,
        codebaseMemoryIndexPath: wf.config.codebaseMemory?.attached === true
          ? (wf.config.codebaseMemory.indexPath || cwd)
          : undefined,
      });
    }
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // False when STOP revoked the claim mid-compact (and a newer turn may hold
  // busy now) — report the outcome but leave busy + the queue alone.
  const owned = releaseBusy(wf, busyToken, 'interrupted', false);

  if (result.ok) {
    const foldedNote = typeof result.foldedTurns === 'number' ? ` (${result.foldedTurns} turn(s) folded)` : '';
    broadcastWorkflow(workflowId, {
      type: 'system_notice',
      workflowId,
      content: provider === 'cursor'
        ? `${tag} Conversation compressed — Cursor summarized older context in place. The same ACP session continues with a smaller retained history.`
        : provider === 'codex' || provider === 'zai'
        ? compactedVia === 'zai-native'
          ? `${tag} Conversation compacted — native history replaced with a summary. Next turn continues from the reduced context.`
          : `${tag} Thread compacted — earlier history summarized server-side. Next turn continues against the reduced context.`
        : `${tag} Conversation compacted${foldedNote} — history replaced with a summary. Next turn continues from it.`,
    });
    if ((compactedVia === 'codex-appserver' || compactedVia === 'zai-appserver') && wf.primarySessionId) {
      // Refresh the CTX bar: the compacted thread's next-prompt dropped, but the
      // client's lastTurnTokens still shows the pre-compact turn. Tail the
      // rollout for the latest per-call usage (same path turnEngine uses
      // post-turn). Best-effort; the next real turn corrects it regardless.
      const account = compactedVia === 'codex-appserver'
        ? await resolveProviderAccount('codex', wf.config.providerAccountRef, cwd).catch(() => null)
        : null;
      const snapshot = await refreshCodexTokenSnapshot(workflowId, wf, account?.codexHome, { updateAutoHandoffSignal: false });
      resetCodexContextAfterCompact(workflowId, wf, snapshot?.modelContextWindow);
    }
    // Claude Native: the CTX bar is driven by the NEXT turn's lastPromptTokens
    // (the server emits context_usage post-turn from the SDK count). The compact
    // shrinks messages[] in place, so the drop shows on the operator's next turn
    // — no synthetic snapshot needed here.
  } else {
    broadcastWorkflow(workflowId, {
      type: 'system_notice',
      workflowId,
      content: `${tag} Compact failed: ${result.error ?? 'unknown error'}`,
    });
  }

  // Stale (STOP'd) holder: handleCancel already sent turn_ended, and a late one
  // here would unlock the composer under the operator's resent turn.
  if (owned) broadcastTransient(workflowId, { type: 'primary_turn_ended', workflowId, endedAt: Date.now() });
  void notifyClusterStateForWorkflow(workflowId);

  // NATIVE_COMPACTION_PLAN Phase 3 — opt-in auto-continue after a successful
  // Claude Native compaction. Default off (manual: the operator clicks Continue
  // in the composer). Runs AFTER primary_turn_ended released the lock so the
  // continuance dispatches as a clean fresh turn. Claude-only; Codex/Ollama keep
  // their existing manual-resume behavior. Kept behind the per-tab flag because
  // auto-continuing after a between-turn compaction is autonomous continuation
  // (CLAUDE.md autonomy fence).
  if (!claimGuard && owned && result.ok && provider === 'claude' && wf.config.nativeCompactAutoContinue === true) {
    await maybeAutoContinueAfterCompact(workflowId, ws, session);
  }
  // Messages typed during the compaction queued behind busy; nothing else
  // flushes them (only the turn loop drains), so they'd sit until the next send.
  if (owned) await drainQueueIfIdle(workflowId);
  if (!wf.config.incognito && !wf.config.voiceOperator) publishActivity({kind:result.ok&&owned?'worker_compaction_finished':'worker_compaction_failed',workflowId,clusterId:clusterStore.getClusterIdForWorkflow(workflowId)});
}

// §2.1 — operator-triggered Fold. Deterministic + instant (no LLM round), so
// the handler is far lighter than compact: gate (claude + native + idle), run
// foldClaudeNativeWorker, surface the byte delta. The worker emits the durable
// context_folded marker itself (replay re-seeds it). Same four-question
// eligibility as compact/handoff.
export async function handleFoldWorkflow(ws: WebSocket, _session: Session, msg: FoldWorkflowMessage): Promise<void> {
  const workflowId = msg.workflowId;
  const wf = workflows.get(workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${workflowId.slice(0, 8)}` });
    return;
  }
  if (wf.primary.provider !== 'claude') {
    send(ws, { type: 'error', message: 'Fold is a Claude Native feature — use Compact or Handoff on other providers.' });
    return;
  }
  const serverEngine = msg.engine === 'server';
  // Chat tabs have no composer Fold controls; reject a hand-crafted message
  // rather than reshape a projectless chat's history.
  if (serverEngine && isChatWorkflow(wf.config)) {
    send(ws, { type: 'error', message: 'Server Fold is Agent-tab only.' });
    return;
  }
  if (wf.busy) {
    send(ws, { type: 'error', message: 'Agent is busy — wait for the turn to finish, then fold.' });
    return;
  }
  const cwd = workflowCwds.get(workflowId) ?? wf.config.workingDirectory;
  const cascade = await readSettings(cwd).catch(() => null);
  const claudeTransport = wf.config.claudeTransport
    ?? (cascade?.claude?.transport === 'native' ? 'native' : 'cli');
  if (claudeTransport !== 'native') {
    send(ws, { type: 'error', message: 'Fold needs the Claude Native transport (CONFIG → TRANSPORT). On CLI Claude, use Handoff.' });
    return;
  }

  // Same re-check as compact: the gate above predates the readSettings await.
  if (wf.busy) {
    send(ws, { type: 'error', message: 'Agent is busy — wait for the turn to finish, then fold.' });
    return;
  }
  const startedAt = Date.now();
  const busyToken = claimBusy(wf);
  broadcastTransient(workflowId, { type: 'primary_turn_started', workflowId, startedAt });
  broadcastWorkflow(workflowId, {
    type: 'ctx_action',
    workflowId,
    action: 'compact',
    trigger: 'operator',
    detail: serverEngine
      ? 'Claude Native server Fold (on-demand compaction compact-2026-09-04, recent turns kept verbatim; deterministic Fold on failure)'
      : 'Claude Native deterministic Fold (in-place trim, same session)',
  });
  if (serverEngine) {
    broadcastWorkflow(workflowId, {
      type: 'system_notice',
      workflowId,
      content: '[claude] Server-folding conversation… (one on-demand compaction call; recent turns stay verbatim)',
    });
  }

  let result: Awaited<ReturnType<typeof serverFoldClaudeNativeWorker>>;
  try {
    result = serverEngine
      ? await serverFoldClaudeNativeWorker(workflowId)
      : await foldClaudeNativeWorker(workflowId, undefined, { trigger: 'operator' });
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const owned = releaseBusy(wf, busyToken);

  if (result.ok) {
    // A fold drops the prompt size; the next turn's count_tokens refreshes the
    // CTX bar (same as compact — no synthetic snapshot needed). Reset the
    // handoff/fold fired flags so a post-fold low fill re-arms cleanly.
    wf.autoHandoff.warnFired = false;
    wf.autoHandoff.autoFired = false;
    if (wf.autoFold) wf.autoFold.foldFired = false;
    const kb = typeof result.byteDelta === 'number' ? ` (~${Math.round(result.byteDelta / 1024)} KB reclaimed)` : '';
    const turns = typeof result.foldedTurns === 'number' ? `${result.foldedTurns} turn(s) ` : '';
    const spend = result.usage ? ` Compaction call: ${formatFoldUsage(result.usage)}.` : '';
    broadcastWorkflow(workflowId, {
      type: 'system_notice',
      workflowId,
      content: serverEngine && !result.fellBack
        ? `[claude] Server-folded ${turns}into a signed server summary${kb}; last ${result.keptTurns ?? 0} turn(s) kept verbatim (thinking preserved).${spend} Undo: HISTORY → rewind to before this fold.`
        : serverEngine
          ? `[claude] Server Fold ${result.fallbackKind === 'unsupported' ? 'unavailable' : 'failed'} (${result.fallbackReason ?? 'unknown'}) — fell back to the deterministic Fold: folded ${turns}into a digest${kb}.${spend}`
          : `[claude] Folded ${turns}into a deterministic digest${kb} — same session continues from the reduced context.`,
    });
  } else {
    const spend = result.usage ? ` Compaction call: ${formatFoldUsage(result.usage)}.` : '';
    const via = result.fellBack ? ` (server Fold ${result.fallbackKind === 'unsupported' ? 'unavailable' : 'failed'}: ${result.fallbackReason ?? 'unknown'}; deterministic fallback also failed)` : '';
    broadcastWorkflow(workflowId, {
      type: 'system_notice',
      workflowId,
      content: `[claude] Fold failed: ${result.error ?? 'unknown error'}${via}${spend}`,
    });
  }

  // Stale (STOP'd) holder: handleCancel already sent turn_ended, and a late one
  // here would unlock the composer under the operator's resent turn.
  if (owned) broadcastTransient(workflowId, { type: 'primary_turn_ended', workflowId, endedAt: Date.now() });
  void notifyClusterStateForWorkflow(workflowId);
  if (owned) await drainQueueIfIdle(workflowId);
}

function formatFoldUsage(u: { input: number; output: number; cacheRead: number; cacheCreate: number }): string {
  const cache = u.cacheRead + u.cacheCreate > 0 ? ` (+${u.cacheRead.toLocaleString()} cache-read, ${u.cacheCreate.toLocaleString()} cache-write)` : '';
  return `${u.input.toLocaleString()} in${cache} / ${u.output.toLocaleString()} out tokens`;
}

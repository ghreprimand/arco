import { publishActivity, computerProjectionChanged } from '../voice/activityBus.js';
import { setComputerBackgroundClaim, clearComputerBackgroundClaim, isComputerBackgroundClaim } from '../voice/operatorTools.js';
import { watchClaimed, watchSettled } from '../voice/watches.js';
import { renderComputerHistory } from '../voice/history.js';
import { computerReplayEvents, announceComputerSettled } from '../voice/computerContext.js';
import { VOICE_OPERATOR_PROMPT } from '../voice/operatorPrompt.js';
import { COMPUTER_TIMEOUT } from '../voice/turnWatchdog.js';
import type {
ServerMessage,
SteerItem,
WorkflowConfig,
ClusterEfficiencyLevel
} from '@arco/shared';
import { type WorkflowSessionMetadata, zaiModelContextWindow } from '@arco/shared';
import { WebSocket } from 'ws';
import { discoverClaudeMdFiles } from '../claudeMdDiscovery.js';
import { buildKnowledgeBlock } from '../knowledge/store.js';
import { expandContextRefs } from '../contextRefs.js';
import { refsDoctrine } from '../planRefContext.js';
import { createCheckpoint } from '../gitSnapshots.js';
import { isManagedBakeoffWorktree } from '../gitBakeoff.js';
import * as clusterMailbox from '../clusterMailbox.js';
import * as clusterPlanBridge from '../clusterPlanBridge.js';
import * as clusterStore from '../clusterStore.js';
import * as clusterEfficiency from '../clusterEfficiency.js';
import { BLIND_CLUSTER_DOCTRINE } from '../clusterAccessDoctrine.js';
import { buildProgressDoctrine } from '../clusterProgress.js';
import { buildClusterDirectorDoctrine, joinClusterDoctrines } from '../clusterDirector.js';
import * as projectTrust from '../projectTrust.js';
import { parsePromptInvocation, expandPromptCommand, projectPromptExists } from '../prompts.js';
import {
highestUncalibratedZoneCrossed,
runCalibration,
type CalibrationState,
} from '../contextCalibrator.js';
import { BYTES_PER_TOKEN_DEFAULT,estimateContextFill,nativeContextEstimate,OVERHEAD_TOKENS_DEFAULT,promptContextEstimate } from '../contextEstimator.js';
import { computeContextBudget, crossedThresholds } from '../providers/claude-native/contextBudget.js';
import { chooseMaxTokens, lookupCtx } from '../providers/claude-native/modelParams.js';
import * as mcpConfigWriter from '../mcp/mcpConfigWriter.js';
import { codexModelUsesCodeMode, codexCodeModeClusterAddendum } from '../providers/codexCodeMode.js';
import { composeClusterAppend, APPEND_CLUSTER_MAX, CODEX_APP_SERVER_CLUSTER_MAX } from '../clusterStringFold.js';
import { planOutline } from '../clusterPlanOutline.js';
import { resolveRegistryWiring } from '../mcp/registryWiring.js';
import {
listPlanRefs,
readPlan
} from '../planStore.js';
import { PreviewAutoDetect } from '../previewAutoDetect.js';
import { PrimaryBackgroundTracker } from '../primaryBackgroundTracker.js';
import { renderTranscript,summarizePriorTurns } from '../primitives/exportContext.js';
import { runPrimaryTurn,type PrimaryConfig } from '../primitives/seedWorker.js';
import { ollamaContextUsage } from '../providers/ollamaTokens.js';
import { evaluateGoalRun, goalRunContinuePrompt, GOAL_RUN_STOP_TEXT, type GoalRunState } from '../goalRun.js';
import { isAvailable } from '../quota.js';
import { resolveProviderAccount } from '../providerAccounts.js';
import {
broadcastTransient,
broadcastWorkflow,
notifyClusterStateForWorkflow,
send
} from '../server/broadcast.js';
import {
FOREIGN_WARN_DEBOUNCE_MS,
FOREIGN_WRITE_BLOCK_MS,
PORT,
SESSION_HISTORY_PAGE_SIZE
} from '../server/constants.js';
import {
buildLocalClusterSystemPrompt,
LLAMACPP_PRIMARY_SYSTEM_PROMPT,
OLLAMA_PRIMARY_SYSTEM_PROMPT,
withPreviewNudge
} from '../server/prompts.js';
import { buildGenesisSystemBlock } from '../genesis/prompts.js';
import { CHAT_PROVIDERS, chatSystemPrompt, chatWebArmed, isChatWorkflow } from '../chatMode.js';
import {
sessions,
workflows
} from '../server/state.js';
import { loadSessionJsonl,resolveSessionJsonlPath,watchSessionJsonl,type SessionJsonlEntry } from '../sessionJsonl.js';
import { startUltracodeFleetWatcher, type FleetWatcher } from '../ultracodeFleetWatcher.js';
import {
readSettings
} from '../settings.js';
import {
buildPickedSkillsBlock,
buildPinnedSkillsBlock,
resolvePinnedSkills,
buildSkillsManifest,
listSkills,
readSkillBody
} from '../skills.js';
import {
ensureMeta,readMeta,reconcileLatestCliSession,updateMeta,type WorkflowMeta
} from '../workflowMeta.js';
import {
currentSeq as currentWorkflowSeq,
replayEvents as replayWorkflowEvents
} from '../workflowStore.js';
import {
latestCodexTokenSnapshot
} from '../workflows/transcripts.js';
import { compactClaudeNativeWorker, foldClaudeNativeWorker } from '../providers/claude-native/index.js';
import { maybeFreshComputerContext } from '../voice/computerContext.js';
import type {
QueueItem,
Session,
SessionEntryPayload,
WorkflowState
} from '../workflows/types.js';
import { awaitModelImages } from '../providers/attachments.js';

const PUBLIC_REPO_SAFETY_SYSTEM_BLOCK = [
  'Genesis public repository safety:',
  'This workflow is attached to a Genesis project configured for a public GitHub repository.',
  'Before committing or pushing, inspect staged changes for secrets, credentials, API keys, tokens, private URLs, private hostnames, personal data, local-only config, and Arco workflow metadata.',
  'Never publish sensitive material. If a file or value is ambiguous, stop and ask the operator before committing or pushing.',
].join('\n');

// Turn engine — the core user-message handler plus the session watcher, queue
// drain/requeue, calibration/auto-handoff lifecycle, plan-prefix builder, and
// config-derivation helpers. Extracted from index.ts in Phase 4 Milestone D
// step 2. Three back-edges index.ts keeps (the PreviewAutoDetect instance and
// the create-workflow / handoff handlers it dispatches into) are injected once
// via initTurnEngine. See docs/FILE_SIZE_REFACTOR_PLAN.md.
export interface TurnEngineDeps {
  previewAutoDetect: PreviewAutoDetect;
  handleCreateWorkflow: (ws: WebSocket, session: Session, config: WorkflowConfig) => Promise<void>;
  handleHandoffRequest: (ws: WebSocket, session: Session, msg: import('@arco/shared').HandoffRequestMessage) => Promise<void>;
}
let deps: TurnEngineDeps;
export function initTurnEngine(d: TurnEngineDeps): void { deps = d; }


// Extract renderable entries from a raw Claude session JSONL line. A single
// line can produce 0..N entries: assistant messages often contain a text
// block plus one or more tool_use blocks, and we want each to show up
// in chat as its own row (text as a bubble, tool_use as a compact pill).
// Returns [] for tool_result / summary / other entries that don't render.

// For Write/Edit/Read/NotebookEdit the tool input carries a `file_path` that
// we want to expose on the pill so clicking opens the file in FileViewerModal.
// Other tools (Bash, WebFetch, Grep, ...) surface their own summary from input
// and are non-clickable.
export function extractFilePath(tool: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  if (tool === 'Read' || tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const p = rec.file_path;
    return typeof p === 'string' ? p : undefined;
  }
  return undefined;
}

export function stripSafetyReminder(text: string): string {
  const marker = '[Arco safety reminders';
  const markerIdx = text.indexOf(marker);
  if (markerIdx === -1) return text;
  const before = text.slice(0, markerIdx).trimEnd();
  return before.endsWith('---') ? before.slice(0, -3).trimEnd() : before;
}

// Drop the per-turn plan prefix that buildPlanPrefix() prepends to user
// prompts. Claude's session JSONL records the full prompt verbatim, so the
// prefix would otherwise re-render as a duplicate user bubble in chat (the
// clean copy comes from user_message_echo). The pattern is distinctive
// (`[Active project plan…]` opening line + optional `<plan>…</plan>`
// block + blank separator); anchoring at the start of the message means
// we don't touch user-typed content that happens to mention plans later.
// Both prefix forms are stripped: the attached-plan one-liner and the
// no-plan-attached authoring note (`planAuthoringNote`). The greedy `[^\n]*\]`
// runs to the last bracket on the line, which is each form's own closer — that
// matters for the note, whose text contains a literal `- [ ]` example.
export const PLAN_PREFIX_RE = /^\[(?:Active project plan|No project plan is attached)[^\n]*\]\n(?:<plan>\n[\s\S]*?\n<\/plan>\n)?\n/;
export function stripPlanPrefix(text: string): string {
  return text.replace(PLAN_PREFIX_RE, '');
}

export function toSessionEntries(raw: SessionJsonlEntry): SessionEntryPayload[] {
  if (raw.type !== 'user' && raw.type !== 'assistant') return [];
  // CLI-fabricated assistant rows (model:"<synthetic>", zero usage) are
  // bookkeeping, not model output — e.g. the "No response requested." reply
  // Claude writes for a resumed `--print "/context"` probe. Rendering them as
  // agent replies is how the 2026-08-02 calibration-pollution incident painted
  // phantom bubbles over real answers.
  if (raw.type === 'assistant' && raw.message?.model === '<synthetic>') return [];
  // Skip slash-command echoes. When a resumed `claude --print "/<cmd>"` runs
  // (e.g. Arco's /context calibration), Claude writes three rows into the
  // session JSONL: a `<local-command-caveat>` user turn with isMeta:true, a
  // `<command-name>` user turn (no isMeta flag), and a `system` row holding
  // the command's stdout. The system row is already dropped by the type check
  // above; the two user rows would otherwise render in chat as if the
  // operator had typed them. Filter on the meta flag plus a content-prefix
  // sniff so we also catch the command-name row.
  if (raw.type === 'user') {
    if (raw.isMeta) return [];
    const c = raw.message?.content;
    const head = typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? (c as Array<{ type?: string; text?: string }>).find((p) => p?.type === 'text')?.text ?? ''
        : '';
    if (/^\s*<(command-name|local-command-caveat)>/.test(head)) return [];
  }
  const role = raw.type as 'user' | 'assistant';
  const msg = raw.message;
  if (!msg) return [];
  const ts = raw.timestamp ? Date.parse(raw.timestamp) || Date.now() : Date.now();
  const out: SessionEntryPayload[] = [];

  // String content — a plain text message with no tool blocks. Claude's SDK
  // stores user turns this way when --append-system-prompt was used, so the
  // safety-reminder footer has to be stripped here too (not just in the
  // array-content path).
  if (typeof msg.content === 'string') {
    let text = msg.content;
    if (role === 'user') text = stripPlanPrefix(stripSafetyReminder(text));
    if (text.trim()) out.push({ kind: 'message', role, content: text, timestamp: ts, uuid: raw.uuid });
    return out;
  }

  if (!Array.isArray(msg.content)) return [];

  // Block-structured message. Concatenate all text blocks into one message
  // entry (matches old behavior), emit each tool_use block as its own pill.
  let text = (msg.content as Array<{ type?: string; text?: string }>)
    .filter((p) => p?.type === 'text')
    .map((p) => p.text ?? '')
    .join('');
  if (role === 'user') text = stripPlanPrefix(stripSafetyReminder(text));
  if (text.trim()) {
    out.push({ kind: 'message', role, content: text, timestamp: ts, uuid: raw.uuid });
  }

  // Tool uses render only for assistant messages. User messages contain
  // tool_result blocks we deliberately skip (they'd blow out the chat;
  // the Read on a PNG is 26KB base64, for example).
  if (role === 'assistant') {
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (!block || block.type !== 'tool_use') continue;
      const tool = typeof block.name === 'string' ? block.name : 'unknown';
      const toolUseId = typeof block.id === 'string' ? block.id : '';
      if (!toolUseId) continue; // no dedup key → drop
      out.push({
        kind: 'tool_use',
        tool,
        input: block.input ?? {},
        filePath: extractFilePath(tool, block.input),
        toolUseId,
        timestamp: ts,
      });
    }
  }

  return out;
}

// Effective Claude transport for a workflow: sticky ultracode forces 'cli'
// (the harness WorkflowTool lives only in the `claude` binary), else explicit
// per-tab config wins, else the cwd's TRANSPORT DEFAULTS cascade, else 'cli'.
// Same precedence as the turn dispatcher — keep the two in sync.
export async function resolveClaudeTransport(wf: WorkflowState, cwd: string): Promise<'cli' | 'native'> {
  if (wf.primary.provider === 'claude' && wf.config.ultracode === true) return 'cli';
  if (wf.config.claudeTransport === 'native' || wf.config.claudeTransport === 'cli') {
    return wf.config.claudeTransport;
  }
  const cascade = await readSettings(cwd).catch(() => null);
  return cascade?.claude?.transport === 'native' ? 'native' : 'cli';
}

// Start watching Claude's session JSONL for a workflow.
// `initialWs` receives the historical entries; new entries go to all observers.
// No-op for non-Claude providers, when primarySessionId is absent, or on the
// Native transport — a Native tab's transcript truth is events.jsonl; its turns
// never write the CLI session JSONL. Watching a (stale, e.g. handoff-era) file
// here let out-of-band appends — notably the /context calibration probe's
// synthetic "No response requested." rows — render as agent replies while
// ChatPanel's sessionChat-canonical mode hid every real finalized answer
// (2026-08-02 incident).
export function startSessionWatcher(workflowId: string, wf: WorkflowState, cwd: string, initialWs?: WebSocket): void {
  if (wf.primary.provider !== 'claude') return;
  const sessionId = wf.primarySessionId;
  if (!sessionId) return;
  if (wf.sessionWatcher) {
    wf.sessionWatcher();
    wf.sessionWatcher = null;
  }
  const path = resolveSessionJsonlPath(cwd, sessionId);
  resolveClaudeTransport(wf, cwd).then((transport) => {
    if (transport === 'native') return null;
    return loadSessionJsonl(path);
  }).then((loaded) => {
    if (!loaded) return;
    const { entries, byteLength } = loaded;
    // Tail-first: only the last N raw entries go out immediately. Anything
    // older sits on wf.pendingEarlierEntries until the operator pages back
    // via `load_earlier_messages`. Keeps first-paint fast on huge sessions
    // (the old behavior emitted thousands of session_entry messages at once
    // and the client's O(n) upsert-dedup made it N² expensive to render).
    const splitIdx = Math.max(0, entries.length - SESSION_HISTORY_PAGE_SIZE);
    const earlier = entries.slice(0, splitIdx);
    const tail = entries.slice(splitIdx);
    const wfAtLoad = workflows.get(workflowId);
    if (wfAtLoad) {
      wfAtLoad.pendingEarlierEntries = earlier;
    }
    for (const raw of tail) {
      for (const entry of toSessionEntries(raw)) {
        const msg: ServerMessage = { type: 'session_entry', workflowId, entry };
        if (initialWs && initialWs.readyState === WebSocket.OPEN) {
          initialWs.send(JSON.stringify(msg));
        }
      }
    }
    if (initialWs && initialWs.readyState === WebSocket.OPEN) {
      initialWs.send(JSON.stringify({
        type: 'session_history_status',
        workflowId,
        hasEarlier: earlier.length > 0,
        earlierRemaining: earlier.length,
      } satisfies ServerMessage));
    }
    if (!workflows.has(workflowId)) return; // workflow removed while loading
    const dispose = watchSessionJsonl(path, byteLength, (raw) => {
      // Concurrent-session detection. Live writes with an entrypoint other
      // than 'sdk-cli' mean a native `claude --resume` terminal is writing
      // to this same JSONL. Flag the workflow, and emit a debounced chat
      // warning so the operator knows the next turn will be refused.
      if (raw.entrypoint && raw.entrypoint !== 'sdk-cli') {
        const wfNow = workflows.get(workflowId);
        if (wfNow) {
          const now = Date.now();
          wfNow.lastForeignWriteAt = now;
          const lastWarn = wfNow.lastForeignWarnAt ?? 0;
          if (now - lastWarn > FOREIGN_WARN_DEBOUNCE_MS) {
            wfNow.lastForeignWarnAt = now;
            const obs = anyObserver(workflowId);
            if (obs) {
              send(obs, {
                type: 'system_notice',
                workflowId,
                content:
                  '[CONCURRENT NATIVE SESSION] A native `claude --resume` terminal is writing to this session. Two processes writing one JSONL corrupts conversation state — Arco will refuse new turns until it stops. Close the native terminal, or rotate via Handoff.',
              });
            }
          }
        }
      }
      for (const entry of toSessionEntries(raw)) {
        broadcastTransient(workflowId, { type: 'session_entry', workflowId, entry });
      }
    });
    const wfNow = workflows.get(workflowId);
    if (wfNow) {
      wfNow.sessionWatcher = dispose;
    } else {
      dispose(); // workflow gone — clean up immediately
    }
    console.log(`[arco] [${workflowId.slice(0, 8)}] session watcher started (${tail.length} emitted / ${earlier.length} deferred / ${entries.length} total, ${byteLength}B)`);
  }).catch((err) => {
    console.error(`[arco] [${workflowId.slice(0, 8)}] session watcher init failed:`, err);
  });
}

export function derivePrimaryConfig(config: WorkflowConfig): PrimaryConfig {
  return {
    provider: config.primaryProvider ?? 'claude',
    model: config.primaryModel,
    effort: config.primaryEffort,
    skipPermissions: config.skipPermissions,
    additionalDirectories: config.advanced?.additionalDirectories,
    fallbackModel: config.advanced?.fallbackModel,
  };
}

export function deriveAutoHandoff(config: WorkflowConfig): WorkflowState['autoHandoff'] {
  return {
    enabled: config.autoHandoff?.enabled ?? true,
    warnAt: config.autoHandoff?.warnAt ?? 75,
    autoAt: config.autoHandoff?.autoAt ?? 90,
    warnFired: false,
    autoFired: false,
    // WP5 — carry through verbatim (no defaulting); resolution happens at
    // fire time so a later change to the global default still affects tabs
    // that never set a per-tab override.
    mode: config.autoHandoff?.mode,
    summarizer: config.autoHandoff?.summarizer,
  };
}

// §2.1 — mirror WorkflowConfig.autoFold into the live state shape (carrying the
// runtime-only foldFired + anti-thrash counter). Returns undefined when the tab
// has no autoFold config (auto-fold off).
export function deriveAutoFold(config: WorkflowConfig): WorkflowState['autoFold'] {
  if (!config.autoFold) return undefined;
  return {
    enabled: config.autoFold.enabled ?? false,
    foldAt: config.autoFold.foldAt ?? 60,
    tailBudget: config.autoFold.tailBudget,
    foldFired: false,
    foldIneffectiveCount: 0,
  };
}

export function applyAutoHandoffDefault(
  config: WorkflowConfig,
  defaults?: Partial<NonNullable<WorkflowConfig['autoHandoff']>> | null,
): boolean {
  if (config.autoHandoff) return false;
  if (!defaults) return false;
  if (
    defaults.enabled === undefined
    && defaults.warnAt === undefined
    && defaults.autoAt === undefined
    && defaults.mode === undefined
    && defaults.summarizer === undefined
  ) return false;
  config.autoHandoff = {
    enabled: defaults.enabled ?? true,
    warnAt: defaults.warnAt ?? 75,
    autoAt: defaults.autoAt ?? 90,
    ...(defaults.mode !== undefined ? { mode: defaults.mode } : {}),
    ...(defaults.summarizer !== undefined ? { summarizer: defaults.summarizer } : {}),
  };
  return true;
}

export function sessionMetadataForWorkflow(wf: WorkflowState): WorkflowSessionMetadata | undefined {
  if (wf.primary.provider !== 'antigravity') return undefined;
  return {
    sessionKind: 'antigravity-cascade',
    ...(wf.primarySessionId ? { cascadeId: wf.primarySessionId } : {}),
    opaqueContext: true,
    arcoAutoCompact: false,
    contextLabel: 'Antigravity-managed',
  };
}

export function broadcastSessionMetadata(workflowId: string, wf: WorkflowState): void {
  broadcastTransient(workflowId, {
    type: 'workflow_session_metadata',
    workflowId,
    sessionMetadata: sessionMetadataForWorkflow(wf),
  });
}

export async function refreshCodexTokenSnapshot(
  workflowId: string,
  wf: WorkflowState,
  codexHome?: string,
  opts?: { updateAutoHandoffSignal?: boolean },
): Promise<Awaited<ReturnType<typeof latestCodexTokenSnapshot>>> {
  if (!wf.primarySessionId) return null;
  const snapshot = await latestCodexTokenSnapshot(wf.primarySessionId, codexHome).catch(() => null);
  if (!snapshot) return null;
  const modelContextWindow = wf.primary.provider === 'zai'
    ? zaiModelContextWindow(wf.primary.model)
    : snapshot.modelContextWindow;
  broadcastTransient(workflowId, {
    type: 'codex_token_snapshot',
    workflowId,
    tokens: snapshot.tokens,
    ...(typeof modelContextWindow === 'number'
      ? { modelContextWindow }
      : {}),
  } as ServerMessage);
  if (opts?.updateAutoHandoffSignal !== false) {
    const lastInput = snapshot.tokens.input;
    const win = modelContextWindow;
    if (typeof lastInput === 'number' && typeof win === 'number' && win > 0) {
      wf.lastContextPercent = Math.max(0, Math.min(100, Math.round((lastInput / win) * 100)));
    }
  }
  return snapshot;
}

export function resetCodexContextAfterCompact(
  workflowId: string,
  wf: WorkflowState,
  modelContextWindow?: number,
): void {
  wf.lastContextPercent = 0;
  wf.autoHandoff.warnFired = false;
  wf.autoHandoff.autoFired = false;
  broadcastTransient(workflowId, {
    type: 'codex_token_snapshot',
    workflowId,
    tokens: { input: 0, output: 0 },
    ...(typeof modelContextWindow === 'number' && modelContextWindow > 0
      ? { modelContextWindow }
      : {}),
  } as ServerMessage);
}

// Seed the per-tab Anthropic server-side compaction toggle for NEW tabs.
// Precedence: explicit per-tab value (meta.json / UI) > global settings default
// (settings.claudeNativeCompactDefault) > hardcoded `false`. The default flipped
// to OFF in NATIVE_COMPACTION_PLAN Phase 1 — the server-side beta fires mid-turn
// at a flat ~150K tokens and can evict a Read-heavy coding tab's working set.
export function applyClaudeNativeCompactDefault(config: WorkflowConfig, globalDefault?: boolean): void {
  config.claudeNativeCompact ??= globalDefault ?? false;
}

function isLegacyClaudeNativeCompact(meta: WorkflowMeta): boolean {
  return meta.claudeNativeCompact === true && typeof meta.claudeNativeCompactUserSetAt !== 'number';
}

async function migrateLegacyClaudeNativeCompact(cwd: string, workflowId: string, wf: WorkflowState): Promise<void> {
  if (wf.config.claudeNativeCompact !== true) return;
  // Locked RMW (GOTCHAS § Persistence): a bare read→write here could drop a
  // concurrent meta mutation (plan attach, calibration) landing in between.
  let migrated = false;
  await updateMeta(cwd, workflowId, (meta) => {
    if (!isLegacyClaudeNativeCompact(meta)) return false;
    meta.claudeNativeCompact = false;
    meta.lastActiveAt = Date.now();
    migrated = true;
  }).catch(() => null);
  if (!migrated) return;
  wf.config.claudeNativeCompact = false;
  broadcastWorkflow(workflowId, {
    type: 'system_notice',
    workflowId,
    content: '[claude] Disabled legacy Anthropic server-side compaction for this workflow. Use Arco COMPACT/HANDOFF instead, or re-enable it in CONFIG if you explicitly want Anthropic compact_20260112.',
  });
  console.log(`[arco] [${workflowId.slice(0, 8)}] migrated legacy claude.native.compact true → false`);
}

// Return any open WebSocket observing workflowId — used as the `ws` argument
// for `send()` when broadcasting from server-internal triggers (auto-handoff).
// `send()` already fans out to all observers; the ws here is just the fallback.
export function anyObserver(workflowId: string): WebSocket | null {
  const wf = workflows.get(workflowId);
  if (!wf) return null;
  for (const obs of wf.observers) {
    if (obs.readyState === WebSocket.OPEN) return obs;
  }
  return null;
}

// Per-claim busy ownership. `wf.busy` alone can't tell WHICH holder is
// releasing it: STOP (handleCancel) drops busy immediately, the operator's
// quick resend claims it for turn 2, and turn 1's loop — still unwinding its
// post-settle awaits — then hit its `finally` and cleared turn 2's busy flag
// (and drained/cleared turn 2's queue). Every holder that claims through here
// gets a token; only the current token may release, and revokeBusy() (STOP /
// tab close) orphans whatever claim is in flight so its late release is a
// no-op. Keyed on the WorkflowState object so a removed tab's entry is GC'd.
let busyClaimSeq = 0;
const busyOwners = new WeakMap<WorkflowState, number>();

export function publishWorkerActivity(wf: WorkflowState, kind: 'worker_started' | 'worker_finished' | 'worker_failed' | 'worker_interrupted' | 'worker_removed' | 'queue_changed') {
  if (wf.config?.incognito || wf.config?.kind === 'chat' || wf.config?.voiceOperator) return;
  for (const [id, current] of workflows) if (current === wf) {
    publishActivity({ kind, workflowId: id, clusterId: clusterStore.getClusterIdForWorkflow(id), name: wf.config.name ?? id }); break;
  }
}

export function claimBusy(wf: WorkflowState): number {
  const token = ++busyClaimSeq;
  busyOwners.set(wf, token);
  watchClaimed(wf, token);
  wf.busy = true;
  if(wf.config?.voiceOperator)wf.computerSettled=false;
  publishWorkerActivity(wf, 'worker_started');
  return token;
}

export function ownsBusy(wf: WorkflowState, token: number): boolean {
  return busyOwners.get(wf) === token;
}

// Returns false (and leaves wf.busy alone) when the claim was revoked or
// superseded — the caller is a stale holder and must not touch busy/queue.
export function releaseBusy(wf: WorkflowState, token: number, outcome: 'finished' | 'interrupted' | 'failed' = 'interrupted', workerActivity = true): boolean {
  if (busyOwners.get(wf) !== token) return false;
  watchSettled(wf, busyOwners.get(wf), outcome);
  busyOwners.delete(wf);
  wf.busy = false;
  clearComputerBackgroundClaim([...workflows].find(([, current]) => current === wf)?.[0] ?? '', token);
  if (wf.config?.voiceOperator) computerProjectionChanged();
  // Compaction publishes its own operation outcome after refresh/queue drain;
  // releasing that claim must not fabricate a worker STOP in the live ledger.
  if (workerActivity) publishWorkerActivity(wf, outcome === 'finished' ? 'worker_finished' : outcome === 'failed' ? 'worker_failed' : 'worker_interrupted');
  return true;
}

export function revokeBusy(wf: WorkflowState): void {
  const token = busyOwners.get(wf);
  watchSettled(wf, busyOwners.get(wf), 'interrupted');
  busyOwners.delete(wf);
  wf.busy = false;
  if (token !== undefined) clearComputerBackgroundClaim([...workflows].find(([, current]) => current === wf)?.[0] ?? '', token);
  if (wf.config?.voiceOperator) computerProjectionChanged();
  if(token !== undefined)publishWorkerActivity(wf, 'worker_interrupted');
}

// Start a turn from queued operator messages when nothing else holds the tab.
// The handleUserMessage loop drains its own queue, but every OTHER busy holder
// (compact / fold / auto-fold / handoff / spawn) used to release busy and walk
// away — messages typed during them sat QUEUED until the operator sent another
// one, and an armed goal run skipped forever (evaluateGoalRun: queued ⇒ skip).
// Resolves true when a drain turn was dispatched (awaited to completion — that
// turn runs its own post-settle actions, goal run included). Queue items were
// echoed + context-expanded at enqueue, so the drain path skips both.
export async function drainQueueIfIdle(workflowId: string): Promise<boolean> {
  const wf = workflows.get(workflowId);
  if (!wf || wf.busy || wf.computerResetting) return false;
  if (wf.queue.steering.length === 0 && wf.queue.followUp.length === 0) return false;
  const obs = anyObserver(workflowId);
  // No socket to dispatch through: leave them queued (still visible); the next
  // operator send drains them after its turn.
  if (!obs) return false;
  const session: Session = sessions.get(obs) ?? { id: 'drain', workflowIds: new Set([workflowId]), clusterIds: new Set(), clusterObserved: new Map() };
  try {
    await handleUserMessage(obs, session, workflowId, '', undefined, undefined, false, undefined, undefined, undefined, { fromQueue: true });
  } catch (err) {
    console.error(`[arco] [${workflowId.slice(0, 8)}] queue drain dispatch failed:`, err);
  }
  return true;
}

// GOAL_RUN_PLAN.md — explicit operator-side disarm (STOP / tab close). Before
// this, STOP only ended a run because every provider's kill() emits a
// synthetic error that tripped `turn_error` on the next settle — an accident
// of plumbing, and the cancel-race fix (stale loops skip post-settle) removed
// even that. Announced like every other stop; counters are not mirrored to
// meta.json by design, so the persisted record is the notice itself.
export function disarmGoalRun(workflowId: string, wf: WorkflowState, why: string): void {
  const state = wf.config.goalRun;
  if (!state?.enabled) return;
  state.enabled = false;
  const spent = state.total - state.remaining;
  broadcastWorkflow(workflowId, {
    type: 'system_notice',
    workflowId,
    content:
      `[GOAL RUN] Stopped after ${spent}/${state.total} iteration${spent === 1 ? '' : 's'} — ` +
      `${why}. ${formatGoalRunTokens(state.tokensUsed)} spent. Re-arm with \`/goal run <n>\`.`,
  });
  broadcastWorkflow(workflowId, { type: 'goal_run_state', workflowId, ...snapshotGoalRun(state) });
  delete wf.config.goalRun;
  if (!wf.config.incognito) console.log(`[arco] [${workflowId.slice(0, 8)}] goal run disarmed (${why}) after ${spent}/${state.total}`);
}

// §2.1 — minimum bytes a fold must reclaim to count as "productive". Below this
// the anti-thrash counter increments; a productive fold resets it (delta 2).
const MIN_EFFECTIVE_FOLD_BYTES = 8 * 1024;
// Stop auto-folding after this many consecutive ineffective folds (history is
// already near-minimal — folding again just churns). Operator can still manual
// Fold or Handoff. Resets on a productive fold.
const MAX_INEFFECTIVE_FOLDS = 2;

// Check the §2.3 budget meter and fire a deterministic in-place Fold before the
// handoff thresholds (foldAt sits below warnAt). Claude-Native only; operator
// must have armed wf.config.autoFold. Returns true when a fold actually fired,
// so the caller can skip the (now-stale) handoff check this round. Called
// post-turn with wf.busy already false.
export async function maybeAutoFold(workflowId: string, wf: WorkflowState, cwd: string | undefined): Promise<boolean> {
  // Chat tabs never reshape history behind the operator's back.
  if (isChatWorkflow(wf.config)) return false;
  if (wf.primary.provider !== 'claude') return false;
  const cfg = wf.config.autoFold;
  if (!cfg?.enabled) return false;
  // Lazily mirror config → live state so the fired/anti-thrash counters persist
  // across post-turn checks even if the state field wasn't derived at creation.
  if (!wf.autoFold) wf.autoFold = deriveAutoFold(wf.config);
  const st = wf.autoFold;
  if (!st) return false;

  const pct = wf.lastContextBudgetPct;
  if (typeof pct !== 'number' || pct <= 0) return false;
  // Re-arm once the budget drops back below the threshold (post-fold the seed +
  // tail starts well under foldAt) — mirrors autoHandoff.warnFired reset.
  if (pct < Math.max(0, st.foldAt - 5)) st.foldFired = false;
  if (pct < st.foldAt || st.foldFired || wf.busy) return false;
  if ((st.foldIneffectiveCount ?? 0) >= MAX_INEFFECTIVE_FOLDS) return false;

  // Native transport required (CLI Claude has no in-process history to fold).
  const cascade = await readSettings(cwd).catch(() => null);
  const transport = wf.config.claudeTransport ?? (cascade?.claude?.transport === 'native' ? 'native' : 'cli');
  if (transport !== 'native') return false;
  // Re-check after the settings await: an operator message can have claimed
  // the tab meanwhile, and folding under a live turn corrupts its history.
  if (wf.busy) return false;

  st.foldFired = true;
  const startedAt = Date.now();
  const busyToken = claimBusy(wf);
  broadcastTransient(workflowId, { type: 'primary_turn_started', workflowId, startedAt });
  let res: { ok: boolean; error?: string; foldedTurns?: number; byteDelta?: number };
  try {
    res = await foldClaudeNativeWorker(workflowId, undefined, { trigger: 'auto', tailTokenBudget: cfg.tailBudget });
  } catch (err) {
    res = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // STOP during the fold revoked the claim; a newer turn may own busy now.
  if (!releaseBusy(wf, busyToken)) return false;
  broadcastTransient(workflowId, { type: 'primary_turn_ended', workflowId, endedAt: Date.now() });

  if (!res.ok) {
    console.warn(`[arco] [${workflowId.slice(0, 8)}] auto-fold failed: ${res.error}`);
    return false;
  }
  // Anti-thrash (delta 2): productive fold resets the counter; an ineffective
  // one increments it toward the cap.
  if ((res.byteDelta ?? 0) < MIN_EFFECTIVE_FOLD_BYTES) {
    st.foldIneffectiveCount = (st.foldIneffectiveCount ?? 0) + 1;
  } else {
    st.foldIneffectiveCount = 0;
  }
  const kb = typeof res.byteDelta === 'number' ? ` (~${Math.round(res.byteDelta / 1024)} KB)` : '';
  const obs = anyObserver(workflowId);
  if (obs) {
    send(obs, {
      type: 'system_notice',
      workflowId,
      content: `[AUTO-FOLD] Context budget at ${pct}% — folded older history into a deterministic digest${kb}. Same session continues.`,
    });
  }
  console.log(`[arco] [${workflowId.slice(0, 8)}] auto-fold fired at ${pct}% budget, byteDelta=${res.byteDelta ?? 0}`);
  return true;
}

// Check context fill and fire warning or auto-handoff. Called after the turn
// loop exits (wf.busy has been reset to false by the finally block).
export async function maybeAutoHandoff(workflowId: string, wf: WorkflowState, cwd: string): Promise<void> {
  // Chat tabs are projectless: a handoff re-seeds as an Agent worker (tools,
  // project context) and, for incognito, installed a cwdHandoffChain slot for
  // the temp root + broadcast lock snapshots. deriveAutoHandoff defaults ON,
  // so an Ollama chat at 90% window used to rotate into an Agent tab silently.
  if (isChatWorkflow(wf.config)) return;
  // Provider-agnostic: read the shared signal each post-turn context_usage
  // branch keeps fresh (Claude CLI/Native, Codex, Ollama). Providers with no
  // signal yet (gemini/antigravity/llamacpp) leave it 0/undefined, which
  // no-ops here — the safe default until they grow a ctx-fill estimate.
  const percentOfWindow = wf.lastContextPercent;
  if (typeof percentOfWindow !== 'number' || percentOfWindow <= 0) return;

  const ah = wf.autoHandoff;
  // Reset fired flags when context drops back to safe levels (after a handoff
  // the new session starts near 0%).
  if (percentOfWindow < Math.max(0, ah.warnAt - 5)) {
    ah.warnFired = false;
    ah.autoFired = false;
  }

  // Warning
  if (percentOfWindow >= ah.warnAt && !ah.warnFired) {
    ah.warnFired = true;
    const obs = anyObserver(workflowId);
    if (obs) {
      send(obs, {
        type: 'system_notice',
        workflowId,
        content: `[CONTEXT] ${percentOfWindow}% — handoff recommended. Auto-handoff at ${ah.autoAt}%.`,
      });
    }
    console.log(`[arco] [${workflowId.slice(0, 8)}] context warning: ${percentOfWindow}% >= ${ah.warnAt}%`);
  }

  // Auto-handoff
  if (ah.enabled && percentOfWindow >= ah.autoAt && !ah.autoFired && !wf.busy) {
    ah.autoFired = true;
    const obs = anyObserver(workflowId);
    if (!obs) {
      console.warn(`[arco] [${workflowId.slice(0, 8)}] auto-handoff: no observer to broadcast on`);
      return;
    }
    console.log(`[arco] [${workflowId.slice(0, 8)}] auto-handoff: context at ${percentOfWindow}%, firing`);
    send(obs, {
      type: 'system_notice',
      workflowId,
      content: `[AUTO-HANDOFF] Context at ${percentOfWindow}%. Running comprehensive handoff…`,
    });

    // Re-use the same handoff logic as the manual button by constructing
    // a synthetic message and calling the handler.
    //
    // WP6 — MODE resolution order: per-tab override → global default →
    // 'original-worker' (now uniform across providers). Original is valid for
    // every provider: handoffHandlers translates it for non-resumable locals
    // (same model re-reads its transcript via the fresh-summarizer mechanism,
    // with overflow fallback). So we no longer force fresh here or gate the
    // default on provider resumability — let the chosen mode flow downstream.
    const cascade = await readSettings(cwd).catch(() => null);
    const mode: 'original-worker' | 'fresh-summarizer' =
      wf.autoHandoff.mode
      ?? cascade?.autoHandoffDefaults?.mode
      ?? 'original-worker';
    const synthMsg: import('@arco/shared').HandoffRequestMessage = {
      type: 'handoff_request',
      workflowId,
      mode,
    };
    // SUMMARIZER resolution: only matters for fresh-summarizer. Put the
    // per-tab summarizer (if set) onto the synthesized message; the handler's
    // chain is `msg.summarizer ?? settings.handoffSummarizer ?? primary`, so
    // per-tab wins, global is the middle, primary is last. For original-worker
    // we leave summarizer unset.
    if (mode === 'fresh-summarizer' && wf.autoHandoff.summarizer) {
      const s = wf.autoHandoff.summarizer;
      synthMsg.summarizer = {
        provider: s.provider,
        model: s.model ?? wf.primary.model,
        effort: s.effort ?? wf.primary.effort,
      };
    }
    try {
      const dummySession: Session = sessions.get(obs) ?? { id: 'auto', workflowIds: new Set([workflowId]), clusterIds: new Set(), clusterObserved: new Map() };
      await deps.handleHandoffRequest(obs, dummySession, synthMsg);
    } catch (err) {
      console.error(`[arco] [${workflowId.slice(0, 8)}] auto-handoff failed:`, err);
      const obs2 = anyObserver(workflowId);
      if (obs2) {
        send(obs2, {
          type: 'system_notice',
          workflowId,
          content: `[AUTO-HANDOFF FAILED] ${err instanceof Error ? err.message : String(err)}. Click HANDOFF manually.`,
        });
      }
    }
  }
}

// NATIVE_COMPACTION_PLAN Phase 2 — real between-turn auto-compaction for the
// Claude Native transport. Called from the SAME post-turn site as
// maybeAutoHandoff (wf.busy already reset to false). Native-only: the CLI
// transport compacts inside the Claude process and other providers have their
// own paths (Ollama maybeCompact, Codex thread/compact). Window-scaled: the
// threshold is a % of the model's REAL window because lastContextPercent is
// already window-relative (nativeContextEstimate / windowForModel), so a 1M
// Opus tab compacts near ITS ceiling, not a flat ~150K.
//
// Mode → threshold mapping (efficiencyAutoCompact, default 'off'):
//   off          → no auto-compaction (today's behavior; only the tool-count
//                  maybeEmitAutoThreshold nudge still runs inside the worker).
//   conservative → warn AUTO_COMPACT_WARN_CONSERVATIVE (70), compact at
//                  AUTO_COMPACT_CONSERVATIVE (80) — fire later, nearer the
//                  ceiling, fewer compactions.
//   aggressive   → warn AUTO_COMPACT_WARN_AGGRESSIVE (60), compact at
//                  AUTO_COMPACT_AGGRESSIVE (70) — fire earlier, keep more
//                  headroom. Reuses the existing two-mode arming surface (no
//                  new per-tab threshold numbers) per the plan's "keep surface
//                  small" guidance. Clamped to [50,95] like auto-handoff's
//                  warnAt/autoAt bounds so an env/config override can't push it
//                  to a degenerate value.
//
// Fail-soft (a failed/empty summary leaves messages[] untouched — compactInPlace
// already returns { ok:false } without mutating on an empty summary) and bounded
// (at most one per settled turn via wf.autoCompactFired, reset when context
// drops below the warn threshold — exactly like autoHandoff.autoFired).
const AUTO_COMPACT_CONSERVATIVE = 80;
const AUTO_COMPACT_AGGRESSIVE = 70;
const AUTO_COMPACT_WARN_CONSERVATIVE = 70;
const AUTO_COMPACT_WARN_AGGRESSIVE = 60;
const AUTO_COMPACT_CLAMP_LOW = 50;
const AUTO_COMPACT_CLAMP_HIGH = 95;

function clampCompactThreshold(n: number): number {
  return Math.max(AUTO_COMPACT_CLAMP_LOW, Math.min(AUTO_COMPACT_CLAMP_HIGH, n));
}

// NATIVE_COMPACTION_PLAN Phase 3 — the continuance prompt the opt-in auto-continue
// sends to resume work from the compacted seed. Mirrors the client-side
// COMPACT_CONTINUE_PROMPT (TerminalInput) so manual-Continue and auto-continue
// feel identical. Kept here (server) so the auto path doesn't depend on a client.
export const COMPACT_CONTINUE_PROMPT =
  'Context was just compacted into a summary. Re-orient from that summary and continue the work in progress — pick up exactly where we left off.';

export async function maybeAutoCompactNative(
  workflowId: string,
  wf: WorkflowState,
  cwd: string,
  ws?: WebSocket,
  session?: Session,
): Promise<void> {
  if (wf.busy) return; // settled-turn only
  if (isChatWorkflow(wf.config)) return; // chat tabs: operator-driven only (see maybeAutoHandoff)
  if (wf.primary.provider !== 'claude') return;

  const mode = wf.config.efficiencyAutoCompact ?? 'off';
  if (mode !== 'conservative' && mode !== 'aggressive') return; // 'off' ⇒ no-op

  // Native transport only — same precedence as the turn dispatcher.
  if (await resolveClaudeTransport(wf, cwd) !== 'native') return;

  const percent = wf.lastContextPercent;
  if (typeof percent !== 'number' || percent <= 0) return;

  const compactAt = clampCompactThreshold(
    mode === 'aggressive' ? AUTO_COMPACT_AGGRESSIVE : AUTO_COMPACT_CONSERVATIVE,
  );
  const warnAt = clampCompactThreshold(
    mode === 'aggressive' ? AUTO_COMPACT_WARN_AGGRESSIVE : AUTO_COMPACT_WARN_CONSERVATIVE,
  );

  // Reset fired flags once context falls back to safe levels — a successful
  // compaction (seed + kept tail) lands well below the warn threshold, so the
  // next pressure cycle re-arms cleanly.
  if (percent < Math.max(0, warnAt - 5)) {
    wf.autoCompactWarnFired = false;
    wf.autoCompactFired = false;
  }

  // Warn (toast-only — never sends a prompt to the worker).
  if (percent >= warnAt && !wf.autoCompactWarnFired) {
    wf.autoCompactWarnFired = true;
    const obs = anyObserver(workflowId);
    if (obs) {
      send(obs, {
        type: 'system_notice',
        workflowId,
        content: `[CONTEXT] ${percent}% — Native auto-compaction at ${compactAt}% (${mode}).`,
      });
    }
    console.log(`[arco] [${workflowId.slice(0, 8)}] native auto-compact warning: ${percent}% >= ${warnAt}%`);
  }

  // Compact.
  if (percent >= compactAt && !wf.autoCompactFired) {
    wf.autoCompactFired = true;
    console.log(`[arco] [${workflowId.slice(0, 8)}] native auto-compact: context at ${percent}%, firing (${mode}, threshold ${compactAt}%)`);
    broadcastWorkflow(workflowId, {
      type: 'system_notice',
      workflowId,
      content: `[AUTO-COMPACT] Context at ${percent}%. Compacting conversation in place (between-turn)…`,
    });
    // Visible audit marker (mirrors the operator COMPACT button's ctx_action).
    broadcastWorkflow(workflowId, {
      type: 'ctx_action',
      workflowId,
      action: 'compact',
      trigger: 'auto-threshold',
      detail: `context ${percent}% >= ${compactAt}% (${mode}) — between-turn auto-compaction`,
    });

    // Reuse the EXACT path the manual compact_workflow handler uses — the cached
    // worker's compactInPlace via the provider index. No reaching into worker
    // internals. Fail-soft: compactInPlace returns { ok:false } (and leaves
    // messages[] untouched) on a busy turn / empty summary / error; we surface a
    // notice and never abort or error the tab.
    let result: { ok: boolean; error?: string; foldedTurns?: number };
    try {
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
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) {
      const foldedNote = typeof result.foldedTurns === 'number' ? ` (${result.foldedTurns} turn(s) folded)` : '';
      broadcastWorkflow(workflowId, {
        type: 'system_notice',
        workflowId,
        content: `[AUTO-COMPACT] Conversation compacted${foldedNote} — history replaced with a summary plus the recent verbatim turns. Next turn continues from it.`,
      });
      // The CTX bar is driven by the NEXT turn's prompt-token count (same as the
      // manual compact path); the shrink shows on the operator's next turn.
      // NATIVE_COMPACTION_PLAN Phase 3 — opt-in auto-continue. Default is manual
      // (the operator clicks Continue in the composer). When armed AND we have
      // the operator's ws/session in scope, dispatch a short continuance turn
      // immediately. wf.busy is false here, so handleUserMessage starts a fresh
      // turn. Kept behind the flag: between-turn compaction ends the turn, so
      // auto-continuing is autonomous continuation (CLAUDE.md autonomy fence).
      if (wf.config.nativeCompactAutoContinue === true && ws && session) {
        console.log(`[arco] [${workflowId.slice(0, 8)}] native auto-compact: auto-continue armed — dispatching continuance turn`);
        await maybeAutoContinueAfterCompact(workflowId, ws, session);
      }
    } else {
      broadcastWorkflow(workflowId, {
        type: 'system_notice',
        workflowId,
        content: `[AUTO-COMPACT] Compaction skipped: ${result.error ?? 'unknown error'}. History left untouched — fire COMPACT or HANDOFF manually if context stays high.`,
      });
    }
    void notifyClusterStateForWorkflow(workflowId);
  }
}

// NATIVE_COMPACTION_PLAN Phase 3 — dispatch the opt-in continuance turn after a
// successful compaction. Shared by the auto path (maybeAutoCompactNative) and the
// manual COMPACT button (compactHandlers, which calls this directly). Goes through
// the normal operator-message path so the continuance turn is a real, visible
// turn in events.jsonl (operator-readable per the four-question test), echoes a
// short system_notice, and queues correctly if the operator raced a message in.
// `interjection=false` because wf.busy is false at the call site (compaction
// released the lock) — this starts a fresh turn, not a steer.
export async function maybeAutoContinueAfterCompact(
  workflowId: string,
  ws: WebSocket,
  session: Session,
): Promise<void> {
  broadcastWorkflow(workflowId, {
    type: 'system_notice',
    workflowId,
    content: '[AUTO-CONTINUE] Resuming from the compacted summary (auto-continue is ON for this tab).',
  });
  try {
    await handleUserMessage(ws, session, workflowId, COMPACT_CONTINUE_PROMPT, undefined, undefined, false, undefined, undefined);
  } catch (err) {
    console.error(`[arco] [${workflowId.slice(0, 8)}] auto-continue dispatch failed:`, err);
  }
}

// After the turn loop settles, check if a calibration pty should run for this
// session. Fires once per zone (A/B/C) per session, idle-only. If a primary
// turn starts while calibration is running, the pty is cancelled via
// wf.cancelCalibration (set by the primary turn handler in handleUserMessage).
export async function maybeCalibrate(workflowId: string, wf: WorkflowState, cwd: string): Promise<void> {
  if (wf.primary.provider !== 'claude') return;
  // CLI transport only. Native gets exact token counts from the API
  // (lastPromptTokens) — the byte-ratio estimator this tunes never runs for
  // it. Worse than useless: the `--print "/context"` probe APPENDS synthetic
  // turns ("Continue from where you left off." / "No response requested.") to
  // whatever session id it resumes — against a Native tab's stale handoff-era
  // CLI session that polluted a file the session watcher was treating as
  // transcript truth (2026-08-02 incident).
  if (await resolveClaudeTransport(wf, cwd) === 'native') return;
  const sessionId = wf.primarySessionId;
  if (!sessionId) return;

  const cal: CalibrationState = wf.calibration ?? {
    ratio: BYTES_PER_TOKEN_DEFAULT,
    overhead: OVERHEAD_TOKENS_DEFAULT,
    zonesCalibrated: new Set(),
  };

  // Get current estimate to detect zone crossing
  const est = await estimateContextFill(cwd, sessionId, wf.primary.model, cal).catch(() => null);
  if (!est) return;

  const currentPercent = est.percentOfWindow;
  const prevPercent = wf.lastContextPercent;
  wf.lastContextPercent = currentPercent;

  // Don't calibrate at or above the auto-handoff threshold — not worth the
  // latency when a session rotation is imminent.
  if (currentPercent >= wf.autoHandoff.autoAt) return;

  // Skip when the estimator already has ground truth from the JSONL usage
  // blocks — calibration only exists to tune the byte-count ratio, and the
  // ground-truth path doesn't use that ratio at all. Running /context here
  // would just spawn an extra `claude --print` for no gain.
  if (est.method === 'ground-truth') return;

  // First observation (prev undefined, e.g. fresh workflow, resumed native
  // session, or just-restarted server): treat `from` as 0 so the overlap test
  // catches every uncalibrated zone the session has already passed through.
  // Previously this used `current`, which produced a zero-width range
  // [current, current] — if `current` happened to sit between zone ranges
  // (e.g. 34%, in the gap between A 20–30 and B 45–55), no zone matched and
  // calibration never fired. Resumed sessions mid-range stayed on the raw
  // byte-count estimate (○ glyph) forever. Using 0 means we'll calibrate the
  // highest uncalibrated zone we've crossed, which is what we want.
  const fromPercent = Number.isFinite(prevPercent) ? (prevPercent as number) : 0;
  const zone = highestUncalibratedZoneCrossed(fromPercent, currentPercent, cal.zonesCalibrated);
  if (!zone) return;

  console.log(`[arco] [${workflowId.slice(0, 8)}] calibrating zone ${zone} at ${currentPercent}%`);

  let result: import('../contextCalibrator.js').CalibrationResult | null = null;
  try {
    result = await runCalibration(sessionId, wf.primary.model, cwd, est.jsonlBytes, (cancelFn) => {
      wf.cancelCalibration = cancelFn;
    });
  } catch (err) {
    console.error(`[arco] [${workflowId.slice(0, 8)}] calibration error:`, err);
  }
  wf.cancelCalibration = undefined;

  if (!result) {
    console.warn(`[arco] [${workflowId.slice(0, 8)}] calibration zone ${zone} failed or was cancelled`);
    return;
  }

  cal.zonesCalibrated.add(zone);
  cal.ratio = result.ratio;
  cal.overhead = result.overhead;
  cal.lastGroundTruth = Date.now();
  wf.calibration = cal;

  // Persist so server restarts don't drop back to the byte-count heuristic.
  // Best-effort — a failed write just means the next restart recalibrates.
  writeCalibrationToMeta(cwd, workflowId, cal.ratio, cal.overhead, cal.lastGroundTruth).catch((err) => {
    console.error(`[arco] [${workflowId.slice(0, 8)}] calibration meta write failed:`, err);
  });

  console.log(
    `[arco] [${workflowId.slice(0, 8)}] calibration zone ${zone} complete:` +
    ` ratio=${result.ratio.toFixed(2)} B/T, overhead=${result.overhead},` +
    ` ground-truth total=${result.groundTruthTotalTokens}, messages=${result.groundTruthMessagesTokens}`,
  );

  // Re-estimate with the new calibration values and broadcast to all observers.
  const calEst = await estimateContextFill(cwd, sessionId, wf.primary.model, cal).catch(() => null);
  if (calEst) {
    broadcastTransient(workflowId, {
      type: 'context_usage',
      workflowId,
      ...calEst,
      claudeSessionId: sessionId,
    });
    wf.lastContextPercent = calEst.percentOfWindow;
  }
}

// Plan authoring note — injected when NO plan is attached.
//
// 2026-07-28: operators kept asking workers to "create a plan and attach it to
// this workflow" and getting a confident "Plan attached" that attached nothing.
// The capability was always there (`POST /api/plans` with `attach:true`), just
// undiscoverable: only Claude Native's EnterPlanMode reaches it via a tool, so
// every other transport had to guess that Arco has a local HTTP API and
// reverse-engineer the route with curl + jq. One worker eventually got there
// after several turns; another wrote a markdown file into its artifacts dir and
// reported success. Neither outcome is the model's fault — nothing told it.
//
// The shape guidance is equally load-bearing: `parsePlan` (reviewContent.ts)
// keys phases off `###` and tasks off top-level `- [ ]`. A plan without
// checkboxes parses to zero tasks, so per-phase Review and the item picker
// silently have nothing to offer — which is exactly how the same operator got
// a "poorly designed plan" out of a worker that had otherwise done fine work.
//
// Kept to ONE line, like the attached-plan variants — `PLAN_PREFIX_RE` strips
// the prefix from Claude's session JSONL so it doesn't re-render as a duplicate
// user bubble, and that pattern is single-line-anchored. A multi-line note
// would leak into chat on every CLI-Claude turn. (Its greedy `[^\n]*\]` is also
// why the literal `- [ ]` inside this text is safe: greedy runs to the LAST
// bracket on the line, which is the note's own closer.)
//
// The two-step `jq --rawfile | curl -d @-` idiom is deliberate, not padding:
// naming the endpoint alone still leaves the model hand-escaping a multi-KB
// markdown body (newlines, backticks, quotes, apostrophes) through BOTH shell
// single-quoting and JSON string encoding in one `-d '{...}'`. That is the step
// most likely to fail after several minutes of drafting. It's also what the
// worker that eventually succeeded on 2026-07-28 converged on by itself.
//
// It rides EVERY turn of every plan-less tab, so it stays terse; the anti-nudge
// clause at the end is the one part that can't be cut.
function planAuthoringNote(cwd: string, workflowId: string): string {
  return (
    `[No project plan is attached to this Arco workflow. If asked to create/attach one, do NOT just write a ` +
    `markdown file — a loose file is invisible to Arco. Prefer the \`plan_create\` tool (MCP server \`arco\`) ` +
    `if you have it — one call, title + body, creates and attaches. Otherwise write the body to a scratch file, then POST it (this ` +
    `two-step avoids hand-escaping markdown into JSON): ` +
    `jq -n --rawfile body /tmp/plan.md --arg t 'Plan title' '{title:$t,body:$body,workflowId:"${workflowId}",attach:true}' ` +
    `| curl -sS --fail-with-body -X POST 'http://127.0.0.1:${PORT}/api/plans?path=${encodeURIComponent(cwd)}' ` +
    `-H 'Content-Type: application/json' -d @- ` +
    `— a success response echoes the created plan's id. To attach one that already exists: ` +
    `POST /api/plans/attach?path=<cwd>&planId=<id>&workflowId=${workflowId}. ` +
    `The body's structure is parsed, not decorative: one \`### Phase name\` heading per phase, and every task a ` +
    `top-level \`- [ ] task\` checkbox line (indent subtasks under it). A plan without checkboxes parses to zero ` +
    `reviewable items. An Arco plan has two parts: a lean checklist (one or two lines per task) and its reference ` +
    `docs, which hold the specs/research/design detail. After creating the plan, write each doc with \`plan_ref_write\` ` +
    `(or as files at .arco/plans/<planId>.refs/<slug>.md — not loose design files elsewhere in the repo) and link it ` +
    `from every task that depends on it as \`[label](ref:slug)\`; whoever works that task reads the linked ref first. ` +
    `Don't create a plan unless asked.]\n\n`
  );
}

export async function buildPlanPrefix(
  cwd: string,
  wf: WorkflowState,
  workflowId: string,
): Promise<string> {
  if (!cwd) return '';
  if (!wf.planId) return planAuthoringNote(cwd, workflowId);
  const plan = await readPlan(cwd, wf.planId).catch(() => null);
  if (!plan) {
    // Plan was deleted out from under us. Detach quietly so future turns
    // don't keep failing the read.
    wf.planId = undefined;
    try {
      await updateMeta(cwd, workflowId, (meta) => {
        if (!meta.planId) return false;
        delete meta.planId;
        delete meta.planLastSeenUpdatedAt;
      });
    } catch { /* best-effort */ }
    broadcastWorkflow(workflowId, { type: 'plan_detached', workflowId });
    return '';
  }
  let lastSeen = 0;
  try {
    const meta = await readMeta(cwd, workflowId);
    lastSeen = meta?.planLastSeenUpdatedAt ?? 0;
  } catch { /* best-effort */ }
  const isFirstAttach = lastSeen === 0;
  const wasEdited = !isFirstAttach && plan.updatedAt > lastSeen;
  // Refs ride the same one line — slugs only (charset [a-z0-9-], so they
  // can't break the single-line PLAN_PREFIX_RE), capped so a ref-heavy plan
  // doesn't bloat every turn.
  const refs = await listPlanRefs(cwd, plan.id).catch(() => []);
  const refsNote = ` ${refsDoctrine(plan.id, refs.map((r) => r.slug))}`;
  const livingDocNote = `The plan is a working contract — read it freely, and tick off completed checklist items (\`- [ ]\` → \`- [x]\`) when you finish them this turn. Do NOT add new sections, headings, or substantive content on your own initiative — even if you have findings, research results, or scope expansions you think belong there. Surface those in your reply and ask whether to add them. Tick-offs and resolving inline open questions are fine; structural additions and new content require an explicit operator cue.`;
  // Always one-liner — never inject the full body. The agent reads the file
  // on demand if it cares about the current state. Earlier behavior injected
  // the full body on first attach AND on every edit (which the agent itself
  // could trigger via tick-off, creating a feedback loop where every working
  // turn re-injected ~1.5–5KB of prose). The one-liner saves that bandwidth
  // unconditionally and avoids the duplicate-in-chat artifact when Claude's
  // session JSONL captures the prefix verbatim. Three variants flag whether
  // the agent should re-read for fresh content.
  let header: string;
  if (isFirstAttach) {
    header = `[Active project plan: "${plan.title}" — newly attached. Read the brief at .arco/plans/${plan.id}.md to orient.${refsNote} ${livingDocNote}]\n\n`;
  } else if (wasEdited) {
    header = `[Active project plan: "${plan.title}" — edited since last turn. Re-read .arco/plans/${plan.id}.md if you need the current state.${refsNote} ${livingDocNote}]\n\n`;
  } else {
    header = `[Active project plan: "${plan.title}" — file: .arco/plans/${plan.id}.md.${refsNote} ${livingDocNote}]\n\n`;
  }
  // Bump lastSeen so the next turn sees the stable form unless there's
  // another edit between now and then. Best-effort — a meta write failure
  // just means the agent sees the "edited" hint twice, harmless.
  try {
    await updateMeta(cwd, workflowId, (meta) => {
      meta.planLastSeenUpdatedAt = plan.updatedAt;
    });
  } catch { /* best-effort */ }
  return header;
}

export function projectQueue(items: QueueItem[]): Array<{ content: string; clientMessageId?: string }> {
  return items.map((q) => ({
    content: q.content,
    ...(q.clientMessageId ? { clientMessageId: q.clientMessageId } : {}),
  }));
}
export function broadcastQueueUpdate(workflowId: string): void {
  const wf = workflows.get(workflowId);
  if (!wf) return;
  publishWorkerActivity(wf, 'queue_changed');
  broadcastWorkflow(workflowId, {
    type: 'queue_update',
    workflowId,
    steering: projectQueue(wf.queue.steering),
    followUp: projectQueue(wf.queue.followUp),
  });
}

// Phase 5 — synchronous drain of the steering bucket for the local-loop
// providers (Ollama / llama.cpp). Called between tool-result append and the
// next API round-trip. Drains the *whole* steering bucket (FIFO) on each
// hit — operators stack mid-turn steers as a cumulative thought ("and also
// …", "wait actually …") the same way they stack follow-ups; one-at-a-time
// delivery would force them to wait many tool iterations to land all
// pending corrections, which defeats the point of mid-turn steering. The
// follow-up bucket is left untouched so it still drains as the merged
// post-turn turn — the steer/follow-up split stays meaningful.
//
// Side effects: broadcasts `queue_update` (queue strip clears) and a
// `queued_messages_drained` to the originating socket so the optimistic
// QUEUED pill on the originator's chat row clears in lockstep — same wire
// shape the post-turn drain uses. The `user_message_echo` was already
// emitted at enqueue time (handleUserMessage) so we don't re-echo here;
// the persisted echo at the original timestamp is the authoritative
// transcript record. Replay therefore renders the steer as a normal
// user-message at its enqueue position with `kind: 'steer'`.
//
// Retry safety: the drain is destructive (splice) so a same-iteration
// re-call would return []. Provider-side retry loops that call drainSteer
// only at one point per loop iteration (the canonical spot, between tool
// results and the next streamOneTurn) cannot double-deliver. Recovery
// paths in llamacpp.ts inject their own synthetic user messages and skip
// past the hook — by design.
export function drainSteerForWorker(workflowId: string, ws: WebSocket): SteerItem[] {
  const wf = workflows.get(workflowId);
  if (!wf || wf.queue.steering.length === 0) return [];
  const drained = wf.queue.steering.splice(0);
  broadcastQueueUpdate(workflowId);
  const drainedClientIds = drained
    .map((d) => d.clientMessageId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (drainedClientIds.length > 0) {
    send(ws, {
      type: 'queued_messages_drained',
      workflowId,
      clientMessageIds: drainedClientIds,
      drainedAt: Date.now(),
    });
  }
  console.log(`[arco] [${workflowId.slice(0, 8)}] mid-turn steer drained (${drained.length} item${drained.length === 1 ? '' : 's'}; follow-up bucket untouched)`);
  return drained.map((d) => ({
    // §D1 — mid-turn steer is delivered as a single `content` string through
    // the provider steer APIs (SteerItem has no separate context block), so a
    // steer message's expanded `@`-refs ride appended to its content. The echo
    // already went out compact at enqueue; this only affects what the model
    // sees mid-turn. Post-turn drain (the loop in handleUserMessage) uses the
    // separate-block path instead.
    content: d.expandedContext ? d.content + d.expandedContext : d.content,
    ...(d.clientMessageId ? { clientMessageId: d.clientMessageId } : {}),
    ...(d.attachments && d.attachments.length > 0 ? { attachments: d.attachments } : {}),
  }));
}

// Phase 6b — re-enqueue support for the Codex app-server worker. The worker
// drains via `drainSteerForWorker` (destructive splice) and dispatches
// `turn/steer` against the live turn; on failure (turnNotSteerable, late
// expectedTurnId mismatch, transport blip) the items have to land back in
// a queue. `bucket: 'steer'` re-fills the steering bucket so the next
// operator turn picks them up as steer; `bucket: 'follow-up'` routes them
// through the post-turn merge path, mirroring the behavior they would have
// had if the operator had pressed Alt+Enter instead of Enter at enqueue.
//
// We re-broadcast `queue_update` because `drainSteerForWorker` already
// emitted a snapshot showing the bucket empty; without the re-broadcast,
// the queue strip would stay clear visually while the items are actually
// re-queued.
export function requeueSteerForWorker(
  workflowId: string,
  ws: WebSocket,
  items: SteerItem[],
  bucket: 'steer' | 'follow-up',
): void {
  const wf = workflows.get(workflowId);
  if (!wf || items.length === 0) return;
  const arr = bucket === 'steer' ? wf.queue.steering : wf.queue.followUp;
  for (const item of items) {
    arr.push({
      content: item.content,
      ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
      ...(item.attachments && item.attachments.length > 0 ? { attachments: item.attachments } : {}),
    });
  }
  broadcastQueueUpdate(workflowId);
  // No `queued_messages_drained` undo — the originator's optimistic chat row
  // (and its QUEUED pill) was already cleared at drain time; the next drain
  // will re-clear once the steer succeeds. Leaving the optimistic row gone
  // is preferable to flicker-restoring it; the queue strip is the source of
  // truth for "items waiting" and the re-broadcast above repopulates it.
  console.log(
    `[arco] [${workflowId.slice(0, 8)}] mid-turn steer re-queued (bucket=${bucket}, items=${items.length})`,
  );
  // ws is unused today (no per-originator notification); keep the parameter
  // for parity with drainSteerForWorker so future per-tab signaling can wire
  // through here without re-threading the call sites.
  void ws;
}

export async function persistInitialMeta(
  cwd: string,
  workflowId: string,
  config: WorkflowConfig,
  primary: PrimaryConfig,
  opts?: { parentWorkflowId?: string },
): Promise<void> {
  // Cheap unlocked probe first (the common resume case); the actual seed goes
  // through ensureMeta so a check-then-write can't clobber a concurrent
  // updateMeta landing between the two.
  const existing = await readMeta(cwd, workflowId);
  if (existing) return;
  const now = Date.now();
  const meta: WorkflowMeta = {
    workflowId,
    name: config.name,
    cwd,
    ...(config.kind === 'chat' ? { kind: 'chat' as const } : {}),
    ...(config.kind === 'chat' && config.voiceOperator === true ? { voiceOperator: true } : {}),
    createdAt: now,
    lastActiveAt: now,
    primaryProvider: primary.provider,
    primaryModel: primary.model,
    primaryEffort: primary.effort,
    ...(config.providerAccountRef ? { providerAccountRef: config.providerAccountRef } : {}),
    cliSessions: [],
    operator: 'local',
    lastEventSeq: null,
    lastTranscriptSeq: null,
    compactedAt: null,
    ...(config.pinnedSkills?.length
      ? { pinnedSkills: config.pinnedSkills.map((s) => ({ scope: s.scope, slug: s.slug })) }
      : {}),
    ...(opts?.parentWorkflowId ? { parentWorkflowId: opts.parentWorkflowId } : {}),
    // OUTPUT_STYLE_PLAN.md / EFFICIENCY_PLAN.md Phase C — when the New-tab
    // picker (or Spawn-from-here parent inheritance) provided a non-default
    // value, persist it to disk on the very first meta write so a server
    // restart before the operator's first turn doesn't lose the pick.
    // Sanitized one more time at write-site against unknown values reaching
    // disk via a hand-edited cascade default.
    ...(config.efficiencyToolFilter === 'off' || config.efficiencyToolFilter === 'conservative' || config.efficiencyToolFilter === 'aggressive'
      ? { efficiencyToolFilter: config.efficiencyToolFilter }
      : {}),
    // EFFICIENCY_PLAN.md Phase D §8a — persist the stamped new-tab default or
    // an explicit operator choice on the first meta write.
    ...(config.efficiencyFactForce === 'on' || config.efficiencyFactForce === 'off'
      ? { efficiencyFactForce: config.efficiencyFactForce }
      : {}),
    // Persist an explicit config-protection choice to disk on first meta-write
    // so an operator opt-out survives a restart. Absent ⇒ gate ON by default.
    ...(config.efficiencyConfigProtection === 'on' || config.efficiencyConfigProtection === 'off'
      ? { efficiencyConfigProtection: config.efficiencyConfigProtection }
      : {}),
    ...(typeof config.claudeNativeCompact === 'boolean'
      ? {
          claudeNativeCompact: config.claudeNativeCompact,
          ...(config.claudeNativeCompact === true ? { claudeNativeCompactUserSetAt: now } : {}),
        }
      : {}),
    ...(typeof config.claudeNativeForceInterleavedThinkingBeta === 'boolean'
      ? { claudeNativeForceInterleavedThinkingBeta: config.claudeNativeForceInterleavedThinkingBeta }
      : {}),
    ...(config.claudeNativeThinkingDisplay === 'omitted' || config.claudeNativeThinkingDisplay === 'summarized' || config.claudeNativeThinkingDisplay === 'updates'
      ? { claudeNativeThinkingDisplay: config.claudeNativeThinkingDisplay }
      : {}),
    ...(config.codexTransport === 'exec' || config.codexTransport === 'appserver'
      ? { codexTransport: config.codexTransport }
      : {}),
    ...(config.codexContextPolicy === 'max' || config.codexContextPolicy === 'standard'
      ? { codexContextPolicy: config.codexContextPolicy }
      : {}),
    ...(config.claudeTransport === 'cli' || config.claudeTransport === 'native'
      ? { claudeTransport: config.claudeTransport }
      : {}),
    ...(config.zaiTransport === 'native' || config.zaiTransport === 'appserver'
      ? { zaiTransport: config.zaiTransport }
      : {}),
    // Persist the seeded auto-handoff default on the first meta-write so a
    // server restart before the operator's first turn keeps the global
    // default (handleCreateWorkflow bakes it into config for new tabs). The
    // savedMeta restore in handleCreateWorkflow reads this back.
    ...(config.autoHandoff ? { autoHandoff: { ...config.autoHandoff } } : {}),
    // EFFICIENCY_PLAN.md Phase E §9 — persist the sandbox toggle on the
    // first meta-write when the cascade default supplied a non-undefined
    // value. Default is 'off'; only the explicit on/off pair lands here so
    // a stale cascade doesn't accidentally turn the sandbox on for tabs
    // that were never asked.
    ...(config.efficiencySandbox === 'on' || config.efficiencySandbox === 'off'
      ? { efficiencySandbox: config.efficiencySandbox }
      : {}),
    // DEBAG_PLAN.md — persist the review-gate toggle on the first meta-write
    // when the cascade default supplied an explicit value, so an operator opt-in
    // survives a restart before the first turn. Default 'off'.
    ...(config.reviewSafeMode === 'on' || config.reviewSafeMode === 'off'
      ? { reviewSafeMode: config.reviewSafeMode }
      : {}),
    ...((config.outputStyle === 'lite' || config.outputStyle === 'terse')
      ? { outputStyle: config.outputStyle }
      // Legacy `caveman` from a stale client → write `terse` to disk.
      : (config.outputStyle as string) === 'caveman'
        ? { outputStyle: 'terse' as const }
        : {}),
    // GOAL_NORTHSTAR_PLAN.md — persist a north-star seeded before the first turn
    // (e.g. a Spawn-from-here that inherited the parent's) so it survives a
    // restart even if the operator never re-sets it. Blank ⇒ omitted.
    ...(config.goal && config.goal.trim() ? { goal: config.goal } : {}),
    // ULTRACODE_PLAN.md — persist sticky ultracode on the first meta-write so a
    // tab left in ultracode survives a restart (the rehydrate read in
    // workflowHandlers.ts expects saved.ultracode). Without this the flag lives
    // only in-memory and the tab silently drops out of ultracode on restart.
    ...(config.ultracode === true ? { ultracode: true } : {}),
    ...(typeof config.webSearchMaxUses === 'number' ? { webSearchMaxUses: config.webSearchMaxUses } : {}),
    ...(config.managedWorktreeSourceCwd
      ? { managedWorktreeSourceCwd: config.managedWorktreeSourceCwd }
      : {}),
  };
  await ensureMeta(cwd, meta);
}

export async function writeCalibrationToMeta(
  cwd: string,
  workflowId: string,
  ratio: number,
  overhead: number,
  lastGroundTruth: number,
): Promise<void> {
  // Locked RMW — calibration lands post-turn, concurrently with plan-prefix /
  // chat-preview / handler meta writes; an unlocked read→write drops theirs.
  await updateMeta(cwd, workflowId, (meta) => {
    meta.calibration = { ratio, overhead, lastGroundTruth };
  });
}

export async function handleUserMessage(
  ws: WebSocket,
  session: Session,
  workflowId: string,
  content: string,
  clientMessageId: string | undefined,
  attachments: string[] | undefined,
  interjection: boolean,
  kind: 'steer' | 'follow-up' | undefined,
  primitive: 'docs' | 'git' | undefined,
  pickedSkills?: Array<{ scope: 'project' | 'global'; slug: string }>,
  // drainQueueIfIdle only: take the prompt from wf.queue at claim time
  // instead of `content` (items were echoed + expanded at enqueue).
  opts?: { fromQueue?: boolean; backgroundEvent?: boolean; onBackgroundSettled?: (error?: string) => void; claimGuard?: (claim: () => boolean) => Promise<boolean> },
): Promise<void> {
  const fromQueue = opts?.fromQueue === true;
  const wf = workflows.get(workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${workflowId.slice(0, 8)}` });
    return;
  }
  const cwd = wf.config.workingDirectory;
  if (!cwd) {
    send(ws, { type: 'error', message: 'Workflow has no working directory configured.' });
    return;
  }
  const memberClusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  const chatMode = isChatWorkflow(wf.config);
  const incognito = chatMode && wf.config.incognito === true;
  // Chat tabs expose no project tools; web_search/web_fetch is the one
  // exception the operator can arm (default on for a saved Chat). Computed per
  // turn so the header toggle takes effect on the next message, and passed
  // down so each provider arms its own web surface.
  const chatWeb = chatMode && chatWebArmed(wf.config, wf.primary.provider);
  const clusterAccessMode = memberClusterId
    ? clusterStore.getMemberAccessMode(memberClusterId, workflowId)
    : 'standard';
  const isolatedMember = clusterAccessMode === 'isolated';
  const projectContextEnabled = !chatMode && !isolatedMember;
  if (chatMode && !CHAT_PROVIDERS.has(wf.primary.provider)) {
    send(ws, { type: 'error', workflowId, message: `${wf.primary.provider} is not available in Chat mode.` });
    return;
  }
  const configuredTrustSource = wf.config.managedWorktreeSourceCwd;
  const managedTrustSource = configuredTrustSource
    && await isManagedBakeoffWorktree(configuredTrustSource, cwd).catch(() => false)
      ? configuredTrustSource
      : undefined;
  if (isolatedMember && (wf.primary.provider !== 'claude' || wf.config.claudeTransport !== 'native')) {
    send(ws, {
      type: 'error',
      message: 'isolated cluster members require the Claude Native transport',
    });
    return;
  }

  // DD10 — parameterized `/prompt` command expansion. Runs FIRST (before
  // context-refs + before any echo/record) so events.jsonl carries the expanded
  // turn, and so `@`-refs inside an expanded template still expand below. A
  // project-scope template is gated behind DD7 trust (key on the raw decision —
  // a cloned repo's `.arco/prompts/*.md` is an injection vector). No matching
  // template ⇒ the text passes through untouched as a normal turn.
  if (projectContextEnabled && !fromQueue) {
    const invocation = parsePromptInvocation(content);
    if (invocation) {
      const trustStatus = await projectTrust.resolveTrustStatus(
        managedTrustSource ?? cwd,
      ).catch(() => 'ask' as const);
      const includeProject = trustStatus === 'always';
      const expanded = await expandPromptCommand(invocation.name, invocation.argsRaw, cwd, { includeProject }).catch((err) => {
        console.error(`[arco] [${workflowId.slice(0, 8)}] prompt-command expansion failed:`, err);
        return null;
      });
      if (expanded) {
        content = expanded.expanded;
        broadcastWorkflow(workflowId, {
          type: 'system_notice',
          workflowId,
          content: `[PROMPT] Expanded /${invocation.name} (${expanded.scope}) into this turn.`,
        });
      } else if (!includeProject && await projectPromptExists(invocation.name, cwd).catch(() => false)) {
        // A project template EXISTS but the repo isn't trusted — explain the
        // suppression rather than silently sending the literal `/name`.
        broadcastWorkflow(workflowId, {
          type: 'system_notice',
          workflowId,
          content: `[PROMPT] /${invocation.name} is a project template but this repo isn't trusted (${trustStatus}) — it was NOT expanded. Trust the repo to enable it.`,
        });
      }
    }
  }

  // WORKBENCH_EXPANSION_PLAN.md §D1 — context-refs expansion. Expand `@`-refs
  // (`@file:`, `@diff`, `@staged`, `@git:N`; `@url:` deferred) ONCE here, before
  // the busy/queue split, so queued AND immediate sends both carry the result.
  // The operator's chat echo stays compact (raw `content`); the expanded block
  // is appended to the MODEL prompt only (below for immediate; on the QueueItem
  // for queued). A system_notice summarizes the expansion so it's visible +
  // reviewable in events.jsonl (the four-question test). Never throws — the
  // expander converts every failure to a notice.
  const contextExpansion = !projectContextEnabled || fromQueue
    ? { block: '', notices: [], expandedCount: 0 }
    : await expandContextRefs(cwd, content, { windowSize: lookupCtx(wf.primary.model) }).catch((err) => {
    console.error(`[arco] [${workflowId.slice(0, 8)}] context-ref expansion failed:`, err);
    return { block: '', notices: [], expandedCount: 0 };
  });
  if (contextExpansion.notices.length > 0) {
    send(ws, {
      type: 'system_notice',
      workflowId,
      content:
        `[CONTEXT REFS] expanded ${contextExpansion.expandedCount} ref` +
        `${contextExpansion.expandedCount === 1 ? '' : 's'} into this turn's context:\n` +
        contextExpansion.notices.map((n) => `  • ${n}`).join('\n'),
    });
  }
  let expandedContext = contextExpansion.block || undefined;

  // Mid-turn queue path. The operator sent text while the primary was working;
  // echo it into chat (so they see their own message), append to the pending
  // queue, and return. The in-flight turn's drain loop will flush this as
  // the next turn's prompt once it settles.
  //
  // Phase 4 — `kind` selects steering vs follow-up bucket. Default 'follow-up'
  // for back-compat with pre-Phase-4 clients (they sent `interjection: true`
  // with no kind, which matched today's silent post-turn flush; follow-up is
  // the closest fit). Phase 4 ships visible/rebindable; both kinds still
  // drain post-turn — Phases 5–7 turn on real mid-turn delivery for steer
  // per provider.
  if (opts?.claimGuard && (wf.busy || wf.computerResetting)) return;
  if (wf.busy || wf.computerResetting) {
    // A drain lost the race to another holder; that holder's loop (or its own
    // drainQueueIfIdle) flushes the queue — nothing to enqueue here.
    if (fromQueue) return;
    if (!interjection) {
      // Non-interjection arriving while busy is a client bug (didn't tag it),
      // but we still queue rather than error — drops fewer operator messages.
      console.warn(`[arco] [${workflowId.slice(0, 8)}] user_message while busy without interjection flag — queuing anyway`);
    }
    const bucket: 'steer' | 'follow-up' = isComputerBackgroundClaim(workflowId) ? 'follow-up' : kind ?? 'follow-up';
    const arr = bucket === 'steer' ? wf.queue.steering : wf.queue.followUp;
    arr.push({ content, attachments: isolatedMember ? undefined : attachments, clientMessageId, expandedContext });
    send(ws, {
      type: 'user_message_echo',
      workflowId,
      content,
      attachments,
      clientMessageId,
      timestamp: Date.now(),
      kind: bucket,
    });
    broadcastQueueUpdate(workflowId);
    console.log(
      `[arco] [${workflowId.slice(0, 8)}] queued as ${bucket} (depth: steer=${wf.queue.steering.length}, follow-up=${wf.queue.followUp.length})`,
    );
    return;
  }

  // Refuse the turn if a native `claude --resume` terminal has written to
  // this session JSONL recently. Two concurrent writers corrupt session
  // state — the JSONL interleaves sdk-cli and cli entries, the model sees
  // synthetic "Continue from where you left off" turns, and Arco's chat
  // drifts from the CLI's internal state. The block clears itself
  // FOREIGN_WRITE_BLOCK_MS after the last foreign write (i.e. ~60s after
  // the operator closes the native terminal), without needing explicit
  // state reset. A handoff remains the clean escape.
  if (wf.lastForeignWriteAt && (Date.now() - wf.lastForeignWriteAt) < FOREIGN_WRITE_BLOCK_MS) {
    // Queued items stay queued (already echoed); the operator resends later.
    if (fromQueue) return;
    const secs = Math.ceil((FOREIGN_WRITE_BLOCK_MS - (Date.now() - wf.lastForeignWriteAt)) / 1000);
    send(ws, {
      type: 'system_notice',
      workflowId,
      content:
        `[TURN BLOCKED] A native \`claude --resume\` terminal is writing to this session. Close it (Arco will auto-clear the block ~${secs}s after its last write), or rotate via Handoff to continue in a clean session.`,
    });
    // Echo the operator's message so it isn't silently dropped; they can
    // resend once the block clears.
    send(ws, {
      type: 'user_message_echo',
      workflowId,
      content,
      attachments,
      clientMessageId,
      timestamp: Date.now(),
    });
    return;
  }

  // Cancel any in-flight calibration pty before starting the primary turn.
  // Calibration is idle-only; the primary turn takes priority.
  if (wf.cancelCalibration) {
    wf.cancelCalibration();
    wf.cancelCalibration = undefined;
  }

  // Drain path: splice the queue in the same synchronous span as the busy
  // claim below, so nothing can slip in between the idle check and the take.
  if (fromQueue) {
    const drained = [...wf.queue.steering.splice(0), ...wf.queue.followUp.splice(0)];
    if (drained.length === 0) return;
    if (!incognito) console.log(`[arco] [${workflowId.slice(0, 8)}] idle drain: flushing ${drained.length} queued message(s) as a fresh turn`);
    broadcastQueueUpdate(workflowId);
    const drainedClientIds = drained
      .map((d) => d.clientMessageId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (drainedClientIds.length > 0) {
      send(ws, { type: 'queued_messages_drained', workflowId, clientMessageIds: drainedClientIds, drainedAt: Date.now() });
    }
    content = drained.map((d) => d.content).join('\n\n');
    const mergedAttachments = drained.flatMap((d) => d.attachments ?? []);
    attachments = mergedAttachments.length > 0 ? mergedAttachments : undefined;
    const mergedRefs = drained.map((d) => d.expandedContext ?? '').filter(Boolean).join('');
    expandedContext = mergedRefs.length > 0 ? mergedRefs : undefined;
    clientMessageId = undefined;
  }

  let busyToken: number;
  if (opts?.claimGuard) {
    let guardedToken: number | undefined;
    await opts.claimGuard(() => {
      // Async preflight may have lost to STOP, a real operator turn or removal.
      // Conditional nudges must never fall into the ordinary follow-up queue.
      if (workflows.get(workflowId) !== wf || wf.busy || wf.computerResetting || wf.queue.steering.length || wf.queue.followUp.length
        || (wf.lastForeignWriteAt && Date.now() - wf.lastForeignWriteAt < FOREIGN_WRITE_BLOCK_MS)) return false;
      guardedToken = claimBusy(wf); return true;
    });
    if (guardedToken === undefined) return;
    busyToken = guardedToken;
  } else busyToken = claimBusy(wf);

  // Drive the turn loop. On first iteration `prompt` is the incoming content;
  // on subsequent iterations it's the drained interjection queue (joined so
  // multiple queued messages land in a single follow-up turn). This keeps
  // the CLI session alive and matches Claude Code terminal's flush-on-idle.
  if (opts?.backgroundEvent) setComputerBackgroundClaim(workflowId, busyToken);
  let prompt: string = content;
  let promptAttachments: string[] | undefined = isolatedMember ? undefined : attachments;
  let promptClientMessageId: string | undefined = clientMessageId;
  // §D1 — expanded `@`-context-refs for the current iteration's prompt. First
  // iteration uses the immediate-send expansion; drain iterations rebuild it
  // from the drained QueueItems' stored blocks. Appended to the model prompt
  // (after the plan prefix) but never to the echo.
  let promptExpandedContext: string | undefined = expandedContext;
  // First iteration echoes the original message via the standard path; later
  // iterations generate their own clientMessageId so the dedup on the
  // originating tab doesn't accidentally swallow an auto-flushed prompt
  // whose UUID was already rendered client-side.
  let firstIteration = true;
  // GOAL_RUN_PLAN.md — outcome of the LAST settled turn in this drain loop.
  // An armed goal run stops on an errored turn rather than looping on the same
  // failure; the flag has to outlive the loop body to reach `maybeGoalRun`.
  let lastTurnErrored = false;
  let staleLoop = false;
  let watchLoopFinished = false;
  let watchHadError = false;

  // DD7 — project-trust gate. Resolve ONCE per turn (stable across drain
  // iterations) from USER/GLOBAL scope only — trust.json + the global
  // settings.json's defaultProjectTrust — BEFORE any project-local surface is
  // read below. When the repo is untrusted, `includeProject` suppresses its
  // CLAUDE.md, project skills, and project settings.json from the model turn
  // (the cloned-repo prompt-injection vector). The turn STILL PROCEEDS; an
  // 'ask' repo additionally raises a one-time operator prompt (deduped per cwd,
  // so cluster peers sharing the cwd prompt once). Decision + suppressed list
  // land in events.jsonl for the four-question test's visibility leg.
  const trustGate = !projectContextEnabled
    ? { includeProject: false, needsPrompt: false, status: 'never' as const, resources: [] as string[] }
    : await (
      managedTrustSource
        ? projectTrust.gateManagedWorktreeResources(cwd, managedTrustSource)
        : projectTrust.gateProjectResources(cwd)
    ).catch((err) => {
    // Fail SAFE: on any gate error, suppress project resources rather than
    // leaking an unvetted repo's instructions into the turn.
    console.error(`[arco] [${workflowId.slice(0, 8)}] project-trust gate failed; suppressing project resources:`, err);
    return { includeProject: false, needsPrompt: false, status: 'ask' as const, resources: [] };
  });
  const includeProject = trustGate.includeProject;
  const trustDecisionCwd = managedTrustSource ?? cwd;
  // Log the suppression for the four-question test's visibility leg — but stay
  // quiet for an explicit 'never' (the operator deliberately chose to suppress;
  // a per-turn notice would just nag). 'ask' / fail-safe always log.
  if (!includeProject && trustGate.resources.length > 0 && trustGate.status !== 'never') {
    broadcastWorkflow(workflowId, {
      type: 'system_notice',
      workflowId,
      content:
        `[PROJECT TRUST] This repo is not trusted (${trustGate.status}); suppressed from this turn: ` +
        `${trustGate.resources.join(', ')}. Trust it to fold these in (next turn).`,
    });
  }
  if (trustGate.needsPrompt && projectTrust.markPromptPending(trustDecisionCwd)) {
    broadcastWorkflow(workflowId, {
      type: 'project_trust_prompt',
      workflowId,
      cwd: trustDecisionCwd,
      resources: trustGate.resources,
    });
  }

  // DD8 — operator-picked skills. Resolve the full bodies ONCE (operator picks
  // apply to the originating prompt, i.e. the first iteration) and build the
  // inline block. This is an explicit operator action, so it applies regardless
  // of the DD7 trust gate above — picking IS the operator's vouch. A missing /
  // unreadable skill is skipped with a notice rather than failing the turn.
  let pickedSkillsBlock = '';
  if (projectContextEnabled && pickedSkills && pickedSkills.length > 0) {
    const resolved: Array<{ name: string; scope: 'project' | 'global'; body: string }> = [];
    const missing: string[] = [];
    for (const pick of pickedSkills) {
      try {
        const full = await readSkillBody(pick.scope, pick.slug, cwd);
        if (full) resolved.push({ name: full.name, scope: full.scope, body: full.body });
        else missing.push(`${pick.scope}:${pick.slug}`);
      } catch {
        missing.push(`${pick.scope}:${pick.slug}`);
      }
    }
    const built = buildPickedSkillsBlock(resolved);
    pickedSkillsBlock = built.text;
    const names = resolved.map((s) => s.name).join(', ');
    broadcastWorkflow(workflowId, {
      type: 'system_notice',
      workflowId,
      content:
        `[SKILLS] Inlined ${resolved.length} operator-picked skill${resolved.length === 1 ? '' : 's'} ` +
        `(${built.bytes} bytes) into this turn${names ? `: ${names}` : ''}.` +
        (missing.length > 0 ? ` Skipped (not found): ${missing.join(', ')}.` : ''),
    });
  }

  // Standing +SKILL pins are re-resolved once per primary-turn invocation.
  // This keeps edits live, survives Native compaction / Handoff / restart, and
  // avoids silently snapshotting stale bodies into meta.json. Like a one-shot
  // pick, a project pin is an explicit operator vouch and bypasses discovery's
  // project-trust suppression. Missing files fail safe and stay visible.
  let pinnedSkillsBlock = '';
  if (projectContextEnabled && wf.config.pinnedSkills?.length) {
    const resolved = await resolvePinnedSkills(wf.config.pinnedSkills, cwd);
    const built = buildPinnedSkillsBlock(resolved.skills);
    pinnedSkillsBlock = built.text;
    const skipped = [...resolved.missing, ...resolved.truncated];
    if (skipped.length > 0) {
      broadcastWorkflow(workflowId, {
        type: 'system_notice',
        workflowId,
        content: `[PINNED SKILLS] ${resolved.skills.length} active (${built.bytes} bytes); skipped: ${skipped.join(', ')}.`,
      });
    }
  }

  // Phase 6 — resolve the Codex transport once per primary-turn invocation.
  // Reading the cascade up here means the value is stable across the
  // drain-loop iterations below; an HMR-driven settings.json change between
  // turns won't re-toggle the transport mid-loop, which would otherwise
  // leak a long-lived `codex app-server` worker after switching back to
  // exec mode. The dispatcher's exec-default fall-through covers other
  // providers; reviewers/handoffs leave codexTransport unset.
  // Phase 6e — per-tab override (`wf.config.codexTransport`) takes precedence
  // over the cascade. The CONFIG-tab toggle writes to that field via
  // update_primary_config so the operator's choice doesn't depend on a
  // hand-edited settings.json.
  const cascade = await readSettings(cwd, { includeProject }).catch(() => null);
  const tabTransport = wf.config.codexTransport;
  const codexTransport: 'exec' | 'appserver' =
    tabTransport === 'appserver' || tabTransport === 'exec'
      ? tabTransport
      : cascade?.codex?.transport === 'appserver' ? 'appserver' : 'exec';
  // Phase 7a — Claude transport, same precedence as Codex above.
  const tabClaudeTransport = wf.config.claudeTransport;
  // ULTRACODE_PLAN.md — sticky ultracode mode forces the CLI transport (the
  // harness WorkflowTool lives only in the `claude` binary; Native's raw SDK
  // can't host it). The operator's base transport is remembered separately in
  // wf.config.ultracodeBaseTransport so turning ultracode OFF restores it.
  const ultracode = wf.primary.provider === 'claude' && wf.config.ultracode === true;
  const claudeTransport: 'cli' | 'native' =
    ultracode
      ? 'cli'
      : tabClaudeTransport === 'native' || tabClaudeTransport === 'cli'
        ? tabClaudeTransport
        : cascade?.claude?.transport === 'native' ? 'native' : 'cli';
  const tabZaiTransport = wf.config.zaiTransport;
  const zaiTransport: 'native' | 'appserver' =
    tabZaiTransport === 'native' || tabZaiTransport === 'appserver'
      ? tabZaiTransport
      : cascade?.zai?.transport === 'appserver' ? 'appserver' : 'native';
  const providerAccount = wf.primary.provider === 'codex'
    ? await resolveProviderAccount('codex', wf.config.providerAccountRef, cwd).catch(() => null)
    : null;
  if (providerAccount?.profile.id && wf.config.providerAccountRef !== providerAccount.profile.id) {
    wf.config.providerAccountRef = providerAccount.profile.id;
  }
  if (claudeTransport === 'native') {
    await migrateLegacyClaudeNativeCompact(cwd, workflowId, wf);
  }
  // Anthropic server-side compaction (`compact_20260112`). Defaults OFF for
  // Native tabs (NATIVE_COMPACTION_PLAN §1) — seeded into config at tab
  // creation, so by here it's a concrete boolean; an absent value also reads
  // as off. CLI Claude handles compaction inside the CLI process so the flag
  // is moot there.
  const claudeNativeCompact: boolean = claudeTransport === 'native'
    ? wf.config.claudeNativeCompact === true
    : false;
  const claudeNativeForceInterleavedThinkingBeta: boolean = claudeTransport === 'native'
    ? wf.config.claudeNativeForceInterleavedThinkingBeta === true
    : false;
  // Adaptive-thinking display for the Native worker. Absent ⇒ 'omitted'
  // (Claude-Code parity — no thinking streamed back); 'summarized' streams
  // summarized thinking into the Activity tab.
  const claudeNativeThinkingDisplay: 'omitted' | 'summarized' | 'updates' | undefined = claudeTransport === 'native'
    ? wf.config.claudeNativeThinkingDisplay
    : undefined;
  // EFFICIENCY_PLAN.md Phase 6b.2 — operator opt-in auto-threshold ctx_action
  // emission. Off by default; honored on Native (CLI/Codex transports don't
  // surface tool-call counts to us in the same way).
  const efficiencyAutoCompact: 'off' | 'conservative' | 'aggressive' = claudeTransport === 'native'
    ? (wf.config.efficiencyAutoCompact ?? 'off')
    : 'off';
  // EFFICIENCY_PLAN.md Phase C — Native tool-result filter mode. Only honored
  // on Native (the filter pipeline runs inside `claude-native/dispatchTool`;
  // CLI/Codex don't surface raw tool stdout to us). Default off until measured
  // per the §13.3 / §2.4 doc-discipline rule (no aggressive defaults).
  const efficiencyToolFilter: 'off' | 'conservative' | 'aggressive' = claudeTransport === 'native'
    ? (wf.config.efficiencyToolFilter ?? 'off')
    : 'off';
  // EFFICIENCY_PLAN.md Phase D §8a — fact-force first-edit gate mode. It is
  // opt-in: new tabs and rehydrated tabs without the field stay 'off'. CLI
  // parity is deferred (master §3.3 F4), so hard-zero non-Native transports.
  const efficiencyFactForce: 'on' | 'off' = claudeTransport === 'native'
    ? (wf.config.efficiencyFactForce ?? 'off')
    : 'off';
  // Config-protection write-gate. Default 'on' (safety gate); the operator
  // opts out per-tab. Native-only (the gate lives in the Native worker), so
  // we hard-zero non-Native transports to 'off' to avoid a meaningless flag.
  const efficiencyConfigProtection: 'on' | 'off' = claudeTransport === 'native'
    ? (wf.config.efficiencyConfigProtection ?? 'on')
    : 'off';
  // EFFICIENCY_PLAN.md Phase E §9 — opt-in sandbox tool surface. Native-only
  // (the tools are registered into the in-process Anthropic tools[] array;
  // CLI / Codex / Gemini don't surface a per-turn tools[] we control).
  // Default 'off' so the toggle stays operator-opted-in.
  const efficiencySandbox: 'off' | 'on' = claudeTransport === 'native' && !isolatedMember
    ? (wf.config.efficiencySandbox ?? 'off')
    : 'off';
  // DEBAG_PLAN.md — operator-armed durable review gate. Native-only (the gate
  // lives in the in-process worker's dispatchTool). Default 'off' so it stays
  // operator-opted-in and inert until armed.
  const reviewSafeMode: 'off' | 'on' = claudeTransport === 'native'
    ? (wf.config.reviewSafeMode ?? 'off')
    : 'off';
  // OUTPUT_STYLE_PLAN.md — operator-armed terseness picker. Honored by
  // Claude Native and by Codex app-server providers (including Z.ai). Other
  // transports ignore it because Arco has no stable per-turn prompt-prefix
  // insertion point there.
  // Default `normal` (no addendum, status quo). Plan §6 hard exclusion:
  // in-tab DOCS / GIT one-off composer dispatches force normal even when
  // the tab is pinned to lite / terse, since the prompt's output is
  // either documentation prose or a commit/PR body that humans read.
  // Renamed `caveman` → `terse` 2026-05-10.
  const outputStyleSupported =
    (wf.primary.provider === 'claude' && claudeTransport === 'native') ||
    (wf.primary.provider === 'codex' && codexTransport === 'appserver') ||
    wf.primary.provider === 'zai';
  const outputStyle: 'normal' | 'lite' | 'terse' = primitive === 'docs' || primitive === 'git'
    ? 'normal'
    : outputStyleSupported
      ? (wf.config.outputStyle ?? 'normal')
      : 'normal';
  // GOAL_NORTHSTAR_PLAN.md — operator-set persistent north-star. Read straight
  // from wf.config, inherited on EVERY path including in-tab DOCS / GIT (the one
  // deliberate divergence from outputStyle's forced 'normal' for those two — a
  // DOCS/GIT prompt benefits from the goal context). Absent / blank ⇒ no block
  // on any transport; honored wherever clusterPlan is folded.
  const goal: string | undefined = isolatedMember ? undefined : wf.config.goal;
  // LOCAL_AI_MASTER_PLAN.md M3 — per-tab Ollama param preset blob. Resolved
  // ONLY for Ollama tabs (the provider's request builder is the sole consumer;
  // every other provider ignores the field). Read straight from wf.config so
  // it is byte-stable across this workflow's turns — the prefix-cache
  // invariant. The operator-edit path (updatePrimaryConfig) is the only place
  // it changes between turns, and that's logged as a cache-invalidation event.
  const ollamaParams: Record<string, unknown> | undefined = wf.primary.provider === 'ollama'
    ? wf.config.ollamaParams
    : undefined;

  try {
    while (true) {
      console.log(`[arco] [${workflowId.slice(0, 8)}] user_message received; starting primary turn (${wf.primary.provider}:${wf.primary.model}, resume=${wf.primarySessionId?.slice(0, 8) || 'none'})`);

      // Peer mailbox: don't auto-drain pre-turn. Just count what's pending and
      // surface a short notice so the worker knows it has peer mail and reads
      // it via peer_read. Keeps peer messages as a normal tool-flow primitive
      // instead of getting silently shoved into the system prompt where the
      // model conflates "system context" with "current peer mail."
      // peer_message_received events now fire on peer_read call (where they
      // belong) rather than pre-turn.
      //
      // Phrase the notice as INTENT ("read them now with the peer_read tool"),
      // not as the imperative "Call the `peer_read` tool…". Incident: the old
      // backtick-wrapped imperative was occasionally PARROTED back by the model
      // as literal text (`<invoke name="peer_read">` under ARCO ::
      // PASSTHROUGH) instead of issuing a real tool_use — so the mailbox never
      // drained and the operator had to re-nudge. This notice fires on every
      // pending-mail turn (nudge or not), so it's the shared trigger; the
      // ClusterTab NUDGE prompt was reframed the same way. Stochastic, so this
      // reduces the rate rather than eliminating it.
      // 2026-06-15 — the notice text now varies by the cluster's efficiency
      // level (clusterEfficiency.buildPeerMailboxNotice). At balanced/lean the
      // doctrine tells members not to re-review unless signalled, so the notice
      // must NOT also shout "re-engage on every inbound" — that contradiction
      // is exactly the over-review loop this feature targets. The level lookup
      // is a synchronous in-memory read, so resolving the clusterId here
      // (ahead of the turn-start resolution below) is cheap. 'thorough' yields
      // the byte-identical historical notice.
      let peerMessagesPrologue: string | undefined;
      if (firstIteration) {
        const pendingDepth = await clusterMailbox.depthFor(workflowId).catch(() => 0);
        if (pendingDepth > 0) {
          const noticeClusterId = clusterStore.getClusterIdForWorkflow(workflowId);
          const noticeLevel = noticeClusterId
            ? clusterStore.getEfficiencyLevel(noticeClusterId)
            : 'thorough';
          const noticeAccess = noticeClusterId
            ? clusterStore.getMemberAccessMode(noticeClusterId, workflowId)
            : 'standard';
          peerMessagesPrologue = noticeAccess === 'standard'
            ? clusterEfficiency.buildPeerMailboxNotice(noticeLevel, pendingDepth)
            : `You have ${pendingDepth} pending peer message${pendingDepth === 1 ? '' : 's'}. Read them with peer_read; no other cluster context is available.`;
        }
      }

      // First turn echoes the operator's fresh prompt into events.jsonl.
      // Drain turns don't re-echo — each queued interjection was already
      // echoed at enqueue-time, so the transcript renders the individual
      // interjections rather than the joined follow-up prompt.
      if (firstIteration) {
        // An idle drain's items were echoed individually at enqueue time.
        if (!fromQueue) send(ws, {
          type: 'user_message_echo',
          workflowId,
          content: prompt,
          attachments: promptAttachments,
          clientMessageId: promptClientMessageId,
          timestamp: Date.now(),
        });
        if (chatMode && !incognito) {
          // Keep the global Past Chats list useful without rescanning a growing
          // events.jsonl for every creator render.
          const preview = prompt.replace(/\s+/g, ' ').trim().slice(0, 80);
          await updateMeta(cwd, workflowId, (meta) => {
            meta.lastActiveAt = Date.now();
            meta.lastUserPreview = preview;
          }).catch((err) => {
            console.warn(`[arco] [${workflowId.slice(0, 8)}] Chat activity meta write failed:`, err);
          });
        }
      }

      // Lazy-create the bg-jobs tracker on first turn — most tabs never
      // spawn long-running children, so the /proc poller only starts when
      // a Bash(run_in_background) hint or a fresh descendant actually
      // appears. Tracker is persistent across turns (and across handoffs)
      // so a download started in turn N stays visible in turn N+3.
      if (!chatMode && !wf.bgTracker) {
        wf.bgTracker = new PrimaryBackgroundTracker({
          workflowId,
          broadcast: (msg) => broadcastTransient(workflowId, msg),
        });
      }

      // Plan header injection. When a plan is attached, prepend a brief
      // "active plan" reminder to the prompt before forwarding to the
      // provider — the operator's echo'd transcript stays clean. If the
      // plan body was edited since the last turn that injected it, also
      // include the full body once so the agent picks up the change. The
      // operator's transcript is unaffected (echo already sent above).
      const planPrefix = projectContextEnabled ? await buildPlanPrefix(cwd, wf, workflowId) : '';
      const promptWithRefs = promptExpandedContext ? prompt + promptExpandedContext : prompt;
      // DD8 — inline operator-picked skill bodies. Only on the first iteration
      // (the picks rode in on the originating prompt; drained queue turns don't
      // re-inline). Appended after the refs, before the plan prefix is prepended
      // — model-facing only, never echoed into the operator's transcript.
      const promptWithSkills = firstIteration && pickedSkillsBlock
        ? `${promptWithRefs}\n\n${pickedSkillsBlock}`
        : promptWithRefs;
      const promptWithPlan = planPrefix ? planPrefix + promptWithSkills : promptWithSkills;

      // Ollama has no native session resume — every spawn is a fresh HTTP
      // request. To give the model memory across turns we replay the
      // workflow's events.jsonl into the same USER:/AGENT: transcript shape
      // the fresh-summarizer Handoff produces, then hand it to the provider
      // as appendSystemPrompt. The provider parses it back into structured
      // /api/chat messages so the prefix bytes stay stable across turns
      // and Ollama's prefix cache hits.
      //
      // The system prompt counters two observed Qwen-MoE behaviors against
      // a code chat: (1) verbose tabular formatting on every reply, (2)
      // hallucinating about files when no tools are wired (§5.4 still
      // pending). Static text — no timestamps or random ids — so the prefix
      // cache hits cleanly across turns.
      let primaryAppendSystemPrompt: string | undefined;
      let primarySystemPrompt: string | undefined;
      // The current user echo was just recorded above. Stateless providers
      // receive only the completed turns before it; the current prompt rides
      // the normal provider input exactly once.
      const priorIncognitoEvents = incognito
        ? (() => {
            const events = wf.incognitoEvents ?? [];
            return events[events.length - 1]?.type === 'user_message_echo'
              ? events.slice(0, -1)
              : [...events];
          })()
        : null;
      // Phase 1 — Arco-managed skills. Scan project + global skill
      // directories on every turn (cheap — small dir count, single SKILL.md
      // read each), build the XML manifest, and route it to wherever the
      // provider's system prompt actually lives. Manifest holds only name +
      // description; the agent reads the full SKILL.md via its Read tool.
      // Re-scanning per turn means edits / deletes via the UI take effect on
      // the next turn without restarting anything.
      let primarySkillsManifest = '';
      if (projectContextEnabled) try {
        const catalog = await listSkills(cwd, { includeProject });
        // A pinned body is already present in full; omit its progressive-
        // disclosure metadata to avoid duplicate/conflicting instructions.
        const pinnedKeys = new Set((wf.config.pinnedSkills ?? []).map((s) => `${s.scope}:${s.slug}`));
        primarySkillsManifest = buildSkillsManifest({
          project: catalog.project.filter((s) => !pinnedKeys.has(`project:${s.slug}`)),
          global: catalog.global.filter((s) => !pinnedKeys.has(`global:${s.slug}`)),
        });
      } catch (err) {
        console.error(`[arco] [${workflowId.slice(0, 8)}] skills scan failed:`, err);
      }
      if (wf.primary.provider === 'ollama') {
        primarySystemPrompt = chatMode ? chatSystemPrompt(chatWeb) : OLLAMA_PRIMARY_SYSTEM_PROMPT;
        try {
          const events = priorIncognitoEvents ?? (wf.config.voiceOperator
            ? await computerReplayEvents(cwd, workflowId, wf.config.computerContext?.lastResetAt, wf.config.computerContext?.lastResetSeq)
            : await replayWorkflowEvents(cwd, workflowId, 0));
          // preserveThinking: Qwen-family models (3.6, 3-VL) implement
          // Thinking Preservation — prior turn reasoning fed back as
          // context improves multi-turn coherence. Cheap (just routes
          // primary_thinking events into a <think> block on each AGENT
          // entry); UI/handoff paths still call renderTranscript without
          // the flag and stay reasoning-clean.
          // Hidden reasoning is useful continuity for project Agent work, but
          // Chat capabilities can change between turns via the WEB toggle. A
          // saved offline turn can contain the old system restriction verbatim;
          // replaying that reasoning after web is armed makes local models obey
          // the stale state instead of the current system block + tools[].
          const rendered = (wf.config.voiceOperator ? renderComputerHistory(events) : renderTranscript(events, { preserveThinking: !chatMode })).trim();
          if (rendered) primaryAppendSystemPrompt = rendered;
        } catch (err) {
          console.error(`[arco] [${workflowId.slice(0, 8)}] ollama transcript build failed:`, err);
        }
      } else if (wf.primary.provider === 'llamacpp' || wf.primary.provider === 'lmstudio' || (wf.primary.provider === 'strata' || wf.primary.provider === 'deepseek') || (chatMode && wf.primary.provider === 'cursor')) {
        // M13 — LM Studio reuses llama.cpp's transcript-rebuild path verbatim:
        // both are OpenAI-compat local runtimes with no native session, so the
        // deterministic prior-turn summary + reasoning-clean rendered
        // transcript apply identically. (LM Studio is remote, but the
        // context-loss-across-turns problem is the same.)
        primarySystemPrompt = chatMode ? chatSystemPrompt(chatWeb) : LLAMACPP_PRIMARY_SYSTEM_PROMPT;
        // llama.cpp: same prefix-cache benefits as ollama but with an
        // additional structured prior-turn summary prepended. Local thinking
        // models lose track across turns because renderTranscript drops all
        // tool history (only USER:/AGENT: text survives) — the model on
        // turn N has no idea which files it read or wrote on turn N-1.
        // summarizePriorTurns walks events.jsonl and produces a deterministic
        // per-turn breakdown (tools used, files touched, bash run, final
        // reply text). It's stuffed into a faux AGENT block at the head of
        // the transcript so the parser routes it into one assistant message.
        //
        // We deliberately do NOT preserveThinking here: re-feeding Qwen3.6
        // its own reasoning across turns has the opposite of the ollama
        // benefit because llama-server already exposes reasoning_content
        // separately and the extra <think> blocks just inflate the prompt
        // and trigger more verbose monologue on the next turn.
        try {
          const events = priorIncognitoEvents ?? (wf.config.voiceOperator
            ? await computerReplayEvents(cwd, workflowId, wf.config.computerContext?.lastResetAt, wf.config.computerContext?.lastResetSeq)
            : await replayWorkflowEvents(cwd, workflowId, 0));
          const summary = chatMode ? '' : summarizePriorTurns(events);
          const rendered = (wf.config.voiceOperator ? renderComputerHistory(events) : renderTranscript(events, { preserveThinking: false })).trim();
          const parts: string[] = [];
          if (summary) {
            parts.push(`USER: [Workflow context]`);
            parts.push(`AGENT: ${summary}`);
          }
          if (rendered) parts.push(rendered);
          const combined = parts.join('\n\n').trim();
          if (combined) primaryAppendSystemPrompt = combined;
        } catch (err) {
          console.error(`[arco] [${workflowId.slice(0, 8)}] ${wf.primary.provider} transcript build failed:`, err);
        }
      } else if (incognito
          && ((wf.primary.provider === 'claude' && claudeTransport !== 'native')
            || (wf.primary.provider === 'codex' && codexTransport !== 'appserver'))) {
        // Incognito CLI turns deliberately have no resumable provider session.
        // Replay the memory-only completed transcript into each one-shot call.
        const rendered = renderTranscript(priorIncognitoEvents ?? []).trim();
        if (rendered) primaryAppendSystemPrompt = `Conversation so far:\n\n${rendered}`;
      }

      // Skills manifest + standing pins go wherever the provider's system prompt actually
      // lives. ollama/llamacpp use `systemPrompt` (their `appendSystemPrompt`
      // carries the rendered transcript); claude/codex/gemini have no
      // `systemPrompt` and feed everything through `appendSystemPrompt`.
      // Antigravity's RPC path frames prompts in its provider implementation,
      // so it does not consume either field here.
      const usesSystemPromptForSkills = wf.primary.provider === 'ollama' || wf.primary.provider === 'llamacpp' || wf.primary.provider === 'lmstudio' || (wf.primary.provider === 'strata' || wf.primary.provider === 'deepseek');
      const primarySkillsContext = [pinnedSkillsBlock, primarySkillsManifest].filter(Boolean).join('\n\n');
      let finalSystemPrompt = usesSystemPromptForSkills && primarySkillsContext
        ? (primarySystemPrompt ? `${primarySkillsContext}\n\n${primarySystemPrompt}` : primarySkillsContext)
        : primarySystemPrompt;
      const finalAppendBase = chatMode ? primaryAppendSystemPrompt : withPreviewNudge(primaryAppendSystemPrompt);
      const baseWithSkills = !usesSystemPromptForSkills && primarySkillsContext
        ? `${primarySkillsContext}\n\n${finalAppendBase}`
        : finalAppendBase;
      // Phase 7a — fold discovered CLAUDE.md files into appendSystemPrompt
      // for Claude tabs (CLI + Native both benefit). Walks up from cwd
      // collecting CLAUDE.md, plus ~/.claude/CLAUDE.md.
      // ZAI_INTEGRATION_AUDIT.md — also fold for Z.ai/GLM tabs: GLM is a
      // full tool-using coding agent and was previously running blind to
      // project conventions that Claude/Codex tabs already see. `includeProject`
      // is the trust-gate output, so untrusted repos stay suppressed for GLM too.
      let finalAppend = baseWithSkills;
      // VOICE_AGENT_PLAN.md — the Computer voice operator chat has its own
      // base instructions and real (arco-voice) tools; the generic Chat
      // preamble ("do not use backend tools… continue in an Agent tab") made
      // Luna refuse them (2026-10-17 smoke:voice-luna regression).
      if (chatMode && wf.config.voiceOperator === true) {
        if (usesSystemPromptForSkills) finalSystemPrompt = VOICE_OPERATOR_PROMPT;
        else if (wf.primary.provider !== 'codex') finalAppend = [VOICE_OPERATOR_PROMPT, finalAppend].filter(Boolean).join('\n\n');
      }
      if (chatMode && wf.config.voiceOperator !== true) {
        const chatPrompt = chatSystemPrompt(chatWeb);
        if (usesSystemPromptForSkills) {
          finalSystemPrompt = chatPrompt;
        } else {
          finalAppend = finalAppend ? `${chatPrompt}\n\n${finalAppend}` : chatPrompt;
        }
      }
      if (projectContextEnabled && (wf.primary.provider === 'claude' || wf.primary.provider === 'zai') && cwd) {
        try {
          const claudeMd = await discoverClaudeMdFiles(cwd, { includeProject });
          if (claudeMd) {
            finalAppend = baseWithSkills
              ? `${claudeMd}\n\n${baseWithSkills}`
              : claudeMd;
          }
        } catch (err) {
          console.warn(`[arco] [${workflowId.slice(0, 8)}] CLAUDE.md discovery failed:`, err);
        }
      }

      // WORKBENCH_EXPANSION_PLAN.md §B3 — fold the operator-curated knowledge
      // base into appendSystemPrompt as a BOUNDED block. Provider-agnostic
      // (every primary provider that consumes appendSystemPrompt benefits),
      // and only the always-include articles are injected. buildKnowledgeBlock
      // hard-caps the combined body at KNOWLEDGE_INJECT_BUDGET and appends an
      // explicit truncation notice when the set overflows — the KB can NEVER
      // silently bloat the turn. Emitted byte counts land in events.jsonl
      // (system_notice) for the four-question test's context visibility. FENCE:
      // this READS operator-curated articles; nothing here writes the KB.
      if (projectContextEnabled && cwd) {
        try {
          const kb = await buildKnowledgeBlock(cwd);
          if (kb.text) {
            finalAppend = finalAppend ? `${kb.text}\n\n${finalAppend}` : kb.text;
            if (firstIteration) {
              const truncNote = kb.truncated ? ` (truncated — exceeds injection budget)` : '';
              send(ws, {
                type: 'system_notice',
                workflowId,
                content: `Knowledge base: ${kb.included}/${kb.total} always-include article${kb.total === 1 ? '' : 's'} folded into context (${kb.bytes} bytes)${truncNote}.`,
              });
            }
          }
        } catch (err) {
          console.warn(`[arco] [${workflowId.slice(0, 8)}] knowledge-base injection failed:`, err);
        }
      }

      // Operator-initiated plan-mode entry. Resolved per turn from the
      // pending flag the `enter_plan_mode_request` handler set. Only Claude
      // Native honours arming; on any other resolved transport the flag is
      // silently cleared so a stale arm doesn't survive a provider switch.
      // FABLE_51_APPEND_ONLY_PLAN.md §1.5 — per-turn text for Claude Native
      // rides WorkerConfig.turnNotice (appended to the user message, kept
      // forever) instead of appendSystemPrompt, which the Native worker now
      // freezes; a firstIteration-gated fold there flipped the system prompt
      // between consecutive requests of an auto-continued turn.
      const nativeClaudeTurn = wf.primary.provider === 'claude' && claudeTransport === 'native';
      const turnNoticeParts: string[] = [];
      let armPlanMode = false;
      if (wf.pendingPlanModeEntry) {
        if (nativeClaudeTurn && firstIteration) {
          armPlanMode = true;
          turnNoticeParts.push('Operator has armed plan mode for this turn. Write/Edit tools are disabled until you call ExitPlanMode. Begin by calling EnterPlanMode with a plan body for what the operator just asked.');
        }
        wf.pendingPlanModeEntry = false;
      }

      // CLUSTER_MODE_PLAN.md Phase 1 — fold the drained mailbox prologue
      // into the front of appendSystemPrompt so a CLI / Codex worker renders
      // it as system-level context before any operator-supplied
      // appendSystemPrompt content. Only first-iteration (drain ran above only
      // on firstIteration); follow-up drains skip. Native takes it as a
      // turnNotice instead (see above).
      if (peerMessagesPrologue) {
        if (nativeClaudeTurn) turnNoticeParts.push(peerMessagesPrologue);
        else finalAppend = finalAppend ? `${peerMessagesPrologue}\n\n${finalAppend}` : peerMessagesPrologue;
      }

      // CLUSTER_MODE_PLAN.md Phase 1 — resolve the workflow's clusterId
      // (if any) at turn start. Threaded into the worker's WorkerConfig so
      // peer tools register and dispatch only when the membership is live.
      // Per plan §6.2 reversibility: once the cluster is deleted via REST,
      // the next turn's lookup returns undefined and the tools disappear
      // from the worker's tool list.
      const turnClusterId = clusterStore.getClusterIdForWorkflow(workflowId);

      // Phase 2.6 — resolve the cluster's shared plan body + this member's
      // role hint at turn start. Both ride into WorkerConfig so the Native
      // worker's buildSystemBlocks() can inject them as forced system blocks
      // (after FORCED_FIRST_BLOCK, before operator prompts). Editing the
      // plan mid-turn never tears the running turn down — only the NEXT
      // turn's resolution picks up the new body.
      let turnClusterPlan: string | undefined;
      let turnClusterRole: string | undefined;
      // 2026-06-15 — per-cluster efficiency doctrine + level. The doctrine
      // (canned restraint text for the level + optional operator addendum)
      // injects alongside plan/role; the level itself also drives the
      // peer-mailbox notice variant below. Resolved at turn start so an
      // operator level-change lands on the NEXT turn (in-flight turns are
      // untouched). The 'thorough' default yields an undefined doctrine ⇒ no
      // block ⇒ byte-identical to pre-feature behaviour.
      let turnClusterEfficiencyDoctrine: string | undefined;
      let turnClusterEfficiencyLevel: ClusterEfficiencyLevel = 'thorough';
      let turnClusterTaskBoardAttached = false;
      // 2026-06-29 — per-cluster progress-tracking doctrine. Built from the
      // cluster's mode (plan/board/both, default both) gated on whether a plan
      // body and/or a task board actually exist for this turn. Injected
      // alongside the efficiency doctrine. Resolved at turn start so an operator
      // mode-change lands on the NEXT turn (in-flight turns untouched). Undefined
      // when there is nothing to keep current (e.g. mode 'plan' but no plan).
      let turnClusterProgressDoctrine: string | undefined;
      if (turnClusterId && clusterAccessMode === 'standard') {
        const planRec = await clusterPlanBridge.readClusterPlan(turnClusterId).catch(() => null);
        turnClusterPlan = planRec?.body;
        // Plan reference docs ride as one trailing heading line — a heading so
        // the outline fallback (clusterPlanOutline keeps every heading) can't
        // drop it, and slugs only so it stays small. Members read a ref with
        // plan_ref_read or plain file tools.
        const refsCwd = wf.config.workingDirectory;
        if (planRec && turnClusterPlan && refsCwd) {
          const refs = await listPlanRefs(refsCwd, planRec.planId).catch(() => []);
          if (refs.length > 0) {
            turnClusterPlan = `${turnClusterPlan.trimEnd()}\n\n#### Plan reference docs (planId ${planRec.planId}) — ${refsDoctrine(planRec.planId, refs.map((r) => r.slug), 24)}\n`;
          }
        }
        turnClusterRole = clusterStore.getMemberRole(turnClusterId, workflowId);
        turnClusterTaskBoardAttached = clusterStore.isTaskBoardAttached(turnClusterId);
        turnClusterEfficiencyLevel = clusterStore.getEfficiencyLevel(turnClusterId);
        turnClusterEfficiencyDoctrine = clusterEfficiency.buildDoctrine(
          turnClusterEfficiencyLevel,
          clusterStore.getEfficiencyAddendum(turnClusterId),
        );
        turnClusterProgressDoctrine = joinClusterDoctrines(
          buildClusterDirectorDoctrine(turnClusterRole),
          buildProgressDoctrine(
            clusterStore.getProgressTracking(turnClusterId),
            !!turnClusterPlan && turnClusterPlan.trim().length > 0,
            turnClusterTaskBoardAttached,
          ),
        );
      }

      if (turnClusterId && (wf.primary.provider === 'ollama' || wf.primary.provider === 'llamacpp')) {
        if (clusterAccessMode === 'standard') {
          finalSystemPrompt = buildLocalClusterSystemPrompt({
            base: finalSystemPrompt,
            clusterPlan: turnClusterPlan,
            clusterRole: turnClusterRole,
            clusterEfficiencyDoctrine: turnClusterEfficiencyDoctrine,
            clusterProgressDoctrine: turnClusterProgressDoctrine,
          });
        } else {
          finalSystemPrompt = finalSystemPrompt
            ? `${BLIND_CLUSTER_DOCTRINE}\n\n${finalSystemPrompt}`
            : BLIND_CLUSTER_DOCTRINE;
        }
      }

      // CLUSTER_MODE_PLAN.md Phase 3 + Phase 4 — non-Native cluster member
      // wiring. Native dispatches peer_* in-process via peerTools (clusterId
      // on WorkerConfig is sufficient, and buildSystemBlocks injects plan +
      // role as forced system blocks). CLI Claude / Codex `exec` / Codex
      // `appserver` all reach the model via a string-form prompt, so the
      // plan + role have to fold into `finalAppend` (which becomes
      // `--append-system-prompt` for Claude CLI and the byte-stable prefix
      // for both Codex transports). Order (peer prologue → plan → role)
      // matches Native's buildSystemBlocks ordering.
      //
      // For Claude CLI: also write the per-workflow mcp-config.json so the
      // claude CLI's `--mcp-config <path>` spawns the per-turn MCP stdio
      // child. For Codex: nothing to write — the codex provider builds
      // `-c mcp_servers.arco-cluster.*` TOML overrides at spawn time
      // from `WorkerConfig.clusterId` (Phase 4 §13 decision: Codex CLI has
      // no `--mcp-config <path>` flag, but `-c` overrides leave the
      // operator's `~/.codex/config.toml` untouched and avoid TOML merge).
      //
      // CLI transports retain the 16 KB cap: argv paths E2BIG above roughly
      // 128 KB and the tmpfile fallback handles arbitrary sizes, while the
      // explicit bound surfaces unreasonable growth early. Codex app-server
      // uses 48 KB because it rides JSON-RPC stdin and needs room for the
      // maximum 32 KB plan plus small blocks. The PLAN is the only block that
      // shrinks to fit
      // (composeClusterAppend) — the small blocks are load-bearing and
      // survive verbatim.
      let turnClusterMcpConfigPath: string | undefined;
      const needsStringFormCluster =
        turnClusterId !== undefined &&
        ((wf.primary.provider === 'claude' && claudeTransport === 'cli') ||
          wf.primary.provider === 'codex' ||
          wf.primary.provider === 'zai' ||
          wf.primary.provider === 'cursor');
      if (needsStringFormCluster) {
        // Small load-bearing blocks first — composeClusterAppend reserves
        // their bytes (plus whatever already folded into finalAppend, i.e.
        // the peer-mailbox notice) and truncates the PLAN to the remaining
        // budget. 2026-07-09 incident: the old tail-slicing cap let an 18 KB
        // plan silently evict the notice + role + code-mode addendum, and
        // the first live code-mode member freelanced as OpenAI's /root instead
        // of reading its mailbox. See clusterStringFold.ts.
        const tailBlocks: string[] = [];
        if (clusterAccessMode !== 'standard') {
          tailBlocks.push(
            clusterAccessMode === 'isolated'
              ? 'ISOLATED cluster member: the project and cluster coordination state are intentionally hidden. Use only peer_send and peer_read for cluster communication.'
              : BLIND_CLUSTER_DOCTRINE,
          );
        }
        if (turnClusterRole && turnClusterRole.length > 0) {
          tailBlocks.push(`Your role in this cluster: ${turnClusterRole}`);
        }
        // docs/CODEX_GPT56_CLUSTER_INCOMPAT.md — code-mode models run
        // OpenAI's own multi-agent "code mode" harness, which renames the
        // arco-cluster MCP tools into the exec code cell's `tools`
        // namespace (`tools.mcp__arco_cluster__peer_send`) and gives the
        // harness's native send_message top billing. Without this addendum
        // a code-mode member can't find the peer substrate (2026-07-09
        // incident: 236 tool calls, zero peer/cluster). Detection is
        // catalog-driven (codex's own models_cache.json `tool_mode` /
        // `multi_agent_version` — the exact fields that gate the harness);
        // fail-open on unknown because the addendum is phrased
        // conditionally and reads as inapplicable to plain
        // function-calling models. Codex only — Z.ai rides the app-server
        // through a Responses proxy with non-Codex models.
        if (wf.primary.provider === 'codex'
          && codexModelUsesCodeMode(wf.primary.model, providerAccount?.codexHome) !== false) {
          tailBlocks.push(codexCodeModeClusterAddendum());
        }
        if (turnClusterEfficiencyDoctrine && turnClusterEfficiencyDoctrine.length > 0) {
          tailBlocks.push(turnClusterEfficiencyDoctrine);
        }
        if (turnClusterProgressDoctrine && turnClusterProgressDoctrine.length > 0) {
          tailBlocks.push(turnClusterProgressDoctrine);
        }
        const planBlock = turnClusterPlan && turnClusterPlan.length > 0
          ? `--- Shared cluster plan ---\n${turnClusterPlan}`
          : undefined;
        // Outline fallback: when the full plan overflows the budget, fold a
        // deterministic outline (headings + every checkbox line verbatim +
        // labelled standing-directive sections) instead of a head-slice — the
        // actionable skeleton survives whole and omitted prose is one
        // cluster_plan_read call away.
        const planFallback = turnClusterPlan && turnClusterPlan.length > 0
          ? `--- Shared cluster plan (OUTLINE — prose omitted; call cluster_plan_read for the full plan) ---\n${planOutline(turnClusterPlan)}`
          : undefined;
        const clusterAppendCap = wf.primary.provider === 'codex' && codexTransport === 'appserver'
          ? CODEX_APP_SERVER_CLUSTER_MAX
          : APPEND_CLUSTER_MAX;
        const { combined, planTruncatedFrom, usedFallback } = composeClusterAppend(
          planBlock,
          tailBlocks,
          finalAppend?.length ?? 0,
          clusterAppendCap,
          planFallback,
        );
        if (planTruncatedFrom !== undefined) {
          console.log(
            `[arco] [${workflowId.slice(0, 8)}] cluster plan over string-form fold budget ` +
            `(${planTruncatedFrom} bytes → ${usedFallback ? 'outline fallback' : 'head-truncated'}; ` +
            `${clusterAppendCap} total cap; notice/role/addendum/doctrines preserved)`,
          );
        }
        if (combined) {
          finalAppend = finalAppend ? `${combined}\n\n${finalAppend}` : combined;
        }
      }

      // ARCO_OPS_PLAN.md M2 — Genesis staged-ideation system block. A
      // from-nothing genesis workflow runs its staged conversation in a hidden
      // scratch dir (~/.arco/genesis/<wfid>) until `genesis_scaffold` creates
      // the real project and rebinds the cwd. While the workflow is still in that
      // scratch dir we fold the staged framing into the turn the same way cluster
      // hints do — finalSystemPrompt for ollama/llamacpp, finalAppend (a system
      // block on Native, --append-system-prompt on CLI Claude/Codex, system
      // instruction on Gemini) otherwise. Once scaffolded the cwd is the real
      // project dir, this condition is false, and the seed docs + CLAUDE.md carry
      // the context (M3 Creative-mode adds its own in-workflow path). Genesis and
      // cluster membership are mutually exclusive (a scratch-dir genesis is not a
      // cluster member), so this never double-injects with the block above.
      const genesisSeed = wf.config.genesisSeed;
      // Separator-agnostic scratch-dir check (POSIX primary; tolerate Windows).
      const inGenesisScratch = !!genesisSeed && /[\\/]\.arco[\\/]genesis[\\/]/.test(cwd);
      // M3 Creative mode runs the same staged framing inside an EXISTING workflow
      // (real cwd) — gated on the operator-armed seed.creative flag instead of the
      // scratch-dir path. buildGenesisSystemBlock folds in seed.projectContext for
      // this case so the model stays anchored to what is really on disk.
      const inGenesisCreative = !!genesisSeed && genesisSeed.creative === true;
      if ((inGenesisScratch || inGenesisCreative) && genesisSeed) {
        if (wf.primary.provider === 'ollama' || wf.primary.provider === 'llamacpp' || wf.primary.provider === 'lmstudio' || (wf.primary.provider === 'strata' || wf.primary.provider === 'deepseek')) {
          finalSystemPrompt = buildGenesisSystemBlock(genesisSeed, { base: finalSystemPrompt });
        } else {
          const genesisBlock = buildGenesisSystemBlock(genesisSeed);
          finalAppend = finalAppend ? `${genesisBlock}\n\n${finalAppend}` : genesisBlock;
        }
      }
      if (genesisSeed?.github?.create && genesisSeed.github.visibility === 'public') {
        if (wf.primary.provider === 'ollama' || wf.primary.provider === 'llamacpp' || wf.primary.provider === 'lmstudio' || (wf.primary.provider === 'strata' || wf.primary.provider === 'deepseek')) {
          finalSystemPrompt = finalSystemPrompt
            ? `${PUBLIC_REPO_SAFETY_SYSTEM_BLOCK}\n\n${finalSystemPrompt}`
            : PUBLIC_REPO_SAFETY_SYSTEM_BLOCK;
        } else {
          finalAppend = finalAppend
            ? `${PUBLIC_REPO_SAFETY_SYSTEM_BLOCK}\n\n${finalAppend}`
            : PUBLIC_REPO_SAFETY_SYSTEM_BLOCK;
        }
      }

      // GOAL_NORTHSTAR_PLAN.md G2 — the north-star is NOT folded here. Native
      // injects it as its own cached system block (buildSystemBlocks reads
      // config.goal); every other transport folds goalBlock(config.goal) inside
      // its own provider (mirroring outputStyleAddendum). Doing it per-provider
      // rather than into finalAppend here is load-bearing: reviewers spawn via
      // manager.spawn and handoff seeds via runPrimaryTurn — both bypass this
      // operator-turn assembly but still carry config.goal, so the provider fold
      // is the one place that covers operator turns AND primitive seeds without
      // double-injecting.

      // ARCO_OPS_PLAN.md §E1 — resolve the operator-enabled-and-allowed
      // registry MCP servers for this workflow from the global registry + the
      // workflow's per-tab allowlist (meta.mcpAllow). Produces BOTH the merged
      // server entries (for the mcp-config write / Codex `-c` overrides) AND
      // the dangerous-and-unticked `--disallowedTools` set for CLI Claude.
      // This is the ONLY model-exposed expansion besides cluster /
      // codebase-memory — no hidden, model-selected servers.
      let turnRegistryServers: import('@arco/shared').ResolvedMcpServer[] = [];
      let turnMcpDisallowedTools: string[] = [];
      if (projectContextEnabled) try {
        const metaForMcp = await readMeta(cwd, workflowId);
        const wiring = await resolveRegistryWiring(metaForMcp?.mcpAllow ?? []);
        turnRegistryServers = wiring.registryServers;
        turnMcpDisallowedTools = wiring.disallowedTools;
      } catch (err) {
        console.error(`[arco] [${workflowId.slice(0, 8)}] mcp registry resolve failed:`, err);
      }

      // EFFICIENCY_PLAN.md Phase F9 — write `.arco/<wfid>/mcp-config.json`
      // for CLI Claude turns when cluster membership, the operator-attached
      // codebase-memory entry, OR §E1 registry servers apply. All coexist; the
      // writer merges deterministically and unlinks when none apply. Codex
      // transports don't use --mcp-config — they layer the same registrations
      // on via `-c mcp_servers.*` TOML overrides built in the codex provider.
      if (projectContextEnabled && wf.primary.provider === 'claude' && claudeTransport === 'cli') {
        const cbm = wf.config.codebaseMemory;
        const wantsCodebaseMemory = projectContextEnabled && cbm?.attached === true;
        // The workflow-scoped `arco` plan entry applies to EVERY workflow, so
        // the config is now written unconditionally (cwd is the only
        // precondition) rather than only when a cluster / codebase-memory /
        // registry entry applies.
        {
          try {
            turnClusterMcpConfigPath = await mcpConfigWriter.writeFor(cwd, workflowId, {
              planToolsCwd: cwd,
              clusterId: turnClusterId,
              taskBoardAttached: turnClusterTaskBoardAttached,
              accessMode: clusterAccessMode,
              port: PORT,
              codebaseMemoryIndexPath: wantsCodebaseMemory
                ? (cbm?.indexPath || cwd)
                : undefined,
              registryServers: turnRegistryServers,
            });
          } catch (err) {
            console.error(`[arco] [${workflowId.slice(0, 8)}] mcp-config write failed:`, err);
          }
        }
      }

      // Workbench Expansion A2 — shadow-git checkpoint. Snapshot the working
      // tree BEFORE the turn that may mutate files so the operator can
      // undo-the-agent independent of their real git history. Skipped when
      // plan mode is armed (the turn is read-only until ExitPlanMode, so
      // there's nothing to checkpoint). Failure never blocks the turn —
      // createCheckpoint returns null and we just don't emit a marker.
      //
      // Hooked HERE rather than in seedWorker.ts (the plan's guess): runtime
      // verification showed runPrimaryTurn is shared by reviewers, handoff
      // seeds, exportContext, and Task children — none of which should snapshot
      // the operator's tree. The operator-turn loop in turnEngine.handleUserMessage
      // is the only dispatch path that runs an operator-driven, file-mutating
      // turn, so the checkpoint belongs at this call site. The ref suffix uses
      // the workflow's current event seq (the turn it guards); the
      // checkpoint_created broadcast is itself stamped a fresh events.jsonl seq.
      // Upload-time image downscaling runs in the background; a send right
      // after a paste can beat it. Wait (bounded) here so the sync providers
      // (Claude CLI / Native, Codex exec) read the model copy too — they call
      // the sync modelImagePath() and can't wait themselves.
      if (promptAttachments && promptAttachments.length > 0) await awaitModelImages(promptAttachments);
      // STOP landed during the pre-spawn awaits above (killAll had nothing to
      // kill yet). Spawning now would run a turn nobody owns.
      if (!ownsBusy(wf, busyToken)) break;

      if (!chatMode && !armPlanMode) {
        const guardSeq = currentWorkflowSeq(cwd, workflowId);
        void createCheckpoint({ cwd, workflowId, seq: guardSeq })
          .then((cp) => {
            if (!cp) return;
            broadcastWorkflow(workflowId, {
              type: 'checkpoint_created',
              workflowId,
              seq: guardSeq,
              ref: cp.ref,
              label: cp.label,
              ts: cp.ts,
              fileCount: cp.fileCount,
              ...(cp.skippedLargeFiles ? { skippedLargeFiles: cp.skippedLargeFiles } : {}),
            });
          })
          .catch((err) => {
            console.error(`[arco] [${workflowId.slice(0, 8)}] checkpoint hook failed:`, err);
          });
      }

      const turn = runPrimaryTurn(
        {
          workflowId,
          cwd,
          manager: wf.manager,
          broadcast: (msg) => send(ws, msg),
          bgTracker: chatMode ? undefined : wf.bgTracker,
          notePotentialDevServerStart: chatMode ? undefined : (cmd, toolUseId) => deps.previewAutoDetect.notePotentialDevServerStart(workflowId, cmd, toolUseId),
          noteAgentText: chatMode ? undefined : (text) => deps.previewAutoDetect.noteAgentText(workflowId, text),
        },
        {
          primary: wf.primary,
          prompt: promptWithPlan,
          resumeSessionId: incognito ? undefined : wf.primarySessionId,
          attachments: promptAttachments,
          disableRssGuard: wf.disableRssGuard,
          appendSystemPrompt: finalAppend,
          systemPrompt: finalSystemPrompt,
          interactionMode: chatMode ? 'chat' : 'agent',
          chatWebAccess: chatWeb,
          voiceOperator: chatMode && wf.config.voiceOperator === true,
          incognito,
          drainSteer: () => drainSteerForWorker(workflowId, ws),
          requeueSteer: (items, bucket) => requeueSteerForWorker(workflowId, ws, items, bucket),
          codexTransport,
          codexContextPolicy: wf.config.codexContextPolicy,
          providerAccountRef: providerAccount?.profile.id,
          codexHome: providerAccount?.codexHome,
          claudeTransport,
          ultracode,
          zaiTransport,
          claudeNativeCompact,
          claudeNativeForceInterleavedThinkingBeta,
          claudeNativeThinkingDisplay,
          claudeNativePlanModeArmed: armPlanMode,
          turnNotice: turnNoticeParts.length > 0 ? turnNoticeParts.join('\n\n') : undefined,
          efficiencyAutoCompact,
          efficiencyToolFilter,
          efficiencyFactForce,
          efficiencyConfigProtection,
          efficiencySandbox,
          reviewSafeMode,
          outputStyle,
          goal,
          // §4.1 — session-local posture filter (runtime-only WorkflowState
          // field). Operator-turn only; primitives (reviewers / handoff seeds /
          // Task children) leave it unset ⇒ full, like outputStyle's 'normal'.
          toolPosture: wf.toolPosture,
          clusterId: turnClusterId,
          clusterAccessMode,
          executionCwd: isolatedMember && turnClusterId
            ? clusterStore.isolatedWorkspaceFor(turnClusterId, workflowId)
            : undefined,
          persistenceCwd: isolatedMember ? cwd : undefined,
          clusterTaskBoardAttached: turnClusterTaskBoardAttached,
          clusterPlan: turnClusterPlan,
          clusterRole: turnClusterRole,
          clusterEfficiencyDoctrine: turnClusterEfficiencyDoctrine,
          clusterProgressDoctrine: turnClusterProgressDoctrine,
          clusterMcpConfigPath: turnClusterMcpConfigPath,
          codebaseMemoryAttached: projectContextEnabled && wf.config.codebaseMemory?.attached === true,
          codebaseMemoryIndexPath: projectContextEnabled && wf.config.codebaseMemory?.attached === true
            ? (wf.config.codebaseMemory.indexPath || cwd)
            : undefined,
          // §E1 — registry servers feed Codex `-c` overrides; CLI Claude got
          // them via the mcp-config write above. mcpDisallowedTools feed CLI
          // Claude's --disallowedTools (dangerous-tool denylist enforcement).
          mcpRegistryServers: turnRegistryServers,
          mcpDisallowedTools: turnMcpDisallowedTools,
          ollamaParams,
          // Per-tab Claude Native web budget (Anthropic server-tool max_uses).
          // Native-only; the worker falls back to the server default when unset.
          webSearchMaxUses: wf.config.webSearchMaxUses,
        },
      );

      // Claude pre-mints its session id; pin it into meta.json immediately so a
      // crash between now and turn-completion still leaves meta pointing at the
      // right CLI session. Only relevant on the first iteration — later
      // flushes resume the already-pinned session. Native transport runs
      // in-process and never writes a CLI rollout, so seedWorker's pre-minted
      // UUID is meaningless here — recording it would phantom-pollute meta and
      // break original-worker handoff (which would try `claude --resume <id>`
      // against a non-existent rollout).
      if (!incognito && firstIteration && !wf.primarySessionId && turn.initialSessionId
          && wf.primary.provider === 'claude' && claudeTransport !== 'native') {
        wf.primarySessionId = turn.initialSessionId;
        reconcileLatestCliSession(cwd, workflowId, 'claude', turn.initialSessionId).catch((err) => {
          console.error(`[arco] [${workflowId.slice(0, 8)}] meta reconcile (claude mint) failed:`, err);
        });
      }

      // Codex emits thread_id at init. Capture on first fire, persist to meta.
      turn.onSessionDiscovered((sid) => {
        if (incognito) return;
        if (!wf.primarySessionId) wf.primarySessionId = sid;
        if (wf.primary.provider === 'antigravity') broadcastSessionMetadata(workflowId, wf);
        reconcileLatestCliSession(cwd, workflowId, wf.primary.provider, sid, providerAccount?.profile.id).catch((err) => {
          console.error(`[arco] [${workflowId.slice(0, 8)}] meta reconcile (${wf.primary.provider}) failed:`, err);
        });
      });

      // ULTRACODE_PLAN.md — surface the background fleet. Under ultracode the
      // CLI's WorkflowTool runs subagents whose transcripts never touch the
      // parent stream, so the Activity tab would look dead. Poll those files and
      // emit live `ultracode_fleet_progress` snapshots, scoped strictly to this
      // turn (started here, stopped in finally). Gated on a known session id —
      // the watcher needs it to locate `<sessionId>/subagents/workflows/`.
      let fleetWatcher: FleetWatcher | null = null;
      if (ultracode && wf.primarySessionId) {
        fleetWatcher = startUltracodeFleetWatcher({
          workflowId,
          cwd,
          sessionId: wf.primarySessionId,
          emit: (msg) => broadcastTransient(workflowId, msg),
        });
      }

      let outcome: Awaited<typeof turn.settled>;
      try {
        outcome = await turn.settled;
      } finally {
        fleetWatcher?.stop();
      }
      console.log(`[arco] [${workflowId.slice(0, 8)}] turn settled${outcome.error ? ' with error: ' + outcome.error : ''}`);
      lastTurnErrored = !!outcome.error;
      watchHadError ||= lastTurnErrored;
      if (firstIteration && opts?.backgroundEvent) opts.onBackgroundSettled?.(outcome.error ?? undefined);
      clearComputerBackgroundClaim(workflowId, busyToken);
      firstIteration = false;
      if (wf.config.voiceOperator && outcome.error?.startsWith(COMPUTER_TIMEOUT)) {
        // The transport may have executed earlier actions. Never replay this
        // request or drain dependent queued instructions after a timeout.
        const queued = wf.queue.steering.length + wf.queue.followUp.length;
        for (const item of [...wf.queue.steering, ...wf.queue.followUp]) if (item.clientMessageId)
          broadcastWorkflow(workflowId, { type: 'queued_message_cancelled', workflowId, clientMessageId: item.clientMessageId });
        if (queued) broadcastWorkflow(workflowId, { type: 'system_notice', workflowId,
          content: `[COMPUTER] Cancelled ${queued} queued request(s) after the timeout; resubmit them when ready. Earlier actions may already have happened.` });
        if (incognito) wf.config.computerContext = { ...(wf.config.computerContext ?? { keepContext: false, resets: 0 }), pendingFresh: true, pendingFreshReason: 'recovery' };
        break;
      }

      // Phase 2 — emit context estimate after each settled turn (uses
      // per-session calibration when available, byte-count otherwise).
      // Fire-and-forget; a missing JSONL (Gemini/Codex/Ollama) is a silent no-op.
      // Skip for Native — separate branch below uses the SDK-reported
      // lastPromptTokens (no JSONL exists, and a stale CLI JSONL from a prior
      // CLI session on this workflow would otherwise win the race).
      if (wf.primary.provider === 'claude' && wf.primarySessionId && claudeTransport !== 'native') {
        const sid = wf.primarySessionId;
        estimateContextFill(cwd, sid, wf.primary.model, wf.calibration).then((est) => {
          if (!est) return;
          broadcastTransient(workflowId, {
            type: 'context_usage',
            workflowId,
            ...est,
            claudeSessionId: sid,
          });
          // Keep the shared auto-handoff signal fresh (fire-and-forget, so it
          // may settle just after maybeAutoHandoff runs — warnAt/autoAt margin
          // absorbs the one-turn lag).
          wf.lastContextPercent = est.percentOfWindow;
        }).catch(() => { /* best-effort */ });
      } else if (wf.primary.provider === 'claude' && claudeTransport === 'native' && typeof outcome.lastPromptTokens === 'number') {
        // Native Claude has no session JSONL to read. The worker's settled
        // outcome carries the last round's prompt size — convert to a fresh
        // ground-truth context_usage and fan out via broadcastTransient
        // (consistent with the CLI path: primary_complete already persists
        // lastPromptTokens, so context_usage stays derived/transient).
        const est = wf.config.voiceOperator && outcome.modelContextWindow
          ? promptContextEstimate(outcome.lastPromptTokens, outcome.modelContextWindow, Date.now())
          : nativeContextEstimate(wf.primary.model, outcome.lastPromptTokens, Date.now());
        if (est) {
          wf.lastContextPercent = est.percentOfWindow;
          broadcastTransient(workflowId, {
            type: 'context_usage',
            workflowId,
            ...est,
          });
        }
        // §2.3 — emit the deterministic budget meter alongside the CTX bar's
        // context_usage. Uses the same ground-truth lastPromptTokens but against
        // the EFFECTIVE window (real window − reserved output budget) — the
        // usable-input-pressure signal the §2.1 auto-fold trigger reads. Window +
        // reserved come straight from the model's own params (KNOWN_CTX +
        // chooseMaxTokens), so this stays deterministic and LLM-free.
        const win = lookupCtx(wf.primary.model);
        if (typeof win === 'number' && win > 0) {
          const reserved = chooseMaxTokens(wf.primary.model, wf.primary.effort ?? 'high');
          const budget = computeContextBudget(outcome.lastPromptTokens, win, reserved);
          wf.lastContextBudgetPct = budget.pct;
          const thresholds = {
            warnAt: wf.autoHandoff.warnAt,
            autoAt: wf.autoHandoff.autoAt,
            ...(typeof wf.autoFold?.foldAt === 'number' ? { foldAt: wf.autoFold.foldAt } : {}),
          };
          broadcastTransient(workflowId, {
            type: 'context_budget',
            workflowId,
            usedTokens: budget.usedTokens,
            windowSize: budget.windowSize,
            reservedOutput: budget.reservedOutput,
            effectiveWindow: budget.effectiveWindow,
            pct: budget.pct,
            thresholds,
            crossed: crossedThresholds(budget.pct, thresholds),
          });
        }
      } else if (wf.primary.provider === 'ollama' && typeof outcome.lastPromptTokens === 'number') {
        // M6 — Ollama has no session JSONL. The worker's settled outcome carries
        // the LAST turn's prompt_eval_count (ground truth: the exact prompt the
        // daemon saw on its final call) plus the per-backend probed num_ctx the
        // request actually used (M3/M4: the window is per-host, so the
        // denominator must be the host that produced this answer, not a static
        // map). Build the same-shaped context_usage the CTX bar already renders
        // for every other provider; fall back to Ollama's 2048 default only when
        // nothing was probed. Transient (broadcastTransient): primary_complete
        // already persisted lastPromptTokens + modelContextWindow, so this stays
        // derived. M8 reads context_usage.percentOfWindow as its compaction gate.
        const est = ollamaContextUsage(outcome.lastPromptTokens, outcome.modelContextWindow, Date.now());
        if (est) {
          wf.lastContextPercent = est.percentOfWindow;
          broadcastTransient(workflowId, {
            type: 'context_usage',
            workflowId,
            ...est,
          });
        }
      } else if ((wf.primary.provider === 'strata' || wf.primary.provider === 'deepseek') && typeof outcome.lastPromptTokens === 'number' && outcome.modelContextWindow) {
        // Use Strata's discovered window and the final call's actual prompt;
        // never count summed tool-loop input as context occupancy.
        const est = promptContextEstimate(outcome.lastPromptTokens, outcome.modelContextWindow, Date.now());
        if (est) {
          wf.lastContextPercent = est.percentOfWindow;
          broadcastTransient(workflowId, { type: 'context_usage', workflowId, ...est });
        }
      } else if (wf.primary.provider === 'zai' && zaiTransport === 'native' && typeof outcome.lastPromptTokens === 'number') {
        // Z.ai Native's usage.input_tokens is summed across all tool-loop API
        // calls for telemetry, but CTX fill is the prompt size of the final API
        // call. The worker carries that as lastPromptTokens; publish it as a
        // ground-truth context_usage so the footer does not render the summed
        // turn total or any stale app-server rollout state.
        const est = promptContextEstimate(outcome.lastPromptTokens, zaiModelContextWindow(wf.primary.model), Date.now());
        if (est) {
          wf.lastContextPercent = est.percentOfWindow;
          broadcastTransient(workflowId, {
            type: 'context_usage',
            workflowId,
            ...est,
          });
        }
      }

      if (incognito && wf.config.voiceOperator && wf.primary.provider === 'codex'
        && typeof outcome.lastPromptTokens === 'number' && outcome.modelContextWindow) {
        const est = promptContextEstimate(outcome.lastPromptTokens, outcome.modelContextWindow, Date.now());
        if (est) {
          wf.lastContextPercent = est.percentOfWindow;
          broadcastTransient(workflowId, { type: 'context_usage', workflowId, ...est });
        }
      }

      // Codex / Z.ai app-server equivalent — provider turn usage can be the SUM across all
      // internal LLM calls within this operator turn. That's right for billing
      // but wrong for context-window-fill display; the live context is the LAST
      // call's prompt. Await this best-effort rollout read before threshold
      // checks so auto-handoff never fires from the previous turn's percentage.
      if ((wf.primary.provider === 'codex' || (wf.primary.provider === 'zai' && zaiTransport === 'appserver')) && wf.primarySessionId) {
        await refreshCodexTokenSnapshot(workflowId, wf, providerAccount?.codexHome);
      }

      // Drain the whole queue at once as a single merged follow-up turn.
      // Operators typically stack queued messages as a cumulative thought
      // ("oh and also…", "I forgot to mention…") and want one integrated
      // reply, not N sequential turns each answering a partial thought.
      // Messages join with `\n\n` (blank line between, reads as paragraphs
      // of one prompt), attachments concat across all drained items.
      // `cancel` clears the queue, so STOP during the merge drops the
      // whole batch before it fires.
      //
      // Phase 4 — order is steering first, then follow-up. Steer is "do this
      // now / change direction"; follow-up is "after the current task lands."
      // When real mid-turn delivery ships per provider in Phases 5–7, steer
      // entries will be flushed *during* the turn (between tool calls) rather
      // than concatenated post-turn — which is why the kinds are separate
      // arrays now even though they share the same drain path today.
      // Cancelled (and possibly superseded by a resend) while settling: the
      // queue belongs to whoever holds busy now — don't drain it.
      if (!ownsBusy(wf, busyToken)) break;
      if (wf.queue.steering.length === 0 && wf.queue.followUp.length === 0) break;
      const drained = [...wf.queue.steering.splice(0), ...wf.queue.followUp.splice(0)];
      broadcastQueueUpdate(workflowId);
      // Tell the client the queue moved — without this the composer-adjacent
      // QUEUED pill stays lit forever for non-Claude providers (no
      // session_entry to clear it) and can also stick on Claude when the
      // session_entry prefix-match misses (e.g., whitespace drift between
      // optimistic content and the JSONL-written content). The client flips
      // queued:false and rebases the optimistic timestamp to drainedAt so
      // ChatPanel's 5s sessionChat dedup window can collapse Claude's
      // shortly-arriving JSONL echo.
      const drainedClientIds = drained
        .map((d) => d.clientMessageId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (drainedClientIds.length > 0) {
        send(ws, {
          type: 'queued_messages_drained',
          workflowId,
          clientMessageIds: drainedClientIds,
          drainedAt: Date.now(),
        });
      }
      prompt = drained.map((d) => d.content).join('\n\n');
      const mergedAttachments = drained.flatMap((d) => d.attachments ?? []);
      promptAttachments = mergedAttachments.length > 0 ? mergedAttachments : undefined;
      // §D1 — concat each drained item's expanded context-refs block (each was
      // expanded at enqueue and stored on the QueueItem). The blocks already
      // carry their own leading newlines + `--- Context (...) ---` headers.
      const mergedRefs = drained.map((d) => d.expandedContext ?? '').filter(Boolean).join('');
      promptExpandedContext = mergedRefs.length > 0 ? mergedRefs : undefined;
      promptClientMessageId = undefined;
      console.log(`[arco] [${workflowId.slice(0, 8)}] flushing ${drained.length} queued interjection(s) as merged follow-up turn`);
    }
    watchLoopFinished = true;
  } finally {
    // Only the owning claim may release busy / touch the queue. A loop whose
    // claim STOP revoked exits quietly — STOP + quick resend used to let turn
    // 1's finally clear turn 2's busy flag (and drain/clear turn 2's queue).
    staleLoop = !releaseBusy(wf, busyToken, watchLoopFinished && !watchHadError ? 'finished' : 'failed');
    if (!staleLoop) {
      // The provider's `primary_turn_ended` broadcast already fired before
      // this finally runs (it's queued from the settled.then() microtask in
      // seedWorker which awaits the same promise the turn loop does — the
      // provider's .then attaches first, so it runs first). At that moment
      // wf.busy was still `true`, so the cluster_state push triggered by
      // CLUSTER_STATE_TRIGGERS read `busy` and reported the member as still
      // busy. Re-notify here so the cluster tab dot + per-card status
      // actually drop when the worker becomes idle. Without this the
      // cluster-level indicators stay lit until the next unrelated event.
      void notifyClusterStateForWorkflow(workflowId);
      // Defensive: the drain loop above already empties both arrays on each
      // iteration. This catches the case where the loop exited via throw —
      // we don't want the next turn to inherit half-drained state.
      if (wf.queue.steering.length > 0 || wf.queue.followUp.length > 0) {
        wf.queue.steering.length = 0;
        wf.queue.followUp.length = 0;
        broadcastQueueUpdate(workflowId);
      }
    }
  }
  // Stale loop: STOP already disarmed the goal run and owns the teardown; the
  // post-settle armed actions belong to whoever holds the tab now.
  if (staleLoop) {
    // A requested Computer reset still needs a boundary after STOP's
    // interrupt actually settles. A newer busy owner keeps it deferred.
    if (wf.config.voiceOperator) {
      await maybeFreshComputerContext(workflowId, false);
      await drainQueueIfIdle(workflowId);
      await announceComputerSettled(workflowId);
    }
    return;
  }

  // Computer rotates only after the complete tool/queue turn has settled.
  await maybeFreshComputerContext(workflowId, !lastTurnErrored);
  await announceComputerSettled(workflowId);

  // Phase 2 calibration — run after the full drain queue empties (idle moment).
  // Updates per-session ratio/overhead from ground-truth /context output.
  await maybeCalibrate(workflowId, wf, cwd);

  // §2.1 — auto-fold runs FIRST (foldAt sits below the handoff thresholds): the
  // cheap deterministic in-place Fold is tried before recommending a handoff. A
  // successful fold reseeds the session, so skip the (now-stale) handoff check
  // this round — the next turn's meter re-evaluates against the reduced context.
  const folded = await maybeAutoFold(workflowId, wf, cwd);

  // Phase 3 — after the turn loop settles, check context thresholds for
  // warning / auto-handoff. Runs only when wf.busy is false (turn complete).
  if (!folded) await maybeAutoHandoff(workflowId, wf, cwd);

  // NATIVE_COMPACTION_PLAN Phase 2 — between-turn auto context-fill compaction
  // for Native (operator-armed via efficiencyAutoCompact, default off). Runs
  // AFTER auto-handoff: a successful auto-handoff resets lastContextPercent to 0,
  // so this no-ops when handoff already rotated the session — handoff (the heavy
  // rung) wins, compaction (the light rung) only fires when handoff didn't.
  // Phase 3 — pass ws/session so the opt-in auto-continue can dispatch a
  // continuance turn through the normal operator path.
  await maybeAutoCompactNative(workflowId, wf, cwd, ws, session);

  // Messages typed while auto-fold / auto-handoff held the tab are still
  // queued. Flush them first; that turn runs its own post-settle chain (goal
  // run included), so this settle is done.
  if (await drainQueueIfIdle(workflowId)) return;

  // GOAL_RUN_PLAN.md — north-star auto-continue. Last of the post-settle armed
  // actions on purpose: fold / handoff / compaction all reshape the context
  // this tick would run against, so they get to act first.
  await maybeGoalRun(workflowId, wf, ws, session, lastTurnErrored);
}

// GOAL_RUN_PLAN.md — one tick of an armed goal run. Every branch either
// dispatches exactly one visible turn or stops the run with an operator-
// readable reason; there is no third outcome and no model input to the
// decision (see `evaluateGoalRun`).
async function maybeGoalRun(
  workflowId: string,
  wf: WorkflowState,
  ws: WebSocket | undefined,
  session: Session | undefined,
  lastTurnErrored: boolean,
): Promise<void> {
  const state = wf.config.goalRun;
  if (!state?.enabled) return;

  const decision = evaluateGoalRun({
    state,
    hasNorthStar: !!wf.config.goal?.trim(),
    busy: wf.busy,
    queuedMessages: wf.queue.steering.length + wf.queue.followUp.length,
    lastTurnErrored,
    providerThrottled: !isAvailable(wf.primary.provider),
    contextPercent: wf.lastContextPercent,
  });

  if (decision.action === 'idle' || decision.action === 'skip') return;

  if (decision.action === 'stop') {
    state.enabled = false;
    const spent = state.total - state.remaining;
    broadcastWorkflow(workflowId, {
      type: 'system_notice',
      workflowId,
      content:
        `[GOAL RUN] Stopped after ${spent}/${state.total} iteration${spent === 1 ? '' : 's'} — ` +
        `${GOAL_RUN_STOP_TEXT[decision.reason]}. ${formatGoalRunTokens(state.tokensUsed)} spent. ` +
        `Re-arm with \`/goal run <n>\`.`,
    });
    broadcastWorkflow(workflowId, { type: 'goal_run_state', workflowId, ...snapshotGoalRun(state) });
    console.log(`[arco] [${workflowId.slice(0, 8)}] goal run stopped (${decision.reason}) after ${spent}/${state.total}`);
    return;
  }

  // Dispatching. Decrement BEFORE the await so a re-entrant settle (the turn we
  // are about to start finishing fast) can never see the old count and double-
  // spend the same iteration.
  state.remaining -= 1;
  const prompt = goalRunContinuePrompt(decision.iteration, state.total);
  broadcastWorkflow(workflowId, {
    type: 'system_notice',
    workflowId,
    content:
      `[GOAL RUN] Auto-continuing toward the north star — iteration ${decision.iteration}/${state.total}, ` +
      `${state.remaining} left, ${formatGoalRunTokens(state.tokensUsed)} spent so far. ` +
      `Type \`/goal run stop\` (or click the chip) to stop.`,
  });
  broadcastWorkflow(workflowId, { type: 'goal_run_state', workflowId, ...snapshotGoalRun(state) });
  console.log(`[arco] [${workflowId.slice(0, 8)}] goal run tick ${decision.iteration}/${state.total}`);

  if (!ws || !session) {
    // No socket to dispatch through (server-originated turn path). Stop rather
    // than silently stall — an armed run that can't tick must say so.
    state.enabled = false;
    broadcastWorkflow(workflowId, {
      type: 'system_notice',
      workflowId,
      content: '[GOAL RUN] Stopped — no operator session to dispatch the next turn through.',
    });
    return;
  }
  try {
    await handleUserMessage(ws, session, workflowId, prompt, undefined, undefined, false, undefined, undefined);
  } catch (err) {
    state.enabled = false;
    console.error(`[arco] [${workflowId.slice(0, 8)}] goal run dispatch failed:`, err);
    broadcastWorkflow(workflowId, {
      type: 'system_notice',
      workflowId,
      content: `[GOAL RUN] Stopped — dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// Compact token count for operator-facing notices ("1.2M", "418k", "930").
function formatGoalRunTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k tokens`;
  return `${n} tokens`;
}

export function snapshotGoalRun(state: GoalRunState): {
  enabled: boolean; total: number; remaining: number; tokensUsed: number; tokenBudget?: number;
} {
  return {
    enabled: state.enabled,
    total: state.total,
    remaining: state.remaining,
    tokensUsed: state.tokensUsed,
    ...(typeof state.tokenBudget === 'number' ? { tokenBudget: state.tokenBudget } : {}),
  };
}

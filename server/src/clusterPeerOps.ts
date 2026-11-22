// docs/PROTOCOL_CLUSTER.md - shared peer-ops module.
//
// Phase 1 shipped peer_list / peer_send / peer_read as in-process methods on
// the Native worker (server/src/providers/claude-native/peerTools.ts). Phase 3
// adds CLI Claude parity via an MCP stdio child that translates tool calls to
// REST against `/api/clusters/:id/peer/...`. Both call sites do the same
// thing: validate the sender, walk clusterBudget / clusterMailbox /
// clusterStore, emit the same WS events (peer_message_sent /
// peer_send_rejected on the sender's workflow channel;
// peer_message_received on the recipient's channel at drain time).
//
// This module is the single source of truth so the wire surface stays
// identical across transports. Native peerTools.ts delegates here; the REST
// handler in index.ts delegates here too. Tests of one transport implicitly
// cover the other.
//
// Each operation takes a `PeerOpsContext` that supplies the calling member's
// workflowId + clusterId (resolved by the caller — Native pulls from
// WorkerConfig, REST pulls from the URL path + the body's `workflowId`) and a
// pair of broadcast functions:
//
//   - `broadcastSender(msg)` — events that land on the sender's workflow
//     channel (peer_message_sent, peer_send_rejected).
//   - `broadcastRecipient(toWfId, msg)` — events that land on the recipient's
//     workflow channel (peer_message_received on drain).
//
// The Native path passes `broadcast: (msg) => broadcastWorkflow(workflowId, msg)`
// for the sender and `(toWfId, msg) => broadcastWorkflow(toWfId, msg)` for the
// recipient. The REST path does the same — both reach the in-process
// `broadcastWorkflow` so persistAndStampSeq stamps every event into the
// recipient's events.jsonl.

import { readSettings } from './settings.js';
import { withFileLock } from './atomicFile.js';
import { recipientContext, type RecipientContext } from './peerRecipientContext.js';
import { loadResearch, researcherFor, researcherName } from './research/researchState.js';
import { holdResearcherReply, recordTargeted, resolveResearcherRef, wakeForResearchMail } from './research/researchRounds.js';
import { IsolatedArtifactTooLarge, readIsolatedArtifact } from './research/isolatedArtifact.js';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import * as clusterStore from './clusterStore.js';
import { listPlanRefs } from './planStore.js';
import { resolveLinkedRefs, planItemContextFor } from './planRefContext.js';
import { parsePlan } from './primitives/reviewContent.js';
import * as clusterMailbox from './clusterMailbox.js';
import * as clusterBudget from './clusterBudget.js';
import * as clusterMailTally from './clusterMailTally.js';
import * as clusterPlanStore from './clusterPlanStore.js';
import * as clusterPlanBridge from './clusterPlanBridge.js';
import * as taskLedger from './project/taskLedger.js';
import { appendLedgerComment, persistLedgerKernelMutation, persistLedgerMutation } from './ws/taskLedgerHandlers.js';
import { isClusterDirector, isIsolatedAccessMode, isTaskApprovalCurrent, presetForText } from '@arco/shared';
import type { ServerMessage, MemberTier, LedgerTask, LedgerTaskStatus, TaskComment, TaskDetails, TaskLink, TaskRun, TaskSignoff, TaskSignoffState } from '@arco/shared';
import { isGeminiMember } from './geminiMembers.js';
import { isOperatorStartedTurn } from './clusterTurnOrigin.js';

// peer_send dedupe — guards against the orphan-tool-use retry pattern:
// a previous turn aborted mid-tool, leaving the model with no memory of
// having sent (pruneOrphanToolUse drops the orphan assistant block); on
// the next turn the operator nudges and the model re-issues the same
// peer_send, producing a duplicate mailbox entry. 60s window catches the
// rapid-fire variant; longer-gap recoveries fall to the operator-driven
// mailbox CANCEL modal. Env override: ARCO_PEER_SEND_DEDUPE_MS.
const PEER_SEND_DEDUPE_MS = (() => {
  const raw = Number(process.env.ARCO_PEER_SEND_DEDUPE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
})();
// (from|to|sha256(content)) → epoch ms of the last accepted send. Cleared
// lazily on every lookup that finds an expired entry — no scheduled sweep
// needed; the map only holds active windows. Process-local; restarts clear
// the cache (which is correct, since restarts also wipe the orphan state
// that caused the retry).
const peerSendDedupeCache = new Map<string, number>();
function peerSendDedupeKey(from: string, to: string, content: string): string {
  const h = createHash('sha256').update(content).digest('hex');
  return `${from}|${to}|${h}`;
}

export interface PeerOpsContext {
  workflowId: string;
  clusterId: string;
  broadcastSender: (msg: ServerMessage) => void;
  broadcastRecipient: (toWfId: string, msg: ServerMessage) => void;
}

function mailboxOnly(ctx: PeerOpsContext): boolean {
  return clusterStore.getMemberAccessMode(ctx.clusterId, ctx.workflowId) !== 'standard';
}

export interface PeerListEntry {
  workflowId: string;
  displayName: string;
  pendingForThem: number;
  // Optional operator-set cluster role. Exposed so agents can distinguish a
  // display name ("Director") from a role ("Coordinator role...") and target
  // peer_send correctly.
  role?: string;
  // optional operator-set builder-tier hint. Surfaces in
  // peer_list so the director (an LLM) can match task complexity to
  // builder capability. Pure metadata: the director decides routing,
  // not the server.
  //   light    — quick edits / renames / simple commands
  //   standard — normal feature work
  //   heavy    — architectural changes / complex refactors
  // Absent when the operator hasn't set a tier ("no opinion").
  tier?: MemberTier;
  // optional operator-set focus (sub-specialty). Free-form
  // text that complements `tier` and a member's role: while role/tier
  // describe the canonical kind of work, focus describes what THIS
  // specific peer specializes in (e.g. "React frontend, Zustand
  // patterns"). Absent when the operator hasn't set one.
  focus?: string;
}

export interface PeerSendResult {
  ok: true;
  msgId: string;
  to: string;
  deliveredImmediately: false;
  // Research projects: the reply is held until this round is released.
  heldForRound?: number;
  recipientContext?: RecipientContext;
  guard?: clusterBudget.BudgetDecision & { warning?: string };
}

export interface PeerSendRejection {
  ok: false;
  code: 'unknown_peer' | 'self_send' | 'budget_exhausted' | 'content_too_large' | 'enqueue_failed' | 'recipient_not_in_cluster' | 'duplicate_send' | 'status_confirmation' | 'unknown_task';
  message: string;
  // Budget-only fields. Present when the rejection rides through
  // peer_send_rejected with budget_exhausted.
  count?: number;
  cap?: number;
}

export interface PeerReadEntry {
  msgId: string;
  fromName: string;
  content: string;
  createdAt: string;
  artifacts?: Array<{ name: string; path: string; byteLength: number }>;
}

export async function peerList(ctx: PeerOpsContext): Promise<PeerListEntry[]> {
  if (mailboxOnly(ctx)) return [];
  const members = clusterStore.getMembers(ctx.clusterId) ?? [];
  const peers = members.filter((wfid) => wfid !== ctx.workflowId);
  const rows: PeerListEntry[] = [];
  // A research project shows researchers by letter only: no provider, model,
  // mailbox depth or other activity (docs/RESEARCH.md).
  const research = await loadResearch(ctx.clusterId).catch(() => null);
  for (const wfid of peers) {
    const researcher = research ? researcherFor(research, wfid) : undefined;
    if (researcher) {
      rows.push({ workflowId: wfid, displayName: researcherName(researcher.letter), pendingForThem: 0, role: 'Researcher',
        ...(!research!.blind || research!.revealedAt ? { focus: `${researcher.provider}${researcher.claudeTransport ? ` ${researcher.claudeTransport}` : ''}, ${researcher.model}` } : {}) });
      continue;
    }
    const depth = await clusterMailbox.depthFor(wfid).catch(() => 0);
    const role = clusterStore.getMemberRole(ctx.clusterId, wfid);
    const tier = clusterStore.tierFor(wfid);
    const focus = clusterStore.focusFor(wfid);
    rows.push({
      workflowId: wfid,
      displayName: clusterStore.displayNameFor(wfid),
      pendingForThem: depth,
      ...(role ? { role } : {}),
      ...(tier ? { tier } : {}),
      ...(focus ? { focus } : {}),
    });
  }
  return rows;
}

export function isStatusOnlyPeerMessage(content: string): boolean {
  return /\b(?:landed|merged|pushed|accepted|tagged|recorded)\b/i.test(content)
    && !/\?/.test(content)
    && !/\b(?:start|stop|fix|rebase|run|change|add|remove|use|wait|hold|resume|revert|retry|report)\b/i.test(content)
    && !/(?:\b[a-f0-9]{8}-[a-f0-9-]{27,}\b|\b[a-z]\d+(?:\.\d+)+[a-z]?\b|#\d+\b)/i.test(content)
    && !/\b(?:assign(?:ed|ment|ing)?|task)\b[^\n]*\b[a-f0-9]{8}\b/i.test(content);
}

export async function peerSend(
  ctx: PeerOpsContext,
  args: { to: string; content: string; artifactPaths?: string[]; confirm?: boolean; taskId?: string },
  opts?: { bypassBudget?: boolean; bypassDedupe?: boolean; maxContentBytes?: number },
): Promise<PeerSendResult | PeerSendRejection> {
  // Research projects: a researcher's mail always goes to the Research
  // Director, and the Director can name a researcher by letter.
  const research = await loadResearch(ctx.clusterId).catch(() => null);
  const senderResearcher = research ? researcherFor(research, ctx.workflowId) : undefined;
  const directorOfResearch = !!research && research.directorWorkflowId === ctx.workflowId;
  // Primary path: full workflowId or unambiguous 8-char prefix (plan §0).
  let resolved = senderResearcher
    ? research!.directorWorkflowId
    : (directorOfResearch ? resolveResearcherRef(research!, args.to) : undefined) ?? clusterStore.resolvePeer(ctx.clusterId, args.to);
  // 2026-05-11 bug fix — fall back to displayName matching when the model
  // types a friendly name ("Harbor", "Harbor #2") instead of a wfid
  // prefix. Resolution order: case-insensitive exact displayName match
  // first; on a miss, case-insensitive prefix match. Ambiguous (>1
  // match) folds into the `unknown_peer` rejection below with a roster
  // hint — keeps the PeerSendRejection union narrow (no new code).
  const members = clusterStore.getMembers(ctx.clusterId) ?? [];
  const roster = members.map((wfid) => ({
    wfid,
    name: clusterStore.displayNameFor(wfid),
    role: clusterStore.getMemberRole(ctx.clusterId, wfid),
  }));
  if (!resolved) {
    const ref = args.to.trim().toLowerCase();
    if (ref.length > 0) {
      const exact = roster.filter((r) => r.name.toLowerCase() === ref);
      if (exact.length === 1) {
        resolved = exact[0].wfid;
      } else if (exact.length === 0) {
        const prefix = roster.filter((r) => r.name.toLowerCase().startsWith(ref));
        if (prefix.length === 1) resolved = prefix[0].wfid;
      }
    }
  }
  // Role fallback. Models often target a peer by role text ("Coordinator")
  // rather than displayName ("Director"). Resolve only when the role match
  // is unique; otherwise fall through to unknown_peer with a roster hint.
  if (!resolved) {
    const ref = args.to.trim().toLowerCase();
    if (ref.length > 0) {
      const withRole = roster
        .filter((r) => r.wfid !== ctx.workflowId && r.role && r.role.trim().length > 0)
        .map((r) => ({ ...r, roleLc: r.role!.toLowerCase() }));
      const exactRole = withRole.filter((r) => r.roleLc === ref);
      if (exactRole.length === 1) {
        resolved = exactRole[0].wfid;
      } else if (exactRole.length === 0) {
        const rolePrefix = withRole.filter((r) => r.roleLc.startsWith(ref));
        if (rolePrefix.length === 1) {
          resolved = rolePrefix[0].wfid;
        } else if (rolePrefix.length === 0) {
          const roleWord = withRole.filter((r) => (presetForText(r.role!)?.label.toLowerCase() ?? r.roleLc).split(/[^a-z0-9]+/).some((part) => part === ref));
          if (roleWord.length === 1) resolved = roleWord[0].wfid;
        }
      }
    }
  }
  if (!resolved) {
    ctx.broadcastSender({
      type: 'peer_send_rejected',
      workflowId: ctx.workflowId,
      reason: 'unknown_peer',
      targetRef: args.to.slice(0, 64),
    });
    const peers = roster.filter((r) => r.wfid !== ctx.workflowId);
    const hint = mailboxOnly(ctx)
      ? 'Ask the operator or a correspondent for an exact recipient name or id.'
      : peers.length === 0
      ? 'no peers in your cluster.'
      : `available peers: ${peers.map((r) => `${r.name} (${r.wfid.slice(0, 8)}${r.role ? `; role: ${r.role}` : ''})`).join(', ')}.`;
    return {
      ok: false,
      code: 'unknown_peer',
      message: `no member of your cluster matches "${args.to}" (full workflowId, unique 8-char prefix, unique displayName, or unique role). ${hint}`,
    };
  }
  if (resolved === ctx.workflowId) {
    // Decision §13 2026-05-10: self-send is a model error, not a policy
    // rejection — no peer_send_rejected event.
    return {
      ok: false,
      code: 'self_send',
      message: 'peer_send target resolves to your own workflowId; cannot message self.',
    };
  }
  // A handoff names the board task it hands over, so Arco can tell from
  // structured state that the task reached a member (see directorContinue.ts).
  // An id that is not on this cluster's board is refused before anything is
  // reserved or sent.
  const handoffTaskId = typeof args.taskId === 'string' && args.taskId.trim().length > 0 ? args.taskId.trim() : undefined;
  let handoffBoard: ClusterTaskBoardContext | null = null;
  if (handoffTaskId) {
    handoffBoard = mailboxOnly(ctx) ? null : await clusterTaskBoardContext(ctx.clusterId);
    const boardTasks = handoffBoard ? await taskLedger.load(handoffBoard.cwd, handoffBoard.boardKey).catch(() => null) : null;
    if (!boardTasks?.some((t) => t.id === handoffTaskId)) {
      return { ok: false, code: 'unknown_task', message: `task_id ${handoffTaskId.slice(0, 36)} is not on this cluster's board; nothing was sent. Use a full id from cluster_task_list, or send without task_id.` };
    }
  }
  const statusOnly = isClusterDirector(clusterStore.getMemberRole(ctx.clusterId, ctx.workflowId))
    && !args.artifactPaths?.length && isStatusOnlyPeerMessage(args.content);
  const confirmedStatus = statusOnly && args.confirm === true && !opts?.bypassBudget;
  // The operator path bypasses this model-only check. Held sends do not reserve
  // a dedupe entry or consume the per-turn message budget.
  if (!opts?.bypassBudget && statusOnly && !confirmedStatus) {
    ctx.broadcastSender({ type: 'peer_send_rejected', workflowId: ctx.workflowId, reason: 'status_confirmation', targetRef: resolved });
    return { ok: false, code: 'status_confirmation', message: 'This reads as status already on the board; send again with confirm to deliver' };
  }
  // Dedupe — reject exact-content retries within the window. Runs BEFORE
  // budget recordSend so a duplicate doesn't consume the sender's per-turn
  // budget. Sweep-on-lookup keeps the cache bounded without a timer.
  // Operator-driven transcript-send bypasses dedupe (operator intent is
  // explicit; same content sent twice is presumed intentional).
  // Reservations below (dedupe stamp, budget charge) are taken up front so
  // concurrent sends race correctly, then ROLLED BACK on every failure path.
  // They used to stick: a send that failed (bad artifact path, oversize,
  // enqueue error, budget refusal) still stamped the dedupe cache, so the
  // model's corrected retry within 60s was dropped as duplicate_send, and a
  // failed send burned a slot of the (lean: 4) per-turn budget.
  let stampedKey: string | undefined;
  let stampedAt = 0;
  let charged = false;
  let guard: import('@arco/shared').ClusterMessageGuard | undefined;
  let guardDecision: clusterBudget.BudgetDecision | undefined;
  const rollback = (): void => {
    if (stampedKey !== undefined && peerSendDedupeCache.get(stampedKey) === stampedAt) {
      peerSendDedupeCache.delete(stampedKey);
    }
    if (charged) clusterBudget.refund(ctx.workflowId);
  };
  if (PEER_SEND_DEDUPE_MS > 0 && !opts?.bypassDedupe && !confirmedStatus) {
    const key = peerSendDedupeKey(ctx.workflowId, resolved, args.content);
    const now = Date.now();
    const last = peerSendDedupeCache.get(key);
    if (last !== undefined && now - last < PEER_SEND_DEDUPE_MS) {
      const ageMs = now - last;
      ctx.broadcastSender({
        type: 'peer_send_rejected',
        workflowId: ctx.workflowId,
        reason: 'duplicate_send',
        targetRef: resolved,
      });
      return {
        ok: false,
        code: 'duplicate_send',
        message: `duplicate_send — identical content was sent to this peer ${Math.round(ageMs / 1000)}s ago. The previous send is in the mailbox or already delivered; do not retry unless the operator explicitly asks. Window: ${Math.round(PEER_SEND_DEDUPE_MS / 1000)}s.`,
      };
    }
    // Stamp now so concurrent retries within the same turn race correctly;
    // rollback() clears it if this send doesn't land.
    peerSendDedupeCache.set(key, now);
    stampedKey = key;
    stampedAt = now;
    // Lazy sweep: drop any expired entries we trip over on this lookup.
    if (peerSendDedupeCache.size > 256) {
      for (const [k, t] of peerSendDedupeCache) {
        if (now - t >= PEER_SEND_DEDUPE_MS) peerSendDedupeCache.delete(k);
      }
    }
  }
  // Operator-driven transcript-send bypasses budget — the operator is in
  // direct control, and a stuck "budget_exhausted" would silently block a
  // deliberate UI action. Model-driven sends still count.
  if (!opts?.bypassBudget) {
    guard = clusterStore.getMessageGuard(ctx.clusterId);
    const decision = clusterBudget.recordSend(ctx.workflowId, guard);
    guardDecision = confirmedStatus && !decision.allowed ? { ...decision, allowed: true } : decision;
    charged = true;
    if (!decision.allowed && !confirmedStatus) {
      rollback();
      ctx.broadcastSender({
        type: 'peer_send_rejected',
        workflowId: ctx.workflowId,
        reason: 'budget_exhausted',
        targetRef: resolved,
        count: decision.count - 1,
        cap: decision.cap!,
      });
      return {
        ok: false,
        code: 'budget_exhausted',
        message: `budget_exhausted: this mail was not delivered. ${decision.count - 1}/${decision.cap} accepted peer messages; 0 remaining. Counts reset at primary_turn_started and are not persisted across server restart. Consolidate same-recipient information; do not start turns to evade the guard.`,
        count: decision.count - 1,
        cap: decision.cap!,
      };
    }
  }
  const msgId = clusterMailbox.mintMsgId();
  const fromDisplayName = clusterStore.displayNameFor(ctx.workflowId);
  let artifacts: clusterMailbox.PeerArtifact[] | undefined;
  if (args.artifactPaths?.length) {
    if (!isIsolatedAccessMode(clusterStore.getMemberAccessMode(ctx.clusterId, ctx.workflowId))) {
      rollback();
      return { ok: false, code: 'enqueue_failed', message: 'artifact_paths is available only to isolated members' };
    }
    const root = resolve(clusterStore.isolatedWorkspaceFor(ctx.clusterId, ctx.workflowId));
    let total = 0;
    artifacts = [];
    for (const rawPath of args.artifactPaths.slice(0, 8)) {
      const abs = resolve(root, rawPath);
      if (abs !== root && !abs.startsWith(root + sep)) {
        rollback();
        return { ok: false, code: 'enqueue_failed', message: `artifact path escapes isolated workspace: ${rawPath}` };
      }
      let data: Buffer;
      try { data = await readIsolatedArtifact(root, rawPath, clusterMailbox.MAX_ARTIFACT_BYTES - total); }
      catch (error) {
        rollback();
        if (error instanceof IsolatedArtifactTooLarge) return { ok: false, code: 'content_too_large', message: `artifacts exceed ${clusterMailbox.MAX_ARTIFACT_BYTES} bytes` };
        return { ok: false, code: 'enqueue_failed', message: `artifact is unavailable or not a bounded regular file: ${rawPath}` };
      }
      total += data.byteLength;
      if (total > clusterMailbox.MAX_ARTIFACT_BYTES) {
        rollback();
        return { ok: false, code: 'content_too_large', message: `artifacts exceed ${clusterMailbox.MAX_ARTIFACT_BYTES} bytes` };
      }
      artifacts.push({ name: basename(abs), contentBase64: data.toString('base64'), byteLength: data.byteLength });
    }
  }
  const createdAt = new Date().toISOString();
  if (senderResearcher) {
    // A reply during an open round is held until the round is released; it
    // is not enqueued and raises no mail event the Director could see.
    const heldForRound = await holdResearcherReply(ctx.clusterId, ctx.workflowId, args.content, artifacts);
    if (heldForRound !== undefined) {
      return { ok: true, msgId, to: resolved, deliveredImmediately: false, heldForRound };
    }
  }
  try {
    await clusterMailbox.enqueue(resolved, {
      msgId,
      fromWorkflowId: ctx.workflowId,
      fromDisplayName,
      toWorkflowId: resolved,
      content: args.content,
      createdAt,
      delivered: false,
      ...(artifacts?.length ? { artifacts } : {}),
      ...(isGeminiMember(ctx.workflowId) ? { fromGemini: true } : {}),
    }, opts?.maxContentBytes !== undefined ? { maxContentBytes: opts.maxContentBytes } : undefined);
  } catch (err) {
    rollback();
    const code = (err as { code?: string })?.code ?? 'enqueue_failed';
    ctx.broadcastSender({
      type: 'peer_send_rejected',
      workflowId: ctx.workflowId,
      reason: code,
      targetRef: resolved,
    });
    return {
      ok: false,
      code: (code === 'content_too_large' || code === 'recipient_not_in_cluster')
        ? code
        : 'enqueue_failed',
      message: `${code}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  clusterMailTally.recordDelivery(ctx.clusterId, ctx.workflowId, resolved);
  ctx.broadcastSender({
    type: 'peer_message_sent',
    workflowId: ctx.workflowId,
    msgId,
    from: ctx.workflowId,
    to: resolved,
    contentPreview: args.content.length > 200 ? `${args.content.slice(0, 200)}…` : args.content,
    content: args.content,
    ts: Date.parse(createdAt),
  });
  if (handoffTaskId && handoffBoard) {
    await recordHandoff(ctx, handoffBoard, handoffTaskId, resolved, msgId)
      .catch((err) => console.error('[arco] handoff record failed:', err));
  }
  const warning = guard && clusterBudget.takeWarning(ctx.workflowId, guard, guardDecision!.count)
    ? `Warn-only threshold exceeded: ${guardDecision!.count}/${guard.threshold} peer messages this primary turn. Mail accepted. Consolidate related same-recipient information; required work and review still apply.`
    : undefined;
  const recipientResearcher = research ? researcherFor(research, resolved) : undefined;
  if (directorOfResearch && recipientResearcher) {
    await recordTargeted(ctx.clusterId, resolved, 'director', args.content)
      .catch((err) => console.error('[arco] research targeted message not recorded:', err));
  }
  if (research && (senderResearcher || recipientResearcher)) wakeForResearchMail(resolved, !!recipientResearcher);
  const context = senderResearcher || recipientResearcher
    ? undefined
    : await recipientContext(ctx.clusterId, ctx.workflowId, resolved).catch(() => undefined);
  return { ok: true, msgId, to: resolved, deliveredImmediately: false,
    ...(context ? { recipientContext: context } : {}),
    ...(guardDecision ? { guard: { ...guardDecision, ...(warning ? { warning } : {}) } } : {}),
  };
}

// Peer-tool plan-read. Returns the full canonical plan body on demand.
// Exists because the per-turn injected copy is NOT guaranteed to be the whole
// plan on string-form transports — a plan bigger than the fold budget is
// delivered as a deterministic outline (headings, checkbox lines, and
// labelled standing-directive sections) with a pointer here. Pure read: no broadcast, no
// mailbox side effects — the tool_use in the transcript is the audit record.
export interface PeerPlanReadOk {
  ok: true;
  title: string;
  body: string;
  updatedAt: number;
  byteLength: number;
  // Reference docs attached to the plan — read one with plan_ref_read or the
  // file path; listed here so a member doesn't need a second call to learn
  // they exist.
  planId: string;
  revision: string;
  refs: Array<{ slug: string; title: string; bytes: number }>;
  refsDir: string;
}

export interface PeerPlanReadRejection {
  ok: false;
  code: 'no_plan' | 'access_denied';
  message: string;
}

export async function peerPlanRead(
  ctx: PeerOpsContext,
): Promise<PeerPlanReadOk | PeerPlanReadRejection> {
  if (mailboxOnly(ctx)) return { ok: false, code: 'access_denied', message: 'blind members cannot read cluster plans' };
  const rec = await clusterPlanBridge.readClusterPlan(ctx.clusterId);
  if (!rec || rec.body.length === 0) {
    return { ok: false, code: 'no_plan', message: 'no plan is attached to this cluster' };
  }
  const cwd = (await clusterStore.readCluster(ctx.clusterId).catch(() => null))?.cwd;
  const refs = cwd ? await listPlanRefs(cwd, rec.planId).catch(() => []) : [];
  return {
    ok: true,
    title: rec.title,
    body: rec.body,
    updatedAt: rec.updatedAt,
    byteLength: Buffer.byteLength(rec.body, 'utf8'),
    planId: rec.planId,
    revision: clusterPlanStore.planRevision(rec.body),
    refs: refs.map((r) => ({ slug: r.slug, title: r.title, bytes: r.bytes })),
    refsDir: `.arco/plans/${rec.planId}.refs/`,
  };
}

// Peer-tool plan-tick. Toggles a single `- [ ]` / `- [x]` checkbox in the
// attached cluster plan. Matcher is either `{ lineIndex }` (precise 0-based
// line offset) or `{ taskText }` (case-insensitive substring; must match
// exactly one checkbox line). On success persists the new plan body via the
// canonical per-cwd plan store and broadcasts cluster_plan_changed cluster-
// wide so every member's PLAN tab + activity feed re-renders. The broadcast
// uses a cluster-scoped fanout, not a workflow-scoped one — callers must
// supply a `broadcastCluster` helper because clusterPeerOps' usual
// broadcastSender / broadcastRecipient are both workflow-scoped.
export type PeerPlanTickMatcher = { lineIndex: number } | { taskText: string };

export interface PeerPlanTickOk {
  ok: true;
  toggledLine: number;
  before: '[ ]' | '[x]';
  after: '[ ]' | '[x]';
}

export interface PeerPlanTickRejection {
  ok: false;
  code: 'no_plan' | 'out_of_range' | 'not_a_checkbox_line' | 'task_not_found' | 'ambiguous_task' | 'invalid_matcher' | 'write_failed' | 'access_denied' | 'stale_plan';
  message: string;
  matches?: number[];
}

export async function peerPlanTick(
  ctx: PeerOpsContext,
  matcher: PeerPlanTickMatcher,
  broadcastCluster: (msg: ServerMessage) => void,
): Promise<PeerPlanTickOk | PeerPlanTickRejection> {
  if (mailboxOnly(ctx)) return { ok: false, code: 'access_denied', message: 'blind members cannot update cluster plans' };
  let selected: number | { taskText: string };
  if ('lineIndex' in matcher && typeof matcher.lineIndex === 'number') selected = matcher.lineIndex;
  else if ('taskText' in matcher && typeof matcher.taskText === 'string') selected = { taskText: matcher.taskText };
  else return { ok: false, code: 'invalid_matcher', message: 'matcher must be either { lineIndex: number } or { taskText: string }.' };
  let result: clusterPlanBridge.PlanTickResult;
  try {
    result = await clusterPlanBridge.togglePlanItem(ctx.clusterId, selected);
  } catch (err) {
    return {
      ok: false,
      code: 'write_failed',
      message: `togglePlanItem failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!result.ok) return { ok: false, code: result.code, message: result.message, ...(result.matches ? { matches: result.matches } : {}) };
  broadcastCluster({
    type: 'cluster_plan_changed',
    clusterId: ctx.clusterId,
    body: result.body,
    updatedAt: result.updatedAt,
    bodyLength: result.body.length,
  });
  return { ok: true, toggledLine: result.toggledLine, before: result.before, after: result.after };
}

// director-side plan authorship. Model-driven writes can
// author the initial plan or add/restructure non-destructively, but must
// preserve existing checkbox tasks and their status. Operators can still
// replace or clear plans from the PLAN tab; cluster_plan_tick remains the
// narrow path for model-driven status changes.
export interface PeerPlanWriteOk {
  ok: true;
  bodyLength: number;
  updatedAt: number;
}

export interface PeerPlanWriteRejection {
  ok: false;
  code: 'empty_body' | 'too_large' | 'item_too_long' | 'destructive_write_requires_operator' | 'write_failed' | 'access_denied';
  message: string;
  limit?: number;
  actual?: number;
  removed?: string[];
  statusChanged?: Array<{ text: string; before: '[ ]' | '[x]'; after: '[ ]' | '[x]' }>;
}

export async function peerPlanWrite(
  ctx: PeerOpsContext,
  body: string,
  broadcastCluster: (msg: ServerMessage) => void,
): Promise<PeerPlanWriteOk | PeerPlanWriteRejection> {
  if (mailboxOnly(ctx)) return { ok: false, code: 'access_denied', message: 'blind members cannot write cluster plans' };
  const trimmed = typeof body === 'string' ? body : '';
  if (trimmed.trim().length === 0) {
    return {
      ok: false,
      code: 'empty_body',
      message: 'plan body cannot be empty; use cluster_plan_tick for status changes or ask the operator to clear via the PLAN tab.',
    };
  }
  let rec: clusterPlanBridge.ClusterPlanRecord | null;
  class PlanWriteRejected extends Error {
    constructor(readonly rejection: PeerPlanWriteRejection) { super(rejection.message); }
  }
  try {
    rec = await clusterPlanBridge.writeModelPlan(ctx.clusterId, trimmed, existingBody => {
      const preservation = clusterPlanStore.validatePlanWritePreservesCheckboxes(existingBody, trimmed);
      if (!preservation.ok) throw new PlanWriteRejected({
        ok: false, code: 'destructive_write_requires_operator',
        message: 'Preserve existing items and their checked state. Only uniquely numbered items may be shortened; use cluster_plan_tick for status changes.',
        removed: preservation.violation.removed, statusChanged: preservation.violation.statusChanged,
      });
      const oversized = clusterPlanStore.oversizedPlanItems(existingBody, trimmed);
      if (oversized.length) throw new PlanWriteRejected({
        ok: false, code: 'item_too_long', limit: clusterPlanStore.PLAN_ITEM_SUMMARY_MAX,
        message: `Checkbox summary exceeds ${clusterPlanStore.PLAN_ITEM_SUMMARY_MAX} characters: ${oversized[0]}. Put assignment and evidence on the board and durable specifications in linked reference docs.`,
      });
    });
  } catch (err) {
    if (err instanceof PlanWriteRejected) return err.rejection;
    if (err instanceof clusterPlanBridge.PlanTooLargeError) return {
      ok: false, code: 'too_large', message: err.message, limit: err.limit, actual: trimmed.length,
    };
    return { ok: false, code: 'write_failed', message: `writePlan failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!rec) {
    return {
      ok: false,
      code: 'write_failed',
      message: 'writePlan failed: cluster disappeared while writing plan.',
    };
  }
  broadcastCluster({
    type: 'cluster_plan_changed',
    clusterId: ctx.clusterId,
    body: rec.body,
    updatedAt: rec.updatedAt,
    bodyLength: rec.body.length,
  });
  return { ok: true, bodyLength: rec.body.length, updatedAt: rec.updatedAt };
}

// Mid-turn drain — same shape as the pre-turn `drainPeerMailbox` helper in
// seedWorker.ts, but called explicitly by the model via peer_read. Emits a
// peer_message_received event per drained item on the recipient's channel
// so transcripts on both sides reproduce the delivery record.
export async function peerRead(ctx: PeerOpsContext, options?: { onlyFrom: string }): Promise<PeerReadEntry[]> {
  // Mail from a Gemini member is delivered only in a turn the operator
  // started (clusterMailbox.drain, docs/PROTOCOL_CLUSTER.md "Gemini members").
  const drained = await clusterMailbox.drain(ctx.workflowId, { ...(options ?? {}), operatorTurn: isOperatorStartedTurn(ctx.workflowId) });
  if (drained.length === 0) return [];
  const materialized = new Map<string, Array<{ name: string; path: string; byteLength: number }>>();
  for (const m of drained) {
    const artifacts = await clusterMailbox.materializeArtifacts(ctx.workflowId, m).catch(() => []);
    materialized.set(m.msgId, artifacts);
    // stamp the event with the message's original createdAt so
    // the chat row sorts at send-time, not drain-time. Otherwise a mid-turn
    // peer_read leaves the peer row below the assistant text that responded
    // to it (chat sort key is timestamp, ties broken by source-array order
    // which favors sessionChat).
    const ts = Date.parse(m.createdAt);
    ctx.broadcastRecipient(ctx.workflowId, {
      type: 'peer_message_received',
      workflowId: ctx.workflowId,
      msgId: m.msgId,
      from: m.fromWorkflowId,
      fromName: m.fromDisplayName,
      content: artifacts.length > 0
        ? `${m.content}\n\n[Artifacts materialized]\n${artifacts.map((a) => `- ${a.path} (${a.byteLength} bytes)`).join('\n')}`
        : m.content,
      ...(Number.isFinite(ts) ? { ts } : {}),
    });
  }
  const projected: PeerReadEntry[] = [];
  for (const m of drained) {
    const artifacts = materialized.get(m.msgId) ?? [];
    projected.push({
      msgId: m.msgId,
      fromName: m.fromDisplayName,
      content: m.content,
      createdAt: m.createdAt,
      ...(artifacts.length > 0 ? { artifacts } : {}),
    });
  }
  return projected;
}

// ── §D3 task-board peer-ops ───────────────────────────────────────────────
//
// A cluster's task board is a kanban VIEW over the existing cwd-scoped task
// ledger (project/taskLedger.ts). These lifecycle tools let cluster members
// read / show / claim / update / comment / block / complete tasks; the operator
// still owns the LEDGER tab and is the ONLY actor allowed to set terminal
// statuses (the §D1 operator-confirmed terminal-status invariant, re-enforced
// at this peer layer below).
//
// cwd derivation: a cluster has exactly one shared cwd by construction, stored
// on the cluster record. We resolve it from clusterStore.readCluster(clusterId)
// — the same authoritative source the plan-ops use — NOT from the calling
// workflow's config (a member may be unhydrated). Mutations persist through the
// D1 module via the shared persistLedgerMutation helper (load → mutate via
// applyUpdate → save → durable task_ledger_event) and broadcast a fresh
// task_ledger_snapshot CLUSTER-WIDE so every member's board re-renders.

async function clusterCwd(clusterId: string): Promise<string | null> {
  const state = await clusterStore.readCluster(clusterId).catch(() => null);
  return state?.cwd && state.cwd.length > 0 ? state.cwd : null;
}

interface ClusterTaskBoardContext {
  cwd: string;
  boardKey?: string;
}

async function clusterTaskBoardContext(clusterId: string): Promise<ClusterTaskBoardContext | null> {
  const state = await clusterStore.readCluster(clusterId).catch(() => null);
  if (!state?.cwd || state.cwd.length === 0) return null;
  if (!clusterStore.isTaskBoardEnabledForState(state)) return null;
  const boardKey = clusterStore.taskBoardKeyForState(state);
  return { cwd: state.cwd, ...(boardKey ? { boardKey } : {}) };
}

/** This cluster's board with its comments, or null when it has no board. */
export async function loadClusterBoardKernel(clusterId: string): Promise<{ cwd: string; boardKey?: string; tasks: LedgerTask[]; comments: TaskComment[] } | null> {
  const board = await clusterTaskBoardContext(clusterId);
  if (!board) return null;
  const state = await taskLedger.loadKernel(board.cwd, board.boardKey);
  return { ...board, tasks: state.tasks, comments: state.comments };
}

/** Tasks on this cluster's own board, or null when it has no board. */
export async function loadClusterBoardTasks(clusterId: string): Promise<LedgerTask[] | null> {
  const board = await clusterTaskBoardContext(clusterId);
  return board ? taskLedger.load(board.cwd, board.boardKey) : null;
}

function broadcastTaskSnapshot(
  broadcastCluster: (msg: ServerMessage) => void,
  ctx: PeerOpsContext,
  board: ClusterTaskBoardContext,
  tasks: LedgerTask[],
): void {
  broadcastCluster({
    type: 'task_ledger_snapshot',
    workflowId: ctx.workflowId,
    cwd: board.cwd,
    ...(board.boardKey ? { boardKey: board.boardKey } : {}),
    tasks,
  });
}

export interface PeerTaskListOk {
  ok: true;
  cwd: string;
  tasks: LedgerTask[];
}

export interface PeerTaskShowOk {
  ok: true;
  cwd: string;
  details: TaskDetails;
}

// Refs a board task links (title / notes / comments / its originating plan
// item), resolved against the cluster plan and any plan the task links — so a claimed task arrives with
// its spec pointers instead of a bare `ref:slug` the member has to hunt for.
async function withLinkedRefs(ctx: PeerOpsContext, cwd: string, details: TaskDetails): Promise<TaskDetails> {
  const planIds = details.task.links.filter((l) => l.kind === 'plan').map((l) => l.ref);
  const clusterPlan = await clusterPlanBridge.readClusterPlan(ctx.clusterId).catch(() => null);
  if (clusterPlan?.planId) planIds.unshift(clusterPlan.planId);
  const texts = [details.task.title, details.task.notes, ...details.comments.map((c) => c.body)];
  // Plus the refs on the plan item this task came from (its sub-bullets and
  // phase preamble) — see planItemContextFor.
  if (clusterPlan?.body) {
    const itemContext = planItemContextFor(parsePlan(clusterPlan.body), details.task.title);
    if (itemContext) texts.push(itemContext);
  }
  const linked = await resolveLinkedRefs(cwd, planIds, texts).catch(() => []);
  if (linked.length === 0) return details;
  return {
    ...details,
    referenceDocs: {
      instruction: 'This task links plan reference docs. Read each one (plan_ref_read with planId + slug, or open the path) before working the task — they are the spec; the task line is the summary.',
      refs: linked,
    },
  };
}

export interface PeerTaskRejection {
  ok: false;
  code: 'no_cwd' | 'board_detached' | 'not_found' | 'already_claimed' | 'not_owner' | 'operator_gated' | 'invalid_status' | 'invalid_link' | 'empty_title' | 'write_failed' | 'access_denied';
  message: string;
}

const WORKER_TASK_STATUSES = new Set<LedgerTaskStatus>([
  'triage',
  'todo',
  'ready',
  'in_progress',
  'blocked',
  'review',
]);

// Read the cluster cwd's ledger. Pure read — no mutation, no broadcast.
export async function peerTaskList(ctx: PeerOpsContext): Promise<PeerTaskListOk | PeerTaskRejection> {
  if (mailboxOnly(ctx)) return { ok: false, code: 'access_denied', message: 'blind members cannot access the cluster task board' };
  const board = await clusterTaskBoardContext(ctx.clusterId);
  if (!board) {
    return { ok: false, code: 'board_detached', message: 'no task board is enabled for this cluster.' };
  }
  const tasks = await taskLedger.load(board.cwd, board.boardKey);
  return { ok: true, cwd: board.cwd, tasks };
}

export interface PeerTaskClaimOk {
  ok: true;
  task: LedgerTask;
}

export interface PeerTaskCreateOk {
  ok: true;
  task: LedgerTask;
}

export interface PeerTaskHeartbeatOk {
  ok: true;
  run: TaskRun;
  comment?: TaskComment;
}

// Locked + fresh-state append (taskLedgerHandlers.appendLedgerComment). Never
// write back a caller-captured task list — it can be stale by now.
async function appendTaskComment(board: ClusterTaskBoardContext, comment: TaskComment): Promise<void> {
  await appendLedgerComment(board.cwd, comment, board.boardKey);
}

// Durable record that a peer message handed a board task to a member. The
// comment's metadata (kind 'handoff', recipient, message id) is what
// directorContinue.ts reads; the body is for people reading the board.
async function recordHandoff(ctx: PeerOpsContext, board: ClusterTaskBoardContext, taskId: string, toWorkflowId: string, msgId: string): Promise<void> {
  // The handoff belongs to the operator approval current when it was sent, so
  // a later approval (after an edit, or withdraw and approve again) needs a
  // handoff of its own. Read inside the mutation so it sees the stored task.
  let comment: TaskComment | undefined;
  const result = await persistLedgerMutation(ctx.workflowId, board.cwd, 'comment', (tasks) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return null;
    const approvalId = isTaskApprovalCurrent(task) ? task.operatorApproval?.id : undefined;
    comment = taskLedger.newTaskComment({
      taskId,
      body: `Handoff sent to ${clusterStore.displayNameFor(toWorkflowId)} by peer message ${msgId}.`,
      authorWorkflowId: ctx.workflowId,
      authorLabel: clusterStore.displayNameFor(ctx.workflowId),
      metadata: { kind: 'handoff', toWorkflowId, msgId, ...(approvalId ? { approvalId } : {}) },
    });
    return { tasks, id: taskId, payload: { comment } };
  }, { boardKey: board.boardKey });
  if (result && comment) await appendTaskComment(board, comment);
}

function resolveAssignee(clusterId: string, assignee: string | undefined): string | undefined | null {
  if (assignee === undefined) return undefined;
  const trimmed = assignee.trim();
  if (!trimmed) return undefined;
  return clusterStore.resolvePeer(clusterId, trimmed) ?? null;
}

export async function peerTaskShow(
  ctx: PeerOpsContext,
  args: { id: string },
): Promise<PeerTaskShowOk | PeerTaskRejection> {
  if (mailboxOnly(ctx)) return { ok: false, code: 'access_denied', message: 'blind members cannot access the cluster task board' };
  const board = await clusterTaskBoardContext(ctx.clusterId);
  if (!board) {
    return { ok: false, code: 'board_detached', message: 'no task board is enabled for this cluster.' };
  }
  const state = await taskLedger.loadKernel(board.cwd, board.boardKey);
  const details = taskLedger.taskDetails(state, args.id);
  if (!details) {
    return { ok: false, code: 'not_found', message: `task ${args.id.slice(0, 8)} not found in this cluster's ledger.` };
  }
  return { ok: true, cwd: board.cwd, details: await withLinkedRefs(ctx, board.cwd, details) };
}

export async function peerTaskCreate(
  ctx: PeerOpsContext,
  args: {
    title: string;
    body?: string;
    notes?: string;
    assignee?: string;
    priority?: number;
    parentIds?: string[];
    links?: TaskLink[];
    reviewRequired?: boolean;
    goalMode?: boolean;
    goalMaxTurns?: number;
    release?: string;
    status?: LedgerTaskStatus;
  },
  broadcastCluster: (msg: ServerMessage) => void,
): Promise<PeerTaskCreateOk | PeerTaskRejection> {
  if (mailboxOnly(ctx)) return { ok: false, code: 'access_denied', message: 'blind members cannot access the cluster task board' };
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) {
    return { ok: false, code: 'empty_title', message: 'task title is required.' };
  }
  if (args.status === 'done' || args.status === 'archived') {
    return {
      ok: false,
      code: 'operator_gated',
      message: 'new worker-created tasks cannot start in done/archived. The operator owns terminal statuses.',
    };
  }
  if (args.status && args.status !== 'todo') {
    return {
      ok: false,
      code: 'invalid_status',
      message: 'worker-created tasks start as todo; claim or update them after creation.',
    };
  }
  const board = await clusterTaskBoardContext(ctx.clusterId);
  if (!board) {
    return { ok: false, code: 'board_detached', message: 'no task board is enabled for this cluster.' };
  }
  const assignee = resolveAssignee(ctx.clusterId, args.assignee);
  if (assignee === null) {
    return { ok: false, code: 'not_found', message: `assignee ${args.assignee?.slice(0, 64) ?? ''} is not a cluster member.` };
  }
  let rejection: PeerTaskRejection | null = null;
  const result = await persistLedgerMutation(ctx.workflowId, board.cwd, 'create', (tasks) => {
    const parentIds = Array.isArray(args.parentIds)
      ? [...new Set(args.parentIds.map((id) => id.trim()).filter(Boolean))]
      : [];
    const missing = parentIds.filter((id) => !tasks.some((task) => task.id === id));
    if (missing.length > 0) {
      rejection = {
        ok: false,
        code: 'invalid_link',
        message: `parent task not found: ${missing.map((id) => id.slice(0, 8)).join(', ')}.`,
      };
      return null;
    }
    let task = taskLedger.newTask({
      title,
      notes: typeof args.notes === 'string' ? args.notes : args.body,
      links: args.links,
      priority: args.priority,
      parentIds,
      reviewRequired: args.reviewRequired,
      goalMode: args.goalMode,
      goalMaxTurns: args.goalMaxTurns,
      release: args.release,
      createdBy: ctx.workflowId,
    });
    if (assignee) {
      const applied = taskLedger.applyUpdate([task], task.id, { assignee, updatedBy: ctx.workflowId });
      task = applied?.updated ?? task;
    }
    return {
      tasks: [...tasks, task],
      id: task.id,
      task,
      payload: {
        actor: {
          workflowId: ctx.workflowId,
          label: clusterStore.displayNameFor(ctx.workflowId),
        },
      },
    };
  }, { boardKey: board.boardKey });
  if (!result) return rejection ?? { ok: false, code: 'write_failed', message: 'create failed.' };
  broadcastTaskSnapshot(broadcastCluster, ctx, board, result.tasks);
  return { ok: true, task: result.task! };
}

// Claim a task: set assignee = caller's workflowId and move it to in_progress.
// Concurrency guard: if the task is already assigned to a DIFFERENT member, we
// REJECT with `already_claimed` rather than stomping the existing owner.
// Re-claiming a task you already own is idempotent (re-asserts in_progress).
export async function peerTaskClaim(
  ctx: PeerOpsContext,
  args: { id: string },
  broadcastCluster: (msg: ServerMessage) => void,
): Promise<PeerTaskClaimOk | PeerTaskRejection> {
  if (mailboxOnly(ctx)) return { ok: false, code: 'access_denied', message: 'blind members cannot access the cluster task board' };
  const board = await clusterTaskBoardContext(ctx.clusterId);
  if (!board) {
    return { ok: false, code: 'board_detached', message: 'no task board is enabled for this cluster.' };
  }
  // Pre-check the owner under the same lock as the mutation by doing the guard
  // INSIDE the mutate callback — persistLedgerMutation runs it under the per-cwd
  // lock, so two concurrent claims serialize and the second sees the first's
  // assignee. We signal a guarded reject by returning null from mutate and
  // re-checking ownership after.
  let rejection: PeerTaskRejection | null = null;
  const result = await persistLedgerMutation(ctx.workflowId, board.cwd, 'update', (tasks) => {
    const existing = tasks.find((t) => t.id === args.id);
    if (!existing) {
      rejection = { ok: false, code: 'not_found', message: `task ${args.id.slice(0, 8)} not found in this cluster's ledger.` };
      return null;
    }
    if (existing.assignee && existing.assignee !== ctx.workflowId) {
      rejection = {
        ok: false,
        code: 'already_claimed',
        message: `task ${args.id.slice(0, 8)} is already claimed by ${existing.assignee.slice(0, 8)}; coordinate via peer_send before taking it over.`,
      };
      return null;
    }
    const applied = taskLedger.applyUpdate(tasks, args.id, {
      assignee: ctx.workflowId,
      status: 'in_progress',
    });
    if (!applied) {
      rejection = { ok: false, code: 'not_found', message: `task ${args.id.slice(0, 8)} not found in this cluster's ledger.` };
      return null;
    }
    return { tasks: applied.tasks, id: args.id, task: applied.updated };
  }, { boardKey: board.boardKey });
  if (!result) return rejection ?? { ok: false, code: 'write_failed', message: 'claim failed.' };
  broadcastTaskSnapshot(broadcastCluster, ctx, board, result.tasks);
  return { ok: true, task: result.task! };
}

export interface PeerTaskUpdateOk {
  ok: true;
  task: LedgerTask;
}

export interface PeerTaskCommentOk {
  ok: true;
  comment: TaskComment;
}

function taskDependsOn(tasks: LedgerTask[], fromId: string, targetId: string, seen = new Set<string>()): boolean {
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  const task = tasks.find((t) => t.id === fromId);
  if (!task) return false;
  if (task.parentIds.includes(targetId)) return true;
  return task.parentIds.some((parentId) => taskDependsOn(tasks, parentId, targetId, seen));
}

// Workers may set non-terminal statuses. Direct done / archived requests are
// rejected; a director met sign-off may close the task when auto-done is on.
const SIGNOFF_STATES: ReadonlySet<TaskSignoffState> = new Set(['met', 'not_met', 'partial']);

export async function peerTaskUpdate(
  ctx: PeerOpsContext,
  args: {
    id: string;
    status?: LedgerTaskStatus;
    notes?: string;
    // Release label such as "0.1.4"; an empty string clears it.
    release?: string;
    // The director verdict. The model passes `{ state, summary }`;
    // the server stamps `byWorkflowId`/`at` so it's attributable and unspoofable.
    // `null` explicitly clears a prior sign-off (back to PENDING).
    signoff?: { state?: string; summary?: string } | null;
    completePlan?: { planId: string; itemId: string; revision: string };
    finishPending?: string;
    pendingPlan?: NonNullable<TaskSignoff['planCompletion']>;
    expectedStatus?: LedgerTaskStatus;
    expectedTaskLink?: { title: string; links: TaskLink[] };
  },
  broadcastCluster: (msg: ServerMessage) => void,
): Promise<PeerTaskUpdateOk | PeerTaskRejection> {
  if (mailboxOnly(ctx)) return { ok: false, code: 'access_denied', message: 'blind members cannot access the cluster task board' };
  if (args.status === 'done' || args.status === 'archived') {
    return {
      ok: false,
      code: 'operator_gated',
      message: 'done/archived can only be set by the operator from the LEDGER tab. Move the task to review, set blocked, or report completion via peer_send to the director.',
    };
  }
  // Stamp the sign-off at the peer boundary so its author cannot be spoofed.
  let signoffPatch: TaskSignoff | null | undefined;
  if (args.signoff === null) {
    signoffPatch = null;
  } else if (args.signoff && typeof args.signoff === 'object') {
    const state = args.signoff.state;
    if (typeof state !== 'string' || !SIGNOFF_STATES.has(state as TaskSignoffState)) {
      return {
        ok: false,
        code: 'invalid_status',
        message: `invalid signoff.state "${state}". Use met, not_met, or partial.`,
      };
    }
    signoffPatch = {
      state: state as TaskSignoffState,
      ...(typeof args.signoff.summary === 'string' && args.signoff.summary.trim().length > 0
        ? { summary: args.signoff.summary.trim() }
        : {}),
      byWorkflowId: ctx.workflowId,
      at: Date.now(),
    };
  }
  if (args.pendingPlan && signoffPatch) signoffPatch.planCompletion = args.pendingPlan;
  if (args.status && !WORKER_TASK_STATUSES.has(args.status)) {
    return {
      ok: false,
      code: 'invalid_status',
      message: `invalid task status "${args.status}". Use triage, todo, ready, in_progress, blocked, or review.`,
    };
  }
  const board = await clusterTaskBoardContext(ctx.clusterId);
  if (!board) {
    return { ok: false, code: 'board_detached', message: 'no task board is enabled for this cluster.' };
  }
  const director = isClusterDirector(clusterStore.getMemberRole(ctx.clusterId, ctx.workflowId));
  if (args.completePlan !== undefined) return withFileLock(`cluster-plan-signoff:${ctx.clusterId}:${args.id}`, async () => {
    if (!args.completePlan || typeof args.completePlan !== 'object') return { ok: false, code: 'invalid_link', message: 'Provide the plan ID, numbered item ID and reviewed revision from cluster_plan_read.' };
    if (!director || signoffPatch?.state !== 'met') return { ok: false, code: 'operator_gated', message: 'Only a Director met sign-off can complete a plan item.' };
    const { planId, itemId, revision } = args.completePlan;
    if (typeof planId !== 'string' || typeof itemId !== 'string' || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) || !clusterPlanStore.planItemId(itemId) || clusterPlanStore.planItemId(itemId) !== itemId.toLowerCase()) {
      return { ok: false, code: 'invalid_link', message: 'Provide the plan ID, numbered item ID and reviewed revision from cluster_plan_read.' };
    }
    const tasks = await taskLedger.load(board.cwd, board.boardKey);
    const task = tasks.find(t => t.id === args.id);
    if (!task) return { ok: false, code: 'not_found', message: 'The board task no longer exists.' };
    if (task.status === 'archived') return { ok: false, code: 'operator_gated', message: 'Archived tasks cannot complete plan items. Reopen the task first.' };
    const plan = await clusterPlanBridge.readClusterPlan(ctx.clusterId);
    const links = task.links.filter(link => link.kind === 'plan');
    const linkedPlans = links.map(link => link.ref);
    const linkedItemIds = links.map(link => link.label && clusterPlanStore.planItemId(link.label)).filter((id): id is string => Boolean(id));
    const titleId = clusterPlanStore.planItemId(task.title);
    const resolvedId = linkedItemIds.length ? (new Set(linkedItemIds).size === 1 ? linkedItemIds[0] : undefined) : titleId;
    if (!plan || plan.planId !== planId || (linkedPlans.length > 0 && (new Set(linkedPlans).size !== 1 || linkedPlans[0] !== planId)) || resolvedId !== itemId.toLowerCase()) {
      return { ok: false, code: 'invalid_link', message: 'The task and the currently attached plan must identify the same numbered item. Read them again.' };
    }
    const matches = clusterPlanStore.extractPlanCheckboxItems(plan.body).filter(item => clusterPlanStore.planItemId(item.text) === itemId.toLowerCase());
    if (matches.length !== 1) return { ok: false, code: 'invalid_link', message: 'The numbered item must identify exactly one checkbox.' };
    const currentRevision = clusterPlanStore.planRevision(plan.body);
    const receipt = task.signoff?.planCompletion;
    const sameReceipt = receipt && receipt.planId === planId && receipt.itemId.toLowerCase() === itemId.toLowerCase() && receipt.revision === revision;
    if (task.signoff?.state === 'partial' && task.signoff.summary?.startsWith('Plan completion pending for ') && !sameReceipt) {
      return { ok: false, code: 'invalid_link', message: 'The pending completion belongs to another reviewed plan item or revision. Resolve it before signing off.' };
    }
    const alreadyApplied = sameReceipt && task.signoff?.state === 'met' && currentRevision === receipt.completedRevision && matches[0].checked;
    if (alreadyApplied && (task.status === 'done' || (task.status === 'review' && (await readSettings()).autoMarkDoneOnMetSignoff === false))) return { ok: true, task };
    if (task.status === 'done' && task.signoff?.state === 'met' && currentRevision === revision && matches[0].checked) return { ok: true, task };
    const recoveringCompleted = sameReceipt && task.signoff?.state === 'partial' && currentRevision === receipt.completedRevision && matches[0].checked;
    if (currentRevision !== revision && !recoveringCompleted && !alreadyApplied) return { ok: false, code: 'invalid_link', message: 'The plan changed since review. If completion is pending, replace that partial sign-off first; then read and review the plan again.' };
    const completion = sameReceipt && (task.signoff?.state === 'partial' || alreadyApplied) ? receipt : {
      planId, itemId, revision,
      completedRevision: clusterPlanStore.planRevision(clusterPlanStore.checkedPlanBody(plan.body, matches[0].lineIndex)),
    };
    // A visible partial sign-off is a durable recovery marker. If the process
    // stops between the two stores, retrying the same action finishes it.
    const pendingSummary = `Plan completion pending for ${itemId}; retry the met sign-off.`;
    const pending = await peerTaskUpdate(ctx, {
      id: args.id, ...(task.status === 'done' ? {} : { status: 'review' as const }), expectedStatus: task.status, expectedTaskLink: { title: task.title, links: task.links }, pendingPlan: completion,
      signoff: { state: 'partial', summary: pendingSummary },
    }, broadcastCluster);
    if (!pending.ok) return pending;
    let completed: clusterPlanBridge.PlanTickResult;
    try { completed = await clusterPlanBridge.completePlanItem(ctx.clusterId, planId, itemId, { text: matches[0].text, checked: matches[0].checked, revision: currentRevision }); }
    catch (err) { return { ok: false, code: 'write_failed', message: `Plan completion pending; retry the same met sign-off: ${err instanceof Error ? err.message : String(err)}` }; }
    if (!completed.ok) return { ok: false, code: 'invalid_link', message: `Plan completion pending; ${completed.message} Read the board and plan. If changed, replace the pending partial sign-off and review again; otherwise retry using its saved identity and revision.` };
    broadcastCluster({ type: 'cluster_plan_changed', clusterId: ctx.clusterId, body: completed.body, updatedAt: completed.updatedAt, bodyLength: completed.body.length });
    try {
      const signed = await peerTaskUpdate(ctx, { id: args.id, ...(task.status !== 'done' && args.status ? { status: args.status } : {}), expectedStatus: task.status === 'done' ? 'done' : 'review', pendingPlan: completion, ...(args.notes !== undefined ? { notes: args.notes } : {}), ...(args.release !== undefined ? { release: args.release } : {}), signoff: args.signoff, finishPending: pendingSummary, expectedTaskLink: { title: task.title, links: task.links } }, broadcastCluster);
      if (!signed.ok) return { ok: false, code: 'write_failed', message: `Plan item completed but board sign-off remains pending. Retry the same met sign-off: ${signed.message}` };
      return signed;
    } catch (err) {
      return { ok: false, code: 'write_failed', message: `Plan item completed but board sign-off remains pending. Retry the same met sign-off: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
  const autoMarkDone = director && signoffPatch?.state === 'met' && (await readSettings()).autoMarkDoneOnMetSignoff !== false;
  let rejection: PeerTaskRejection | null = null;
  const result = await persistLedgerMutation(ctx.workflowId, board.cwd, 'update', (tasks) => {
    const previous = tasks.find((task) => task.id === args.id);
    if (previous && args.expectedStatus && previous.status !== args.expectedStatus) {
      rejection = { ok: false, code: 'invalid_status', message: 'The task status changed. Read the board before retrying.' };
      return null;
    }
    if (previous && args.expectedTaskLink && (previous.title !== args.expectedTaskLink.title || JSON.stringify(previous.links) !== JSON.stringify(args.expectedTaskLink.links))) {
      rejection = { ok: false, code: 'invalid_link', message: 'The task link changed. Read the board and plan before retrying.' };
      return null;
    }
    const previousPending = previous?.signoff?.state === 'partial' && previous.signoff.summary?.startsWith('Plan completion pending for ');
    if (args.finishPending && (!previousPending || previous?.signoff?.summary !== args.finishPending)) {
      rejection = { ok: false, code: 'write_failed', message: 'The pending board sign-off changed; read the board and plan before retrying.' };
      return null;
    }
    if (previousPending && signoffPatch?.state === 'met' && !args.finishPending) {
      rejection = { ok: false, code: 'invalid_link', message: 'Plan completion is pending. Read the plan and retry the met sign-off with completePlan.' };
      return null;
    }
    const close = director && autoMarkDone && signoffPatch?.state === 'met' && previous?.status !== 'done' && previous?.status !== 'archived';
    const applied = taskLedger.applyUpdate(tasks, args.id, {
      ...(close ? { directorClosure: { byWorkflowId: ctx.workflowId, at: signoffPatch!.at } } : {}),
      ...(close ? { status: 'done' as const } : args.status ? { status: args.status } : {}),
      ...(typeof args.notes === 'string' ? { notes: args.notes } : {}),
      ...(typeof args.release === 'string' ? { release: args.release } : {}),
      ...(signoffPatch !== undefined ? { signoff: signoffPatch } : {}),
    });
    if (!applied) {
      rejection = { ok: false, code: 'not_found', message: `task ${args.id.slice(0, 8)} not found in this cluster's ledger.` };
      return null;
    }
    return { tasks: applied.tasks, id: args.id, task: applied.updated };
  }, { boardKey: board.boardKey });
  if (!result) return rejection ?? { ok: false, code: 'write_failed', message: 'update failed.' };
  broadcastTaskSnapshot(broadcastCluster, ctx, board, result.tasks);
  return { ok: true, task: result.task! };
}

export async function peerTaskComment(
  ctx: PeerOpsContext,
  args: { id: string; body: string; metadata?: Record<string, unknown> },
  broadcastCluster: (msg: ServerMessage) => void,
): Promise<PeerTaskCommentOk | PeerTaskRejection> {
  if (mailboxOnly(ctx)) return { ok: false, code: 'access_denied', message: 'blind members cannot access the cluster task board' };
  const board = await clusterTaskBoardContext(ctx.clusterId);
  if (!board) {
    return { ok: false, code: 'board_detached', message: 'no task board is enabled for this cluster.' };
  }
  const body = args.body.trim();
  if (!body) {
    return { ok: false, code: 'write_failed', message: 'comment body is required.' };
  }
  const comment = taskLedger.newTaskComment({
    taskId: args.id,
    body,
    authorWorkflowId: ctx.workflowId,
    authorLabel: clusterStore.displayNameFor(ctx.workflowId),
    metadata: args.metadata,
  });
  let rejection: PeerTaskRejection | null = null;
  const result = await persistLedgerMutation(ctx.workflowId, board.cwd, 'comment', (tasks) => {
    const existing = tasks.find((t) => t.id === args.id);
    if (!existing) {
      rejection = { ok: false, code: 'not_found', message: `task ${args.id.slice(0, 8)} not found in this cluster's ledger.` };
      return null;
    }
    return { tasks, id: args.id, payload: { comment } };
  }, { boardKey: board.boardKey });
  if (!result) return rejection ?? { ok: false, code: 'write_failed', message: 'comment failed.' };
  await appendTaskComment(board, comment);
  broadcastTaskSnapshot(broadcastCluster, ctx, board, result.tasks);
  return { ok: true, comment };
}

export async function peerTaskHeartbeat(
  ctx: PeerOpsContext,
  args: { id: string; note?: string },
  broadcastCluster: (msg: ServerMessage) => void,
): Promise<PeerTaskHeartbeatOk | PeerTaskRejection> {
  if (mailboxOnly(ctx)) return { ok: false, code: 'access_denied', message: 'blind members cannot access the cluster task board' };
  const board = await clusterTaskBoardContext(ctx.clusterId);
  if (!board) {
    return { ok: false, code: 'board_detached', message: 'no task board is enabled for this cluster.' };
  }
  const note = typeof args.note === 'string' ? args.note.trim() : '';
  let rejection: PeerTaskRejection | null = null;
  let outRun: TaskRun | null = null;
  let outComment: TaskComment | undefined;
  const result = await persistLedgerKernelMutation(ctx.workflowId, board.cwd, 'heartbeat', (state) => {
    const existing = state.tasks.find((t) => t.id === args.id);
    if (!existing) {
      rejection = { ok: false, code: 'not_found', message: `task ${args.id.slice(0, 8)} not found in this cluster's ledger.` };
      return null;
    }
    const comment = note
      ? taskLedger.newTaskComment({
        taskId: args.id,
        body: `HEARTBEAT: ${note}`,
        authorWorkflowId: ctx.workflowId,
        authorLabel: clusterStore.displayNameFor(ctx.workflowId),
        metadata: { kind: 'heartbeat', note },
      })
      : undefined;
    const heartbeat = taskLedger.heartbeatRun(state.runs, {
      taskId: args.id,
      workflowId: ctx.workflowId,
      clusterId: ctx.clusterId,
      workerId: clusterStore.displayNameFor(ctx.workflowId),
      note,
    });
    outRun = heartbeat.run;
    outComment = comment;
    return {
      state: {
        tasks: state.tasks,
        comments: comment ? [...state.comments, comment] : state.comments,
        runs: heartbeat.runs,
      },
      id: args.id,
      payload: {
        run: heartbeat.run,
        ...(comment ? { comment } : {}),
        actor: {
          workflowId: ctx.workflowId,
          label: clusterStore.displayNameFor(ctx.workflowId),
        },
      },
    };
  }, { boardKey: board.boardKey });
  if (!result || !outRun) return rejection ?? { ok: false, code: 'write_failed', message: 'heartbeat failed.' };
  broadcastTaskSnapshot(broadcastCluster, ctx, board, result.state.tasks);
  return { ok: true, run: outRun, ...(outComment ? { comment: outComment } : {}) };
}

export async function peerTaskLink(
  ctx: PeerOpsContext,
  args: { parentId: string; childId: string },
  broadcastCluster: (msg: ServerMessage) => void,
): Promise<PeerTaskUpdateOk | PeerTaskRejection> {
  if (mailboxOnly(ctx)) return { ok: false, code: 'access_denied', message: 'blind members cannot access the cluster task board' };
  if (!args.parentId || !args.childId) {
    return { ok: false, code: 'invalid_link', message: 'parentId and childId are required.' };
  }
  if (args.parentId === args.childId) {
    return { ok: false, code: 'invalid_link', message: 'a task cannot depend on itself.' };
  }
  const board = await clusterTaskBoardContext(ctx.clusterId);
  if (!board) {
    return { ok: false, code: 'board_detached', message: 'no task board is enabled for this cluster.' };
  }
  let rejection: PeerTaskRejection | null = null;
  const result = await persistLedgerMutation(ctx.workflowId, board.cwd, 'link', (tasks) => {
    const parent = tasks.find((t) => t.id === args.parentId);
    const child = tasks.find((t) => t.id === args.childId);
    if (!parent || !child) {
      rejection = { ok: false, code: 'not_found', message: 'parent or child task not found in this cluster ledger.' };
      return null;
    }
    if (taskDependsOn(tasks, args.parentId, args.childId)) {
      rejection = { ok: false, code: 'invalid_link', message: 'link would create a dependency cycle.' };
      return null;
    }
    const parentIds = child.parentIds.includes(args.parentId)
      ? child.parentIds
      : [...child.parentIds, args.parentId];
    const applied = taskLedger.applyUpdate(tasks, args.childId, {
      parentIds,
      updatedBy: ctx.workflowId,
    });
    if (!applied) {
      rejection = { ok: false, code: 'not_found', message: `task ${args.childId.slice(0, 8)} not found in this cluster's ledger.` };
      return null;
    }
    return {
      tasks: applied.tasks,
      id: args.childId,
      task: applied.updated,
      payload: { parentId: args.parentId, childId: args.childId },
    };
  }, { boardKey: board.boardKey });
  if (!result) return rejection ?? { ok: false, code: 'write_failed', message: 'link failed.' };
  broadcastTaskSnapshot(broadcastCluster, ctx, board, result.tasks);
  return { ok: true, task: result.task! };
}

export async function peerTaskUnlink(
  ctx: PeerOpsContext,
  args: { parentId: string; childId: string },
  broadcastCluster: (msg: ServerMessage) => void,
): Promise<PeerTaskUpdateOk | PeerTaskRejection> {
  if (mailboxOnly(ctx)) return { ok: false, code: 'access_denied', message: 'blind members cannot access the cluster task board' };
  if (!args.parentId || !args.childId) {
    return { ok: false, code: 'invalid_link', message: 'parentId and childId are required.' };
  }
  const board = await clusterTaskBoardContext(ctx.clusterId);
  if (!board) {
    return { ok: false, code: 'board_detached', message: 'no task board is enabled for this cluster.' };
  }
  let rejection: PeerTaskRejection | null = null;
  const result = await persistLedgerMutation(ctx.workflowId, board.cwd, 'unlink', (tasks) => {
    const child = tasks.find((t) => t.id === args.childId);
    if (!child || !tasks.some((t) => t.id === args.parentId)) {
      rejection = { ok: false, code: 'not_found', message: 'parent or child task not found in this cluster ledger.' };
      return null;
    }
    const applied = taskLedger.applyUpdate(tasks, args.childId, {
      parentIds: child.parentIds.filter((id) => id !== args.parentId),
      updatedBy: ctx.workflowId,
    });
    if (!applied) {
      rejection = { ok: false, code: 'not_found', message: `task ${args.childId.slice(0, 8)} not found in this cluster's ledger.` };
      return null;
    }
    return {
      tasks: applied.tasks,
      id: args.childId,
      task: applied.updated,
      payload: { parentId: args.parentId, childId: args.childId },
    };
  }, { boardKey: board.boardKey });
  if (!result) return rejection ?? { ok: false, code: 'write_failed', message: 'unlink failed.' };
  broadcastTaskSnapshot(broadcastCluster, ctx, board, result.tasks);
  return { ok: true, task: result.task! };
}

export async function peerTaskBlock(
  ctx: PeerOpsContext,
  args: { id: string; reason: string; metadata?: Record<string, unknown> },
  broadcastCluster: (msg: ServerMessage) => void,
): Promise<PeerTaskUpdateOk | PeerTaskRejection> {
  if (mailboxOnly(ctx)) return { ok: false, code: 'access_denied', message: 'blind members cannot access the cluster task board' };
  const reason = args.reason.trim();
  if (!reason) {
    return { ok: false, code: 'write_failed', message: 'block reason is required.' };
  }
  const board = await clusterTaskBoardContext(ctx.clusterId);
  if (!board) {
    return { ok: false, code: 'board_detached', message: 'no task board is enabled for this cluster.' };
  }
  const comment = taskLedger.newTaskComment({
    taskId: args.id,
    body: `BLOCKED: ${reason}`,
    authorWorkflowId: ctx.workflowId,
    authorLabel: clusterStore.displayNameFor(ctx.workflowId),
    metadata: { kind: 'block', reason, ...(args.metadata ?? {}) },
  });
  let rejection: PeerTaskRejection | null = null;
  const result = await persistLedgerMutation(ctx.workflowId, board.cwd, 'update', (tasks) => {
    const applied = taskLedger.applyUpdate(tasks, args.id, {
      status: 'blocked',
      blockedReason: reason,
      updatedBy: ctx.workflowId,
    });
    if (!applied) {
      rejection = { ok: false, code: 'not_found', message: `task ${args.id.slice(0, 8)} not found in this cluster's ledger.` };
      return null;
    }
    return { tasks: applied.tasks, id: args.id, task: applied.updated, payload: { comment } };
  }, { boardKey: board.boardKey });
  if (!result) return rejection ?? { ok: false, code: 'write_failed', message: 'block failed.' };
  await appendTaskComment(board, comment);
  broadcastTaskSnapshot(broadcastCluster, ctx, board, result.tasks);
  return { ok: true, task: result.task! };
}

export async function peerTaskComplete(
  ctx: PeerOpsContext,
  args: { id: string; summary: string; metadata?: Record<string, unknown> },
  broadcastCluster: (msg: ServerMessage) => void,
): Promise<PeerTaskUpdateOk | PeerTaskRejection> {
  if (mailboxOnly(ctx)) return { ok: false, code: 'access_denied', message: 'blind members cannot access the cluster task board' };
  const summary = args.summary.trim();
  if (!summary) {
    return { ok: false, code: 'write_failed', message: 'completion summary is required.' };
  }
  const board = await clusterTaskBoardContext(ctx.clusterId);
  if (!board) {
    return { ok: false, code: 'board_detached', message: 'no task board is enabled for this cluster.' };
  }
  const comment = taskLedger.newTaskComment({
    taskId: args.id,
    body: `COMPLETION REPORT:\n${summary}`,
    authorWorkflowId: ctx.workflowId,
    authorLabel: clusterStore.displayNameFor(ctx.workflowId),
    metadata: { kind: 'completion', summary, ...(args.metadata ?? {}) },
  });
  // H48 — hallucinated-id + ownership guards, checked INSIDE the mutate callback
  // so they run under the per-cwd lock (a concurrent claim can't slip an owner
  // change past the check). A worker can only complete a task it owns: this
  // stops a member fabricating/guessing an id, and stops it marking another
  // member's in-progress work as done-pending-review. Mirrors peerTaskClaim's
  // in-lock owner pre-check; null from mutate signals a guarded reject.
  let rejection: PeerTaskRejection | null = null;
  const result = await persistLedgerMutation(ctx.workflowId, board.cwd, 'update', (tasks) => {
    const existing = tasks.find((t) => t.id === args.id);
    if (!existing) {
      // Hallucinated-id gate — an id not in this cluster's ledger.
      rejection = { ok: false, code: 'not_found', message: `task ${args.id.slice(0, 8)} not found in this cluster's ledger.` };
      return null;
    }
    if (existing.assignee !== ctx.workflowId) {
      // Ownership guard — you can only complete a task assigned to you.
      rejection = existing.assignee
        ? { ok: false, code: 'not_owner', message: `task ${args.id.slice(0, 8)} is owned by ${existing.assignee.slice(0, 8)}, not you; coordinate via peer_send instead of completing their work.` }
        : { ok: false, code: 'not_owner', message: `task ${args.id.slice(0, 8)} is unassigned; claim it with cluster_task_claim before completing it.` };
      return null;
    }
    const applied = taskLedger.applyUpdate(tasks, args.id, {
      status: 'review',
      blockedReason: '',
      updatedBy: ctx.workflowId,
    });
    if (!applied) {
      rejection = { ok: false, code: 'not_found', message: `task ${args.id.slice(0, 8)} not found in this cluster's ledger.` };
      return null;
    }
    return { tasks: applied.tasks, id: args.id, task: applied.updated, payload: { comment } };
  }, { boardKey: board.boardKey });
  if (!result) return rejection ?? { ok: false, code: 'write_failed', message: 'complete failed.' };
  await appendTaskComment(board, comment);
  broadcastTaskSnapshot(broadcastCluster, ctx, board, result.tasks);
  return { ok: true, task: result.task! };
}

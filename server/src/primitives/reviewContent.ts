// Transcript-slicing + git-diff collection for the Review primitive.
// Extracted from handleReviewRequest so the scope logic is testable in
// isolation and the server handler can stay readable.

import { exec } from 'child_process';
import { promises as fsPromises } from 'fs';
import path from 'path';
import type { ServerMessage, ReviewContextRef, PlanReviewMode } from '@arco/shared';
import { readPlan } from '../planStore.js';
import { renderLinkedRefsForReview } from '../planRefContext.js';
import { artifactsDir } from '../workers/limits.js';

// A completed operator-agent exchange. `isHandoffSeed` flags the seed
// prompt Arco injects after a Handoff primitive — the "current session"
// scope uses this to find the most recent session boundary.
interface Turn {
  prompt: string;
  reply: string;
  isHandoffSeed: boolean;
  // Seq of the primary_complete that closed this turn — used by since-event
  // scope to keep turns whose tail lands at/after the anchor, even when the
  // operator's anchor falls mid-turn (e.g. on a tool_use row).
  completeSeq: number;
  // Phase 2.5c — cluster peer-message rows. `peerReceivedBefore` lists peer
  // messages that drained into this member's mailbox between the previous
  // primary_complete and this turn's user_message_echo (i.e. context the
  // worker saw injected as a system block at turn start). `peerSentDuring`
  // lists peer_message_sent events the worker emitted during this turn's
  // tool dispatches. Empty arrays for non-cluster workflows.
  peerReceivedBefore: Array<{ fromName: string; content: string }>;
  peerSentDuring: Array<{ toName: string; content: string }>;
}

// Same prefix HandoffSeedPill checks on the client. Coupled to the seed
// string at server/src/index.ts handleHandoffRequest. If that string
// changes, "current session" scope silently degrades to "full".
const HANDOFF_SEED_PREFIX = '[HANDOFF — new session initialized for this tab.';

// Walk an events.jsonl replay, emitting one Turn per completed turn.
// Incomplete turns (no primary_complete yet, e.g. a live in-flight reply)
// are skipped — reviewers should only see settled work.
//
// Phase 2.5c — cluster peer-message rows are folded into the turn they
// belong to. `peer_message_received` events fire BEFORE `user_message_echo`
// at turn start (drain happens in handleUserMessage before the echo), so
// they're collected in a running buffer and attached to the next echoed
// turn. `peer_message_sent` events fire during the model's response
// (when the agent calls peer_send), so they're collected inside the j-loop
// alongside `primary_text`.
function extractTurns(events: ServerMessage[]): Turn[] {
  const turns: Turn[] = [];
  // Running buffer of peer_message_received events seen since the last
  // user_message_echo. Attached to the next echoed turn.
  let pendingPeerReceived: Array<{ fromName: string; content: string }> = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'peer_message_received') {
      pendingPeerReceived.push({
        fromName: (e as { fromName?: string }).fromName ?? (e as { from?: string }).from?.slice(0, 8) ?? 'peer',
        content: (e as { content?: string }).content ?? '',
      });
      continue;
    }
    if (e.type !== 'user_message_echo') continue;
    let reply = '';
    let sawComplete = false;
    let completeSeq = 0;
    const peerSentDuring: Array<{ toName: string; content: string }> = [];
    for (let j = i + 1; j < events.length; j++) {
      const e2 = events[j];
      if (e2.type === 'user_message_echo') break;
      if (e2.type === 'primary_text' && e2.phase === 'passthrough') reply += e2.text;
      if (e2.type === 'peer_message_sent') {
        peerSentDuring.push({
          toName: (e2 as { to?: string }).to?.slice(0, 8) ?? 'peer',
          content: (e2 as { contentPreview?: string }).contentPreview ?? '',
        });
      }
      if (e2.type === 'primary_complete') {
        sawComplete = true;
        completeSeq = (e2 as { seq?: number }).seq ?? 0;
        break;
      }
    }
    if (!sawComplete || !reply.trim()) {
      pendingPeerReceived = [];
      continue;
    }
    turns.push({
      prompt: e.content,
      reply,
      isHandoffSeed: e.content.startsWith(HANDOFF_SEED_PREFIX),
      completeSeq,
      peerReceivedBefore: pendingPeerReceived,
      peerSentDuring,
    });
    pendingPeerReceived = [];
  }
  return turns;
}

function sliceTurns(turns: Turn[], ref: ReviewContextRef): Turn[] {
  switch (ref.kind) {
    case 'last-turn':
      return turns.slice(-1);
    case 'last-n':
      return turns.slice(-Math.max(1, Math.floor(ref.n)));
    case 'current-session': {
      // Find the most recent handoff seed; everything after it is the
      // current session. If no handoff seed exists, the whole transcript
      // IS the current session.
      let lastHandoffIdx = -1;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].isHandoffSeed) { lastHandoffIdx = i; break; }
      }
      return lastHandoffIdx >= 0 ? turns.slice(lastHandoffIdx + 1) : turns;
    }
    case 'full':
      return turns;
    case 'git-diff':
      // Transcript-less scope — caller appends the diff instead.
      return [];
    case 'plan-whole':
    case 'plan-phase':
    case 'plan-items':
    case 'cluster-plan-whole':
    case 'cluster-plan-phase':
      // Plan-scoped refs (worker plan + cluster plan) are dispatched to
      // buildPlanReviewContent / buildClusterPlanReviewContent before this
      // function is reached. They never produce a transcript slice.
      return [];
    case 'since-event':
      // since-event is dispatched via a dedicated branch in buildReviewContent
      // that filters by seq before extracting turns. Defensive empty here so
      // the switch is exhaustive.
      return [];
    case 'preview-capture':
      // preview-capture is dispatched in handleReviewRequest before this
      // function is reached (it reads a report artifact, not the transcript).
      // Defensive empty so the switch stays exhaustive.
      return [];
  }
}

function formatTurns(turns: Turn[]): string {
  if (turns.length === 0) return '_No completed turns in this scope._';
  return turns
    .map((t, i) => {
      const blocks: string[] = [`### Turn ${i + 1}${t.isHandoffSeed ? ' (handoff seed)' : ''}`, ''];
      // Phase 2.5c — peer messages drained into this member's mailbox before
      // the operator's turn (injected as a system block at turn start).
      if (t.peerReceivedBefore.length > 0) {
        for (const p of t.peerReceivedBefore) {
          blocks.push(`**[PEER ← ${p.fromName}]**`, '```', p.content, '```', '');
        }
      }
      blocks.push('**Operator:**', '```', t.prompt, '```', '', '**Primary agent:**', '```', t.reply, '```');
      // Phase 2.5c — peer messages this member sent during the turn.
      if (t.peerSentDuring.length > 0) {
        for (const p of t.peerSentDuring) {
          blocks.push('', `**[PEER → ${p.toName}]**`, '```', p.content, '```');
        }
      }
      return blocks.join('\n');
    })
    .join('\n\n');
}

// Human-readable label embedded in the reviewer framing so the reviewer
// knows what it's evaluating. Counts are included where they matter —
// "last N turns" is ambiguous without the actual N if the transcript is
// shorter than requested.
export function contextLabel(ref: ReviewContextRef, turnCount: number, includeGitDiff: boolean): string {
  let base: string;
  switch (ref.kind) {
    case 'last-turn':
      base = 'last turn';
      break;
    case 'last-n':
      base = turnCount === ref.n ? `last ${ref.n} turns` : `last ${turnCount} turns (requested ${ref.n})`;
      break;
    case 'current-session':
      base = `current session (${turnCount} ${turnCount === 1 ? 'turn' : 'turns'})`;
      break;
    case 'full':
      base = `full transcript (${turnCount} ${turnCount === 1 ? 'turn' : 'turns'})`;
      break;
    case 'git-diff':
      base = 'git diff (working tree vs HEAD)';
      break;
    // Plan-scoped review labels are computed by buildPlanReviewContent
    // (it has the resolved item count + heading text); these branches just
    // exist so the switch is exhaustive when callers reuse contextLabel.
    case 'plan-whole':
      base = `whole plan (${ref.mode})`;
      break;
    case 'plan-phase':
      base = `plan phase: ${ref.heading} (${ref.mode})`;
      break;
    case 'plan-items':
      base = `${ref.itemIds.length} plan ${ref.itemIds.length === 1 ? 'item' : 'items'} (${ref.mode})`;
      break;
    case 'cluster-plan-whole':
      base = `cluster plan (${ref.mode})`;
      break;
    case 'cluster-plan-phase':
      base = `cluster plan phase: ${ref.heading} (${ref.mode})`;
      break;
    case 'since-event':
      base = `from event seq ${ref.anchorEventSeq} (${turnCount} ${turnCount === 1 ? 'turn' : 'turns'})`;
      break;
    case 'preview-capture':
      // Label computed by handleReviewRequest (it has the report basename);
      // this branch exists for exhaustiveness when callers reuse contextLabel.
      base = `preview capture (${ref.reportName})`;
      break;
  }
  if (includeGitDiff && ref.kind !== 'git-diff') base += ' + git diff';
  return base;
}

// Run `git diff HEAD` in the workflow cwd and return the stdout. Cap at
// 10MB — a diff bigger than that is almost certainly noise or a lockfile
// churn and would blow the reviewer's context window anyway.
async function collectGitDiff(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    exec('git diff HEAD', { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Not a git repo, or git not installed. Surface the stderr briefly
        // so the reviewer knows the diff block is empty by accident, not
        // because there's nothing to review.
        resolve(`_(git diff unavailable: ${(stderr || err.message).trim().slice(0, 200)})_`);
        return;
      }
      resolve(stdout.trim() || '_(no uncommitted changes)_');
    });
  });
}

export interface BuiltReviewContent {
  turnCount: number;
  content: string;
  label: string;
  // If non-null, the caller should reject the request with this message
  // (e.g. "Primary agent has not replied to the last prompt yet").
  rejectReason: string | null;
}

export async function buildReviewContent(
  events: ServerMessage[],
  cwd: string,
  ref: ReviewContextRef,
  includeGitDiff: boolean,
): Promise<BuiltReviewContent> {
  // Phase 8 — since-event scope. Filter the event stream by seq before
  // extracting turns so the reviewer only sees the slice from the anchor
  // forward. Anchor lookup also pulls the operator_label text (if any) so
  // the reviewer framing can name the checkpoint.
  if (ref.kind === 'since-event') {
    // Extract turns from the full event stream first, THEN filter by
    // primary_complete seq. Filtering events first dropped the
    // user_message_echo when the anchor fell mid-turn (e.g. on a
    // tool_use row), making the in-flight turn invisible. A turn counts
    // as "from this point onward" if its tail lands at/after the anchor.
    const allTurns = extractTurns(events);
    const sliceTurnsFromAnchor = allTurns.filter((t) => t.completeSeq >= ref.anchorEventSeq);
    const anchor = events.find((e) => (e as { seq?: number }).seq === ref.anchorEventSeq);
    const anchorLabel = anchor && anchor.type === 'operator_label'
      ? (anchor as { text: string }).text
      : null;
    const framing = anchorLabel
      ? `You are reviewing the slice from operator label "${anchorLabel}" (event seq ${ref.anchorEventSeq}) onward — earlier turns are context but the verdict applies to this slice only.`
      : `You are reviewing the slice from event seq ${ref.anchorEventSeq} onward — earlier turns are context but the verdict applies to this slice only.`;
    const transcript = formatTurns(sliceTurnsFromAnchor);
    const parts: string[] = [framing, '', transcript];
    if (includeGitDiff) {
      const diff = await collectGitDiff(cwd);
      parts.push([
        '',
        '### Working tree changes (`git diff HEAD`)',
        '```diff',
        diff,
        '```',
      ].join('\n'));
    }
    let label = anchorLabel
      ? `from "${anchorLabel}" (${sliceTurnsFromAnchor.length} ${sliceTurnsFromAnchor.length === 1 ? 'turn' : 'turns'})`
      : `from event seq ${ref.anchorEventSeq} (${sliceTurnsFromAnchor.length} ${sliceTurnsFromAnchor.length === 1 ? 'turn' : 'turns'})`;
    if (includeGitDiff) label += ' + git diff';
    return {
      turnCount: sliceTurnsFromAnchor.length,
      content: parts.join('\n\n'),
      label,
      rejectReason: sliceTurnsFromAnchor.length === 0 && !includeGitDiff
        ? 'No completed turns at or after that point.'
        : null,
    };
  }

  const allTurns = extractTurns(events);
  const sliced = sliceTurns(allTurns, ref);

  let rejectReason: string | null = null;
  if (ref.kind === 'last-turn' && sliced.length === 0) {
    rejectReason = allTurns.length === 0
      ? 'No prompt history yet — send a message before running Review.'
      : 'Primary agent has not replied to the last prompt yet.';
  } else if (ref.kind !== 'git-diff' && sliced.length === 0) {
    rejectReason = 'No completed turns in the selected scope.';
  }

  const parts: string[] = [];
  if (ref.kind !== 'git-diff') {
    parts.push(formatTurns(sliced));
  }
  if (ref.kind === 'git-diff' || includeGitDiff) {
    const diff = await collectGitDiff(cwd);
    parts.push([
      '',
      '### Working tree changes (`git diff HEAD`)',
      '```diff',
      diff,
      '```',
    ].join('\n'));
  }

  return {
    turnCount: sliced.length,
    content: parts.join('\n\n'),
    label: contextLabel(ref, sliced.length, includeGitDiff),
    rejectReason,
  };
}

// ---------------------------------------------------------------------------
// Plan-scoped review content
// ---------------------------------------------------------------------------
// Parses a plan markdown body into a tree of (phases → tasks → subtasks),
// then slices/filters per the operator's selection. Used for plan-whole,
// plan-phase, and plan-items review kinds. The reviewer sees the plan
// markdown directly — no transcript involved.
//
// Item ID scheme: `${phaseIndex}/${taskIndex}` (zero-based). Stable across
// check-state changes; not stable across reordering. Plan reordering
// between selection and submission is rare enough in practice that we
// accept the trade for parser simplicity.

interface ParsedTask {
  raw: string;          // full text of the task block (parent line + nested lines), preserving indent
  parentLine: string;   // just the parent `- [ ] ...` line
  checked: boolean;
}

interface ParsedPhase {
  headingLine: string;  // raw H3 line (e.g. "### Phase 3: ...")
  heading: string;      // text after `### ` for matching
  preamble: string;     // any prose between heading and first task (rare; usually empty)
  tasks: ParsedTask[];
}

interface ParsedPlan {
  preamble: string;     // anything before the first H3 (title, intro)
  phases: ParsedPhase[];
}

const H3_RE = /^###\s+(.+?)\s*$/;
const H2_RE = /^##\s+/;                              // closes a phase; intervening content is discarded
const NUMBERED_BULLET_RE = /^- \*\*[\d.]+/;          // naked `- **4.1**` form (post-checkbox-strip)
const NESTED_NUMBERED_RE = /^\s+- \*\*[\d.]+/;       // nested numbered subtask, no checkbox

// Identify a top-level task line. Returns checked state if it's a task,
// null if it's something else (prose, blank line, etc). The numbered
// fallback handles the case where an agent stripped checkboxes from the
// plan — we still recognize `- **4.1**` shaped bullets as tasks (treated
// as unchecked) so the picker / phase review keep working.
function matchTopTask(line: string): { checked: boolean } | null {
  const checkboxed = line.match(/^- \[( |x|X)\]/);
  if (checkboxed) return { checked: checkboxed[1].toLowerCase() === 'x' };
  if (NUMBERED_BULLET_RE.test(line)) return { checked: false };
  return null;
}

function isNestedTaskOrContinuation(line: string): boolean {
  // Indented `- [ ]` / `- [x]` subtask
  if (/^\s+- \[( |x|X)\]/.test(line)) return true;
  // Indented numbered-form subtask
  if (NESTED_NUMBERED_RE.test(line)) return true;
  // Plain indented continuation (subtask body, multi-line bullet text).
  // We do NOT treat naked indented `- text` bullets as tasks because Phase
  // sections often contain prose with bulleted explanations (e.g. "Edge
  // cases handled: - Empty notes skip rule matching"). Indentation alone
  // means "continuation of the current task block."
  return line.startsWith(' ');
}

export function parsePlan(body: string): ParsedPlan {
  const lines = body.split('\n');
  const result: ParsedPlan = { preamble: '', phases: [] };
  const preambleBuf: string[] = [];
  let currentPhase: ParsedPhase | null = null;
  let phasePreambleBuf: string[] = [];
  let currentTaskBuf: string[] = [];
  let currentTaskParent = '';
  let currentTaskChecked = false;
  // After an H2 inside a phase we discard lines until the next H3. Without
  // this, sections like `## Open Questions / Blockers` between phases get
  // glommed onto the previous phase as preamble, which then leaks into
  // its review body.
  let betweenPhases = false;

  const flushTask = () => {
    if (!currentPhase || currentTaskBuf.length === 0) return;
    currentPhase.tasks.push({
      raw: currentTaskBuf.join('\n'),
      parentLine: currentTaskParent,
      checked: currentTaskChecked,
    });
    currentTaskBuf = [];
    currentTaskParent = '';
    currentTaskChecked = false;
  };

  const flushPhase = () => {
    if (!currentPhase) return;
    flushTask();
    if (phasePreambleBuf.length) currentPhase.preamble = phasePreambleBuf.join('\n');
    result.phases.push(currentPhase);
    currentPhase = null;
    phasePreambleBuf = [];
  };

  for (const line of lines) {
    const h3 = line.match(H3_RE);
    if (h3) {
      if (!currentPhase && !betweenPhases && preambleBuf.length) result.preamble = preambleBuf.join('\n');
      flushPhase();
      currentPhase = { headingLine: line, heading: h3[1], preamble: '', tasks: [] };
      betweenPhases = false;
      continue;
    }
    // H2 inside a phase ends the phase. Subsequent lines are discarded
    // until the next H3 starts a new phase.
    if (currentPhase && H2_RE.test(line)) {
      flushPhase();
      betweenPhases = true;
      continue;
    }
    if (betweenPhases) continue;
    if (!currentPhase) {
      preambleBuf.push(line);
      continue;
    }
    const topTask = matchTopTask(line);
    if (topTask) {
      flushTask();
      currentTaskParent = line;
      currentTaskChecked = topTask.checked;
      currentTaskBuf.push(line);
      continue;
    }
    // Continuation of an open task: indented lines, blank lines that
    // immediately follow task content, or nested checkbox / numbered subtasks.
    if (currentTaskBuf.length > 0 && (line === '' || isNestedTaskOrContinuation(line))) {
      currentTaskBuf.push(line);
      continue;
    }
    // Anything else inside a phase but outside a task: phase preamble.
    if (currentTaskBuf.length === 0) {
      phasePreambleBuf.push(line);
    } else {
      // Non-indented non-task line ends the current task.
      flushTask();
      phasePreambleBuf.push(line);
    }
  }
  if (!currentPhase && !betweenPhases && preambleBuf.length) result.preamble = preambleBuf.join('\n');
  flushPhase();

  // Trim trailing blank lines from each task's raw block — keeps the
  // reconstructed body tidy without dropping intentional spacing inside.
  for (const p of result.phases) {
    for (const t of p.tasks) {
      t.raw = t.raw.replace(/\n+$/, '');
    }
    p.preamble = p.preamble.replace(/^\n+|\n+$/g, '');
  }
  result.preamble = result.preamble.replace(/^\n+|\n+$/g, '');
  return result;
}

// Build the markdown body shown to the reviewer for a plan-* scope.
// `mode` controls filtering: VERIFY drops top-level `[ ]` tasks (work not
// claimed yet); CRITIQUE keeps everything. Subtask check state is
// preserved verbatim in both modes — the reviewer uses partial-completion
// signals when judging the worker's claim.
function renderPhase(phase: ParsedPhase, mode: PlanReviewMode, taskFilter?: Set<number>): string | null {
  const tasks = phase.tasks
    .map((t, idx) => ({ task: t, idx }))
    .filter(({ task, idx }) => {
      if (taskFilter && !taskFilter.has(idx)) return false;
      if (mode === 'verify' && !task.checked) return false;
      return true;
    });
  // Custom-picker selection that left nothing in this phase → drop entirely.
  if (taskFilter && tasks.length === 0) return null;
  // Otherwise, render whatever's left. A non-empty preamble is meaningful
  // even in VERIFY mode — when a phase has been rewritten as prose (e.g.
  // "Phase 3 Completed" with a description of what was done instead of
  // checkbox tasks), the prose IS the completion claim and the reviewer
  // needs to see it. Drop the phase only when there's truly nothing past
  // the heading.
  const hasPreamble = phase.preamble.trim().length > 0;
  if (tasks.length === 0 && !hasPreamble) return null;
  const parts = [phase.headingLine];
  if (phase.preamble) parts.push('', phase.preamble);
  if (tasks.length > 0) parts.push('', ...tasks.map(({ task }) => task.raw));
  return parts.join('\n');
}

function modeBlurb(mode: PlanReviewMode, anyChecked: boolean): string {
  if (mode === 'verify') {
    return anyChecked
      ? 'Items shown below are the worker\'s **claimed-completed work** (`[x]`). Verify each claim against the actual code in the tree using your tools — do not take the checkboxes at face value. Partial-completion signals (a `[x]` parent with `[ ]` subtasks) are worth flagging.'
      : '_(no completed items in this scope)_';
  }
  return 'Items shown below include both completed and pending work, with check state preserved. Evaluate the **plan itself** — gaps, ordering, missing considerations — not just whether the checked items were implemented correctly.';
}

export interface BuiltPlanReviewContent {
  itemCount: number;
  content: string;
  label: string;
  rejectReason: string | null;
}

export async function buildPlanReviewContent(
  cwd: string,
  ref: Extract<ReviewContextRef, { kind: 'plan-whole' | 'plan-phase' | 'plan-items' }>,
  includeGitDiff: boolean,
): Promise<BuiltPlanReviewContent> {
  const plan = await readPlan(cwd, ref.planId);
  if (!plan) {
    return { itemCount: 0, content: '', label: 'plan (missing)', rejectReason: `Plan ${ref.planId} not found in this workflow's working directory.` };
  }
  const parsed = parsePlan(plan.body);

  let renderedPhases: string[] = [];
  let itemCount = 0;
  let labelDetail = '';

  if (ref.kind === 'plan-whole') {
    for (const phase of parsed.phases) {
      const r = renderPhase(phase, ref.mode);
      if (r) renderedPhases.push(r);
    }
    itemCount = parsed.phases.reduce((n, p) => n + p.tasks.filter((t) => ref.mode === 'critique' || t.checked).length, 0);
    labelDetail = `whole plan (${plan.title || 'untitled'})`;
  } else if (ref.kind === 'plan-phase') {
    const phase = parsed.phases.find((p) => p.heading === ref.heading);
    if (!phase) {
      return { itemCount: 0, content: '', label: `plan phase: ${ref.heading}`, rejectReason: `Phase "${ref.heading}" not found in plan. Did the plan get edited?` };
    }
    const r = renderPhase(phase, ref.mode);
    if (r) renderedPhases.push(r);
    itemCount = phase.tasks.filter((t) => ref.mode === 'critique' || t.checked).length;
    labelDetail = `phase: ${ref.heading}`;
  } else {
    // plan-items: itemIds are `${phaseIdx}/${taskIdx}`. Group by phase so
    // each phase rendered once with only its selected tasks present.
    const byPhase = new Map<number, Set<number>>();
    const unresolved: string[] = [];
    for (const id of ref.itemIds) {
      const m = id.match(/^(\d+)\/(\d+)$/);
      if (!m) { unresolved.push(id); continue; }
      const pIdx = Number(m[1]);
      const tIdx = Number(m[2]);
      const phase = parsed.phases[pIdx];
      if (!phase || !phase.tasks[tIdx]) { unresolved.push(id); continue; }
      if (!byPhase.has(pIdx)) byPhase.set(pIdx, new Set());
      byPhase.get(pIdx)!.add(tIdx);
    }
    if (unresolved.length > 0) {
      return {
        itemCount: 0,
        content: '',
        label: `${ref.itemIds.length} plan items`,
        rejectReason: `Plan was edited since the selection was made — ${unresolved.length} of ${ref.itemIds.length} items could not be resolved (${unresolved.slice(0, 3).join(', ')}${unresolved.length > 3 ? ', …' : ''}). Reopen the picker and re-select.`,
      };
    }
    // Stable ordering: phase index ascending, then task index within phase.
    const orderedPhases = Array.from(byPhase.keys()).sort((a, b) => a - b);
    for (const pIdx of orderedPhases) {
      const phase = parsed.phases[pIdx];
      // For plan-items, mode does NOT filter — operator's explicit
      // selection is authoritative. Mode only affects framing/blurb.
      const r = renderPhase(phase, 'critique', byPhase.get(pIdx));
      if (r) renderedPhases.push(r);
      itemCount += byPhase.get(pIdx)!.size;
    }
    labelDetail = `${itemCount} selected ${itemCount === 1 ? 'item' : 'items'}`;
  }

  // "Anything to review" includes both checked tasks AND phases that
  // rendered preamble-only (prose-form completion claims). Drives the
  // VERIFY-mode blurb wording.
  const hasContent = itemCount > 0 || renderedPhases.length > 0;
  const blurb = modeBlurb(ref.mode, hasContent);
  const planTitle = plan.title || 'Untitled plan';

  const parts: string[] = [
    `**Plan:** ${planTitle}`,
    `**Mode:** ${ref.mode === 'verify' ? 'VERIFY WORK' : 'CRITIQUE PLAN'}`,
    '',
    blurb,
    '',
    '---',
    '',
    renderedPhases.length > 0 ? renderedPhases.join('\n\n') : '_(no items in scope)_',
  ];

  // Refs the in-scope items link — inlined (bounded) so the reviewer judges
  // the work against the spec the plan points at, not just the one-line task.
  const refsSection = renderedPhases.length > 0
    ? await renderLinkedRefsForReview(cwd, plan.id, renderedPhases.join('\n')).catch(() => '')
    : '';
  if (refsSection) parts.push('', '---', '', refsSection);

  if (includeGitDiff) {
    const diff = await collectGitDiff(cwd);
    parts.push(
      '',
      '---',
      '',
      '### Working tree changes (`git diff HEAD`)',
      '',
      'Provided as cross-reference. Treat the diff as supplementary — the plan items above are the primary subject of the review.',
      '',
      '```diff',
      diff,
      '```',
    );
  }

  let label = labelDetail + ` (${ref.mode})`;
  if (includeGitDiff) label += ' + git diff';

  // Reject only when there's truly nothing to review. itemCount counts
  // tasks; renderedPhases.length includes phases that contributed prose
  // preambles (e.g. a "Phase X Completed" prose summary with no
  // checkboxes). Either signal is enough to send the body to the
  // reviewer in VERIFY mode.
  return {
    itemCount,
    content: parts.join('\n'),
    label,
    rejectReason: itemCount === 0 && renderedPhases.length === 0 && ref.mode === 'verify'
      ? 'No completed work found in the selected scope — no `[x]` items and no completion prose. Switch to CRITIQUE mode to review pending work, or check off some items first.'
      : null,
  };
}

// Cluster-plan-scoped review. Mirrors buildPlanReviewContent but reads the
// body from a caller-provided string (the caller resolves it through
// clusterPlanBridge — the cluster's project plan file) rather than `readPlan`. Same parse +
// render path so reviewer-side framing is identical to the worker plan
// path. The `cwd` parameter is only used for `git diff` collection when
// `includeGitDiff` is true.
export async function buildClusterPlanReviewContent(
  cwd: string,
  ref: Extract<ReviewContextRef, { kind: 'cluster-plan-whole' | 'cluster-plan-phase' }>,
  body: string,
  clusterName: string | null,
  includeGitDiff: boolean,
): Promise<BuiltPlanReviewContent> {
  if (!body || body.trim().length === 0) {
    return {
      itemCount: 0,
      content: '',
      label: 'cluster plan (empty)',
      rejectReason: 'Cluster plan body is empty. Fill it in the PLAN tab before running Review.',
    };
  }
  const parsed = parsePlan(body);
  let renderedPhases: string[] = [];
  let itemCount = 0;
  let labelDetail = '';

  if (ref.kind === 'cluster-plan-whole') {
    for (const phase of parsed.phases) {
      const r = renderPhase(phase, ref.mode);
      if (r) renderedPhases.push(r);
    }
    itemCount = parsed.phases.reduce(
      (n, p) => n + p.tasks.filter((t) => ref.mode === 'critique' || t.checked).length,
      0,
    );
    labelDetail = `cluster plan${clusterName ? ` (${clusterName})` : ''}`;
  } else {
    const phase = parsed.phases.find((p) => p.heading === ref.heading);
    if (!phase) {
      return {
        itemCount: 0,
        content: '',
        label: `cluster plan phase: ${ref.heading}`,
        rejectReason: `Phase "${ref.heading}" not found in cluster plan. Did the body get edited?`,
      };
    }
    const r = renderPhase(phase, ref.mode);
    if (r) renderedPhases.push(r);
    itemCount = phase.tasks.filter((t) => ref.mode === 'critique' || t.checked).length;
    labelDetail = `cluster plan phase: ${ref.heading}`;
  }

  const hasContent = itemCount > 0 || renderedPhases.length > 0;
  const blurb = modeBlurb(ref.mode, hasContent);
  const titleLine = clusterName ? `cluster plan — ${clusterName}` : 'cluster plan';

  const parts: string[] = [
    `**Plan:** ${titleLine}`,
    `**Mode:** ${ref.mode === 'verify' ? 'VERIFY WORK' : 'CRITIQUE PLAN'}`,
    '',
    blurb,
    '',
    '---',
    '',
    renderedPhases.length > 0 ? renderedPhases.join('\n\n') : '_(no items in scope)_',
  ];

  if (includeGitDiff) {
    const diff = await collectGitDiff(cwd);
    parts.push(
      '',
      '---',
      '',
      '### Working tree changes (`git diff HEAD`)',
      '',
      'Provided as cross-reference. Treat the diff as supplementary — the plan items above are the primary subject of the review.',
      '',
      '```diff',
      diff,
      '```',
    );
  }

  let label = labelDetail + ` (${ref.mode})`;
  if (includeGitDiff) label += ' + git diff';

  return {
    itemCount,
    content: parts.join('\n'),
    label,
    rejectReason: itemCount === 0 && renderedPhases.length === 0 && ref.mode === 'verify'
      ? 'No completed work found in the cluster plan — no `[x]` items and no completion prose. Switch to CRITIQUE mode to review pending work.'
      : null,
  };
}

// ARCO_OPS_PLAN.md §G2 — build the reviewer content for a preview-capture
// report. No transcript: the reviewer reads the markdown report a Preview
// verification capture produced (screenshot reference + console/network + a
// layout/accessibility section) and judges the running UI from it. `reportName`
// is operator-supplied (ATTACH TO REVIEW button) — confine the read to the
// workflow's artifacts dir so a crafted name can't escape it.
export async function buildPreviewCaptureReviewContent(
  cwd: string,
  workflowId: string,
  reportName: string,
): Promise<{ content: string; label: string; rejectReason: string | null }> {
  const baseName = path.basename(reportName);
  if (baseName !== reportName || !baseName.endsWith('.md')) {
    return { content: '', label: 'preview capture', rejectReason: 'Invalid preview-capture report name.' };
  }
  let report: string;
  try {
    report = await fsPromises.readFile(path.join(artifactsDir(cwd, workflowId), baseName), 'utf8');
  } catch {
    return { content: '', label: `preview capture (${baseName})`, rejectReason: 'That preview-capture report no longer exists — capture the preview again.' };
  }
  const content = [
    'You are reviewing a **preview verification capture** of the running app — not a transcript or a diff.',
    'Arco rendered the dev-server preview in a headless browser and recorded the page title/URL, console',
    'errors, failed network requests, and basic layout/accessibility signals. Judge the UI from this evidence:',
    'call out real problems (errors, failed requests, overflow, missing labels) and note what looks healthy.',
    'The screenshot is referenced by filename — you cannot see the image, so reason from the structured notes.',
    '',
    '---',
    '',
    report,
  ].join('\n');
  return { content, label: `preview capture (${baseName})`, rejectReason: null };
}

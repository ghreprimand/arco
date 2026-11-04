// Phase P0 (WORKBENCH_EXPANSION_PLAN) — extracted from worker.ts to keep that
// file under the 2000-line cap. Stateless tail helpers: event replay, usage
// merging, tool-output truncation, plan-parser advisories, abortable sleep.

import { replayMessagesWithResumePolicy, type ClaudeResumeMessage } from './resumeSummary.js';
import { MAX_TOOL_OUTPUT_BYTES } from './tools.js';
import type { MessageParam, AnyContentBlock } from './contentBlocks.js';

// Replay a workflow's events.jsonl into a clean MessageParam[] usable as
// the seed for a Native worker. Short logs replay exactly; large logs are
// seeded with a cached deterministic summary of older events plus exact
// replay of the recent tail. Two invariants make this safe to feed straight
// to messages.create:
//
//   1. Pair-flush — user_message_echo + primary_text + primary_complete
//      land as a (user, assistant) pair. Solo user (latest in-flight echo
//      with no completion yet) and solo assistant (orphan primary_text
//      from a reflection turn that emitted into events.jsonl without a
//      preceding user_echo) are dropped. The next runTurn pushes the
//      operator's prompt as a fresh user, so a dangling user-only entry
//      would duplicate; an orphan assistant would put the conversation in
//      the [assistant, user, …] shape Anthropic rejects.
//   2. Reset on handoff_artifact_ready (success only) — a successful
//      handoff or spawn ends the prior session in this workflow's log.
//      Everything before the most recent successful handoff_artifact_ready
//      is discarded; replay continues with the post-handoff seed turn so
//      the worker reflects the new session, not the rotated-out one.
//
// tool_use / tool_result / thinking events are skipped. Replaying them
// with full fidelity (especially tool_use ids) requires a dedicated
// replay shape we'll add when crash-recovery cost bites; for now the
// USER/ASSISTANT pair shape is sufficient for the model to continue.
export async function replayMessagesFromEvents(cwd: string, workflowId: string, maxSeq?: number): Promise<MessageParam[]> {
  const replay = await replayMessagesWithResumePolicy(cwd, workflowId, maxSeq);
  return replay.messages as MessageParam[];
}

// Numeric fields only. Usage also carries nested objects (`server_tool_use`,
// `cache_creation`) and string/null fields (`service_tier`); summing those
// produced "[object Object][object Object]" in the USAGE payload.
function numericUsage(u: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(u)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

// ACROSS rounds of one turn: each round is a separate request, so its counts
// add up (billing / USAGE tab). Never use this within one streamed message —
// see applyUsageDelta.
export function mergeUsage(prior: Record<string, number> | undefined, next: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!next) return prior;
  const add = numericUsage(next);
  if (!prior) return add;
  const out = numericUsage(prior);
  for (const [k, v] of Object.entries(add)) out[k] = (out[k] ?? 0) + v;
  return out;
}

// WITHIN one streamed message: `message_delta.usage` is CUMULATIVE for the
// message (Anthropic streaming docs), not an increment. Summing it onto the
// `message_start` usage roughly doubled input/cache counts — inflating the
// USAGE tab, the lastPromptTokens CTX% fallback and auto-compact thresholds.
// Delta values overwrite per numeric key; a null / absent key keeps the
// message_start value (the delta may omit input counts).
export function applyUsageDelta(start: Record<string, number> | undefined, delta: Record<string, unknown> | undefined): Record<string, number> | undefined {
  if (!delta) return start;
  return { ...(start ? numericUsage(start) : {}), ...numericUsage(delta) };
}

export function truncateOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_BYTES) return text;
  return text.slice(0, MAX_TOOL_OUTPUT_BYTES) + `\n\n[truncated — tool output exceeded ${MAX_TOOL_OUTPUT_BYTES} bytes]`;
}

function flattenConversationalText(content: string | AnyContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { type: 'text'; text: string } => isTextBlock(b))
    .map((b) => b.text)
    .join('');
}

function setResumeMessageText(msg: ClaudeResumeMessage, text: string): void {
  if (msg.role === 'user') {
    msg.content = text;
  } else {
    msg.content = [{ type: 'text', text }];
  }
}

// Lightweight parser advisories for EnterPlanMode. Mirrors the invariants
// docs/GOTCHAS.md § Plan-review parsing invariants enforces (parsePlan in
// reviewContent.ts is the canonical consumer). Returns warnings only —
// plan-mode entry never rejects (the model corrects on the next turn).
export function planParserAdvisories(plan: string): string[] {
  const warnings: string[] = [];
  const lines = plan.split('\n');
  const phaseLines = lines.filter((l) => /^###\s+/.test(l));
  if (phaseLines.length === 0) {
    warnings.push('no `### Phase …` H3 phase headers found — Plan-scoped Review will treat the whole body as preamble.');
  }
  const checkboxLines = lines.filter((l) => /^- \[( |x|X)\]/.test(l));
  const numberedLines = lines.filter((l) => /^- \*\*[\d.]+/.test(l));
  if (phaseLines.length > 0 && checkboxLines.length === 0 && numberedLines.length === 0) {
    warnings.push('no `- [ ]` checkbox tasks (or `- **N.M**` numbered fallback) under any phase — VERIFY-mode review will see no claimed work.');
  }
  return warnings;
}

// Project live Native history into the same safe conversational shape replay
// reconstructs before sending it to the compact summarizer. Live `messages[]`
// can contain Anthropic tool protocol internals (`assistant.tool_use` followed
// by `user.tool_result`) that are valuable while a turn is executing but toxic
// after an interrupted/cancelled tool loop: one missing result makes the
// summarizer request 400 before it can compact anything. The summary needs the
// visible conversation, not raw tool ids, so preserve text blocks, skip pure
// tool/image plumbing, merge consecutive same-role text, and start on a user
// boundary.
export function projectCompactSummaryMessages(messages: MessageParam[]): ClaudeResumeMessage[] {
  const projected: ClaudeResumeMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const text = flattenConversationalText(msg.content).trim();
    if (!text) continue;
    if (projected.length === 0 && msg.role !== 'user') continue;

    const last = projected[projected.length - 1];
    if (last?.role === msg.role) {
      const lastText = typeof last.content === 'string'
        ? last.content
        : last.content.map((b) => b.text).join('');
      setResumeMessageText(last, `${lastText}\n\n${text}`);
      continue;
    }

    projected.push(
      msg.role === 'user'
        ? { role: 'user', content: text }
        : { role: 'assistant', content: [{ type: 'text', text }] },
    );
  }
  return projected;
}

// NATIVE_COMPACTION_PLAN Phase 2 — project the keep-last-N verbatim tail for
// compactInPlace into the clean resume shape (the SAME shape replay produces:
// `user` → string content, `assistant` → a single `{type:'text'}` block).
//
// Why a projection rather than slicing raw messages: the kept tail rides in the
// persisted `native_compacted.keptTail` and is re-appended on replay via the
// SAME `compactSummarySeed` helper, so it MUST be a shape replay can round-trip
// byte-identically. A live `messages[]` interleaves tool_use-bearing assistant
// messages and tool_result user messages inside each agentic turn — the replay
// path never reconstructs those (docs/GOTCHAS.md — tool_use / tool_result
// entries are skipped on replay; it pair-flushes only clean user/assistant
// text). So we mirror replay: walk backwards and SKIP any message that doesn't
// flatten to non-empty conversational text (tool_use-only assistant turns,
// tool_result user turns, empty/image-only turns), collecting the last
// `keepLast` clean user/assistant text messages. Skipped messages are not
// dropped from context — the summary covered the whole older prefix. Finally we
// drop any leading assistant so the tail starts on a `user` boundary (the seed
// ends on an assistant ack; a leading assistant would invert the order
// Anthropic rejects). Returns at most `keepLast` messages.
export function projectKeptTail(messages: MessageParam[], keepLast: number): ClaudeResumeMessage[] {
  if (keepLast <= 0 || messages.length === 0) return [];

  // Walk backwards, enforcing strict role alternation from the end (the SAME
  // shape replay's pair-flush yields): accept a clean text message only when its
  // role differs from the last-accepted role. Consecutive same-role messages
  // (e.g. an assistant narration block followed by the assistant's final reply,
  // separated only by skipped tool turns) collapse to the most recent — its text
  // is the operator-visible reply; the older same-role narration was already in
  // the summarized prefix.
  const collected: ClaudeResumeMessage[] = [];
  let lastRole: 'user' | 'assistant' | null = null;
  for (let i = messages.length - 1; i >= 0 && collected.length < keepLast; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const text = flattenConversationalText(msg.content).trim();
    if (!text) continue; // tool_use-only / tool_result / image-only — skip, like replay does
    if (msg.role === lastRole) continue; // collapse consecutive same-role → keep most recent
    collected.unshift(
      msg.role === 'user'
        ? { role: 'user', content: text }
        : { role: 'assistant', content: [{ type: 'text', text }] },
    );
    lastRole = msg.role;
  }

  // The seed ends on an assistant ack, so the tail must start on a `user`
  // boundary to keep alternation valid. Drop any leading assistant messages.
  while (collected.length > 0 && collected[0].role !== 'user') collected.shift();
  return collected;
}

// §2.1 — token-budget variant of projectKeptTail for the Fold. Same backward
// walk + strict role-alternation + clean-text projection (so the kept tail
// round-trips byte-identically through compactSummarySeed on replay), but the
// tail boundary is a TOKEN budget rather than a fixed message count: the Fold
// keeps the most-recent conversational turns whose summed estimated tokens fit
// within `tailTokenBudget` (~20% of the context window by default). A coarse
// chars/4 estimate is used — eviction/fold only needs a budget comparison, and
// the worker re-measures exactly via count_tokens on the next turn. Always
// keeps at least the most recent clean user→assistant exchange (so a single
// huge turn can't fold the tail to nothing and strand the model).
export function projectKeptTailByTokens(messages: MessageParam[], tailTokenBudget: number): ClaudeResumeMessage[] {
  if (messages.length === 0) return [];
  const budget = tailTokenBudget > 0 ? tailTokenBudget : 0;
  const collected: ClaudeResumeMessage[] = [];
  let lastRole: 'user' | 'assistant' | null = null;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const text = flattenConversationalText(msg.content).trim();
    if (!text) continue; // tool_use-only / tool_result / image-only — skip, like replay
    if (msg.role === lastRole) continue; // collapse consecutive same-role → most recent
    const cost = Math.ceil(text.length / 4);
    // Always admit the first (most-recent) message even if it alone exceeds the
    // budget; stop admitting older ones once the budget is exhausted.
    if (collected.length > 0 && tokens + cost > budget) break;
    collected.unshift(
      msg.role === 'user'
        ? { role: 'user', content: text }
        : { role: 'assistant', content: [{ type: 'text', text }] },
    );
    lastRole = msg.role;
    tokens += cost;
  }
  // Seed ends on an assistant ack — tail must start on a user boundary.
  while (collected.length > 0 && collected[0].role !== 'user') collected.shift();
  return collected;
}

function isTextBlock(b: unknown): b is { type: 'text'; text: string } {
  return (
    typeof b === 'object' &&
    b !== null &&
    (b as { type?: unknown }).type === 'text' &&
    typeof (b as { text?: unknown }).text === 'string'
  );
}

export function sleepWithSignal(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

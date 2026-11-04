// Ollama auto-compaction (Master-plan M8 / Hardening §6 Phase 4).
//
// This is a PORT of `llamacppRecovery.ts`'s auto-compaction to the Ollama
// provider, sharpened with the two tool-message invariants odysseus learned the
// hard way (sanitize orphaned tool turns, truncate oversized tool-call args).
// Read `llamacppRecovery.ts` first — this module mirrors its operator-facing
// POSTURE exactly: opt-in by choosing the provider (default-on for the provider,
// env-gated off), bounded by a deterministic context-fill threshold, every
// reduction lands in events.jsonl, and reversible from the original transcript.
// That posture is what passes CLAUDE.md's four-question test the same way
// llama.cpp's compaction does — preserve it.
//
// ── WHY THE TRANSFORM DIFFERS FROM llamacppRecovery.performCompaction ─────────
// The reference asks the PRIMARY model to summarize its whole stack and reseeds
// `[system, seed]`. M8's spec (Hardening §6) is sharper, matching odysseus:
//   - keep the leading system block intact (odysseus dropped it with a naïve
//     split — load-bearing);
//   - keep the current turn + last-10 messages VERBATIM (the recent tail the
//     model needs to continue coherently — a summary of the last few turns
//     loses the exact state the model is mid-edit on);
//   - summarize ONLY the older half, on the M7 UTILITY model (not the primary —
//     we have a cheap model for this; the reference had none);
//   - repair tool-call/tool-result pairing after the cut, or the daemon 400s on
//     `/api/chat` (an orphaned `role:'tool'` with no preceding `tool_calls`, or
//     a dangling `tool_calls` assistant with its result summarized away);
//   - truncate oversized retained tool-call argument blobs so one giant call
//     can't itself blow the window.
// The DETERMINISTIC fallback (no utility model configured / call failed) is the
// never-fail-closed guarantee the reference also has: compaction always produces
// SOMETHING, it never aborts the turn.
//
// ── WHY THE TRIGGER POINT DIFFERS ────────────────────────────────────────────
// llama.cpp keeps a long-lived in-memory `messages[]` and compacts at the END of
// a turn so the NEXT turn starts shrunk. Ollama's worker is stateless per turn:
// `run()` rebuilds the transcript from `appendSystemPrompt` every operator turn.
// So the clean turn boundary for Ollama is the START of `run()` — estimate the
// freshly-built stack (M6 `estimatePromptTokens`, forward-looking) against the
// probed window and compact BEFORE the first dispatch if it won't fit. Same
// "never mid tool-loop" rule, just anchored at the turn's front edge.

import {
  estimatePromptTokens,
  type EstimableMessage,
  type EstimableToolDef,
} from './ollamaTokens.js';

// ── Config (mirror llamacppRecovery.RecoveryConfig, compaction subset) ────────
//
// Only the compaction knobs are ported; the reference's reasoning-runaway /
// stall / wall-clock budgets are STREAMING-recovery concerns out of M8's scope.
// Defaults match the reference (0.85 fill, maxAutoRecoveries 1) plus the §6
// early-warning threshold (0.75) the reference doesn't have.
export interface CompactionConfig {
  enabled: boolean;
  // Hard trigger: fraction of the model context window consumed. 0.85 mirrors
  // llama.cpp's contextFillThreshold — leaves headroom for the post-compaction
  // turn itself plus the operator's next message without immediately re-tripping.
  contextFillThreshold: number;
  // Early warning: a softer fraction at which we emit a heads-up (no action)
  // suggesting Handoff before the lossy local summary fires. Hardening §6 asks
  // for this; the reference has no equivalent (it just compacts at the hard
  // gate). Local summaries are lossier than Handoff — give the operator the
  // choice before the automatic cut.
  warnThreshold: number;
  // Hard cap on auto-compactions per operator turn. 1 mirrors the reference:
  // one compaction is the recoverable case; a second within the same turn means
  // the transcript is pathological and should fail to the normal path rather
  // than loop. Counter is per-turn (run() is fresh each turn).
  maxAutoRecoveries: number;
  // Number of trailing messages kept VERBATIM (never summarized). Mirrors
  // odysseus's last-~10 invariant: the recent tail is the state the model is
  // actively working from; summarizing it loses the exact mid-edit context.
  keepLastMessages: number;
  // Cap on a single retained tool-call's serialized `arguments` (chars). A
  // single tool-only turn can itself overflow the window; oversized args in the
  // RETAINED tail get shrunk to a placeholder. Mirrors odysseus
  // `_truncate_tool_call_args`.
  maxToolCallArgChars: number;
  // Output token cap for the utility summary (num_predict). Bounded so the
  // "cheap" model can't run away. ~1024 matches the ollamaUtility default.
  summaryMaxTokens: number;
}

export function defaultCompactionConfig(): CompactionConfig {
  return {
    enabled: boolEnv('ARCO_OLLAMA_AUTO_COMPACT', true),
    contextFillThreshold: floatEnv('ARCO_OLLAMA_COMPACT_THRESHOLD', 0.85, 0.5, 0.99),
    warnThreshold: floatEnv('ARCO_OLLAMA_COMPACT_WARN', 0.75, 0.4, 0.98),
    maxAutoRecoveries: numEnv('ARCO_OLLAMA_MAX_COMPACTIONS', 1, 0, 10),
    keepLastMessages: numEnv('ARCO_OLLAMA_COMPACT_KEEP_LAST', 10, 2, 100),
    maxToolCallArgChars: numEnv('ARCO_OLLAMA_COMPACT_MAX_ARG_CHARS', 8000, 500, 200_000),
    summaryMaxTokens: numEnv('ARCO_OLLAMA_COMPACT_SUMMARY_TOKENS', 1024, 128, 4096),
  };
}

// WP3 — the operator-facing settings overlay shape (mirrors
// shared OllamaCompactionConfig; redeclared locally to keep this module free of
// the protocol import, the same posture defaultCompactionConfig keeps re: env).
// Every field optional — only set fields override.
export interface CompactionSettingsOverlay {
  enabled?: boolean;
  threshold?: number;
  warn?: number;
  keepLast?: number;
  maxRecoveries?: number;
  summaryTokens?: number;
}

// WP3 — three-layer config resolution: settings field (if set) > env var (if
// set) > hardcoded default. The env layer is `defaultCompactionConfig()` (which
// already folds env over the hardcoded baseline); the settings overlay is
// applied LAST so an operator's CONFIG-tab value wins over a stray env var. A
// field absent from the overlay leaves the env/default value untouched, so
// existing ARCO_OLLAMA_* deployments keep working unchanged when settings is
// absent. Callers (ollama.maybeCompact) trust the settings sanitizer to have
// clamped the overlay to the same bounds the env parser uses.
export function resolveCompactionConfig(overlay?: CompactionSettingsOverlay): CompactionConfig {
  const base = defaultCompactionConfig();
  if (!overlay) return base;
  return {
    ...base,
    ...(overlay.enabled !== undefined ? { enabled: overlay.enabled } : {}),
    ...(overlay.threshold !== undefined ? { contextFillThreshold: overlay.threshold } : {}),
    ...(overlay.warn !== undefined ? { warnThreshold: overlay.warn } : {}),
    ...(overlay.keepLast !== undefined ? { keepLastMessages: overlay.keepLast } : {}),
    ...(overlay.maxRecoveries !== undefined ? { maxAutoRecoveries: overlay.maxRecoveries } : {}),
    ...(overlay.summaryTokens !== undefined ? { summaryMaxTokens: overlay.summaryTokens } : {}),
  };
}

function boolEnv(key: string, def: boolean): boolean {
  const v = process.env[key]?.toLowerCase().trim();
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  return def;
}

function numEnv(key: string, def: number, min: number, max: number): number {
  const raw = process.env[key];
  if (!raw) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return def;
  return n;
}

function floatEnv(key: string, def: number, min: number, max: number): number {
  const raw = process.env[key];
  if (!raw) return def;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < min || n > max) return def;
  return n;
}

// ── The compaction message shape ─────────────────────────────────────────────
//
// Structurally a subset of ollama.ts's OllamaChatMessage — declared locally so
// the module + its offline smoke stay dependency-free of the whole provider.
// NOTE the Ollama difference from llama.cpp's ChatMessageLite: here
// `tool_calls[].function.arguments` is an already-PARSED object (Record), not a
// JSON string. The transform + digest account for that.
export interface CompactMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> }; argError?: string }>;
  images?: string[];
  thinking?: string;
}

// ── Detection ────────────────────────────────────────────────────────────────

// Hard trigger. token-based (M6 estimate or post-turn ground truth) against the
// probed window. Mirrors llamacppRecovery.shouldAutoCompact's guard: an unknown
// window (no probe) never triggers — guessing risks a wrong cut.
export function shouldAutoCompact(
  estimatedTokens: number,
  modelContextWindow: number | undefined,
  threshold: number,
): boolean {
  if (!modelContextWindow || modelContextWindow <= 0) return false;
  return estimatedTokens / modelContextWindow >= threshold;
}

// Early warning. Same denominator, softer fraction, and only when we're NOT yet
// at the hard gate (a single message at >=warn but <hard).
export function shouldWarnContext(
  estimatedTokens: number,
  modelContextWindow: number | undefined,
  warnThreshold: number,
  hardThreshold: number,
): boolean {
  if (!modelContextWindow || modelContextWindow <= 0) return false;
  const frac = estimatedTokens / modelContextWindow;
  return frac >= warnThreshold && frac < hardThreshold;
}

// ── Tool-message safety (odysseus _sanitize_tool_messages) ───────────────────
//
// THE load-bearing invariant. Front-trimming/summarizing the older half can
// orphan tool turns: a `role:'tool'` result whose preceding assistant
// `tool_calls` got summarized away, or a dangling assistant `tool_calls` whose
// following result got cut. Ollama's /api/chat 400s on the broken pairing
// ("a tool message must follow a message with tool_calls", and vice versa), so
// the daemon CHOKES if we hand it an orphan. Ollama's native message shape has
// NO tool_call_id to pair by — pairing is positional/adjacency: a `role:'tool'`
// message must be preceded (somewhere earlier, before the next assistant text
// turn) by an assistant message carrying tool_calls. We repair conservatively:
//   - drop a leading `role:'tool'` message that has no preceding assistant
//     tool_calls (the classic orphan a front-cut creates);
//   - drop tool_calls off a trailing assistant message that has no following
//     tool result (a dangling call the tail-cut creates) — keeping its text.
// Dropping (not synthesizing) is safest: a fabricated result could mislead the
// model; a removed orphan just costs a little history the summary already covers.
export function sanitizeToolMessages(messages: CompactMessage[]): CompactMessage[] {
  const out: CompactMessage[] = [];
  // Track whether the most recent assistant turn opened tool_calls that a
  // following `role:'tool'` message is allowed to answer.
  let pendingToolCalls = 0;
  for (const m of messages) {
    if (m.role === 'tool') {
      // Orphaned result — no open assistant tool_calls to pair with. Drop it.
      if (pendingToolCalls <= 0) continue;
      pendingToolCalls--;
      out.push(m);
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      // A new assistant tool-call turn opens N expected results.
      pendingToolCalls = m.tool_calls.length;
      out.push(m);
      continue;
    }
    // Any non-tool, non-tool-call message (system / user / plain assistant)
    // closes the pairing window: if the previous assistant opened calls that
    // were never answered, that assistant's tool_calls is now dangling. Strip
    // the dangling tool_calls off the last pushed assistant, keeping its text.
    if (pendingToolCalls > 0) {
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].role === 'assistant' && out[i].tool_calls && out[i].tool_calls!.length > 0) {
          const { tool_calls: _drop, ...rest } = out[i];
          out[i] = rest;
          break;
        }
        if (out[i].role === 'tool') break; // some calls were answered; leave it
      }
      pendingToolCalls = 0;
    }
    out.push(m);
  }
  // Trailing dangling tool_calls (assistant opened calls at the very end with
  // no following result) — strip them too.
  if (pendingToolCalls > 0) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === 'assistant' && out[i].tool_calls && out[i].tool_calls!.length > 0) {
        const { tool_calls: _drop, ...rest } = out[i];
        out[i] = rest;
        break;
      }
      if (out[i].role === 'tool') break;
    }
  }
  return out;
}

// ── Oversized tool-call args (odysseus _truncate_tool_call_args) ──────────────
//
// A single tool-only assistant turn can itself overflow the window (a Write with
// a huge `content`, an Edit with a giant `new_string`). Shrink any retained
// tool-call whose serialized arguments exceed the cap to a placeholder that
// PRESERVES the function name (so the model still knows what it did) and records
// the dropped size. We keep the name/argError but replace arguments wholesale —
// the retained tail is for continuity, not re-execution, so the full blob isn't
// needed. Returns a new list; never mutates input.
export function truncateToolCallArgs(messages: CompactMessage[], maxArgChars: number): CompactMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !m.tool_calls || m.tool_calls.length === 0) return m;
    let changed = false;
    const calls = m.tool_calls.map((tc) => {
      let serialized: string;
      try { serialized = JSON.stringify(tc.function.arguments ?? {}); }
      catch { serialized = ''; }
      if (serialized.length <= maxArgChars) return tc;
      changed = true;
      return {
        ...tc,
        function: {
          name: tc.function.name,
          // Placeholder preserves pairing + the fact a call happened; the byte
          // count is the reversibility breadcrumb (events.jsonl has the original).
          arguments: { _truncated_for_context: serialized.length } as Record<string, unknown>,
        },
      };
    });
    return changed ? { ...m, tool_calls: calls } : m;
  });
}

// ── Deterministic digest (never-fail-closed fallback) ────────────────────────
//
// Adapted from llamacppRecovery.deterministicSummary. The ONE shape difference:
// Ollama's tool_calls[].function.arguments is already a parsed object, so we read
// fields directly instead of JSON.parse-ing a string. Used when the utility
// model is unconfigured or its call returns null — compaction MUST still produce
// a usable recap so the turn never dies for lack of a summarizer.
export function deterministicDigest(messages: CompactMessage[]): string {
  const toolCalls = new Map<string, number>();
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const bashCommands: string[] = [];
  const assistantTextSnippets: string[] = [];

  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const name = tc.function?.name ?? '';
        toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
        const args = tc.function?.arguments ?? {};
        // file_path matches Arco's tool shape (ollamaTools.ts) — keep in sync.
        if (name === 'Read' && typeof args.file_path === 'string') filesRead.add(args.file_path);
        if ((name === 'Write' || name === 'Edit') && typeof args.file_path === 'string') filesWritten.add(args.file_path);
        if (name === 'Bash' && typeof args.command === 'string') {
          bashCommands.push(args.command.split('\n')[0].slice(0, 120));
        }
      }
    }
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 50) {
      assistantTextSnippets.push(m.content.trim().slice(0, 400));
      if (assistantTextSnippets.length > 3) assistantTextSnippets.shift();
    }
  }

  const lines: string[] = ['## Progress recap (older history, auto-compacted)'];
  if (toolCalls.size > 0) {
    lines.push('', '### Tools used');
    for (const [name, count] of toolCalls) lines.push(`- ${name}: ${count}x`);
  }
  if (filesRead.size > 0) {
    lines.push('', '### Files read');
    for (const f of filesRead) lines.push(`- ${f}`);
  }
  if (filesWritten.size > 0) {
    lines.push('', '### Files written/edited');
    for (const f of filesWritten) lines.push(`- ${f}`);
  }
  if (bashCommands.length > 0) {
    lines.push('', '### Bash commands run');
    for (const c of bashCommands.slice(-10)) lines.push(`- \`${c}\``);
  }
  if (assistantTextSnippets.length > 0) {
    lines.push('', '### Last things said in the compacted span');
    for (const s of assistantTextSnippets) lines.push(`> ${s.replace(/\n+/g, ' ').slice(0, 300)}…`);
  }
  if (lines.length === 1) lines.push('', '(no concrete actions recorded in the compacted span)');
  return lines.join('\n');
}

// ── Summary seed message ─────────────────────────────────────────────────────
//
// The summary text (utility-model or deterministic) is folded back into the
// transcript as a single synthetic `user` message anchored where the older half
// was. user-role (not system) keeps the leading system block singular + first —
// some daemons reject a second system message mid-stack, and the prefix cache
// keys on a stable leading system block.
export function compactionSeedMessage(summary: string, foldedCount: number): CompactMessage {
  return {
    role: 'user',
    content:
      `[Arco auto-compaction] The earlier ${foldedCount} message(s) of this conversation were summarized to fit the context window. ` +
      `Treat the recap below as authoritative state — do NOT re-read files or re-run commands it already records.\n\n` +
      `${summary}\n\n` +
      `Continue from this state.`,
  };
}

// ── The transform ────────────────────────────────────────────────────────────
//
// Pure (no I/O): takes the full message stack + the already-produced summary
// text, returns the compacted stack. The caller (ollama.ts) owns the summary
// production (utility-model or deterministic fallback) so this stays testable.
//
// Layout of the result:
//   [ ...leading system block(s), seed(summary), ...sanitized+truncated tail ]
//
// `splitOlderHalf` decides the cut: everything before the kept tail (minus the
// system block) is the "older half" that gets summarized away. The tail is the
// last `keepLastMessages` messages kept VERBATIM (then sanitized/truncated for
// pairing + arg-size safety).
export function splitForCompaction(
  messages: CompactMessage[],
  keepLastMessages: number,
): { system: CompactMessage[]; older: CompactMessage[]; tail: CompactMessage[] } {
  // Leading system block: all consecutive system messages at the front. Preserve
  // them verbatim — odysseus's bug was dropping the system prompt with a naïve
  // midpoint split. Offset the split past it.
  let sysEnd = 0;
  while (sysEnd < messages.length && messages[sysEnd].role === 'system') sysEnd++;
  const system = messages.slice(0, sysEnd);
  const body = messages.slice(sysEnd);

  // Keep the last N body messages verbatim. If the body is already short enough
  // there's nothing to summarize — older is empty, tail is the whole body.
  if (body.length <= keepLastMessages) {
    return { system, older: [], tail: body };
  }
  const tail = body.slice(body.length - keepLastMessages);
  const older = body.slice(0, body.length - keepLastMessages);
  return { system, older, tail };
}

// Assemble the compacted stack from the split + the summary. Runs the tail
// through sanitize + truncate (the cut can orphan tool turns at the seam; an
// oversized retained tool call can itself overflow). The summary seed sits
// between the system block and the sanitized tail.
export function assembleCompacted(
  split: { system: CompactMessage[]; older: CompactMessage[]; tail: CompactMessage[] },
  summary: string,
  config: CompactionConfig,
): CompactMessage[] {
  const out: CompactMessage[] = [...split.system];
  if (split.older.length > 0) {
    out.push(compactionSeedMessage(summary, split.older.length));
  }
  out.push(...split.tail);
  // Sanitize across the WHOLE assembled stack: the seam between the seed and the
  // tail is exactly where an orphaned tool result appears (the assistant
  // tool_calls turn that opened it lived in the summarized older half).
  let safe = sanitizeToolMessages(out);
  safe = truncateToolCallArgs(safe, config.maxToolCallArgChars);
  return safe;
}

// Byte/token accounting for the events.jsonl reversibility record. The original
// stack is reconstructable from the prior turns' events; this records the
// before/after so transcript review shows exactly how much was cut.
export function compactionStats(
  before: CompactMessage[],
  after: CompactMessage[],
  tools: EstimableToolDef[] | undefined,
): { beforeBytes: number; afterBytes: number; beforeTokens: number; afterTokens: number; foldedMessages: number } {
  const bytes = (msgs: CompactMessage[]): number => Buffer.byteLength(JSON.stringify(msgs), 'utf8');
  const beforeBytes = bytes(before);
  const afterBytes = bytes(after);
  const beforeTokens = estimatePromptTokens({ messages: before as EstimableMessage[], tools });
  const afterTokens = estimatePromptTokens({ messages: after as EstimableMessage[], tools });
  return {
    beforeBytes,
    afterBytes,
    beforeTokens,
    afterTokens,
    foldedMessages: Math.max(0, before.length - after.length),
  };
}

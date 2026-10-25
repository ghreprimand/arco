// Auto-recovery helpers for the llama.cpp provider. Local thinking models
// (Qwen3.6 et al) are weaker than Claude/Codex on multi-step planning and
// they fail in three specific ways that the lifecycle alone can't handle:
//
//   1. Reasoning runaway — model generates `reasoning_content` for minutes
//      without ever emitting `content` or `tool_calls`. Stream looks alive
//      but never produces a useful turn.
//
//   2. Tool-loop cap hit — even with the loop detector, complex multi-file
//      work can run >50 tool turns. Failing the worker forces operator to
//      restart from scratch.
//
//   3. Context fill — 96K is small compared to Claude's 200K. Long sessions
//      hit the cap mid-conversation; llama-server returns 400 and the next
//      turn just dies.
//
// This module provides shared utilities for detecting + recovering from
// each. The actual integration lives in llamacpp.ts run()/streamOneTurn().
//
// Design principle: in-place recovery. Same worker, same workflow, just an
// intelligent reset of the in-memory message stack. Operator sees a small
// system_notice but doesn't have to do anything. Distinct from the existing
// Handoff primitive which spawns a whole new workflow with a chosen
// summarizer model — that's heavyweight by design and tuned for Claude/Codex.

export interface RecoveryConfig {
  enabled: boolean;
  // Reasoning intervention: max reasoning_content tokens before we abort
  // the stream and inject a "commit now" coaching message. 8000 is enough
  // for genuine deep planning; past that the model is almost always stuck.
  reasoningBudgetTokens: number;
  // Auto-compaction trigger: fraction of model context window consumed
  // by the last call's prompt_tokens. 0.85 leaves ~14k headroom on a 96K
  // model — enough for the summary turn itself plus the operator's next
  // message without immediately re-tripping.
  contextFillThreshold: number;
  // Hard cap on auto-continuations / auto-compactions / stall retries
  // per operator turn. Prevents a stuck workflow from burning unbounded
  // VRAM. Each recovery action increments the counter; when exhausted the
  // worker falls back to the normal failure path.
  maxAutoRecoveries: number;
  // Stream stall: if no SSE event arrives for this many ms, abort the
  // call and treat as a hang. 90s is generous for the slowest expected
  // decode rate on a busy 5090 (a thinking model in mid-reasoning emits
  // tokens slower than answer-mode but never goes silent for 90s when
  // healthy).
  stallTimeoutMs: number;
  // Per-turn wall-clock budget. Hard ceiling on a single streamOneTurn
  // call regardless of what the model is emitting. Catches productive-
  // looking-but-going-nowhere modes (tool_calls + reasoning + content
  // pumping endlessly) that the runaway detector misses because each
  // signal individually looks legit. 120s lets a long, healthy reasoning
  // pass through; past that the model is almost certainly stuck.
  turnBudgetMs: number;
}

export function defaultRecoveryConfig(): RecoveryConfig {
  return {
    enabled: boolEnv('ARCO_LLAMACPP_AUTO_RECOVER', true),
    reasoningBudgetTokens: numEnv('ARCO_LLAMACPP_REASONING_BUDGET', 4000, 100, 100_000),
    contextFillThreshold: floatEnv('ARCO_LLAMACPP_COMPACT_THRESHOLD', 0.85, 0.5, 0.99),
    maxAutoRecoveries: numEnv('ARCO_LLAMACPP_MAX_RECOVERIES', 1, 0, 10),
    stallTimeoutMs: numEnv('ARCO_LLAMACPP_STALL_TIMEOUT_MS', 90_000, 10_000, 600_000),
    turnBudgetMs: numEnv('ARCO_LLAMACPP_TURN_BUDGET_MS', 120_000, 10_000, 1_800_000),
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

// ---- Deterministic summary builder -----------------------------------------
//
// Walk the message stack and produce a structured recap of what happened.
// Used as a fallback (no LLM call) when we need a summary fast and can't
// trust the model to produce one — typically on stall recovery, where the
// model is already misbehaving and asking it to summarize itself would
// likely hang too.

export interface ChatMessageLite {
  role: string;
  content: string | unknown;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
}

export function deterministicSummary(messages: ChatMessageLite[]): string {
  const toolCalls = new Map<string, number>(); // name -> count
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const bashCommands: string[] = [];
  let assistantTextSnippets: string[] = [];

  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const name = tc.function?.name ?? '';
        toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
        try {
          const args = JSON.parse(tc.function?.arguments ?? '{}') as Record<string, unknown>;
          // Read/Write args use `file_path` (matches Claude's tool shape) — the
          // earlier `args.path` wording silently produced empty file lists,
          // which gutted the recap's anti-rework signal. Watch this if a tool
          // schema ever drifts: keep it in sync with ollamaTools.ts.
          if (name === 'Read' && typeof args.file_path === 'string') filesRead.add(args.file_path);
          if (name === 'Write' && typeof args.file_path === 'string') filesWritten.add(args.file_path);
          if (name === 'Bash' && typeof args.command === 'string') {
            // Truncate long commands; show first line.
            const cmd = args.command.split('\n')[0].slice(0, 120);
            bashCommands.push(cmd);
          }
        } catch { /* malformed args, skip */ }
      }
    }
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0) {
      // Keep the last 3 substantial assistant text segments. Truncate each.
      const trimmed = m.content.trim();
      if (trimmed.length > 50) {
        assistantTextSnippets.push(trimmed.slice(0, 400));
        if (assistantTextSnippets.length > 3) assistantTextSnippets.shift();
      }
    }
  }

  const lines: string[] = ['## Progress recap'];
  if (toolCalls.size > 0) {
    lines.push('');
    lines.push('### Tools used');
    for (const [name, count] of toolCalls) {
      lines.push(`- ${name}: ${count}x`);
    }
  }
  if (filesRead.size > 0) {
    lines.push('');
    lines.push('### Files read');
    for (const f of filesRead) lines.push(`- ${f}`);
  }
  if (filesWritten.size > 0) {
    lines.push('');
    lines.push('### Files written');
    for (const f of filesWritten) lines.push(`- ${f}`);
  }
  if (bashCommands.length > 0) {
    lines.push('');
    lines.push('### Bash commands run');
    for (const c of bashCommands.slice(-10)) lines.push(`- \`${c}\``);
  }
  if (assistantTextSnippets.length > 0) {
    lines.push('');
    lines.push('### Last things you said');
    for (const s of assistantTextSnippets) {
      lines.push(`> ${s.replace(/\n+/g, ' ').slice(0, 300)}…`);
    }
  }
  if (lines.length === 1) {
    lines.push('');
    lines.push('(no concrete actions recorded)');
  }
  return lines.join('\n');
}

// ---- Recovery message templates -------------------------------------------

// Injected as a `user`-role message after auto-continue from tool-cap hit.
// The model sees its own tool history summarized and is told to either
// continue concretely or wrap up. Avoid blaming the model — that tends to
// make Qwen models defensive and produce more reasoning, not less.
//
// The "Files written"/"Files read" sections of the recap are load-bearing:
// without an explicit "do not re-verify these" directive, post-recovery
// runs frequently spend their second tool budget re-Reading the files
// they just wrote. The wording below names the recap sections directly so
// the model treats them as authoritative state, not stale notes.
export function toolCapContinuationMessage(maxToolTurns: number, recap: string): string {
  return (
    `[Arco auto-continue] You hit the ${maxToolTurns}-turn tool-call limit for this single message.\n\n` +
    `${recap}\n\n` +
    `**Trust the recap above as authoritative state.** Anything under "Files written" is already on disk in the form you wrote it — do NOT re-Read or re-Write those files unless the operator's task explicitly needs them changed again. Anything under "Files read" you've already inspected — do NOT re-Read to "verify" it. Anything under "Bash commands run" already executed — do NOT re-run for confirmation.\n\n` +
    `Continue from where you left off. Make ONE concrete next action. ` +
    `If you're close to done, finish the work; if scope is bigger than a single tool budget can finish, produce a final summary for the operator (decisions made, files touched, what's next) and stop. Do not start over.`
  );
}

// Injected when auto-recovery is exhausted — last-chance turn before the
// worker terminates. Distinct from toolCapContinuationMessage in that it
// does NOT invite further tool calls; the goal is a clean handoff artifact
// for the operator, not more execution. Phrased to discourage tool calls
// without strictly forbidding them (some models will emit one anyway; we
// let the next iteration's exhaustion check terminate for real).
export function finalSummaryDemandMessage(reason: string, recap: string): string {
  return (
    `[Arco final-summary mode] Auto-recovery is exhausted (${reason}). This is your last turn before the worker terminates.\n\n` +
    `${recap}\n\n` +
    `**Do not call any more tools.** Write a plain-text handoff for the operator. Cover:\n\n` +
    `1. **What's done** — concrete work completed, with file paths.\n` +
    `2. **What's broken or unfinished** — anything you started but didn't land, including known build errors.\n` +
    `3. **Next concrete step** — the single most useful thing to do next.\n\n` +
    `Be terse and specific. The operator will pick up from your summary, so accuracy matters more than completeness.`
  );
}

// Injected as `assistant` (faked) + `user` pair to break out of reasoning
// runaway. The assistant message ends the runaway naturally; the user
// message tells the model what to do next. Some thinking models respond
// well to seeing their own "I'll commit now" voice in the transcript.
export function reasoningInterruptionPair(reasoningTokens: number): {
  assistant: string;
  user: string;
} {
  return {
    assistant: `[I was reasoning for ${reasoningTokens} tokens without committing. Time to act.]`,
    user:
      `[Arco reasoning recovery] The previous reasoning phase exceeded the budget without producing content or a tool call. ` +
      `Stop deliberating. Take ONE concrete action now: either ` +
      `(a) call a tool to make progress, or ` +
      `(b) write a final answer to the operator with what you have. ` +
      `Do not re-enter the planning phase.`,
  };
}

// System prompt asked of the model when it's time to compact. The model
// summarizes its own recent work; that summary becomes the new compact
// message stack. Phrased to encourage structured, dense output.
export function compactionRequestPrompt(operatorAsk: string): string {
  return (
    `[Arco auto-compaction] The conversation is approaching this model's context limit. ` +
    `Before we proceed, please write a thorough handoff summary. Include:\n\n` +
    `1. **Original goal** (from the operator's first ask): ${operatorAsk.slice(0, 500)}\n` +
    `2. **Decisions made** so far — architecture choices, file structure, naming, etc.\n` +
    `3. **What's done** — concrete work completed.\n` +
    `4. **What's in progress** — what you were about to do next.\n` +
    `5. **What remains** — explicit list of remaining steps.\n` +
    `6. **Key file paths and code references** — the operator cares about these surviving the handoff.\n\n` +
    `Be dense and specific. This summary will replace the conversation history; anything not included will be lost.`
  );
}

// Injected after compaction to seed the fresh message stack. The compacted
// summary plays the role of "system memory" — high-priority, anchored at
// the start of the new conversation.
export function compactionSeedMessage(summary: string): string {
  return (
    `[Arco: previous conversation was compacted to fit within the context window]\n\n` +
    `${summary}\n\n` +
    `Continue from this state. The operator's next message will follow.`
  );
}

// ---- Detection helpers ----------------------------------------------------

export function shouldAutoCompact(lastInputTokens: number, modelContextWindow: number | undefined, threshold: number): boolean {
  if (!modelContextWindow || modelContextWindow <= 0) return false;
  return (lastInputTokens / modelContextWindow) >= threshold;
}

export function reasoningBudgetExceeded(reasoningTokensThisCall: number, budget: number): boolean {
  return reasoningTokensThisCall >= budget;
}

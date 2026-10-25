// Ollama token accounting (Hardening §5 / Master-plan M6).
//
// Two jobs, kept separate because they answer different questions:
//
//   1. POST-TURN GROUND TRUTH — Ollama returns `prompt_eval_count` on the
//      `done:true` line: the exact prompt-token count the daemon's chat
//      template produced for the call it just ran. ollama.ts captures this;
//      the run-loop hands the LAST turn's value out as `lastPromptTokens`
//      (the per-call context-fill figure, not the tool-loop sum — the same
//      distinction Codex draws between billing sum and last_token_usage).
//      That value drives the CTX bar's numerator and is the trustworthy
//      threshold M8 (compaction) reads. No estimation needed for it.
//
//   2. PRE-TURN ESTIMATE — before a turn is sent we have no ground truth yet
//      (the daemon hasn't seen the prompt). M8 needs a forward-looking size
//      so it can compact BEFORE the request overflows the window, not after a
//      400. This module is that estimate.
//
// THE LOAD-BEARING GOTCHA (odysseus 6973c54, Hardening §5): a naïve estimate
// that only counts visible `content` text undershoots by 20-30% on tool-heavy
// transcripts, because a tool-CALL assistant turn carries `content:""` with
// the entire payload in `tool_calls[].function.arguments`, and a tool-RESULT
// turn's body (a 32 KB file Read, a Grep dump) is large but easy to forget.
// When the estimate blinds out the tool traffic, the compaction gate fires too
// late and the turn dies on a context-overflow 400. So this estimator MUST
// serialize and count the tool-call argument JSON and the tool-result message
// bodies — that is the whole point of M6 feeding M8.
//
// The estimate is tokenizer-free on purpose: we don't ship a per-model BPE
// tokenizer, and the daemon's real count arrives post-turn anyway. The
// chars*RATIO + per-message overhead heuristic is the same shape odysseus used
// (`estimate_tokens`) and is plenty for a "are we near the window?" decision —
// it only needs to be in the right ballpark and, critically, to MOVE when tool
// traffic grows. It deliberately over- rather than under-counts (safer for a
// compaction gate: a slightly-early compact beats a 400).

// Generic English/code chars-per-token. ~3.3 chars/token for code-and-prose
// mixes is the commonly-cited figure; 0.3 tokens/char is its inverse. Matches
// odysseus's constant so the gate behaves the same across the two apps.
const TOKENS_PER_CHAR = 0.3;

// Per-message structural overhead (role tag + chat-template delimiters the
// daemon wraps each message in). ~4 tokens/message, same as odysseus.
const PER_MESSAGE_TOKENS = 4;

// The shape this estimator counts. Structurally a subset of ollama.ts's
// OllamaChatMessage — declared locally so the estimator stays a pure,
// dependency-free unit (importable by the offline test without dragging in
// the whole provider). `tool_calls[].function.arguments` is the field the
// naïve estimate forgets; counting it is the deliverable.
export interface EstimableMessage {
  role: string;
  content?: string;
  thinking?: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  // base64 image bytes — present on a vision turn. Counted as raw length / 4
  // (base64 inflation) so an attached screenshot doesn't silently blow the
  // estimate; vision tokenization is model-specific, this is a coarse guard.
  images?: string[];
}

// The tool-schema shape we count. Subset of OllamaToolDefinition — the schemas
// ride in EVERY request (Hardening §5: "Account for the tool schemas in the
// budget too — they're sent every turn"), so a 12-tool catalog adds a fixed
// few-thousand-token floor the gate must include.
export interface EstimableToolDef {
  function: { name: string; description: string; parameters: unknown };
}

function tokensForChars(chars: number): number {
  return Math.ceil(chars * TOKENS_PER_CHAR);
}

// Count one message, INCLUDING its tool-call arguments and (for tool-result
// turns) its body. Returns whole tokens.
export function estimateMessageTokens(msg: EstimableMessage): number {
  let chars = 0;
  // Visible text. role:'tool' messages carry their (possibly huge) result here.
  if (typeof msg.content === 'string') chars += msg.content.length;
  // Round-tripped reasoning — sent back to the model across tool-loop turns, so
  // it occupies context and must be counted.
  if (typeof msg.thinking === 'string') chars += msg.thinking.length;
  // THE gotcha: serialize tool-call arguments. A tool-only assistant turn has
  // empty content and the whole payload lives here. JSON.stringify mirrors what
  // the chat template renders into the prompt.
  if (Array.isArray(msg.tool_calls)) {
    for (const call of msg.tool_calls) {
      chars += (call.function.name ?? '').length;
      try {
        chars += JSON.stringify(call.function.arguments ?? {}).length;
      } catch {
        // Unserializable args (cycles) — fall back to a coarse fixed cost so a
        // pathological payload still bumps the estimate rather than vanishing.
        chars += 256;
      }
    }
  }
  let tokens = tokensForChars(chars) + PER_MESSAGE_TOKENS;
  // Images: base64 → ~0.75 bytes of real data per char; vision models burn a
  // model-specific number of tokens per tile. We approximate at length/4 — a
  // deliberate over-count so a screenshot can't sneak past the gate.
  if (Array.isArray(msg.images)) {
    for (const b64 of msg.images) tokens += Math.ceil(b64.length / 4);
  }
  return tokens;
}

// Count the tool schemas advertised on the turn. They serialize into the
// request body's `tools[]` and the daemon folds them into the rendered prompt,
// so they consume real context every turn.
export function estimateToolSchemaTokens(tools: EstimableToolDef[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  let chars = 0;
  for (const t of tools) {
    chars += (t.function.name ?? '').length;
    chars += (t.function.description ?? '').length;
    try {
      chars += JSON.stringify(t.function.parameters ?? {}).length;
    } catch {
      chars += 256;
    }
  }
  return tokensForChars(chars);
}

// Pre-turn prompt-size estimate: every message (text + tool-call args +
// tool-result bodies + thinking) PLUS the advertised tool schemas. This is the
// forward-looking number M8 compares against the effective window to decide
// whether to compact before dispatch.
export function estimatePromptTokens(input: {
  messages: EstimableMessage[];
  tools?: EstimableToolDef[];
}): number {
  let total = 0;
  for (const m of input.messages) total += estimateMessageTokens(m);
  total += estimateToolSchemaTokens(input.tools);
  return total;
}

// Ollama's HISTORICAL default context window when no num_ctx is sent and the
// Modelfile sets none. Current daemons pick a VRAM-derived default instead
// (32768 on a 32 GB card, logged as `default_num_ctx`), which Archon measures
// via /api/ps after the first such turn (ollama.ts measuredLoadedCtx). This
// stays as the conservative floor for a window never measured — it only
// under-states room, so M9's strict-greater bump check stays safe.
export const OLLAMA_DEFAULT_WINDOW = 2048;

// Build the CTX-bar signal fields from a ground-truth prompt-token count and
// the effective window. Mirrors contextEstimator.nativeContextEstimate so the
// `context_usage` message is identical in shape across providers — the client
// CTX bar consumes it unchanged. `windowSize` is the effective num_ctx the
// request will actually send (M3's per-backend probed window), falling back to
// Ollama's 2048 default only when nothing was probed.
//
// Returns null when there's no usable ground truth (no turn has reported
// prompt_eval_count yet), so callers can skip the broadcast rather than paint
// a 0% bar.
export function ollamaContextUsage(
  lastPromptTokens: number | undefined,
  effectiveWindow: number | undefined,
  calibratedAt?: number,
): {
  estimatedTokens: number;
  percentOfWindow: number;
  windowSize: number;
  method: 'ground-truth';
  calibratedAt?: number;
  messagesTokens: number;
  overheadTokens: number;
  jsonlBytes: number;
} | null {
  if (typeof lastPromptTokens !== 'number' || lastPromptTokens <= 0) return null;
  const windowSize = typeof effectiveWindow === 'number' && effectiveWindow > 0
    ? effectiveWindow
    : OLLAMA_DEFAULT_WINDOW;
  const percentOfWindow = Math.min(100, Math.round((lastPromptTokens / windowSize) * 100));
  return {
    // The daemon's prompt_eval_count already includes the system prompt + tool
    // schemas + transcript — it's the whole rendered prompt — so there's no
    // separate overhead term to add (unlike Claude, where overhead is modeled
    // because the JSONL byte count excludes the system/tool surface).
    estimatedTokens: lastPromptTokens,
    percentOfWindow,
    windowSize,
    method: 'ground-truth',
    ...(typeof calibratedAt === 'number' ? { calibratedAt } : {}),
    messagesTokens: lastPromptTokens,
    overheadTokens: 0,
    jsonlBytes: 0,
  };
}

// ── Generation speed (decode / prefill tok/s) ────────────────────────────────
//
// Ollama's `done` envelope carries exact daemon-side timings: eval_count +
// eval_duration (decode) and prompt_eval_count + prompt_eval_duration
// (prefill), durations in nanoseconds. Reading them beats wall-clock timing,
// which folds in model load, network and Archon's own stream handling.

export interface GenSpeedSample {
  decodeTokens: number;
  decodeMs: number;
  prefillTokens: number;
  prefillMs: number;
}

const nsToMs = (v: unknown): number => (typeof v === 'number' && v > 0 ? v / 1_000_000 : 0);
const count = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0);

// Null when the envelope has no usable timing (older daemon, dropped fields).
export function genSpeedFromOllamaDone(evt: Record<string, unknown>): GenSpeedSample | null {
  const sample: GenSpeedSample = {
    decodeTokens: count(evt.eval_count),
    decodeMs: nsToMs(evt.eval_duration),
    prefillTokens: count(evt.prompt_eval_count),
    prefillMs: nsToMs(evt.prompt_eval_duration),
  };
  return sample.decodeMs > 0 || sample.prefillMs > 0 ? sample : null;
}

// Sum samples across a turn's tool loop. Summing counts and durations (not
// averaging per-call rates) keeps a short tool-call round from skewing the
// turn's figure.
export function addGenSpeed(a: GenSpeedSample | null, b: GenSpeedSample | null): GenSpeedSample | null {
  if (!a) return b;
  if (!b) return a;
  return {
    decodeTokens: a.decodeTokens + b.decodeTokens,
    decodeMs: a.decodeMs + b.decodeMs,
    prefillTokens: a.prefillTokens + b.prefillTokens,
    prefillMs: a.prefillMs + b.prefillMs,
  };
}

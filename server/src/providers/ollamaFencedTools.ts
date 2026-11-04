// M11 (LOCAL_AI_MASTER_PLAN Stage 4 / Excellence LE-5, superset of
// OLLAMA_HARDENING_PLAN §8) — capability-gated tool handling for the Ollama
// primary path.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Not every Ollama model supports native tool-calling. Arco gates the
// `/api/chat` `tools[]` array on the model's probed `tools` capability
// (`/api/show` → `capabilities`). The PRE-M11 fallback for a non-tool model was
// "advertise no tools" — so an older/smaller model could not act at all. M11
// emulates tool-calling for those models: it injects a tool-call PROTOCOL into
// the system prompt (how to request a tool via a fenced block), then PARSES the
// model's free-text output for those fenced blocks and dispatches them through
// the SAME executeOllamaTool path the native `tool_calls` use. Capable models
// keep today's native behavior untouched.
//
// This module is the non-native (fenced) half. The native half stays in
// ollama.ts unchanged. The GATE that chooses between them is `resolveToolMode`.
//
// ── THE load-bearing constraints (flagged by the M10 worker) ────────────────
// 1. PREFIX-CACHE STABILITY. The injected protocol text becomes part of the
//    SYSTEM BLOCK — which is M10's ranking signal AND Ollama's prefix-cache-
//    stable region (the load-bearing invariant of this whole program; see
//    ollama.ts header + ollamaToolSubset.ts). So the protocol block MUST be
//    byte-stable across a workflow's turns. We build it PURELY from the
//    (already-subsetted, already-stable) tool list — no clock, no per-turn user
//    text, no random ids. Stable input list → byte-identical block → cache
//    survives. `buildFencedToolPrompt` is therefore a PURE function of the tool
//    list (and the run mode), which the smoke asserts.
// 2. TOKEN ACCOUNTING. The injected protocol text is real prompt tokens. M6's
//    estimator (ollamaTokens.ts) only counts native `tools[]` schemas; when
//    tools are presented via prompt injection instead, that text rides every
//    request and must be COUNTED or M8's compaction gate undercounts and the
//    turn dies on a context-overflow 400. `estimateFencedPromptTokens` is the
//    count; run() adds it to the pre-turn estimate on the fenced path.

import type { OllamaToolDefinition } from './ollamaTools.js';
import { estimateToolSchemaTokens } from './ollamaTokens.js';

// ── The tool-call mode for a turn ────────────────────────────────────────────
// 'native' — the model has the `tools` capability: advertise `tools[]`, parse
//            native `tool_calls`. (Pre-M11 behavior for capable models.)
// 'fenced' — the model lacks `tools`: inject the protocol, parse fenced blocks.
// 'none'   — no tools at all this turn (no cwd / one-shot / structured format).
export type OllamaToolMode = 'native' | 'fenced' | 'none';

// Operator override for the gate (reversibility guardrail — the fenced path is
// additive; forcing 'native' reverts to the pre-M11 "non-tool models just don't
// get tools" behavior). Read once per turn:
//   ARCO_OLLAMA_TOOL_MODE = auto (default) | native | fenced
//     auto   — pick from the probe (native if capable, fenced if not)
//     native — force native (a non-tool model then simply gets no tools, the
//              pre-M11 fallback — the clean "turn the feature off" switch)
//     fenced — force fenced even for a tools-capable model (for testing the
//              emulation path, or working around a model whose native tool
//              parser is unreliable)
export type ToolModeOverride = 'auto' | 'native' | 'fenced';

export function resolveToolModeOverride(env: NodeJS.ProcessEnv = process.env): ToolModeOverride {
  const raw = env.ARCO_OLLAMA_TOOL_MODE?.trim().toLowerCase();
  if (raw === 'native' || raw === 'fenced') return raw;
  return 'auto';
}

// THE gate. Given whether tools are being offered at all this turn (`hasTools`),
// whether the chosen backend's model probed the `tools` capability
// (`nativeCapable`), and the operator override, decide the presentation.
//
//   - hasTools=false → 'none' (no cwd / structured one-shot — nothing to gate).
//   - override 'native' → 'native' (force; a non-tool model then advertises
//     `tools[]` it can't use, but that's the explicit "off" switch — Ollama
//     ignores unusable tools, it just won't call them).
//   - override 'fenced' → 'fenced' (force emulation regardless of capability).
//   - 'auto' → native iff the probe says the model is tools-capable, else
//     fenced. This is the LE-5 capability gate.
export function resolveToolMode(input: {
  hasTools: boolean;
  nativeCapable: boolean;
  override?: ToolModeOverride;
}): OllamaToolMode {
  if (!input.hasTools) return 'none';
  const override = input.override ?? resolveToolModeOverride();
  if (override === 'native') return 'native';
  if (override === 'fenced') return 'fenced';
  return input.nativeCapable ? 'native' : 'fenced';
}

// ── The fenced protocol ──────────────────────────────────────────────────────
// SYNTAX (Hardening §8: the `~~~tool_name(args)~~~` family). A call is a fenced
// block whose opening fence carries the tool name and whose body is the JSON
// arguments object:
//
//     ~~~tool
//     {"name": "Read", "arguments": {"file_path": "/abs/path.ts"}}
//     ~~~
//
// We standardize on a single shape — a ```tool / ~~~tool fenced block holding a
// JSON object with `name` + `arguments` — because:
//   - JSON arguments reuse the EXACT same arg-normalization the native path
//     already has (object → Record<string,unknown>), so the downstream
//     executeOllamaTool path is identical (no second arg parser to maintain).
//   - small models reliably produce fenced code blocks (they're trained on
//     markdown); a bespoke `tool_name(args)` call syntax drifts more.
// The PARSER below is deliberately lenient about the surrounding shape (fence
// char, language tag, prose around the block, a bare top-level JSON object) —
// see parseFencedToolCalls — because that drift is exactly what small models
// produce. The PROMPT teaches the canonical shape; the parser tolerates the
// mess.
//
// FENCE_TAG is the language hint on the opening fence the prompt asks for. The
// parser does not REQUIRE it (it accepts ```json / ~~~ / no tag) but teaching it
// makes well-behaved models emit something trivially greppable.
const FENCE_TAG = 'tool';

// ── Prompt-inject-context vs expose-as-tool (LE-5) ───────────────────────────
// LE-5's richer idea: when native tools are OFF, that's also when you fall back
// to PROMPT-INJECTING context instead of exposing it as a tool. A weak non-tool
// model is unreliable at remembering to emit a fenced `peer_read` block to poll
// its mailbox or `cluster_plan_tick` to see the plan — but Arco ALREADY
// injects the cluster plan + role hints into the (stable) system block via
// appendSystemPrompt (CLAUDE.md: "Plan + role hints flow as forced system
// blocks"). So on the fenced path those cluster CONTEXT-READER tools are better
// left OUT of the fenced action protocol: their information arrives as injected
// context, not as a tool the model must think to call. We keep the cluster
// ACTION tool (peer_send — the model must actively report) in the protocol, and
// keep the file/shell/web ACTION tools. This is the concrete, in-scope
// application of LE-5's distinction for Arco's current registry; the general
// RAG/memory injection is LE-9 (separate), which would extend this same split.
//
// CONTEXT-reader tools excluded from the fenced action protocol (their state is
// prompt-injected instead). Deliberately NOT the file readers (Read/Grep/Glob):
// those fetch arbitrary repo content the model genuinely must request per-task —
// they're action tools, not standing context. Only the cluster STATE readers,
// whose payload Arco already folds into the system block, qualify.
const FENCED_CONTEXT_READER_TOOLS: ReadonlySet<string> = new Set([
  'peer_read',        // pending mailbox — surfaced via injected plan/role context
  'peer_list',        // roster — small + stable, belongs in injected context
  'cluster_plan_tick', // plan/progress — already injected via appendSystemPrompt
  'cluster_plan_read', // full plan body — injected (Ollama path injects the full plan, never the outline)
]);

// Split a fenced-path tool subset into the ACTION tools that go into the fenced
// protocol prompt and the CONTEXT-reader tools that are prompt-injected instead
// (LE-5). PURE — deterministic partition by name, so it doesn't perturb the
// prefix-cache-stable protocol block. The dropped context readers are returned
// for the visibility log (guardrail: the operator sees the distinction in
// events.jsonl).
export function partitionFencedTools(tools: OllamaToolDefinition[]): {
  action: OllamaToolDefinition[];
  contextInjected: OllamaToolDefinition[];
} {
  const action: OllamaToolDefinition[] = [];
  const contextInjected: OllamaToolDefinition[] = [];
  for (const t of tools) {
    if (FENCED_CONTEXT_READER_TOOLS.has(t.function.name)) contextInjected.push(t);
    else action.push(t);
  }
  return { action, contextInjected };
}

// Build the STABLE protocol block injected into the system prompt on the fenced
// path. PURE function of the tool list (+ mode) — no clock, no per-turn text —
// so it's byte-identical across turns and the prefix cache survives (constraint
// #1). The tool list passed in is already the M10 subset (stable across turns
// because it ranks off the stable task context), so this whole block is stable.
// Only the ACTION tools are described here; CONTEXT readers are partitioned out
// by the caller (LE-5 — they're prompt-injected as context, not exposed).
//
// Returns '' when there are no tools to present (defensive — callers only invoke
// this on the fenced path with a non-empty list).
export function buildFencedToolPrompt(tools: OllamaToolDefinition[]): string {
  if (!tools || tools.length === 0) return '';

  // One compact line per tool: name — description, then its parameter names so
  // the model knows the arg keys. We do NOT inline the full JSON-Schema (it's
  // verbose and the small models we target read a terse list better); the
  // required params are flagged with *.
  const toolLines = tools.map((t) => {
    const fn = t.function;
    const props = fn.parameters?.properties ?? {};
    const required = new Set(fn.parameters?.required ?? []);
    const paramNames = Object.keys(props);
    const params = paramNames.length === 0
      ? '(no arguments)'
      : paramNames.map((p) => (required.has(p) ? `${p}*` : p)).join(', ');
    return `- ${fn.name} — ${fn.description}\n    arguments: ${params}`;
  });

  // The protocol prose is FIXED (no interpolated volatile content) — only the
  // tool list above varies, and only with the stable subset. Keep this text
  // verbatim-stable; editing it invalidates the prefix cache for every fenced
  // workflow (acceptable on a deploy, never per-turn).
  return [
    '# Tool use (this model has no native tool API — use the fenced protocol below)',
    '',
    'You can act on the repository by calling tools. To call a tool, emit a fenced code block',
    `tagged \`${FENCE_TAG}\` containing a single JSON object with a "name" and an "arguments" object.`,
    'Emit NOTHING else on the lines of the block. Example:',
    '',
    '```' + FENCE_TAG,
    '{"name": "Read", "arguments": {"file_path": "/abs/path/to/file.ts"}}',
    '```',
    '',
    'Rules:',
    '- One tool call per fenced block. You may emit several blocks to call several tools.',
    '- "arguments" MUST be a JSON object (use {} if the tool takes no arguments).',
    '- Use absolute paths. Required arguments are marked with * below.',
    '- After you emit a tool block, STOP and wait — the tool result is returned to you',
    '  as the next message. Then continue. When you are done, answer in plain prose with',
    '  NO fenced tool block.',
    '',
    'Available tools:',
    ...toolLines,
  ].join('\n');
}

// Count the fenced protocol prompt's tokens for M6's pre-turn estimate
// (constraint #2). On the fenced path the protocol text replaces the native
// `tools[]` schemas as the per-request tool surface, so the estimator must count
// IT instead of the schemas. We reuse the same chars*RATIO heuristic the rest of
// M6 uses by routing through estimateToolSchemaTokens-equivalent counting: the
// protocol block is plain text, so we approximate it as one synthetic "message"
// of that length. Returns whole tokens.
//
// Implemented in terms of the same TOKENS_PER_CHAR the estimator uses by
// borrowing estimateToolSchemaTokens on a single synthetic tool whose
// description carries the whole block — keeps ONE chars→tokens constant in the
// codebase (ollamaTokens.ts) rather than duplicating it here.
export function estimateFencedPromptTokens(prompt: string): number {
  if (!prompt) return 0;
  return estimateToolSchemaTokens([
    { function: { name: '', description: prompt, parameters: {} } },
  ]);
}

// A parsed fenced tool-call request — the SAME shape the native parser produces
// (name + normalized args, or an argError the dispatcher surfaces to the model).
// Mapping to this shape is what lets the fenced path reuse executeOllamaTool
// verbatim downstream (the run-loop converts these into OllamaToolCall and feeds
// dispatchToolCalls, identical to native).
export interface ParsedFencedCall {
  name: string;
  arguments: Record<string, unknown>;
  // Set when the JSON body was present but un-parseable / wrong-shaped, so the
  // dispatcher can echo the error back to the model (mirrors native argError).
  argError?: string;
}

// Matches a fenced code block. Tolerant of:
//   - either fence char (``` or ~~~), 3+ of them
//   - any (or no) language tag on the opening fence
//   - leading whitespace before the fence (small models indent)
// Captures the block body (group 1). The `[\s\S]*?` is non-greedy so adjacent
// blocks don't merge. We do NOT require the FENCE_TAG tag — a model that drops
// it or writes ```json still parses (robustness to drift).
const FENCE_RE = /(?:^|\n)[ \t]*(?:```|~~~)[^\n]*\n([\s\S]*?)\n[ \t]*(?:```|~~~)/g;

// Extract a JSON object substring from arbitrary text by brace-matching from the
// first `{`. Mirrors open-webui's brace-slice for non-streaming tool-model
// calls (LE-5 cites it) — but applied as a FALLBACK after fenced parsing, for
// models that emit a bare JSON object with no fence at all. Returns the slice or
// null. String-aware so a `}` inside a JSON string value doesn't end the slice
// early.
function sliceFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unbalanced — model truncated the block
}

// Coerce a parsed JSON value into a ParsedFencedCall, tolerating the format
// drift small models produce:
//   - {"name":"X","arguments":{...}}            — canonical
//   - {"name":"X","args":{...}}                  — common alias
//   - {"name":"X","parameters":{...}}            — common alias
//   - {"tool":"X", ...} / {"tool_name":"X", ...} — name-key drift
//   - {"name":"X"}                               — no args → {}
//   - {"X": {...}}                               — single-key {tool: args} shape
// Returns null when no plausible tool name is present (so prose with stray JSON
// doesn't fabricate a call).
function coerceCall(obj: Record<string, unknown>, knownTool?: (n: string) => boolean): ParsedFencedCall | null {
  const nameKeys = ['name', 'tool', 'tool_name', 'function', 'tool_call'];
  let name: string | undefined;
  for (const k of nameKeys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) { name = v.trim(); break; }
    // {"function": {"name": "X", "arguments": {...}}} — OpenAI-ish nesting.
    if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).name === 'string') {
      name = ((v as Record<string, unknown>).name as string).trim();
      const inner = (v as Record<string, unknown>).arguments ?? (v as Record<string, unknown>).args;
      if (inner && typeof inner === 'object') {
        return { name, arguments: inner as Record<string, unknown> };
      }
      break;
    }
  }

  // Single-key {ToolName: {args}} shape — only when the key is a known tool, so
  // an ordinary one-field JSON object isn't misread as a call.
  if (!name && knownTool) {
    const keys = Object.keys(obj);
    if (keys.length === 1 && knownTool(keys[0]) && obj[keys[0]] && typeof obj[keys[0]] === 'object') {
      return { name: keys[0], arguments: obj[keys[0]] as Record<string, unknown> };
    }
  }

  if (!name) return null;

  const argsRaw = obj.arguments ?? obj.args ?? obj.parameters ?? obj.input;
  if (argsRaw === undefined || argsRaw === null) {
    return { name, arguments: {} };
  }
  if (typeof argsRaw === 'object' && !Array.isArray(argsRaw)) {
    return { name, arguments: argsRaw as Record<string, unknown> };
  }
  // arguments present but the wrong type (string / array / number). Try one
  // JSON-parse for the stringified-object case; otherwise surface an argError
  // (the dispatcher echoes it back, same as the native string-args path).
  if (typeof argsRaw === 'string') {
    try {
      const parsed = JSON.parse(argsRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { name, arguments: parsed as Record<string, unknown> };
      }
    } catch { /* fall through to argError */ }
  }
  return {
    name,
    arguments: {},
    argError: `"arguments" must be a JSON object; got ${Array.isArray(argsRaw) ? 'array' : typeof argsRaw}`,
  };
}

// Parse a model's free-text output for fenced tool-call requests. Robust to the
// messy output small models produce: prose around the block, missing/extra
// language tags, either fence char, and a bare top-level JSON object with no
// fence at all (the brace-slice fallback). Returns the calls in emission order.
//
// `knownTool` (optional) lets the single-key {Tool: args} drift and the bare-
// JSON fallback gate on the real registry so stray JSON in prose can't fabricate
// a call. The dispatcher still validates names downstream (unknown → error),
// so this is a precision aid, not the security boundary.
export function parseFencedToolCalls(
  text: string,
  knownTool?: (n: string) => boolean,
): ParsedFencedCall[] {
  if (!text) return [];
  const calls: ParsedFencedCall[] = [];

  // 1) Fenced blocks — the canonical path. Each block body is brace-sliced to a
  //    JSON object (lets the model wrap the JSON in a stray word), then coerced.
  let m: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  let sawFence = false;
  while ((m = FENCE_RE.exec(text)) !== null) {
    sawFence = true;
    const body = m[1];
    const slice = sliceFirstJsonObject(body) ?? body.trim();
    let parsed: unknown;
    try { parsed = JSON.parse(slice); } catch { parsed = undefined; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const call = coerceCall(parsed as Record<string, unknown>, knownTool);
      if (call) calls.push(call);
      else calls.push({ name: '', arguments: {}, argError: 'fenced block JSON had no recognizable tool "name"' });
    } else {
      // A fenced block the model clearly meant as a call (it emitted the fence)
      // but whose body wasn't valid JSON — surface as an argError so the model
      // gets feedback rather than silent no-op. Skip empty/whitespace bodies.
      if (slice.trim()) {
        calls.push({ name: '', arguments: {}, argError: `fenced tool block was not valid JSON: ${slice.slice(0, 80)}` });
      }
    }
  }

  if (sawFence) {
    // Drop pure-error blocks ONLY if at least one real call parsed — a model
    // that emitted one good call plus a malformed fence shouldn't be blocked on
    // the malformed one. But keep errors when NO call parsed, so the model gets
    // feedback. (Filter nameless error entries when a named call exists.)
    const named = calls.filter((c) => c.name);
    return named.length > 0 ? named : calls;
  }

  // 2) No fence at all — brace-slice fallback (open-webui's approach). Only fire
  //    when the slice coerces to a call whose name is a KNOWN tool, so ordinary
  //    JSON in a prose answer ("here's the config: {...}") isn't misread.
  const slice = sliceFirstJsonObject(text);
  if (slice) {
    let parsed: unknown;
    try { parsed = JSON.parse(slice); } catch { parsed = undefined; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const call = coerceCall(parsed as Record<string, unknown>, knownTool);
      // Bare-JSON fallback is precision-gated on a known name (no fence = weaker
      // signal of call-intent, so require the name to be real).
      if (call && call.name && (!knownTool || knownTool(call.name))) {
        return [call];
      }
    }
  }

  return [];
}

// Format a tool RESULT for the fenced path, fed back to the model as the next
// message so it can continue (mirrors the native role:'tool' message, but the
// fenced model expects the result in-band as a user turn — it has no native
// tool-role rendering). Kept terse + labeled so the small model correlates it
// with the call it made.
export function formatFencedToolResult(name: string, result: string): string {
  return `[tool result: ${name}]\n${result}`;
}

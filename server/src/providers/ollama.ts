import { parseComputerHistory } from '../voice/history.js';
import { computerToolDefinitions, executeComputerTool } from '../voice/toolDefinitions.js';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { extname } from 'path';
import { MAX_WORKER_OUTPUT_BYTES, OUTPUT_TRUNCATION_NOTICE } from '../workers/limits.js';
import { markAvailable } from '../quota.js';
import {
  executeOllamaTool,
  getOllamaToolDefinitions,
  isKnownOllamaTool,
  ToolLoopDetector,
  type OllamaToolDefinition,
} from './ollamaTools.js';
import { goalBlock } from './goalBlock.js';
import { awaitModelImages, modelImagePath } from './attachments.js';
import { applyOllamaParams, effectiveNumCtx, parseArchContextLength } from './ollamaParams.js';
import { loadedContextLength } from './ollamaVram.js';
import { subsetOllamaTools } from './ollamaToolSubset.js';
import { addGenSpeed, estimatePromptTokens, genSpeedFromOllamaDone, OLLAMA_DEFAULT_WINDOW, type GenSpeedSample } from './ollamaTokens.js';
import {
  resolveToolMode,
  resolveToolModeOverride,
  buildFencedToolPrompt,
  partitionFencedTools,
  estimateFencedPromptTokens,
  parseFencedToolCalls,
  formatFencedToolResult,
  type OllamaToolMode,
} from './ollamaFencedTools.js';
import {
  resolveCompactionConfig,
  shouldAutoCompact,
  shouldWarnContext,
  splitForCompaction,
  assembleCompacted,
  deterministicDigest,
  compactionStats,
  type CompactMessage,
  type CompactionConfig,
} from './ollamaRecovery.js';
import { consumeOllamaForceCompact } from './ollamaForceCompact.js';
import { runUtilitySummaryJob, resolveUtilityConfig, type UtilityMessage } from './ollamaUtility.js';
import { loadEffectivePrompt as loadCompactionFraming } from '../handoffPrompts.js';
import type {
  WorkerConfig,
  WorkerStatus,
  OllamaPsAggregate,
  OllamaPsBackend,
  OllamaPsModel,
  OllamaThinkingInfo,
} from '@arco/shared';
import { ollamaThinkParam, parseOllamaThinking } from '@arco/shared';
import { readSettings } from '../settings.js';
import { resolveConfigValue } from '../configValue.js';
import type { Provider, ProviderProcess } from './types.js';
import {
  resolveBackends,
  singleBackend,
  selectBackend,
  reportFailure,
  classifyOllamaError,
  backoffMs,
  resolveViaTailscale,
  isBackendCooled,
  OLLAMA_CONNECT_TIMEOUT_MS,
  OLLAMA_STREAM_START_TIMEOUT_MS,
  CONNECT_TIMEOUT_MARKER,
  type ResolvedBackend,
  type OllamaRoutingEvent,
} from './ollamaResilience.js';
import {
  planCtxEscalation,
  MAX_CTX_ESCALATIONS,
  type CtxBackendInfo,
} from './ollamaCtxFallback.js';

// Slot 4 — Ollama is local-only; no remote quota to throttle. Export a stub
// throttle parser for API symmetry with the subprocess providers, but it
// always returns null.
export function parseOllamaThrottle(_text: string): { resetsAt?: number } | null {
  return null;
}

// Ollama runs locally over HTTP — no subprocess, no auth.
//
// Transport: POST /api/chat with structured `messages` returns NDJSON, one
// JSON object per line: { message: { role, content }, done: false }, ending
// with { done: true, prompt_eval_count, eval_count, total_duration, ... }.
//
// Why /api/chat (not /api/generate): Ollama's prefix cache keys off the
// fully-rendered prompt that comes out of the chat template. Structured
// messages give us byte-stable prefixes across turns — system + prior
// user/assistant pairs stay identical, only the new user turn grows. The
// cache then re-prefills only the delta. The earlier "no cache benefit"
// rationale predates that feature; see docs/PROVIDERS.md.
//
// Tool-loop (§5.4 / §8.1 Path A): the HTTP API is stateless — when the model
// emits `tool_calls`, the *caller* is responsible for executing them and
// appending results to the next request. `run()` is a loop: stream one
// assistant message → if it carries tool_calls, dispatch to ollamaTools.ts,
// append role:'tool' results, loop. Capped at MAX_TOOL_TURNS. AUTO mode
// (skipPermissions=true) executes tools server-side; SAFE mode returns a
// denial string the model sees as the tool result, so the loop converges
// without requiring a new operator-approval protocol surface (plan §5.4
// option (a)).

const DEFAULT_BASE = 'http://localhost:11434';
const OLLAMA_CHAT_WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);

export function ollamaToolCandidates(
  config: Pick<WorkerConfig, 'cwd' | 'interactionMode' | 'chatWebAccess' | 'tools' | 'clusterId' | 'workflowId' | 'clusterAccessMode' | 'voiceOperator'>,
): OllamaToolDefinition[] | undefined {
  if (!config.cwd) return undefined;
  if (config.interactionMode === 'chat') {
    if (config.voiceOperator) return computerToolDefinitions() as OllamaToolDefinition[];
    if (!config.chatWebAccess) return undefined;
    return getOllamaToolDefinitions().filter((tool) => OLLAMA_CHAT_WEB_TOOLS.has(tool.function.name));
  }
  const all = getOllamaToolDefinitions({
    clusterEnabled: !!config.clusterId && !!config.workflowId,
    mailboxOnly: config.clusterAccessMode !== undefined && config.clusterAccessMode !== 'standard',
  });
  return config.tools
    ? all.filter((tool) => config.tools!.includes(tool.function.name))
    : all;
}

export function ollamaToolsAutoExecute(
  config: Pick<WorkerConfig, 'skipPermissions' | 'interactionMode' | 'chatWebAccess' | 'voiceOperator'>,
): boolean {
  // Chat's armed surface is already narrowed above to two read-only network
  // tools. It has no AUTO control, so execute those calls directly; Agent SAFE
  // mode remains unchanged for the full filesystem/shell-capable registry.
  return config.skipPermissions === true
    || (config.interactionMode === 'chat' && (config.voiceOperator === true || config.chatWebAccess === true));
}

export function ollamaToolCallAllowed(
  config: Pick<WorkerConfig, 'interactionMode' | 'chatWebAccess' | 'voiceOperator'>,
  toolName: string,
): boolean {
  // Enforce Chat's web-only boundary again at dispatch. A model can hallucinate
  // a known tool that was absent from tools[] (or from the fenced prompt); the
  // advertised allowlist alone is therefore not a security boundary.
  if (config.interactionMode !== 'chat') return true;
  if (config.voiceOperator) return computerToolDefinitions().some((t) => t.function.name === toolName);
  return config.chatWebAccess === true && OLLAMA_CHAT_WEB_TOOLS.has(toolName);
}

export function ollamaChatWebReminder(
  config: Pick<WorkerConfig, 'interactionMode' | 'chatWebAccess'>,
): string {
  if (config.interactionMode !== 'chat' || config.chatWebAccess !== true) return '';
  return [
    '[Current Arco Chat capability]',
    'WebSearch and WebFetch are attached and available for this turn.',
    'Any earlier message or reasoning saying web access was unavailable describes an older capability state and is obsolete.',
    'When the operator asks for a search, call WebSearch now.',
  ].join(' ');
}

export function ollamaBase(): string {
  return (process.env.OLLAMA_URL_BASE ?? DEFAULT_BASE).replace(/\/+$/, '');
}

// DD12 — the configured baseUrl may be a literal URL or an unresolved
// `!cmd` / `${ENV}` ref. Resolve it, then URL-validate AFTER resolution; on a
// missing/invalid/failed resolution, fall back to the env→localhost default
// rather than handing a bad URL to fetch. Never logs the resolved value.
async function resolveOllamaBaseRef(configured: string | undefined): Promise<string> {
  if (!configured) return ollamaBase();
  const resolved = await resolveConfigValue(configured);
  const v = resolved.value?.trim().replace(/\/+$/, '');
  if (v && /^https?:\/\/[^/\s]+(?::\d+)?$/.test(v)) return v;
  if (resolved.error) console.warn(`[ollama] baseUrl ref did not resolve (${resolved.error}); using default`);
  else if (v) console.warn('[ollama] resolved baseUrl is not a valid host URL; using default');
  return ollamaBase();
}

export async function getOllamaBase(): Promise<string> {
  const settings = await readSettings();
  return resolveOllamaBaseRef(settings.ollama?.baseUrl);
}

// M4 — resolve the operator's configured Ollama backends. Back-compat: when
// `settings.ollama.backends` is empty/unset, synthesize a SINGLE backend from
// the legacy baseUrl→env→localhost cascade so a pre-M4 operator sees identical
// behavior (degenerate one-backend case). Also returns the optional model→host
// affinity hint. The probe/status paths still use getOllamaBase() (the primary
// backend) — multi-backend only changes the chat path; see getOllamaPrimaryBase.
export async function getOllamaBackends(): Promise<{
  backends: ResolvedBackend[];
  modelHostMap: Record<string, string[]>;
}> {
  const settings = await readSettings();
  const configured = settings.ollama?.backends ?? [];
  const modelHostMap = settings.ollama?.modelHostMap ?? {};
  if (configured.length > 0) {
    const resolved = resolveBackends(configured);
    if (resolved.length > 0) return { backends: resolved, modelHostMap };
  }
  // Degenerate one-backend case — the legacy cascade (baseUrl may be a ref).
  const base = await resolveOllamaBaseRef(settings.ollama?.baseUrl);
  return { backends: [singleBackend(base)], modelHostMap };
}

// Ollama's tool_call shape on the wire — OpenAI-compatible. The Claude
// path emits `{name, input}` where input is JSON-stringified; we normalize
// in dispatchToolCalls() so upstream WorkerManager doesn't care which
// provider produced the call (plan §8.3).
interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
  // Set when the model emitted `arguments` as a malformed JSON string;
  // dispatchToolCalls short-circuits with the error so the model sees
  // what was wrong and can retry rather than getting a defaulted execution.
  argError?: string;
}

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  // Per /api/chat: array of base64-encoded image bytes attached to a
  // user-role message. Only set when the operator attached images this
  // turn; absent on every other message so the prefix cache stays
  // byte-stable across turns. Vision-capable model required (e.g.
  // qwen3-vl); a text-only model will silently ignore.
  images?: string[];
  // Native thinking parsers (qwen3.5, qwen3-vl-thinking, deepseek3, ...)
  // surface reasoning in this separate field instead of embedded
  // <think>...</think> markers in `content`. We round-trip it back into
  // the assistant message so the model sees its own prior reasoning
  // across tool-loop iterations within a turn (Thinking Preservation,
  // plan §8.4). Only set on assistant messages from a model that emitted
  // it; absent everywhere else so the prefix cache stays byte-stable.
  thinking?: string;
}

// Ollama's /api/chat tool API is a top-level `tools` array ONLY. It does
// NOT understand the OpenAI-style `tool_choice` or `functions` fields — and
// worse than ignoring them, a body carrying either can make /api/chat HANG
// (the NDJSON stream never starts). litellm deletes both before calling
// Ollama for exactly this reason. This interface deliberately omits them so
// they can't be set through the typed builder; the runtime strip in
// streamOneTurn is the belt-and-suspenders guard against an untyped reintro.
interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: true;
  // Per-request keep_alive — see KEEP_ALIVE constant for rationale on the
  // chosen value. String ("10m") and numeric (-1 = forever, 0 = evict)
  // forms both accepted by the daemon.
  keep_alive: number | string;
  options: Record<string, unknown>;
  // Omitted when there are no tools — heretic reviewer slot stays single-shot
  // text and Modelfile-default token budget. Present when AUTO mode is on
  // and the workflow has a cwd (the runtime's blast-radius anchor).
  tools?: OllamaToolDefinition[];
  // Enable/disable native thinking on models with a thinking-aware parser
  // (qwen3.5, qwen3-vl-thinking, deepseek3, gpt-oss, ...). For
  // non-thinking models the daemon ignores it. We derive this from
  // `effort`: low → false (fast mode), anything else → true. Models
  // that lack the native parser still see the `/no_think` system-prompt
  // prepend as a fallback (plan §6.2 Option A).
  think?: boolean | string; // string = a graded level from /api/show thinking.values
  // M5 — structured output. Top-level (sibling of messages/options/tools), NOT
  // inside options. Either "json" (free-form JSON) or a raw JSON-Schema object
  // — the daemon constrains decoding at the sampler level to match. Omitted on
  // every normal turn so the prefix cache and free-text turns are untouched.
  // Set only by structured primitives, and ONLY on a tool-free turn (a turn
  // carrying tools can't simultaneously grammar-constrain to JSON — the two are
  // mutually exclusive in practice; format would suppress tool_calls).
  format?: 'json' | Record<string, unknown>;
}

// Hard cap on assistant tool-loop iterations within a single operator turn.
// Default 50 — local models genuinely need more rope on multi-step coding
// work than the original 25 (model preparation paralysis, retries on Edit
// exact-string-match, etc.). The ToolLoopDetector below catches *pointless*
// repetition in 3 turns, so this cap only fires when real progress is being
// made and there's just a lot of it. Tune via ARCO_OLLAMA_MAX_TOOL_TURNS.
const MAX_TOOL_TURNS = (() => {
  const env = process.env.ARCO_OLLAMA_MAX_TOOL_TURNS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0 && n <= 200) return n;
  }
  return 50;
})();

// Local thinking models sometimes emit a "final" assistant message that is
// really just preparation ("let me check...", "Step 1...") and contains no
// tool_calls. The HTTP API has no stronger signal than "no tool_calls", so
// continue once or twice with a private coaching message instead of ending
// the operator turn on a false start.
const MAX_PREPARATORY_CONTINUATIONS = 2;
const MAX_CLUSTER_REPORT_CONTINUATIONS = 1;

function looksPreparatoryOnly(text: string): boolean {
  const normalized = text
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.length > 1200) return false;

  const lower = normalized.toLowerCase();
  const startsPreparatory =
    /^(let me|i(?:'ll| will| am going to|’ll)|i need to|first[, ]|next[, ]|now[, ]|step\s+\d+[:.)])\b/.test(lower) ||
    /\b(let me|i(?:'ll| will| am going to|’ll)|i need to)\s+(check|read|inspect|examine|run|look|search|verify|continue|start)\b/.test(lower);
  if (!startsPreparatory) return false;

  const hasCompletionSignal =
    /\b(pass|fail|done|completed|fixed|changed|verified|found|evidence|summary|result|no issues|no hazards)\b/.test(lower) ||
    /\b(exit code|stdout|stderr|diff|commit|status)\b/.test(lower);
  return !hasCompletionSignal;
}

// M8 — render a tool-call's parsed args to a short string for the utility-model
// summary prompt. Bounded so a giant Write `content` doesn't blow the summary's
// own input window; the byte cap in runUtilityJob is the second guard.
function safeStringifyArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
  } catch {
    return '{…}';
  }
}

function shouldRequireClusterPeerReport(
  config: WorkerConfig,
  observedToolNames: ReadonlySet<string>,
): boolean {
  if (!config.clusterId || !config.workflowId) return false;
  if (observedToolNames.has('peer_send')) return false;

  const role = (config.clusterRole ?? '').toLowerCase();
  if (/\b(coordinator|director)\b/.test(role)) return false;

  return true;
}

// Image-attachment cap. Matches Claude's IMAGE_MAX_BYTES — Anthropic's API
// rejects images >5 MB base64, and Ollama doesn't have a documented hard
// cap but >5 MB images are usually a sign the operator screenshot a 4K
// monitor; resize first if you genuinely need that resolution. Caught
// here, not at /api/chat, so the operator gets a clear early error.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

// Image media types Ollama's /api/chat understands (via the underlying
// vision model's CLIP/projector). PNG/JPEG/WebP/GIF cover all common
// screenshot/photo formats; HEIC/AVIF would need conversion first.
const IMAGE_EXT: Record<string, true> = {
  '.png': true,
  '.jpg': true,
  '.jpeg': true,
  '.gif': true,
  '.webp': true,
};

function classifyAttachment(path: string): { kind: 'image' } | { kind: 'other' } {
  return IMAGE_EXT[extname(path).toLowerCase()] ? { kind: 'image' } : { kind: 'other' };
}

// Per-request keep_alive. The plan originally specified -1 (forever) for
// cache reliability, but in practice with OLLAMA_NUM_PARALLEL=1 and
// OLLAMA_MAX_LOADED_MODELS=1 the prefix cache stays clean as long as the
// model is loaded *at all* — it doesn't have to be loaded forever. A
// 10-minute idle window is far longer than between active turns and short
// enough that an unattended workflow doesn't camp ~22GB of VRAM
// indefinitely (Qwen3.6 UD-Q4_K_XL: 17GB model + ~5GB KV at 32K q8_0). The
// 5-10s reload from NVMe on the first turn after a long break is
// negligible compared to the model's per-turn decode cost.
//
// Operators who want forever-loaded behavior can override with the
// `OLLAMA_KEEP_ALIVE` env at the daemon level — that wins for any request
// that doesn't carry an explicit keep_alive (none from Arco today, but
// open-webui / external clients would inherit it).
const KEEP_ALIVE = '10m';

interface OllamaShowMetadata {
  numCtx?: number;
  // `<arch>.context_length` — the operator num_ctx ceiling when the Modelfile
  // sets none (ollamaParams.clampNumCtx). Never used as a window by itself.
  archCtx?: number;
  // The window /api/ps measured after a turn that sent no num_ctx — i.e. the
  // daemon's own default for this model. Filled from measuredLoadedCtx.
  loadedCtx?: number;
  capabilities: string[];
  // /api/show `thinking.{values,default}` — graded levels (qwen3.8, gpt-oss).
  thinking?: OllamaThinkingInfo;
}

// What streamOneTurn needs to build `think`: false ⇒ omit the field (no native
// parser; Ollama rejects think:true there), true ⇒ boolean-only model, info ⇒
// level-capable model.
type NativeThinking = false | true | OllamaThinkingInfo;
function nativeThinkingOf(meta: OllamaShowMetadata): NativeThinking {
  if (!meta.capabilities.includes('thinking')) return false;
  return meta.thinking && meta.thinking.levels.length > 0 ? meta.thinking : true;
}

// Probe the resolved model's configured num_ctx and native capabilities via
// /api/show. num_ctx is the Modelfile-set value (e.g. 32768 for
// qwen3.6-coder), not the architecture's theoretical max from
// `<arch>.context_length`. Capabilities gate request fields such as
// `think`; Ollama rejects `think:true` for GGUFs whose metadata lacks the
// native thinking parser even if the model emits raw <think> tags itself.
// M4 — `base` selects WHICH backend to probe. The trusted num_ctx ceiling is
// per-backend: a model can be loaded with a different window on different hosts
// (M3 handoff note), so the chat path probes the SAME backend it will dispatch
// the turn to. Defaults to the legacy single-base cascade for non-chat callers.
// Measured daemon-default windows, keyed base + NUL + model. Module-level on
// purpose: the per-turn failoverCtx is rebuilt every operator turn, and the
// first compaction check runs before any dispatch, so a per-turn cache would
// never be warm when it matters. The daemon is shared, so the value is too.
// Before 2026-09-29 a stock tag (no Modelfile num_ctx) had no known window at
// all: no auto-compaction, and a CTX bar dividing by the 2048 floor (100%).
const measuredLoadedCtx = new Map<string, number>();
const loadedCtxKey = (base: string, model: string) => `${base}\u0000${model}`;

async function fetchModelShowMetadata(model: string, base?: string): Promise<OllamaShowMetadata> {
  const meta = await fetchModelShowMetadataRaw(model, base);
  const loadedCtx = base !== undefined ? measuredLoadedCtx.get(loadedCtxKey(base, model)) : undefined;
  return loadedCtx !== undefined ? { ...meta, loadedCtx } : meta;
}

async function fetchModelShowMetadataRaw(model: string, base?: string): Promise<OllamaShowMetadata> {
  try {
    const resolvedBase = base ?? await getOllamaBase();
    const res = await fetch(`${resolvedBase}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { capabilities: [] };
    const data = await res.json() as { parameters?: string; capabilities?: unknown; thinking?: unknown; model_info?: unknown };
    const params = typeof data.parameters === 'string' ? data.parameters : '';
    const archCtx = parseArchContextLength(data.model_info);
    const capabilities = Array.isArray(data.capabilities)
      ? data.capabilities.filter((c): c is string => typeof c === 'string')
      : [];
    const thinking = parseOllamaThinking(data.thinking) ?? undefined;
    // parameters comes as a multi-line "key   value" string; whitespace
    // delimited, value can be a number or a quoted string. We only want
    // num_ctx — match the line and parse the integer.
    const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(params);
    if (!m) return { capabilities, ...(thinking ? { thinking } : {}), ...(archCtx ? { archCtx } : {}) };
    const numCtx = parseInt(m[1], 10);
    return {
      capabilities,
      ...(thinking ? { thinking } : {}),
      ...(archCtx ? { archCtx } : {}),
      ...(Number.isFinite(numCtx) && numCtx > 0 ? { numCtx } : {}),
    };
  } catch {
    return { capabilities: [] };
  }
}

// The catalog picks a model alias (today: "heretic", "coder"). The actual
// installed Ollama tag is something like "qwen3.5:35b-heretic". We resolve
// the alias against the live tag list at spawn time. Falls back to the
// literal model string if no fuzzy match — supports operators who put the
// colon-form name straight into the catalog.
async function resolveOllamaModel(alias: string, base?: string): Promise<string> {
  const trimmed = alias.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes(':')) return trimmed;
  try {
    const resolvedBase = base ?? await getOllamaBase();
    const res = await fetch(`${resolvedBase}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return trimmed;
    const data = await res.json() as { models?: Array<{ name?: string }> };
    const installed = (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    const lc = trimmed.toLowerCase();
    const hit = installed.find((n) => n.toLowerCase().includes(lc));
    return hit ?? trimmed;
  } catch {
    return trimmed;
  }
}

// M4 — list the installed model tags on one backend, for the per-backend
// `servesModel` knowledge that drives multi-backend selection. Returns null on
// a probe failure (host down / timeout) — distinct from `[]` (host up, no
// models): a null means "unknown", which selection treats optimistically so a
// momentarily-unreachable host isn't permanently excluded by a stale probe.
// Cheap (/api/tags is metadata-only) and short-timeout so a hung host doesn't
// stall selection.
async function fetchBackendModels(base: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json() as { models?: Array<{ name?: string }> };
    return (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
  } catch {
    return null;
  }
}

// Walk the rendered transcript ("USER: ..\nAGENT: ..", joined with \n\n —
// see exportContext.renderTranscript) into structured messages. Returns
// [] when the input has no markers, which is the heretic reviewer slot's
// shape (single user prompt blob lives in the final-turn message instead).
//
// Byte-stability: identical input text yields byte-identical messages, so
// the prefix cache hits cleanly across turns. A turn boundary is a line
// that begins with `USER: ` or `AGENT: `; everything else is appended to
// the open turn's body, preserving multi-paragraph content verbatim.
export function parseRenderedTranscript(text: string): OllamaChatMessage[] {
  const out: OllamaChatMessage[] = [];
  let role: 'user' | 'assistant' | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (role && buf.length > 0) {
      const content = buf.join('\n').trim();
      if (content) out.push({ role, content });
    }
    buf = [];
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('USER: ')) {
      flush();
      role = 'user';
      buf.push(line.slice('USER: '.length));
    } else if (line.startsWith('AGENT: ')) {
      flush();
      role = 'assistant';
      buf.push(line.slice('AGENT: '.length));
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

// Returns the largest prefix length k such that buf.slice(k) is NOT a
// prefix of `marker` — i.e. everything up to k is safe to emit because the
// trailing bytes can't yet form the start of a marker. Used to hold back
// chunk-straddling `<think>` / `</think>` boundaries.
function trimTrailingPartialMarker(buf: string, marker: string): number {
  const max = Math.min(buf.length, marker.length - 1);
  for (let n = max; n >= 1; n--) {
    if (marker.startsWith(buf.slice(buf.length - n))) {
      return buf.length - n;
    }
  }
  return buf.length;
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';
// Bytes the splitter will buffer at the head of a stream waiting to see
// which reasoning format the model uses, before giving up and committing to
// "no reasoning, plain text". Reasoning models that emit a tag almost always
// do so in the first chunk; 4 KB is a generous ceiling that still keeps
// non-reasoning models' first-byte latency tolerable.
const UNDETERMINED_SOFT_CAP = 4096;

// Streaming reasoning splitter. Two formats appear in the wild:
//
//   Paired:       "<think> ...reasoning... </think> ...answer..."
//                 (Qwen3.6 reference shape; Plan §5.3 was written for this.)
//   Orphan-close: "...reasoning... </think> ...answer..."
//                 (some local model variants — operator hit this with
//                 qwopus-moe-35b-a3b. Reasoning is implicit at the start of
//                 the stream and only the closing tag is emitted.)
//
// At stream start we don't yet know which format is in use, so we buffer in
// an `undetermined` state until the first tag arrives — that tag's identity
// resolves the format. Whichever tag comes first wins:
//   - `<think>` first  → standard paired format. Anything prior is text.
//   - `</think>` first → orphan-close format. Anything prior is thinking.
// Past that point the state machine is the standard "in_think / out_think"
// pair tracker. Markers may straddle chunk boundaries; trailing partial-
// marker bytes are held back until they complete.
//
// Fallback: if the buffer crosses UNDETERMINED_SOFT_CAP without any tag,
// assume the model is non-reasoning and commit to text mode. Without this
// the splitter would silently swallow the entire response of a plain-text
// model.
export class ThinkSplitter {
  private state: 'undetermined' | 'in_think' | 'out_think' = 'undetermined';
  private pending = '';

  push(chunk: string): { thinking: string; text: string } {
    let buf = this.pending + chunk;
    this.pending = '';
    let thinking = '';
    let text = '';

    while (buf.length > 0) {
      if (this.state === 'undetermined') {
        const open = buf.indexOf(THINK_OPEN);
        const close = buf.indexOf(THINK_CLOSE);
        if (open === -1 && close === -1) {
          if (buf.length >= UNDETERMINED_SOFT_CAP) {
            // No marker after a generous wait. Commit to text mode so the
            // operator isn't staring at a stalled bubble. Re-emit safely
            // by withholding any tail that could still become a marker.
            const safeOpen = trimTrailingPartialMarker(buf, THINK_OPEN);
            const safeClose = trimTrailingPartialMarker(buf, THINK_CLOSE);
            const safe = Math.min(safeOpen, safeClose);
            text += buf.slice(0, safe);
            this.pending = buf.slice(safe);
            this.state = 'out_think';
            return { thinking, text };
          }
          // Hold the whole buffer until a tag arrives or the cap trips.
          this.pending = buf;
          return { thinking, text };
        }
        // Pick whichever tag comes first. Equal indices isn't possible
        // since the strings differ in length and start byte.
        const closeFirst = close !== -1 && (open === -1 || close < open);
        if (closeFirst) {
          thinking += buf.slice(0, close);
          buf = buf.slice(close + THINK_CLOSE.length);
          this.state = 'out_think';
        } else {
          text += buf.slice(0, open);
          buf = buf.slice(open + THINK_OPEN.length);
          this.state = 'in_think';
        }
        continue;
      }

      if (this.state === 'in_think') {
        const close = buf.indexOf(THINK_CLOSE);
        if (close === -1) {
          const safe = trimTrailingPartialMarker(buf, THINK_CLOSE);
          thinking += buf.slice(0, safe);
          this.pending = buf.slice(safe);
          return { thinking, text };
        }
        thinking += buf.slice(0, close);
        buf = buf.slice(close + THINK_CLOSE.length);
        this.state = 'out_think';
        continue;
      }

      // out_think
      const open = buf.indexOf(THINK_OPEN);
      if (open === -1) {
        const safe = trimTrailingPartialMarker(buf, THINK_OPEN);
        text += buf.slice(0, safe);
        this.pending = buf.slice(safe);
        return { thinking, text };
      }
      text += buf.slice(0, open);
      buf = buf.slice(open + THINK_OPEN.length);
      this.state = 'in_think';
    }
    return { thinking, text };
  }

  // Drain any pending bytes when the stream ends. `undetermined` at EOF
  // means no tag ever arrived → plain text. `in_think` at EOF is malformed
  // (open without close) but we don't lose the bytes — emit as thinking.
  flush(): { thinking: string; text: string } {
    const out = this.state === 'in_think'
      ? { thinking: this.pending, text: '' }
      : { thinking: '', text: this.pending };
    this.pending = '';
    return out;
  }
}

// Exported for the offline smoke harness (scripts/smoke/ollama-ctx-fallback.ts),
// which drives a real worker with a stubbed global.fetch to exercise the M9
// reactive seam end-to-end (overflow 400 → re-dispatch on a larger window).
// Production code uses the OllamaProvider factory below.
export class OllamaWorkerProcess extends EventEmitter implements ProviderProcess {
  readonly id: string;
  readonly config: WorkerConfig;
  private abortController: AbortController | null = null;
  private _status: WorkerStatus = 'spawning';
  private _output = '';
  private outputCapped = false;
  // Injectable RNG for the weighted-shuffle backend selection. Defaults to
  // Math.random in production (zero behavior change); the offline smokes set a
  // deterministic source so multi-backend selection is reproducible (otherwise
  // an equal-weight 2-backend test races on WHICH host is picked first).
  private rng: () => number = Math.random;

  constructor(id: string, config: WorkerConfig) {
    super();
    this.id = id;
    this.config = config;
  }

  // TEST-ONLY seam: pin the selection RNG so the offline integration smokes are
  // deterministic. Production never calls this — the default Math.random stands.
  __setRngForTest(rng: () => number): void {
    this.rng = rng;
  }

  get status(): WorkerStatus {
    return this._status;
  }

  get output(): string {
    return this._output;
  }

  spawn(prompt: string): void {
    this.abortController = new AbortController();
    void this.run(prompt);
  }

  // Build the structured message stack from systemPrompt + appendSystemPrompt
  // + the new turn. Items 1 and 2 must be byte-stable across turns within a
  // workflow for the prefix cache to hit; only the final message grows.
  //
  // Operator-attached images are base64-embedded into the final user message
  // via /api/chat's `images` field — works against vision-capable models
  // (qwen3-vl, qwen2.5vl, gemma3, llama3.2-vision, etc.). Non-image
  // attachments fall back to text-mention so the operator's intent isn't
  // silently dropped if they drop a PDF or .md file alongside images. Read
  // failures or oversized images surface as a system_notice rather than
  // corrupting the request body.
  //
  // Effort mapping (plan §6.2 Option A): `low` prepends `/no_think` to the
  // system prompt so Qwen-family models skip the reasoning pass — fast-mode
  // for trivial asks. Anything else leaves native Thinking Preservation on.
  // The prefix is byte-stable per-effort-value so the prefix cache hits
  // cleanly within a same-effort run; switching effort mid-workflow is an
  // explicit cache-invalidation event the operator opted into.
  private buildMessages(userPrompt: string): OllamaChatMessage[] {
    const messages: OllamaChatMessage[] = [];
    const noThink = this.config.effort === 'low';
    // docs/GOTCHAS.md - fold the operator's north-star at the top of the
    // system message. Covers operator turns AND primitive seeds. Blank ⇒ unchanged.
    const northStarBlock = goalBlock(this.config.goal);
    const baseSystem = northStarBlock
      ? (this.config.systemPrompt ? `${northStarBlock}\n\n${this.config.systemPrompt}` : northStarBlock)
      : (this.config.systemPrompt ?? '');
    const systemContent = noThink
      ? (baseSystem ? `/no_think\n${baseSystem}` : '/no_think')
      : baseSystem;
    if (systemContent) {
      messages.push({ role: 'system', content: systemContent });
    }
    if (this.config.appendSystemPrompt) {
      messages.push(...(this.config.voiceOperator ? parseComputerHistory(this.config.appendSystemPrompt) : parseRenderedTranscript(this.config.appendSystemPrompt)));
    }

    const images: string[] = [];
    const nonImagePaths: string[] = [];
    for (const p of this.config.attachments ?? []) {
      const cls = classifyAttachment(p);
      if (cls.kind !== 'image') {
        nonImagePaths.push(p);
        continue;
      }
      try {
        const src = modelImagePath(p);
        const size = statSync(src).size;
        if (size > IMAGE_MAX_BYTES) {
          this.emit('system_notice', `attachment "${p}" exceeds ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)}MB image limit — skipped`);
          continue;
        }
        images.push(readFileSync(src).toString('base64'));
      } catch (err) {
        this.emit('system_notice', `attachment "${p}" unreadable: ${err instanceof Error ? err.message : String(err)} — skipped`);
      }
    }

    let text = userPrompt;
    const chatWebReminder = ollamaChatWebReminder(this.config);
    if (chatWebReminder) text += `\n\n${chatWebReminder}`;
    if (nonImagePaths.length > 0) {
      text += '\n\n' + nonImagePaths.map((p) => `[attached file: ${p}]`).join('\n');
    }

    const finalMessage: OllamaChatMessage = { role: 'user', content: text };
    if (images.length > 0) finalMessage.images = images;
    messages.push(finalMessage);
    return messages;
  }

  private emitText(chunk: string): void {
    if (!chunk || this.outputCapped) return;
    const remaining = MAX_WORKER_OUTPUT_BYTES - this._output.length;
    if (chunk.length <= remaining) {
      this._output += chunk;
      this.emit('text', chunk);
    } else {
      const fit = remaining > 0 ? chunk.slice(0, remaining) : '';
      if (fit) {
        this._output += fit;
        this.emit('text', fit);
      }
      this._output += OUTPUT_TRUNCATION_NOTICE;
      this.emit('text', OUTPUT_TRUNCATION_NOTICE);
      this.outputCapped = true;
      this.kill();
    }
  }

  // Stream one /api/chat call to completion against ONE backend. Returns the
  // assembled assistant message (raw content, plus any tool_calls), the usage
  // counters from the trailing `done:true` event, and a sentinel for when the
  // stream errored or was aborted. The raw content goes back into the next
  // turn's `messages` so Qwen's Thinking Preservation (§8.4) keeps `<think>`
  // blocks across the loop within a turn.
  //
  // M4 — the result is a DISCRIMINATED type so the multi-backend wrapper can
  // tell apart: `ok` (completed), `abort` (operator cancel — bail), and `error`
  // (transport/HTTP failure — the wrapper classifies + maybe fails over). On an
  // `error` this method does NOT call this.fail(); the wrapper owns the
  // terminal decision after exhausting retries. `base` is the chosen backend's
  // base URL. A cheap liveness probe fails dead hosts fast; the real chat call
  // gets a larger stream-start budget so cold large-model loads can complete.
  private async streamOneTurn(
    base: string,
    model: string,
    messages: OllamaChatMessage[],
    tools: OllamaToolDefinition[] | undefined,
    nativeThinking: NativeThinking,
    // The backend's /api/show probe — Modelfile num_ctx + arch max form the
    // trusted ceiling for the operator's num_ctx (ollamaParams.clampNumCtx).
    ctxMeta: Pick<OllamaShowMetadata, 'numCtx' | 'archCtx'>,
    // M5 — structured-output schema (or "json"). Honored ONLY when this turn
    // advertises no tools; format + tools are mutually exclusive on the wire.
    format?: 'json' | Record<string, unknown>,
    // M9 — ctx-fallback num_ctx bump. When set, FORCE this exact num_ctx onto
    // the request, overriding the operator preset clamp. The caller (M9 seam)
    // passes the model's full probed trusted ceiling so a turn that overflowed
    // a smaller window (preset-below-ceiling or the daemon 2048 default) gets
    // re-dispatched against the largest window the model was built to handle.
    // Trusted-ceiling rule still holds: the caller only ever passes a probed
    // value, never a guess. Omitted on every normal turn.
    forceNumCtx?: number,
  ): Promise<
    | {
        ok: true;
        assistantMessage: OllamaChatMessage;
        usage: { inputTokens: number; outputTokens: number; durationMs: number; genSpeed: GenSpeedSample | null };
        sawDone: boolean;
      }
    | { ok: false; abort: true }
    | { ok: false; abort: false; error: unknown; httpStatus?: number }
  > {
    // M3 — apply the per-tab preset blob through the typed allowlist boundary.
    // `applied.options` are generation params for the envelope; `applied.root`
    // is keep_alive (lifts to the body root, NOT into options). num_ctx is
    // trusted-only: clampNumCtx omits it unless the operator's value is within
    // the model's probed Modelfile window (never a guess — Hardening §3).
    const applied = applyOllamaParams(this.config.ollamaParams, ctxMeta.numCtx, ctxMeta.archCtx);

    // M9 — ctx-fallback num_ctx bump. Force the larger probed window onto the
    // options envelope, overriding whatever the operator preset clamped to. Only
    // ever a probed (trusted) value — never a guess (trusted-ceiling rule). This
    // is the same-backend escalation arm: the failing turn ran on a smaller
    // window; re-dispatch on the model's full ceiling. NOTE: this deliberately
    // breaks the per-turn byte-stability of `options` for THIS one re-dispatch —
    // acceptable because it's a one-off recovery, not the steady-state loop, and
    // the alternative (a turn that simply 400s and dies) is strictly worse.
    if (typeof forceNumCtx === 'number' && Number.isFinite(forceNumCtx) && forceNumCtx > 0) {
      applied.options.num_ctx = forceNumCtx;
    }

    const body: OllamaChatRequest = {
      model,
      messages,
      stream: true,
      // keep_alive default; an operator preset overrides it (resolved below).
      // keep_alive is a ROOT field, never inside options — the daemon ignores
      // it under options.
      keep_alive: typeof applied.root.keep_alive === 'string' || typeof applied.root.keep_alive === 'number'
        ? applied.root.keep_alive
        : KEEP_ALIVE,
      // Generation params (temperature, top_p, num_ctx, num_predict, ...) live
      // INSIDE this `options` envelope per the /api/chat contract — they are
      // NOT top-level body fields. The M3 preset system populates it from the
      // operator's per-tab blob (allowlisted + type-coerced). PREFIX-CACHE
      // INVARIANT: this object must stay byte-stable across a workflow's turns
      // — the blob is read straight from wf.config (which only mutates via the
      // operator-driven updatePrimaryConfig path, logged there as an explicit
      // cache-invalidation event). Never mutate options per-turn from anything
      // turn-local, or every turn re-prefills the whole prompt.
      options: applied.options,
      ...(tools && tools.length > 0 ? { tools } : {}),
      // Native thinking on for non-low effort. Models with a thinking
      // parser (qwen3.5, qwen3-vl-thinking, ...) emit reasoning into
      // `message.thinking` separately from `message.content`; we read
      // both below. Models without a native parser get the `/no_think`
      // system-prompt prepend on low effort and ignore this field.
      // Level-capable models (thinking.values) get the mapped level string;
      // boolean-only ones keep `effort !== 'low'` (ollamaThinkParam(null)).
      ...(nativeThinking !== false
        ? { think: ollamaThinkParam(this.config.effort, nativeThinking === true ? null : nativeThinking) }
        : {}),
      // M5 — top-level `format` for structured output. Gated on a tool-free
      // turn: a request carrying both `tools` and a JSON-schema `format` can't
      // do both (grammar-constrained decoding suppresses tool_calls), so we only
      // attach it when no tools are advertised. The caller (run()) arranges a
      // dedicated tool-free synthesis turn for the structured path.
      ...(format && !(tools && tools.length > 0) ? { format } : {}),
    };

    // Belt-and-suspenders: never let OpenAI-style `tool_choice` / `functions`
    // reach /api/chat. The typed builder above can't add them, but a future
    // edit that spreads an untyped object into the body could — and Ollama
    // HANGS (stream never starts) when either is present. Strip defensively.
    {
      const raw = body as unknown as Record<string, unknown>;
      delete raw.tool_choice;
      delete raw.functions;
    }

    // M4 connect-timeout + cold-load guard. A dead host must fail fast, but
    // Ollama may not send /api/chat response headers until a cold large model is
    // loaded. Probe /api/version under the short connect budget first; once the
    // daemon is known live, allow a longer stream-start budget for /api/chat
    // headers. Decode/streaming stays unbounded after headers arrive.
    const operatorSignal = this.abortController!.signal;
    const probeController = new AbortController();
    const onProbeOperatorAbort = (): void => probeController.abort(operatorSignal.reason);
    if (operatorSignal.aborted) probeController.abort(operatorSignal.reason);
    else operatorSignal.addEventListener('abort', onProbeOperatorAbort, { once: true });
    const probeTimer = setTimeout(() => {
      probeController.abort(new DOMException(`Ollama connect timeout ${CONNECT_TIMEOUT_MARKER}`, 'AbortError'));
    }, OLLAMA_CONNECT_TIMEOUT_MS);
    try {
      const probe = await fetch(`${base}/api/version`, { signal: probeController.signal });
      clearTimeout(probeTimer);
      operatorSignal.removeEventListener('abort', onProbeOperatorAbort);
      if (!probe.ok) {
        return {
          ok: false,
          abort: false,
          error: new Error(`Ollama liveness HTTP ${probe.status} ${CONNECT_TIMEOUT_MARKER}`),
          httpStatus: probe.status,
        };
      }
    } catch (err) {
      clearTimeout(probeTimer);
      operatorSignal.removeEventListener('abort', onProbeOperatorAbort);
      if (this.isAborted(err) && !(err instanceof Error && err.message.includes(CONNECT_TIMEOUT_MARKER))) {
        return { ok: false, abort: true };
      }
      return { ok: false, abort: false, error: err };
    }

    const streamStartController = new AbortController();
    const onOperatorAbort = (): void => streamStartController.abort(operatorSignal.reason);
    if (operatorSignal.aborted) streamStartController.abort(operatorSignal.reason);
    else operatorSignal.addEventListener('abort', onOperatorAbort, { once: true });
    const streamStartTimer = setTimeout(() => {
      streamStartController.abort(new DOMException(`Ollama stream start timeout ${CONNECT_TIMEOUT_MARKER}`, 'AbortError'));
    }, OLLAMA_STREAM_START_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: streamStartController.signal,
      });
    } catch (err) {
      clearTimeout(streamStartTimer);
      operatorSignal.removeEventListener('abort', onOperatorAbort);
      // Operator cancel → bail (no failover). A stream-start timeout carries
      // the marker and is reported as a retryable error instead.
      if (this.isAborted(err) && !(err instanceof Error && err.message.includes(CONNECT_TIMEOUT_MARKER))) {
        return { ok: false, abort: true };
      }
      return { ok: false, abort: false, error: err };
    }
    // Headers arrived — the connection is alive. Stop the stream-start timeout, but
    // KEEP the operator-abort bridge wired so a cancel during streaming still
    // aborts the underlying body read (streamStartController is what the body
    // reader is bound to). The bridge is torn down in the finally below.
    clearTimeout(streamStartTimer);

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      // Surface the HTTP status to the wrapper's classifier — 5xx/429 are
      // retryable + cool the backend; 4xx (incl. 400 context overflow) are not.
      return {
        ok: false,
        abort: false,
        error: new Error(`Ollama HTTP ${res.status} (${model}): ${detail.slice(0, 200)}`),
        httpStatus: res.status,
      };
    }

    const splitter = new ThinkSplitter();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let durationMs = 0;
    let genSpeed: GenSpeedSample | null = null;
    let sawDone = false;
    let rawContent = '';
    let rawThinking = '';
    const accumulatedToolCalls: OllamaToolCall[] = [];

    try {
      let streamEnded = false;
      while (!streamEnded) {
        const { value, done } = await reader.read();
        if (done) {
          // Drain any trailing partial line that lacked a `\n` terminator.
          // Without this, a daemon that closes the stream right after
          // emitting the final NDJSON envelope (done:true,
          // prompt_eval_count, eval_count, total_duration) drops those
          // fields — token counts go to 0 and modelContextWindow tracking
          // breaks. Synthesize a terminator so the split below picks up
          // the leftover buffer as one final line.
          streamEnded = true;
          if (buf.trim().length === 0) break;
          buf += '\n';
        } else {
          buf += decoder.decode(value, { stream: true });
        }
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(trimmed);
          } catch {
            continue;
          }
          const message = evt.message as { content?: unknown; thinking?: unknown; tool_calls?: unknown } | undefined;
          // Native thinking models (qwen3.5, qwen3-vl-thinking, ...) emit
          // reasoning here, separate from `content`. Pass straight through
          // to the thinking event channel — no splitter needed since the
          // server-side parser already separated it from final-answer text.
          if (message && typeof message.thinking === 'string' && message.thinking.length > 0) {
            rawThinking += message.thinking;
            this.emit('thinking', message.thinking);
          }
          if (message && typeof message.content === 'string' && message.content.length > 0) {
            rawContent += message.content;
            // Splitter handles legacy non-native-parser models (heretic-tools,
            // qwopus, etc.) that still embed <think>...</think> in content.
            // For native-parser models the splitter sees only post-strip text,
            // so it's a no-op and emits everything as text.
            const { thinking, text } = splitter.push(message.content);
            if (thinking) this.emit('thinking', thinking);
            if (text) this.emitText(text);
          }
          if (message && Array.isArray(message.tool_calls)) {
            for (const call of message.tool_calls) {
              const fn = (call as { function?: { name?: unknown; arguments?: unknown } } | undefined)?.function;
              if (!fn || typeof fn.name !== 'string') continue;
              // Some Ollama builds send `arguments` as a JSON-encoded string
              // instead of a parsed object; normalize so the registry sees
              // a Record<string, unknown> regardless.
              let args: Record<string, unknown> = {};
              let argError: string | undefined;
              if (typeof fn.arguments === 'string') {
                try {
                  const parsed = JSON.parse(fn.arguments);
                  if (parsed && typeof parsed === 'object') {
                    args = parsed as Record<string, unknown>;
                  } else {
                    argError = `arguments JSON parsed to a non-object (${typeof parsed})`;
                  }
                } catch (e) {
                  // Preview a short slice so the model sees what it sent and can fix its next attempt.
                  const preview = fn.arguments.slice(0, 80);
                  argError = `arguments not JSON-parseable (${(e as Error).message}); received: ${JSON.stringify(preview)}`;
                }
              } else if (fn.arguments && typeof fn.arguments === 'object') {
                args = fn.arguments as Record<string, unknown>;
              }
              accumulatedToolCalls.push({ function: { name: fn.name, arguments: args }, ...(argError ? { argError } : {}) });
            }
          }
          if (evt.done === true) {
            sawDone = true;
            inputTokens = typeof evt.prompt_eval_count === 'number' ? evt.prompt_eval_count : inputTokens;
            outputTokens = typeof evt.eval_count === 'number' ? evt.eval_count : outputTokens;
            // total_duration is in nanoseconds per Ollama API.
            const totalNs = typeof evt.total_duration === 'number' ? evt.total_duration : 0;
            if (totalNs > 0) durationMs = Math.round(totalNs / 1_000_000);
            genSpeed = genSpeedFromOllamaDone(evt);
          }
        }
      }
    } catch (err) {
      operatorSignal.removeEventListener('abort', onOperatorAbort);
      if (this.isAborted(err) && !(err instanceof Error && err.message.includes(CONNECT_TIMEOUT_MARKER))) {
        return { ok: false, abort: true };
      }
      // Mid-stream transport drop. If we already streamed bytes to the
      // operator, FAILING OVER would double-emit a fresh response on a peer —
      // so the wrapper only fails over when nothing was emitted. Carry the
      // emitted-bytes signal via the error so the wrapper can decide. (A
      // marker on the error object, read in run().)
      const wrapped = Object.assign(
        new Error(`Ollama stream interrupted: ${err instanceof Error ? err.message : String(err)}`),
        { _emittedBytes: rawContent.length + this._output.length, _cause: err },
      );
      return { ok: false, abort: false, error: wrapped };
    } finally {
      operatorSignal.removeEventListener('abort', onOperatorAbort);
    }

    // Drain bytes the splitter held back. Treated as whichever stream was
    // open at EOF (in_think → thinking, otherwise text).
    const drained = splitter.flush();
    if (drained.thinking) this.emit('thinking', drained.thinking);
    if (drained.text) this.emitText(drained.text);

    return {
      ok: true,
      assistantMessage: {
        role: 'assistant',
        content: rawContent,
        // Round-trip thinking back into the message stack so the model
        // sees its own reasoning across loop iterations within a turn.
        // Native-parser models expect this on the assistant message.
        // Cross-turn preservation runs through the appendSystemPrompt path
        // (renderTranscript with preserveThinking, plan §8.4).
        ...(rawThinking.length > 0 ? { thinking: rawThinking } : {}),
        ...(accumulatedToolCalls.length > 0 ? { tool_calls: accumulatedToolCalls } : {}),
      },
      usage: { inputTokens, outputTokens, durationMs, genSpeed },
      sawDone,
    };
  }

  // Run each tool call against the server-side runtime (AUTO mode) or
  // refuse with a denial string the model sees (SAFE mode). Either way the
  // result is a string the caller appends to `messages` as a role:'tool'
  // entry, so the loop converges without a new operator-approval protocol.
  private async dispatchToolCalls(
    calls: OllamaToolCall[],
    autoMode: boolean,
    loopDetector: ToolLoopDetector,
    observedToolNames?: Set<string>,
  ): Promise<OllamaChatMessage[]> {
    const cwd = this.config.cwd;
    const toolMessages: OllamaChatMessage[] = [];
    for (const call of calls) {
      // Cancel mid-batch: Write/Edit don't consult the abort signal, so a
      // [Bash, Write, Edit] batch cancelled during Bash would otherwise still
      // mutate files after "Worker killed". Callers re-check the signal and
      // bail, so the partial result list is never sent back to the model.
      if (this.abortController?.signal.aborted) break;
      const name = call.function.name;
      const args = call.function.arguments;
      observedToolNames?.add(name);
      // UI surfacing — same shape as the Claude path's tool_use event so the
      // existing chat renderer + activity tab light up unchanged.
      const toolUseId = randomUUID();
      this.emit('tool_use', {
        name,
        input: JSON.stringify(args),
        toolUseId,
      });

      let result: string;
      if (call.argError) {
        // Malformed-JSON arguments from the model — surface the parse
        // failure rather than executing with a defaulted-empty arg set
        // (which usually fires a tool against the wrong target).
        result = `[error] tool "${name}" arguments rejected: ${call.argError}`;
      } else if (this.config.interactionMode === 'chat' && this.config.voiceOperator) {
        result = await executeComputerTool(this.config.workflowId, name, args);
      } else if (!ollamaToolCallAllowed(this.config, name)) {
        result = `[error] tool "${name}" is unavailable in Arco Chat. Only armed WebSearch/WebFetch calls are allowed.`;
      } else if (!autoMode) {
        result =
          `[Arco SAFE mode] tool "${name}" was not executed. ` +
          'The local provider runs tools server-side only when AUTO mode is enabled on this workflow. ' +
          'Tell the operator what you were going to do, or answer from what they have shown you.';
      } else if (!cwd) {
        // The tool runtime needs a workflow cwd to anchor path validation.
        // Heretic reviewer / one-shot spawns without a cwd are out of scope
        // for tools; refuse rather than execute relative to the server's
        // own working directory.
        result = `[error] tool "${name}" requires a workflow cwd; this spawn has none.`;
      } else if (!isKnownOllamaTool(name)) {
        result = `[error] unknown tool "${name}". The Ollama tool runtime is on a strict allowlist; see docs/PROVIDERS.md §Ollama for the v1 set.`;
      } else {
        // Loop detection: identical (name, args) past the threshold returns
        // a coaching message instead of re-executing. See ToolLoopDetector
        // in ollamaTools.ts for the rationale and threshold tuning.
        // Ollama provider doesn't have the llama.cpp final-summary path,
        // so terminate falls back to one more coaching pass — same outward
        // behavior as before this flag existed. Wire termination here if
        // Ollama gets a recovery scaffold.
        const { coach, previousCount } = loopDetector.shouldCoach(name, args);
        if (coach) {
          result = loopDetector.coachingMessage(name, previousCount + 1);
          this.emit('system_notice', `tool-loop coach: "${name}" called ${previousCount + 1}x with identical args — injected coaching message instead of re-executing`);
        } else {
          result = await executeOllamaTool(name, args, {
            cwd,
            abortSignal: this.abortController?.signal,
            workflowId: this.config.workflowId,
            clusterId: this.config.clusterId,
          });
        }
      }
      if (this.config.voiceOperator) this.emit('tool_use', { name, input: JSON.stringify(args), toolUseId, status: result.startsWith('[error]') ? 'failed' : 'completed', output: result });
      toolMessages.push({ role: 'tool', content: result });
    }
    return toolMessages;
  }

  // M4 — emit a routing event onto the system_notice channel so it lands in
  // events.jsonl for transcript review (guardrail: visible + reversible). One
  // formatter keeps the wording consistent across selection/cooldown/failover.
  private emitRouting(e: OllamaRoutingEvent): void {
    let line: string;
    switch (e.kind) {
      case 'selected':
        line = `Ollama backend selected: ${e.backend} (${e.reason}; ${e.healthyCount}/${e.candidateCount} healthy)`;
        break;
      case 'cooldown_start':
        line = `Ollama backend cooled: ${e.backend} for ${Math.round(e.ttlMs / 1000)}s — ${e.reason}`;
        break;
      case 'cooldown_skip_last':
        line = `Ollama never-cool-last guard: kept ${e.backend} hot despite "${e.reason}" (sole healthy backend)`;
        break;
      case 'cooldown_expired':
        line = `Ollama backend cooldown expired: ${e.backend} — selectable again`;
        break;
      case 'failover':
        line = `Ollama failover: ${e.from} → ${e.to} (${e.reason}; backoff ${e.backoffMs}ms)`;
        break;
      case 'tailscale_fallback':
        line = `Ollama Tailscale fallback: ${e.backend} resolved to ${e.resolved}`;
        break;
      case 'exhausted':
        line = `Ollama routing exhausted: ${e.reason}`;
        break;
    }
    this.emit('system_notice', line);
  }

  // M4 — select a backend, stream one /api/chat turn against it, and fail over
  // to a healthy peer on a retryable error. Returns the SAME shape
  // streamOneTurn used to (an `ok:true` result, an abort sentinel, or a null
  // for terminal failure after this.fail() has been emitted). Owns:
  //   - weighted-shuffle selection over healthy, model-serving backends
  //   - reactive cooldown on retryable failures (never-cool-last guarded)
  //   - instant zero-backoff failover when a healthy peer exists; jittered
  //     exponential backoff only when forced onto the last/only host
  //   - the per-CHOSEN-backend num_ctx probe (M3 handoff: the trusted ceiling
  //     is per-host; probe the host we actually dispatch to)
  //   - best-effort Tailscale hostname fallback on DNS failure
  //
  // `ctx` carries per-turn caches (model-list + show-metadata per backend) and
  // the resolved-model output so run() can read modelContextWindow for the
  // result event. `firstIteration` gates the M3 params-visibility line.
  private async streamWithFailover(
    backends: ResolvedBackend[],
    modelHostMap: Record<string, string[]>,
    messages: OllamaChatMessage[],
    tools: OllamaToolDefinition[] | undefined,
    ctx: {
      modelCache: Map<string, string[] | null>;
      showCache: Map<string, OllamaShowMetadata>;
      resolvedModelByBase: Map<string, string>;
      lastChosen: { base: string; numCtx?: number } | null;
    },
    firstIteration: boolean,
    // M5 — structured-output schema for THIS turn; forwarded to streamOneTurn,
    // which only attaches it when the turn carries no tools.
    format?: 'json' | Record<string, unknown>,
  ): Promise<
    | { ok: true; assistantMessage: OllamaChatMessage; usage: { inputTokens: number; outputTokens: number; durationMs: number; genSpeed: GenSpeedSample | null }; sawDone: boolean }
    | { ok: false; abort: true }
    | null
  > {
    const requested = this.config.model;
    const attempted = new Set<string>();
    // Models known to be served by a host per its /api/tags (+ the affinity
    // hint). `undefined` from the helper means "unknown" → optimistic.
    const servesModel = (b: ResolvedBackend): boolean | undefined => {
      const installed = ctx.modelCache.get(b.baseUrl);
      if (installed === undefined) return undefined; // not probed yet → optimistic
      if (installed === null) return undefined; // probe failed → optimistic (request reveals truth)
      // Affinity hint: if the operator pinned this model to specific labels and
      // this backend isn't one of them, exclude it (hint narrows only).
      const lc = requested.toLowerCase();
      for (const [pat, labels] of Object.entries(modelHostMap)) {
        if (lc.includes(pat.toLowerCase()) || pat.toLowerCase().includes(lc)) {
          if (!labels.includes(b.label)) return false;
        }
      }
      // Fuzzy-match the requested alias against installed tags (same rule as
      // resolveOllamaModel — colon-form is exact, alias is substring).
      if (requested.includes(':')) return installed.includes(requested);
      return installed.some((n) => n.toLowerCase().includes(lc));
    };

    // Probe model lists for all backends ONCE per turn, in parallel, so the
    // first selection has real serves-model knowledge (a single-backend setup
    // skips straight past — the one host is always a candidate). Cheap
    // (/api/tags metadata-only, 2s cap). A single host can stay unprobed
    // (optimistic) if it's the only one.
    if (backends.length > 1) {
      await Promise.all(
        backends
          .filter((b) => !ctx.modelCache.has(b.baseUrl))
          .map(async (b) => { ctx.modelCache.set(b.baseUrl, await fetchBackendModels(b.baseUrl)); }),
      );
    }

    let backoffAttempt = 0;
    // M9 — bounded context-window escalation state (bounded-to-avoid-loop). The
    // set of backends already escalated-TO this turn (so a second overflow on a
    // bumped/peer window doesn't re-pick the same target), and the hop counter
    // capped at MAX_CTX_ESCALATIONS. Distinct from `attempted` (which the M4
    // failover loop uses for retryable transport errors): an overflow 400 is
    // NOT a transport failure, so it must not consume the failover budget or
    // cool the host — it consumes the SEPARATE escalation budget here.
    const ctxEscalated = new Set<string>();
    let ctxEscalations = 0;
    // Bound the failover loop: at most one attempt per backend + a couple of
    // last-host retries. backends.length+2 is plenty for a 1–3 host setup.
    const maxAttempts = backends.length + 2;
    for (let i = 0; i < maxAttempts; i++) {
      if (this.abortController?.signal.aborted) return { ok: false, abort: true };

      // Count currently-healthy, model-serving backends (for the never-cool-
      // last guard and the peer-available backoff decision).
      const now = Date.now();
      const selection = selectBackend({
        backends,
        exclude: attempted,
        servesModel,
        now,
        rng: this.rng,
      });
      if (!selection) {
        this.emitRouting({ kind: 'exhausted', reason: 'no backend left to try' });
        this.fail(`Ollama: all ${backends.length} backend(s) failed this turn`);
        return null;
      }

      let base = selection.backend.baseUrl;
      // Routing visibility (M4): the `selected` line only carries information
      // when a routing DECISION was actually made. With a single local Ollama it
      // is identical every tool-loop round-trip ("127.0.0.1:11434 … 1/1 healthy")
      // and just spams the transcript — one line per /api/chat call, so an
      // agentic turn that runs 15 tools emits 15 useless copies. Surface it only
      // when it says something: a non-trivial reason (a cooled/least-bad
      // fallback — worth showing even on one host), or a multi-backend setup
      // where the chosen host actually changed from the previous round-trip.
      // cooldown / failover / exhausted / tailscale events still fire
      // unconditionally below — those are the audit-relevant ones and are rare.
      const trivialSelection = selection.reason === 'weighted-shuffle among healthy backends';
      const backendChanged = ctx.lastChosen?.base !== base;
      if (!trivialSelection || (backends.length > 1 && backendChanged)) {
        this.emitRouting({
          kind: 'selected',
          backend: selection.backend.label,
          reason: selection.reason,
          healthyCount: selection.healthyCount,
          candidateCount: selection.candidateCount,
        });
      }

      // Resolve the model alias on THIS backend (a tag installed here may
      // differ from another host) and probe its num_ctx — the M3 trusted
      // ceiling is per-backend. Both cached so a re-selection of the same host
      // doesn't re-probe.
      let resolvedModel = ctx.resolvedModelByBase.get(base);
      if (resolvedModel === undefined) {
        try { resolvedModel = await resolveOllamaModel(requested, base); }
        catch { resolvedModel = requested; }
        ctx.resolvedModelByBase.set(base, resolvedModel);
      }
      let showMeta = ctx.showCache.get(base);
      if (showMeta === undefined) {
        showMeta = await fetchModelShowMetadata(resolvedModel, base);
        ctx.showCache.set(base, showMeta);
      }
      const nativeThinking = nativeThinkingOf(showMeta);

      // M3 visibility — emit the effective preset once per operator turn,
      // computed against THIS backend's probed num_ctx ceiling.
      if (firstIteration && i === 0) {
        const applied = applyOllamaParams(this.config.ollamaParams, showMeta.numCtx, showMeta.archCtx);
        if (applied.appliedKeys.length > 0) {
          const summary = applied.appliedKeys
            .map((k) => `${k}=${k === 'keep_alive' ? applied.root[k] : applied.options[k]}`)
            .join(' ');
          this.emit('system_notice', `Ollama params applied (allowlisted): ${summary}`);
        }
      }

      // The window this turn really runs on (operator num_ctx after the clamp,
      // else the Modelfile value) — the CTX bar denominator. Before 2026-09-29
      // this was always the Modelfile value, so an operator num_ctx below it
      // left the bar measuring against a window the daemon wasn't using.
      ctx.lastChosen = { base, numCtx: effectiveNumCtx(this.config.ollamaParams, showMeta) };
      let result = await this.streamOneTurn(base, resolvedModel, messages, tools, nativeThinking, showMeta, format);

      if (result.ok) {
        // No num_ctx went out and no Modelfile value exists → the daemon picked
        // its own default. Measure it (a real /api/ps reading, never a guess) so
        // the CTX bar and the next compaction check have a denominator.
        if (ctx.lastChosen.numCtx === undefined) {
          const measured = await loadedContextLength(resolvedModel, base);
          if (measured !== null) {
            measuredLoadedCtx.set(loadedCtxKey(base, resolvedModel), measured);
            showMeta.loadedCtx = measured;
            ctx.lastChosen = { base, numCtx: measured };
          }
        }
        return result;
      }
      if (result.abort) {
        return { ok: false, abort: true };
      }

      // Transport/HTTP failure. Classify, cool (guarded), decide failover.
      const decision = classifyOllamaError(result.error, result.httpStatus);
      attempted.add(base);

      // Mid-stream drop after bytes were emitted → don't failover (would
      // double-emit). Surface as terminal.
      const emittedBytes = (result.error as { _emittedBytes?: number } | undefined)?._emittedBytes ?? 0;
      const midStreamWithOutput = emittedBytes > 0;

      // Best-effort Tailscale fallback on DNS failure (Phase 8). Try the
      // resolved IP ONCE before giving up on this host — register the resolved
      // URL as a fresh attempt target by mutating the backend's effective base.
      if (decision.reason === 'DNS resolution failed' && !midStreamWithOutput) {
        const resolved = await resolveViaTailscale(selection.backend).catch(() => null);
        if (resolved && resolved !== base && !attempted.has(resolved)) {
          this.emitRouting({ kind: 'tailscale_fallback', backend: selection.backend.label, resolved });
          // Probe + dispatch against the resolved IP directly (one shot).
          const tsModel = ctx.resolvedModelByBase.get(resolved)
            ?? await resolveOllamaModel(requested, resolved).catch(() => requested);
          ctx.resolvedModelByBase.set(resolved, tsModel);
          const tsShow = ctx.showCache.get(resolved) ?? await fetchModelShowMetadata(tsModel, resolved);
          ctx.showCache.set(resolved, tsShow);
          ctx.lastChosen = { base: resolved, numCtx: effectiveNumCtx(this.config.ollamaParams, tsShow) };
          const tsResult = await this.streamOneTurn(resolved, tsModel, messages, tools, nativeThinkingOf(tsShow), tsShow, format);
          if (tsResult.ok) return tsResult;
          if (tsResult.abort) return { ok: false, abort: true };
          attempted.add(resolved);
        }
      }

      // M9 — REACTIVE context-window fallback. A context-overflow 400 means the
      // prompt exceeded the model's loaded window EVEN AFTER M8's proactive
      // compaction (or when M8 deferred — unknown window / at-keep-tail-floor).
      // Instead of failing, escalate to a LARGER-window target and re-dispatch.
      //   - escalate-don't-recompact: we do NOT touch `messages` (M8 owns the
      //     transcript). A 400 after compaction means "needs a bigger window",
      //     not "compact again". M9 only changes the target/num_ctx.
      //   - overflow-400-is-not-a-host-fault: this path is BEFORE the cooldown
      //     logic below and the host is never cooled (decision.cooldown=false).
      //   - bounded-to-avoid-loop: capped at MAX_CTX_ESCALATIONS hops; each hop
      //     records its target so a second overflow won't re-pick it.
      // Mid-stream guard: if bytes were already emitted, do NOT re-dispatch
      // (would double-emit) — mirrors M4's bytes-emitted failover rule. (An
      // overflow normally fails before the first token, but guard anyway.)
      if (decision.contextOverflow && !midStreamWithOutput) {
        // Inner escalation loop: chain bump → peer within the bounded budget,
        // re-dispatching against each larger target until one succeeds or no
        // larger target remains.
        let escFromBase = base;
        // The window the FAILING turn actually ran on: the value
        // applyOllamaParams put into options.num_ctx (the operator preset,
        // trusted-clamped to the probe), or the daemon default (2048) when the
        // preset omitted num_ctx. This is the number the bump must beat — NOT
        // the probe (using the probe here would make a default-2048 turn look
        // un-bumpable). undefined when even the probe was unknown (M8 defers to
        // M9 on exactly that case; planCtxEscalation treats undefined as the
        // default for the strict-greater comparison).
        const failedAppliedCtx = applyOllamaParams(this.config.ollamaParams, showMeta.numCtx, showMeta.archCtx).options.num_ctx;
        let escFailedWindow = typeof failedAppliedCtx === 'number'
          ? failedAppliedCtx
          : (showMeta.numCtx !== undefined ? OLLAMA_DEFAULT_WINDOW : undefined);
        let escFailedProbe = showMeta.numCtx;
        while (ctxEscalations < MAX_CTX_ESCALATIONS) {
          if (this.abortController?.signal.aborted) return { ok: false, abort: true };
          // Build the per-backend window/serves view from the caches M4 already
          // maintains. Probe any backend not yet in showCache (cheap /api/show)
          // so a peer's larger window is known, not guessed.
          const infos: CtxBackendInfo[] = [];
          for (const b of backends) {
            let meta = ctx.showCache.get(b.baseUrl);
            if (meta === undefined && b.baseUrl !== escFromBase) {
              const m = ctx.resolvedModelByBase.get(b.baseUrl)
                ?? await resolveOllamaModel(requested, b.baseUrl).catch(() => requested);
              ctx.resolvedModelByBase.set(b.baseUrl, m);
              meta = await fetchModelShowMetadata(m, b.baseUrl).catch(() => ({ capabilities: [] as string[] }));
              ctx.showCache.set(b.baseUrl, meta);
            }
            infos.push({
              baseUrl: b.baseUrl,
              label: b.label,
              probedNumCtx: meta?.numCtx,
              serves: servesModel(b),
            });
          }

          const target = planCtxEscalation({
            failedWindow: escFailedWindow,
            failedBase: escFromBase,
            failedProbedNumCtx: escFailedProbe,
            backends: infos,
            alreadyEscalated: ctxEscalated,
          });
          if (!target) break; // no larger window to try → fall through to terminal failure

          ctxEscalations++;
          ctxEscalated.add(target.baseUrl);
          // context_window_fallback record (events.jsonl visibility +
          // reversibility — it's a re-dispatch, not a mutation; the operator
          // sees BOTH the overflow and the escalation in the transcript).
          this.emit(
            'system_notice',
            `context_window_fallback: Ollama context overflow on ${escFromBase} ` +
            `(~${escFailedWindow ?? OLLAMA_DEFAULT_WINDOW} tok window) — ` +
            `escalating [${target.kind}] to ${target.label} (~${target.toWindow} tok): ${target.reason} ` +
            `(hop ${ctxEscalations}/${MAX_CTX_ESCALATIONS}).`,
          );

          // Resolve the target model + capabilities on the chosen base, then
          // re-dispatch ONCE. For 'numctx_bump' force the larger window onto the
          // SAME backend; for 'peer_backend' run on the peer (its own preset/
          // clamp applies against its probe). Same messages — escalate, don't
          // recompact.
          const tBase = target.baseUrl;
          let tModel = ctx.resolvedModelByBase.get(tBase);
          if (tModel === undefined) {
            tModel = await resolveOllamaModel(requested, tBase).catch(() => requested);
            ctx.resolvedModelByBase.set(tBase, tModel);
          }
          let tShow = ctx.showCache.get(tBase);
          if (tShow === undefined) {
            tShow = await fetchModelShowMetadata(tModel, tBase).catch(() => ({ capabilities: [] as string[] }));
            ctx.showCache.set(tBase, tShow);
          }
          ctx.lastChosen = { base: tBase, numCtx: target.toWindow };
          const forceNumCtx = target.kind === 'numctx_bump' ? target.toWindow : undefined;
          const escResult = await this.streamOneTurn(
            tBase, tModel, messages, tools, nativeThinkingOf(tShow),
            tShow, format, forceNumCtx,
          );
          if (escResult.ok) {
            this.emit('system_notice', `context_window_fallback: re-dispatch on ${target.label} succeeded.`);
            return escResult;
          }
          if (escResult.abort) return { ok: false, abort: true };

          // The escalation ITSELF failed. If it overflowed again, loop to try
          // the next larger target (peer after a bump); any other error is a
          // genuine failure on the larger target → stop escalating and fall
          // through to terminal failure with the original-style message.
          const escDecision = classifyOllamaError(escResult.error, escResult.httpStatus);
          const escEmitted = (escResult.error as { _emittedBytes?: number } | undefined)?._emittedBytes ?? 0;
          if (!escDecision.contextOverflow || escEmitted > 0) break;
          // Re-overflowed: advance the "failing window" to the one we just tried
          // so the next plan compares against the bigger number, and continue.
          escFromBase = tBase;
          escFailedWindow = target.toWindow;
          escFailedProbe = tShow.numCtx;
        }
        // Exhausted/no-target: actionable terminal message (the operator can
        // raise num_ctx or add a bigger-window backend). Fall through.
        this.fail(
          `Ollama context overflow with no larger window available — raise the model's num_ctx ` +
          `(Modelfile / CONFIG preset) or add a backend serving this model with a bigger window. ` +
          `(${result.error instanceof Error ? result.error.message : String(result.error)})`,
        );
        return null;
      }

      // Non-retryable (4xx/validation/400 overflow) → terminal, no failover.
      if (!decision.retryable || midStreamWithOutput) {
        this.fail(result.error instanceof Error ? result.error.message : String(result.error));
        return null;
      }

      // Reactive cooldown (never-cool-last guarded). Count healthy serving
      // backends INCLUDING the just-failed host: the guard asks "would cooling
      // this strand the operator?" — if this is the sole healthy serving host,
      // cooling it must be skipped. Healthy = model-serving (not definitively
      // excluded by tags/affinity) AND not already cooled (the just-failed host
      // isn't cooled yet at this point, so it counts).
      const nowForGuard = Date.now();
      const healthyServing = backends.filter((b) => {
        if (servesModel(b) === false) return false;
        return !isBackendCooled(b.baseUrl, nowForGuard);
      }).length;

      reportFailure({
        backend: selection.backend,
        decision,
        healthyServingCount: healthyServing,
        now: nowForGuard,
        emit: (ev) => this.emitRouting(ev),
      });

      // Decide backoff: instant when a healthy, un-attempted peer remains;
      // jittered exponential only when we're forced back onto the last host.
      const peerSelection = selectBackend({ backends, exclude: attempted, servesModel, now: Date.now(), rng: this.rng });
      const hasHealthyPeer = !!peerSelection && peerSelection.healthyCount > 0;
      const wait = backoffMs(hasHealthyPeer, backoffAttempt);
      if (!hasHealthyPeer) backoffAttempt++;
      const nextLabel = peerSelection?.backend.label ?? '(retry same host)';
      this.emitRouting({
        kind: 'failover',
        from: selection.backend.label,
        to: nextLabel,
        reason: decision.reason,
        backoffMs: wait,
      });
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }

    this.emitRouting({ kind: 'exhausted', reason: `exceeded ${maxAttempts} attempts` });
    this.fail(`Ollama: exhausted backend failover after ${maxAttempts} attempts`);
    return null;
  }

  // M8 — auto-compaction entry. Probes the primary backend's window (forward-
  // looking M6 estimate vs. the trusted num_ctx), warns at ~75% fill, and at
  // ~85% summarizes the older half of `messages` in place (utility model →
  // deterministic fallback) while keeping the system block + last-10 verbatim.
  // Mutates `messages` so the tool-loop dispatches the shrunk stack. Fail-soft:
  // any probe/summary failure leaves the original stack untouched (M9's reactive
  // overflow catch is the backstop) — compaction never aborts the turn.
  private async maybeCompact(
    messages: OllamaChatMessage[],
    tools: OllamaToolDefinition[] | undefined,
    backends: ResolvedBackend[],
    modelHostMap: Record<string, string[]>,
    failoverCtx: {
      modelCache: Map<string, string[] | null>;
      showCache: Map<string, OllamaShowMetadata>;
      resolvedModelByBase: Map<string, string>;
      lastChosen: { base: string; numCtx?: number } | null;
    },
  ): Promise<void> {
    // WP3 — operator-armed force flag (manual COMPACT button). Consume it FIRST
    // (read-and-clear, one-shot) so it's honored exactly once even on the paths
    // below that early-return. When set, this turn compacts regardless of the
    // fill threshold — see ollamaForceCompact.ts for why the manual button
    // defers to the next turn (Ollama's worker is stateless per turn).
    const forced = this.config.workflowId
      ? consumeOllamaForceCompact(this.config.workflowId)
      : false;

    // WP3 — three-layer config: settings.ollama.compaction (operator UI) over
    // env (ARCO_OLLAMA_*) over hardcoded default. readSettings is the same
    // path produceCompactionSummary uses below; tolerate a read failure by
    // falling through to env/default (resolveCompactionConfig with no overlay).
    let overlay;
    try { overlay = (await readSettings()).ollama?.compaction; }
    catch { overlay = undefined; }
    const config = resolveCompactionConfig(overlay);
    // A forced compaction still runs even when auto-compaction is disabled — the
    // operator asked for it explicitly. Auto-only runs gate on `enabled`.
    if (!config.enabled && !forced) return;

    // M5 scoping — a one-shot structured primitive (Review verdict, etc.) sets
    // ollamaFormat; a no-cwd one-shot has no tools. Both are single short calls
    // that never approach the window. Compaction is for the INTERACTIVE primary
    // turn loop only (same scoping the reference keeps — its recovery is gated
    // on the interactive run path, not the reviewer/handoff-seed slots).
    if (this.config.ollamaFormat || !this.config.cwd) return;

    // Probe the window we'll actually run against. Resolve+show the primary
    // candidate backend up-front and SEED failoverCtx's caches so the tool-loop
    // doesn't re-probe (M4: num_ctx is per-backend; the loop reads the same
    // cache). A probe failure (no num_ctx) means "unknown window" → no compaction
    // (shouldAutoCompact returns false on an unknown denominator — guessing a
    // cut risks more harm than the overflow M9 catches reactively).
    const primary = backends[0];
    if (!primary) return;
    const base = primary.baseUrl;
    let resolvedModel = failoverCtx.resolvedModelByBase.get(base);
    if (resolvedModel === undefined) {
      try { resolvedModel = await resolveOllamaModel(this.config.model, base); }
      catch { resolvedModel = this.config.model; }
      failoverCtx.resolvedModelByBase.set(base, resolvedModel);
    }
    let showMeta = failoverCtx.showCache.get(base);
    if (showMeta === undefined) {
      try { showMeta = await fetchModelShowMetadata(resolvedModel, base); }
      catch { return; }
      failoverCtx.showCache.set(base, showMeta);
    }
    // Compact against the window the daemon really runs (operator num_ctx
    // after the clamp, else Modelfile) — not the Modelfile value alone, which
    // over-states the room when the operator set a smaller num_ctx.
    const window = effectiveNumCtx(this.config.ollamaParams, showMeta);

    const estTokens = estimatePromptTokens({ messages, tools });

    // WP3 — the forced (manual-button) path bypasses BOTH gates below: the
    // operator asked to compact now, so we don't emit the soft warning and we
    // don't require the hard threshold. The probe + scoping guards above still
    // apply (an unknown window or a one-shot primitive still skips). The
    // keep-tail floor check further down handles "nothing older to summarize".
    if (!forced) {
      // Early warning (Hardening §6) — local summaries are lossier than Handoff,
      // so flag the operator before the automatic cut. Toast-only, no action.
      if (shouldWarnContext(estTokens, window, config.warnThreshold, config.contextFillThreshold)) {
        const pct = Math.round((estTokens / (window ?? 1)) * 100);
        this.emit('system_notice', `Ollama context ~${pct}% full (${estTokens.toLocaleString()}/${window} tok). Approaching the auto-compaction threshold — consider a Handoff for a higher-fidelity summary before the local auto-compact fires.`);
        return;
      }

      if (!shouldAutoCompact(estTokens, window, config.contextFillThreshold)) return;
    }

    const label = forced ? 'manual compaction' : 'auto-compaction';
    const before = messages.map((m) => m as unknown as CompactMessage);
    const split = splitForCompaction(before, config.keepLastMessages);
    if (split.older.length === 0) {
      // Nothing older to summarize: the tail itself + system block is the whole
      // stack. On the auto path we were over threshold; on the forced path the
      // operator asked but there's simply nothing to fold. Either way emit the
      // "nothing to compact" notice and (for forced) clear cleanly — M9's
      // reactive overflow fallback still handles a genuine 400 on auto.
      this.emit('system_notice', forced
        ? `Ollama ${label}: nothing older than the keep-tail (last ${config.keepLastMessages}) to summarize — context left as-is.`
        : 'Ollama auto-compaction: transcript over threshold but already at the keep-tail floor — nothing older to summarize; deferring to reactive overflow handling.');
      return;
    }

    const fillPct = Math.round((estTokens / (window ?? 1)) * 100);
    this.emit('system_notice', `Ollama ${label}: context ~${fillPct}% full (${estTokens.toLocaleString()}/${window} tok) — summarizing ${split.older.length} older message(s) in place, keeping the system block + last ${split.tail.length}.`);

    // Produce the summary: utility model (M7 seam) → deterministic digest. The
    // digest is the never-fail-closed guarantee — compaction always produces a
    // recap even with no utility model / a failed call.
    const summary = await this.produceCompactionSummary(split.older, config);

    const after = assembleCompacted(split, summary.text, config);
    const stats = compactionStats(before, after, tools);

    // ollama_compacted record (events.jsonl visibility + reversibility). Emitted
    // on the system_notice channel — the SAME channel M3–M7 routing/estimate
    // events and llamacppRecovery use (M8 task: "same event/persistence channel
    // the rest of the Ollama path uses"). Carries before/after byte + token
    // counts and the summary source; the ORIGINAL transcript is reconstructable
    // from the prior turns' events.jsonl, so the cut is reversible by review.
    this.emit(
      'system_notice',
      `ollama_compacted: folded ${stats.foldedMessages} message(s) via ${summary.source} summary — ` +
      `before ${stats.beforeBytes.toLocaleString()}B / ~${stats.beforeTokens.toLocaleString()}tok → ` +
      `after ${stats.afterBytes.toLocaleString()}B / ~${stats.afterTokens.toLocaleString()}tok ` +
      `(system block + last ${split.tail.length} kept verbatim; original recoverable from events.jsonl).`,
    );

    // Replace the in-memory stack with the compacted version. The tool-loop
    // below dispatches against this shrunk stack.
    messages.length = 0;
    messages.push(...(after as unknown as OllamaChatMessage[]));
  }

  // Produce the older-half summary. Tries the M7 utility model first (cheap,
  // off the primary); falls back to the deterministic structural digest when the
  // utility model is unconfigured or its call returns null. NEVER throws — the
  // digest is always available, so compaction never fails closed.
  private async produceCompactionSummary(
    older: CompactMessage[],
    config: CompactionConfig,
  ): Promise<{ text: string; source: 'utility-model' | 'deterministic' }> {
    // Flatten the older half into a transcript-shaped prompt for the utility
    // model. tool/assistant tool-call turns are rendered to text so the small
    // model sees what happened (it can't act on native tool_calls in a single-
    // shot summary call). Empty-content turns still contribute their tool names.
    const utilMessages: UtilityMessage[] = older.map((m) => {
      let content = typeof m.content === 'string' ? m.content : '';
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const calls = m.tool_calls
          .map((tc) => `${tc.function.name}(${safeStringifyArgs(tc.function.arguments)})`)
          .join(', ');
        content = content ? `${content}\n[tool calls: ${calls}]` : `[tool calls: ${calls}]`;
      }
      const role: UtilityMessage['role'] = m.role === 'tool' ? 'user' : (m.role === 'system' ? 'system' : m.role);
      return { role, content: content || `[${m.role} turn]` };
    });

    // Resolve the utility config up-front so an unconfigured model short-circuits
    // straight to the deterministic digest without a wasted round-trip.
    let utilConfigured = false;
    try {
      const settings = await readSettings();
      utilConfigured = resolveUtilityConfig(settings.ollama) !== null;
    } catch { utilConfigured = false; }

    if (utilConfigured) {
      // Resolve the operator-overridable framing (project>global>default) the
      // same way handoff prompts resolve; the default falls back to
      // DEFAULT_COMPACTION_FRAMING. The framing carries no template variables,
      // so the resolved template is passed verbatim (no renderPrompt step).
      let framing: string | undefined;
      try {
        framing = (await loadCompactionFraming('ollama-compaction', this.config.cwd ?? '')).template;
      } catch { framing = undefined; }
      try {
        const text = await runUtilitySummaryJob({
          messages: utilMessages,
          maxTokens: config.summaryMaxTokens,
          framing,
          onNotice: (line) => this.emit('system_notice', line),
          signal: this.abortController?.signal,
        });
        if (text && text.trim()) return { text: text.trim(), source: 'utility-model' };
      } catch { /* fall through to deterministic */ }
    }

    // Deterministic fallback — never-fail-closed.
    return { text: deterministicDigest(older), source: 'deterministic' };
  }

  // M11 — front-of-turn native-tool capability probe. The tool-call MODE
  // (native vs fenced) is a SINGLE decision for the whole operator turn: the
  // injected protocol prompt lives in the (byte-stable) system block, so it
  // can't change mid tool-loop. We therefore probe the model's `tools`
  // capability ONCE here, against the first model-serving backend, and reuse the
  // SAME probe the failover loop reads (write-through into failoverCtx.showCache
  // / resolvedModelByBase so streamWithFailover doesn't re-probe that host).
  //
  // Capability is a model property (does this GGUF carry a native tool parser),
  // not a per-host one like num_ctx — so one probe is representative. If the
  // probe fails (host down) we default OPTIMISTICALLY to native-capable: the
  // pre-M11 behavior, and a non-tool model that slips through simply won't emit
  // tool_calls (the old fallback), never worse than before. Returns whether the
  // model is natively tools-capable.
  private async probeNativeToolCapability(
    requested: string,
    backends: ResolvedBackend[],
    modelCache: Map<string, string[] | null>,
    ctx: {
      showCache: Map<string, OllamaShowMetadata>;
      resolvedModelByBase: Map<string, string>;
    },
  ): Promise<boolean> {
    // Prefer a backend known to serve the model; fall back to the first.
    const lc = requested.toLowerCase();
    const serving = backends.find((b) => {
      const installed = modelCache.get(b.baseUrl);
      if (!installed) return false;
      return requested.includes(':')
        ? installed.includes(requested)
        : installed.some((n) => n.toLowerCase().includes(lc));
    });
    const target = serving ?? backends[0];
    if (!target) return true; // no backend at all → optimistic native
    const base = target.baseUrl;
    let resolved = ctx.resolvedModelByBase.get(base);
    if (resolved === undefined) {
      try { resolved = await resolveOllamaModel(requested, base); }
      catch { resolved = requested; }
      ctx.resolvedModelByBase.set(base, resolved);
    }
    let meta = ctx.showCache.get(base);
    if (meta === undefined) {
      meta = await fetchModelShowMetadata(resolved, base);
      ctx.showCache.set(base, meta);
    }
    // Empty capabilities (probe failed / older daemon) → optimistic native.
    if (meta.capabilities.length === 0) return true;
    return meta.capabilities.includes('tools');
  }

  private async run(prompt: string): Promise<void> {
    const startedAt = Date.now();

    // Bounded wait for the upload-time downscaled copies; buildMessages reads
    // them synchronously via modelImagePath.
    await awaitModelImages(this.config.attachments);
    const messages = this.buildMessages(prompt);

    // Tool advertisement gating:
    //   - No cwd → no tools (one-shot/legacy review path; same as pre-§5.4).
    //   - Chat + web armed → WebSearch/WebFetch only; Chat + web off → none.
    //   - Agent + config.tools is an explicit allowlist → filter the registry
    //     to that intersection. Reviewer spawns use this with READ_ONLY_OLLAMA_TOOLS
    //     so the model can read the codebase but not Write/Bash.
    //   - Agent + no allowlist → full kit (primary's normal AUTO/SAFE flow).
    // `tools` is the wire-advertised native `tools[]` (set on the native path,
    // left undefined on the fenced path — see the M11 mode gate below).
    // `toolSubset` is the M10-subsetted list REGARDLESS of mode: native sends it
    // on the wire, fenced renders it into the injected protocol prompt + uses it
    // to ground the parser. Decoupling the two is what lets M11 present the same
    // subset either way ("subset first, then present" — M11 builds on M10).
    let tools: OllamaToolDefinition[] | undefined;
    let toolSubset: OllamaToolDefinition[] | undefined;
    const gated = ollamaToolCandidates(this.config);
    if (gated) {
      // M10 — trim the gated set to a relevant top-K for small local models.
      // CRITICAL: rank against the STABLE task context (system prompt +
      // appendSystemPrompt: handoff seed / role hints / task description), NOT
      // the volatile latest user prompt. The subset is computed ONCE per
      // operator turn here and held stable through the tool-loop below; ranking
      // off a per-turn-volatile signal would change the advertised `tools[]`
      // every turn and thrash Ollama's prefix cache (re-prefill the whole
      // prompt instead of the new-turn delta — exactly the cost this program is
      // cutting). Because the signal is the per-workflow system block, the
      // subset is byte-identical across turns and the cache survives. Only ever
      // narrows on top of the cwd/allowlist/cluster gating above (subsetting
      // never widens). See ollamaToolSubset.ts for the full rationale.
      const taskContext = `${this.config.systemPrompt ?? ''}\n${this.config.appendSystemPrompt ?? ''}`;
      const subset = this.config.voiceOperator ? { tools: gated, applied: false, kept: [], dropped: [], cap: gated.length, signalSource: 'Computer allowlist' } : subsetOllamaTools({
        tools: gated,
        taskContext,
        clusterMember: !!this.config.clusterId && !!this.config.workflowId,
      });
      tools = subset.tools;
      toolSubset = subset.tools;
      if (subset.applied) {
        // Guardrail: every reduction is visible in events.jsonl (same
        // system_notice channel M3–M9 routing/estimate/compaction use), with
        // the kept/dropped split AND the signal-stability provenance so
        // transcript review can confirm prefix-cache safety.
        this.emit(
          'system_notice',
          `Ollama tool-subset (M10): advertising ${subset.kept.length}/${gated.length} tools ` +
            `[${subset.kept.join(', ')}]; dropped [${subset.dropped.join(', ')}] ` +
            `(cap ${subset.cap}, ranked vs ${subset.signalSource} — stable across turns, prefix-cache-safe). ` +
            `Disable with ARCO_OLLAMA_TOOL_SUBSET=0.`,
        );
      }
    }
    const autoMode = ollamaToolsAutoExecute(this.config);

    // M4 — resolve the operator's backends ONCE per operator turn (config is
    // stable across the tool-loop). Back-compat: an unset `backends` yields a
    // single synthesized backend from the legacy baseUrl→env→localhost cascade,
    // so a pre-M4 operator gets identical behavior.
    const { backends, modelHostMap } = await getOllamaBackends();

    // Per-turn caches shared across the tool-loop's streamWithFailover calls:
    // model lists, /api/show metadata, and resolved model aliases — all keyed
    // by backend base URL, so re-selecting the same host doesn't re-probe.
    const failoverCtx: {
      modelCache: Map<string, string[] | null>;
      showCache: Map<string, OllamaShowMetadata>;
      resolvedModelByBase: Map<string, string>;
      lastChosen: { base: string; numCtx?: number } | null;
    } = {
      modelCache: new Map(),
      showCache: new Map(),
      resolvedModelByBase: new Map(),
      lastChosen: null,
    };

    this._status = 'running';
    markAvailable('ollama');
    // The init `model` is the operator's requested alias; the per-backend
    // resolved tag is logged in the routing `selected` event.
    this.emit('init', { model: this.config.model });

    // ── M11 — capability-gated tool mode (LE-5 / Hardening §8 superset) ───────
    // Decide ONCE per operator turn how to present the M10 subset:
    //   native — model has the `tools` capability: advertise `tools[]`, parse
    //            native `tool_calls` (pre-M11 behavior, untouched).
    //   fenced — model lacks `tools`: inject a STABLE protocol prompt into the
    //            system block and parse fenced tool-call blocks out of the
    //            free-text response, dispatching through the SAME
    //            executeOllamaTool path (emulating tool-calling for non-tool
    //            models — the M11 deliverable).
    //   none   — no subset this turn (no cwd / structured one-shot).
    // Operator-overridable via ARCO_OLLAMA_TOOL_MODE (auto|native|fenced) —
    // the reversibility guardrail: forcing native reverts to "non-tool models
    // just don't get tools" (the pre-M11 fallback). The gate reads the SAME
    // probed `tools` capability M1/M3 already surface; it does NOT add a new
    // capability detector.
    let toolMode: OllamaToolMode = 'none';
    let fencedPrompt = '';
    if (toolSubset && toolSubset.length > 0) {
      const override = resolveToolModeOverride();
      // 'fenced' override skips the probe (we're forcing emulation); otherwise
      // probe the model's native tool capability once (write-through cached).
      const nativeCapable = override === 'fenced'
        ? false
        : await this.probeNativeToolCapability(this.config.model, backends, failoverCtx.modelCache, failoverCtx);
      toolMode = resolveToolMode({ hasTools: true, nativeCapable, override });

      if (toolMode === 'fenced') {
        // LE-5 — split the subset into ACTION tools (exposed via the fenced
        // protocol) and CONTEXT-reader tools (prompt-injected as context, NOT
        // exposed — a weak model is unreliable at polling them and Arco
        // already injects their state via appendSystemPrompt). See
        // partitionFencedTools. The protocol describes ONLY the action tools.
        const { action: fencedAction, contextInjected } = partitionFencedTools(toolSubset);
        if (contextInjected.length > 0) {
          this.emit(
            'system_notice',
            `Ollama tool-mode (M11/LE-5): prompt-injecting context for [${contextInjected.map((t) => t.function.name).join(', ')}] ` +
              `instead of exposing as fenced tools (their state is already in the injected plan/role context).`,
          );
        }
        // PRESENT the action subset via the injected protocol. The protocol
        // block is a PURE function of the (stable) action list, so it's
        // byte-identical across turns — it joins the byte-stable system region
        // and the prefix cache survives (the load-bearing invariant; see
        // ollamaFencedTools.ts constraint #1). We FOLD it into the system
        // message that buildMessages already produced (or synthesize one) rather
        // than appending a per-turn message, so it sits in the cached prefix,
        // not after the volatile tail.
        fencedPrompt = buildFencedToolPrompt(fencedAction);
        const sysIdx = messages.findIndex((m) => m.role === 'system');
        if (sysIdx >= 0) {
          messages[sysIdx] = {
            ...messages[sysIdx],
            content: messages[sysIdx].content
              ? `${messages[sysIdx].content}\n\n${fencedPrompt}`
              : fencedPrompt,
          };
        } else {
          messages.unshift({ role: 'system', content: fencedPrompt });
        }
        // DO NOT advertise native tools on the wire — this model can't use them
        // and a `tools[]` it ignores just burns context. The subset now lives in
        // the prompt instead.
        tools = undefined;
        this.emit(
          'system_notice',
          `Ollama tool-mode (M11): FENCED — model "${this.config.model}" lacks native tool capability; ` +
            `injecting fenced tool protocol for ${fencedAction.length} action tool(s) [${fencedAction.map((t) => t.function.name).join(', ')}] ` +
            `and parsing fenced calls from the response. Override with ARCO_OLLAMA_TOOL_MODE=native.`,
        );
      } else {
        // native — leave `tools` as the subset on the wire (unchanged path).
        this.emit(
          'system_notice',
          `Ollama tool-mode (M11): NATIVE — model "${this.config.model}" advertises ${toolSubset.length} tool(s) ` +
            `on /api/chat tools[]${override === 'native' ? ' (forced)' : ''}.`,
        );
      }
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalDurationMs = 0;
    let turnGenSpeed: GenSpeedSample | null = null;
    // M6 — the LAST tool-loop turn's prompt_eval_count: the actual prompt-token
    // count the daemon saw on its final call this operator turn. That is the
    // context-fill figure (what's resident in the window), distinct from the
    // tool-loop SUM above which is billing-shaped. Surfaced as lastPromptTokens
    // so the server can broadcast a ground-truth context_usage and M8 can read a
    // trustworthy compaction threshold. Same numerator/sum distinction Codex
    // draws (last_token_usage vs total_token_usage).
    let lastTurnInputTokens = 0;
    let anyTurnSawDone = false;
    let preparatoryContinuations = 0;
    let clusterReportContinuations = 0;
    // M5 — guard so the structured-output synthesis turn runs at most once.
    let structuredSynthesisDone = false;
    const observedToolNames = new Set<string>();

    // One detector per operator turn. Reset implicitly because `run()` is
    // called fresh per turn; the next operator message gets a clean slate.
    const loopDetector = new ToolLoopDetector();

    // M6 — pre-turn prompt-size estimate. Counts the rebuilt transcript
    // (text + tool-call arguments + tool-result bodies + thinking) PLUS the
    // advertised tool schemas, which ride every request. This is the
    // FORWARD-LOOKING figure M8 (compaction) compares against the effective
    // window to decide whether to compact BEFORE dispatch — the daemon's
    // ground-truth prompt_eval_count only arrives post-turn, too late to
    // prevent an overflow 400. Counting tool-call args is the load-bearing
    // detail (Hardening §5): a tool-only assistant turn has empty content with
    // the whole payload in arguments, so a content-only count undershoots
    // 20-30% and the gate goes blind. Emitted as a visible system_notice
    // (guardrail: the accounting must be inspectable in events.jsonl). The
    // probed per-backend window isn't known until inside streamWithFailover, so
    // the % here is against the daemon-default floor; the post-turn
    // context_usage carries the true probed denominator.
    {
      // M11 token-accounting (constraint #2): on the FENCED path the tool
      // surface is the injected protocol text, NOT native `tools[]` schemas. We
      // FOLD that text into the system message above, so estimatePromptTokens
      // already counts it via estimateMessageTokens — the schemas it would have
      // counted are absent (tools is undefined on fenced). The estimator thus
      // stays unchanged and STILL counts the tool surface on both paths; M8's
      // compaction gate can't undercount. We compute the fenced contribution
      // separately ONLY to surface it in the visibility line below (the system
      // block already carries it in `estTokens`).
      const estTokens = estimatePromptTokens({ messages, tools });
      const floorPct = Math.round((estTokens / OLLAMA_DEFAULT_WINDOW) * 100);
      const surface = toolMode === 'fenced'
        ? `fenced protocol injection ~${estimateFencedPromptTokens(fencedPrompt).toLocaleString()} tok (in the system block)`
        : 'native tools[] schemas';
      this.emit('system_notice', `Ollama pre-turn estimate (counts tool-call args + tool results + ${surface}): ~${estTokens.toLocaleString()} input tokens (>=${floorPct}% of the 2048 default window; true % against the probed num_ctx lands post-turn).`);
    }

    // M8 — auto-compaction at the clean turn boundary (BEFORE the first
    // dispatch). Ollama's worker is stateless per turn: the transcript is
    // rebuilt from appendSystemPrompt each run(), so the front edge of run() IS
    // the turn boundary (llama.cpp compacts the trailing edge of its long-lived
    // stack instead — same "never mid tool-loop" rule, different anchor). If the
    // rebuilt stack won't fit the probed window, compact in place so this turn
    // (and the operator's next) survive instead of 400ing on overflow. Mutates
    // `messages` ahead of the loop. Scoped to the interactive primary path —
    // one-shot structured primitives (Review verdict etc.) and no-cwd one-shots
    // are short single calls that never approach the window, so they skip it.
    if (!this.config.voiceOperator) await this.maybeCompact(messages, tools, backends, modelHostMap, failoverCtx);

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      if (this.abortController?.signal.aborted) return;

      // M4 — select a backend + stream one turn against it, failing over to a
      // healthy peer on a retryable transport error (zero backoff when a peer
      // exists; the per-backend num_ctx probe runs inside). The M3 params
      // visibility line is emitted on the first tool-loop iteration only.
      const turnResult = await this.streamWithFailover(
        backends,
        modelHostMap,
        messages,
        tools,
        failoverCtx,
        turn === 0,
      );
      if (turnResult === null) return; // terminal failure — this.fail() emitted
      if (!turnResult.ok) return; // operator abort

      anyTurnSawDone = anyTurnSawDone || turnResult.sawDone;
      // Ollama's `prompt_eval_count` is post-cache: the *new* tokens it
      // had to prefill on this call. Sum across loop turns gives the
      // operator a faithful picture of the input cost the daemon paid.
      totalInputTokens += turnResult.usage.inputTokens;
      totalOutputTokens += turnResult.usage.outputTokens;
      totalDurationMs += turnResult.usage.durationMs;
      turnGenSpeed = addGenSpeed(turnGenSpeed, turnResult.usage.genSpeed);
      // M6 — track the most recent prompt_eval_count as the context-fill figure.
      if (turnResult.usage.inputTokens > 0) lastTurnInputTokens = turnResult.usage.inputTokens;

      messages.push(turnResult.assistantMessage);

      // ── M11 fenced path — parse tool calls out of the free-text response ────
      // A non-tool model can't emit native `tool_calls`, so we parse the fenced
      // protocol blocks out of its `content`. Parsed calls are mapped to the
      // SAME OllamaToolCall shape the native path uses and dispatched through the
      // SAME dispatchToolCalls → executeOllamaTool path (no forked execution —
      // the M11 reuse guardrail). Termination MIRRORS native: a turn that emits
      // NO fenced block is the model's final answer → fall through to the
      // no-tool-calls block below (preparatory/cluster/structured/final logic
      // applies identically). Results are fed back as USER messages (the fenced
      // model has no native tool-role rendering) formatted by
      // formatFencedToolResult.
      if (toolMode === 'fenced') {
        const parsed = parseFencedToolCalls(turnResult.assistantMessage.content, isKnownOllamaTool);
        if (parsed.length > 0) {
          const fencedCalls: OllamaToolCall[] = parsed.map((p) => ({
            function: { name: p.name, arguments: p.arguments },
            ...(p.argError ? { argError: p.argError } : {}),
          }));
          this.emit(
            'system_notice',
            `Ollama fenced tool-call(s) parsed (M11): [${parsed.map((p) => p.name || '?').join(', ')}] — dispatching via the native execution path.`,
          );
          const toolResults = await this.dispatchToolCalls(fencedCalls, autoMode, loopDetector, observedToolNames);
          if (this.abortController?.signal.aborted) return;
          // Re-frame each role:'tool' result as a labeled USER message the fenced
          // model can read inline (it has no tool-role channel). Same content,
          // different envelope — execution above was identical to native.
          for (let k = 0; k < toolResults.length; k++) {
            const name = fencedCalls[k]?.function.name ?? 'tool';
            messages.push({ role: 'user', content: formatFencedToolResult(name, toolResults[k].content) });
          }
          // Drain operator steer (same as the native tail) before looping.
          const drainSteer = this.config.drainSteer;
          if (drainSteer) {
            for (const item of drainSteer()) {
              let text = item.content;
              if (item.attachments && item.attachments.length > 0) {
                text += '\n\n' + item.attachments.map((p) => `[attached file: ${p}]`).join('\n');
              }
              messages.push({ role: 'user', content: text });
            }
          }
          continue;
        }
        // No fenced block → final answer. Fall through to the shared no-tool-
        // calls block below (which handles preparatory/cluster/structured/final).
      }

      const toolCalls = turnResult.assistantMessage.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        if (preparatoryContinuations < MAX_PREPARATORY_CONTINUATIONS && looksPreparatoryOnly(turnResult.assistantMessage.content)) {
          preparatoryContinuations++;
          this.emit('system_notice', `Ollama produced preparatory text without a tool call; continuing turn (${preparatoryContinuations}/${MAX_PREPARATORY_CONTINUATIONS})`);
          messages.push({
            role: 'user',
            content:
              'Continue now. Your previous message was only preparatory text. ' +
              'If you need repository evidence, call the appropriate tool. ' +
              'Otherwise provide the final concise answer with evidence. Do not stop after saying what you are about to do.',
          });
          continue;
        }
        if (
          clusterReportContinuations < MAX_CLUSTER_REPORT_CONTINUATIONS &&
          shouldRequireClusterPeerReport(this.config, observedToolNames)
        ) {
          clusterReportContinuations++;
          this.emit('system_notice', `Ollama cluster worker produced a final answer without peer_send; continuing turn (${clusterReportContinuations}/${MAX_CLUSTER_REPORT_CONTINUATIONS})`);
          messages.push({
            role: 'user',
            content:
              'You are in an Arco cluster and have not reported this turn back to the assigning peer. ' +
              'Before ending, call peer_send with your concise PASS/FAIL or DONE/BLOCKED result. ' +
              'Use peer_list first only if you do not know the target. Do not redo the task or write more prose until peer_send succeeds.',
          });
          continue;
        }
        // M5 — structured-output synthesis. The tool-loop above ran free
        // (tools enabled, no format) so the model could read the tree; now that
        // it has produced its free-text final answer, re-ask it ONCE on a
        // tool-free, schema-constrained turn so the result is guaranteed-valid
        // JSON the primitive can parse without regex-scraping. Done exactly
        // once (`structuredSynthesisDone`), and only when the operator wired a
        // format (Review verdict). Skipped entirely for normal chat turns.
        // Fail-safe: if the constrained turn errors/aborts, we fall through to
        // the free-text answer already streamed — the caller's free-text parser
        // still applies, so a non-grammar model never breaks.
        if (this.config.ollamaFormat && !structuredSynthesisDone) {
          structuredSynthesisDone = true;
          this.emit('system_notice', 'Ollama structured-output: re-asking on a schema-constrained (format) turn for a guaranteed-valid result.');
          messages.push({
            role: 'user',
            content:
              'Now output your review as a single JSON object conforming to the required schema. ' +
              'Do not include any prose, markdown, or code fences — only the JSON object.',
          });
          // Drop the streamed free-text answer so the emitted result.text is the
          // schema JSON only (the structured primitive parses + reconstructs the
          // markdown body from it; see reviewSchema.ts). The free-text answer
          // is preserved in the message stack so the model can restate it.
          this._output = '';
          this.outputCapped = false;
          // Tool-free synthesis turn: pass `undefined` tools so the format gate
          // in streamOneTurn fires (format + tools are mutually exclusive).
          const structuredResult = await this.streamWithFailover(
            backends,
            modelHostMap,
            messages,
            undefined,
            failoverCtx,
            false,
            this.config.ollamaFormat,
          );
          if (structuredResult === null) return; // terminal failure — fail() emitted
          if (!structuredResult.ok) return; // operator abort
          anyTurnSawDone = anyTurnSawDone || structuredResult.sawDone;
          totalInputTokens += structuredResult.usage.inputTokens;
          totalOutputTokens += structuredResult.usage.outputTokens;
          totalDurationMs += structuredResult.usage.durationMs;
          turnGenSpeed = addGenSpeed(turnGenSpeed, structuredResult.usage.genSpeed);
          if (structuredResult.usage.inputTokens > 0) lastTurnInputTokens = structuredResult.usage.inputTokens;
          messages.push(structuredResult.assistantMessage);
          // Fall through to the result emit below with the JSON now in
          // this._output. (A model that ignored `format` and emitted prose still
          // lands here; the primitive's parser falls back to free-text in that
          // case — fail-safe.)
        }
        // Model produced a final answer.
        if (!anyTurnSawDone && this._output.length === 0) {
          this.fail(`Ollama returned no output (model ${this.config.model})`);
          return;
        }
        // The context window for the CTX bar comes from the LAST backend we
        // actually dispatched to (M4: num_ctx is per-backend, so the bar must
        // reflect the host that produced this answer).
        const modelContextWindow = failoverCtx.lastChosen?.numCtx;
        this._status = 'completed';
        this.emit('result', {
          text: this._output,
          costUsd: 0,
          durationMs: totalDurationMs || (Date.now() - startedAt),
          usage: {
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
          },
          ...(typeof modelContextWindow === 'number' ? { modelContextWindow } : {}),
          // M6 — last call's prompt_eval_count = the context-fill numerator
          // (resident tokens), distinct from the input_tokens sum (billing).
          // The server turns this + the effective num_ctx into a ground-truth
          // context_usage for the CTX bar, and M8 reads it as the compaction
          // threshold. Omitted when no turn reported a count (failover-only
          // turn, or a daemon that dropped the done envelope).
          ...(lastTurnInputTokens > 0 ? { lastPromptTokens: lastTurnInputTokens } : {}),
          ...(turnGenSpeed ? { genSpeed: turnGenSpeed } : {}),
        });
        return;
      }

      // Tools requested. Execute (or refuse), append role:'tool' messages,
      // loop. abort can fire mid-dispatch — the next iteration's signal
      // check + the tool runtime's own aborts will short-circuit cleanly.
      const toolResults = await this.dispatchToolCalls(toolCalls, autoMode, loopDetector, observedToolNames);
      if (this.abortController?.signal.aborted) return;
      messages.push(...toolResults);

      // Phase 5 — mid-turn steer hook. Drain anything the operator typed
      // while we were dispatching tools, append as user messages so the
      // next /api/chat call sees them, and let the model course-correct.
      // Server-side drain handles `queue_update` + `queued_messages_drained`
      // broadcasts; we just inject the text. Attachments are folded as
      // `[attached file: <path>]` text references — mid-turn re-encoding
      // of binary images into the request body is out of scope for v1.
      // A steer that arrives DURING the next streamOneTurn call won't
      // appear here until the iteration after that — by design (we don't
      // abort in-flight calls; the operator's next API call carries it).
      const drainSteer = this.config.drainSteer;
      if (drainSteer) {
        const steerItems = drainSteer();
        for (const item of steerItems) {
          let text = item.content;
          if (item.attachments && item.attachments.length > 0) {
            text += '\n\n' + item.attachments.map((p) => `[attached file: ${p}]`).join('\n');
          }
          messages.push({ role: 'user', content: text });
        }
      }
    }

    this.fail(`Ollama tool-loop exceeded ${MAX_TOOL_TURNS} iterations without producing a final answer`);
  }

  private isAborted(err: unknown): boolean {
    if (!err) return false;
    if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
      return true;
    }
    return false;
  }

  private fail(message: string): void {
    if (this._status === 'failed') return;
    this._status = 'failed';
    this.emit('error', message);
  }

  kill(): void {
    const wasRunning = this._status === 'running' || this._status === 'spawning';
    if (this.abortController && this._status !== 'completed') {
      this.abortController.abort();
    }
    if (wasRunning) {
      this._status = 'failed';
      this.emit('error', 'Worker killed');
    }
  }
}

export const OllamaProvider: Provider = {
  create(id, config) {
    return new OllamaWorkerProcess(id, config);
  },
};

// Per-model capability snapshot. Surfaced to the UI so the picker can
// badge tools-capable / vision-capable models and use the configured
// context window as a lookup default. Probed at boot via /api/show
// (metadata-only call — does not load the model into VRAM).
type OllamaModelCapEntry = readonly [string, OllamaModelCapabilities];

export interface OllamaModelCapabilities {
  tools: boolean;
  vision: boolean;
  thinking: boolean;
  numCtx?: number;
  // Arch max (`<arch>.context_length`) — the num_ctx ceiling when numCtx is unset.
  archCtx?: number;
  // Graded thinking levels, ascending (from /api/show `thinking.values`).
  thinkingLevels?: string[];
  thinkingCanDisable?: boolean;
}

// Probe the Ollama daemon. Returns the installed model list when up plus
// per-model capability metadata (tools / vision / numCtx). Capabilities
// are derived from /api/show's `capabilities` array (a list of strings:
// `completion`, `tools`, `vision`, `thinking`, ...). Failures probing a
// single model don't poison the rest — that model just gets an empty
// capability object. Used by auth.ts to populate the AuthStatus row and
// by the catalog/UI to know what each model is good for.
export async function probeOllama(): Promise<{
  up: boolean;
  models: string[];
  capabilities?: Record<string, OllamaModelCapabilities>;
  error?: string;
}> {
  try {
    const res = await fetch(`${await getOllamaBase()}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      return { up: false, models: [], error: `HTTP ${res.status}` };
    }
    const data = await res.json() as { models?: Array<{ name?: string }> };
    const models = (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);

    // Probe per-model capabilities in parallel. /api/show is metadata-only
    // (no model load), so this is cheap; bounded by `models.length` (rare
    // for an operator to have >5 installed). Each probe is independently
    // capped at 2s; one slow probe doesn't block the rest.
    const capEntries = await Promise.all(models.map(async (name) => {
      try {
        const showRes = await fetch(`${await getOllamaBase()}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
          signal: AbortSignal.timeout(2000),
        });
        if (!showRes.ok) return [name, { tools: false, vision: false, thinking: false }] as OllamaModelCapEntry;
        const show = await showRes.json() as { capabilities?: unknown; parameters?: unknown; thinking?: unknown; model_info?: unknown };
        const archCtx = parseArchContextLength(show.model_info);
        const thinkingInfo = parseOllamaThinking(show.thinking);
        const caps = Array.isArray(show.capabilities)
          ? show.capabilities.filter((c): c is string => typeof c === 'string')
          : [];
        const params = typeof show.parameters === 'string' ? show.parameters : '';
        const ctxMatch = /^\s*num_ctx\s+(\d+)\s*$/m.exec(params);
        const numCtx = ctxMatch ? parseInt(ctxMatch[1], 10) : undefined;
        return [name, {
          tools: caps.includes('tools'),
          vision: caps.includes('vision'),
          thinking: caps.includes('thinking'),
          ...(typeof numCtx === 'number' && Number.isFinite(numCtx) ? { numCtx } : {}),
          ...(archCtx ? { archCtx } : {}),
          ...(caps.includes('thinking') && thinkingInfo && thinkingInfo.levels.length > 0
            ? { thinkingLevels: thinkingInfo.levels, thinkingCanDisable: thinkingInfo.canDisable }
            : {}),
        }] as OllamaModelCapEntry;
      } catch {
        return [name, { tools: false, vision: false, thinking: false }] as OllamaModelCapEntry;
      }
    }));
    const capabilities: Record<string, OllamaModelCapabilities> = {};
    for (const [name, caps] of capEntries) capabilities[name] = caps;

    return { up: true, models, capabilities };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { up: false, models: [], error: message };
  }
}

// Live snapshot of which models are currently loaded into VRAM. Backs the
// Ollama header indicator's LIVE/READY/DOWN states. Cheap one-shot fetch —
// /api/ps is metadata-only on the daemon side. The header poller (gated on
// the operator having Ollama enabled in settings AND the daemon being
// reachable) calls this every ~15s; we keep the timeout tight so a hung
// daemon doesn't stall the indicator.
export async function probeOllamaLive(): Promise<{
  up: boolean;
  version?: string;
  loadedModels: Array<{ name: string; expiresAt: string | null; sizeVram: number | null }>;
  error?: string;
}> {
  // /api/ps + /api/version in parallel — both are metadata-only and the
  // version call is the cheaper of the two, so adding it doesn't change
  // the practical timeout budget. Version failure isn't fatal: if /api/ps
  // succeeds we still report `up: true` and just omit the version field.
  const base = await getOllamaBase();
  try {
    const [psRes, versionRes] = await Promise.all([
      fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${base}/api/version`, { signal: AbortSignal.timeout(2000) }).catch(() => null),
    ]);
    if (!psRes.ok) {
      return { up: false, loadedModels: [], error: `HTTP ${psRes.status}` };
    }
    const data = await psRes.json() as {
      models?: Array<{ name?: string; expires_at?: string; size_vram?: number }>;
    };
    const loadedModels = (data.models ?? [])
      .filter((m): m is { name: string; expires_at?: string; size_vram?: number } => typeof m?.name === 'string' && m.name.length > 0)
      .map((m) => ({
        name: m.name,
        expiresAt: typeof m.expires_at === 'string' ? m.expires_at : null,
        sizeVram: typeof m.size_vram === 'number' ? m.size_vram : null,
      }));
    let version: string | undefined;
    if (versionRes && versionRes.ok) {
      try {
        const vData = await versionRes.json() as { version?: unknown };
        if (typeof vData.version === 'string' && vData.version.length > 0) {
          version = vData.version;
        }
      } catch {
        /* malformed body — fall through with version undefined */
      }
    }
    return { up: true, ...(version ? { version } : {}), loadedModels };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { up: false, loadedModels: [], error: message };
  }
}

// ── M12 (LOCAL_AI_MASTER_PLAN, Excellence LE-6) — model-lifecycle console ──
//
// Aggregate /api/ps across ALL configured backends (M4's getOllamaBackends —
// the same list the chat path fans out over), annotated with the idle/expiry
// countdown the console renders. This is the multi-backend successor to
// probeOllamaLive (which is single-backend, used by the header indicator and
// kept untouched so that hot path's gating discipline is unchanged).
//
// FAIL-SOFT per backend (the M4 connect-timeout posture): a down/unreachable
// host shows `reachable: false` + an error string — never crashes the whole
// aggregation. Each fetch is independently timeout-bounded and the whole fan-out
// runs in parallel, so one hung host can't stall the others (Promise.allSettled
// isn't needed — each per-backend probe already swallows its own error).
//
// /api/ps is metadata-only on the daemon side (no model load), so polling it is
// cheap. The console polls on demand while the operator has it open.

// Injectable fetch for the offline smoke (scripts/smoke/ollama-lifecycle.ts).
// Defaults to global fetch in production; the smoke passes a stub so the ps
// aggregation + unload targeting are exercised without a live daemon.
export type OllamaFetch = typeof fetch;

// Parse one /api/ps `models[]` entry into an OllamaPsModel, computing the
// seconds-until-eviction countdown from the RFC3339 expires_at. The daemon
// reports expires_at as a far-future sentinel (year ~292277) when keep_alive is
// -1/forever; we treat anything more than a year out as "no expiry" (null) so
// the console shows "loaded (no expiry)" instead of a meaningless 9e9-second
// countdown. `nowMs` is the single fetch timestamp so every row's countdown is
// computed against the same clock. Exported for the offline smoke.
export function parsePsModel(
  m: { name: string; expires_at?: string; size_vram?: number; size?: number },
  nowMs: number,
): OllamaPsModel {
  let expiresAt: string | null = null;
  let secondsUntilExpiry: number | null = null;
  if (typeof m.expires_at === 'string' && m.expires_at.length > 0) {
    const t = Date.parse(m.expires_at);
    if (Number.isFinite(t)) {
      const deltaSec = Math.round((t - nowMs) / 1000);
      // Forever-loaded sentinel: the daemon emits a year-292277 timestamp for
      // keep_alive:-1. More than ~370 days out can only be that sentinel.
      if (deltaSec < 370 * 24 * 60 * 60) {
        expiresAt = m.expires_at;
        secondsUntilExpiry = deltaSec;
      }
    }
  }
  return {
    name: m.name,
    expiresAt,
    secondsUntilExpiry,
    sizeVram: typeof m.size_vram === 'number' ? m.size_vram : null,
    size: typeof m.size === 'number' ? m.size : null,
  };
}

// Fetch + parse one backend's /api/ps. Never throws — a transport failure
// becomes `reachable:false` with the error message. `cooling` is read from the
// M4 resilience cooldown Map so the console can grey out a backend the router
// is currently avoiding (LE-6 nice-to-have, cheap: pure in-memory query).
async function fetchBackendPs(
  backend: { baseUrl: string; label: string },
  nowMs: number,
  fetchImpl: OllamaFetch,
): Promise<OllamaPsBackend> {
  const cooling = isBackendCooled(backend.baseUrl, nowMs);
  try {
    const res = await fetchImpl(`${backend.baseUrl}/api/ps`, {
      signal: AbortSignal.timeout(OLLAMA_CONNECT_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { baseUrl: backend.baseUrl, label: backend.label, reachable: false, cooling, loadedModels: [], error: `HTTP ${res.status}` };
    }
    const data = await res.json() as {
      models?: Array<{ name?: string; expires_at?: string; size_vram?: number; size?: number }>;
    };
    const loadedModels = (data.models ?? [])
      .filter((m): m is { name: string; expires_at?: string; size_vram?: number; size?: number } =>
        typeof m?.name === 'string' && m.name.length > 0)
      .map((m) => parsePsModel(m, nowMs));
    return { baseUrl: backend.baseUrl, label: backend.label, reachable: true, cooling, loadedModels };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { baseUrl: backend.baseUrl, label: backend.label, reachable: false, cooling, loadedModels: [], error: message };
  }
}

// Pure core: aggregate /api/ps across a GIVEN backend list. Exported so the
// offline smoke can drive it with injected backends + a stub fetch (no settings
// file, no live daemon). The public wrapper below resolves the M4 backend list.
export async function aggregatePsForBackends(
  backends: Array<{ baseUrl: string; label: string }>,
  fetchImpl: OllamaFetch = fetch,
  nowMs: number = Date.now(),
): Promise<OllamaPsAggregate> {
  const results = await Promise.all(
    backends.map((b) => fetchBackendPs({ baseUrl: b.baseUrl, label: b.label }, nowMs, fetchImpl)),
  );
  return { backends: results, fetchedAt: nowMs };
}

export async function aggregateOllamaPs(): Promise<OllamaPsAggregate> {
  const { backends } = await getOllamaBackends();
  return aggregatePsForBackends(backends.map((b) => ({ baseUrl: b.baseUrl, label: b.label })));
}

// M12 — the keep_alive:0 unload action. Ollama evicts a model from VRAM when it
// receives a request carrying keep_alive:0; open-webui's /api/unload posts
// {model, keep_alive:0} to /api/generate for exactly this. We POST to /api/chat
// (no generate path is wired here, and chat accepts keep_alive at the root just
// the same) with an empty message list so the daemon does no decode — it just
// applies the eviction. NON-DESTRUCTIVE (guardrail: reversible) — the next turn
// reloads the model from disk; this only frees VRAM now.
//
// `baseUrl` targets the SPECIFIC backend the model is loaded on (the console
// knows it from the aggregation row), so a multi-backend operator unloads from
// the right host instead of blindly hitting the primary. Fail-soft: returns
// {ok:false,error} rather than throwing so the route surfaces a clean 4xx/5xx.
export async function unloadOllamaModel(
  model: string,
  baseUrl?: string,
  fetchImpl: OllamaFetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
  const trimmedModel = model.trim();
  if (!trimmedModel) return { ok: false, error: 'model required' };
  const base = (baseUrl?.trim() || (await getOllamaBase())).replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // keep_alive:0 = evict immediately. Empty messages = no decode work; the
      // daemon honors the keep_alive on a no-op chat and unloads.
      body: JSON.stringify({ model: trimmedModel, messages: [], keep_alive: 0, stream: false }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}` };
    }
    // Drain the body so the socket frees cleanly; we don't need its contents.
    await res.text().catch(() => '');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

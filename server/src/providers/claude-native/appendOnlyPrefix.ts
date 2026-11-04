// docs/PROVIDERS.md - pure helpers for keeping the Native request
// prefix (top-level `system`, `tools`, and every already-sent message) append-
// only across a worker's lifetime. Claude Fable 5.1 binds each thinking block's
// signature to that prefix; editing it invalidates every later block (400 on
// enforced accounts). Everything here is stateless so it can be unit-tested
// without a live worker; `worker.ts` owns the frozen snapshots.

// ── Beta header strings (single source of truth; the worker composes them) ──
export const BETA_THINKING_BINDING_CONTROLS = 'thinking-binding-controls-2026-08-01';
export const BETA_MID_CONVERSATION_TOOL_CHANGES = 'mid-conversation-tool-changes-2026-07-01';
export const BETA_SYSTEM_CLEAR_AT = 'mid-conversation-system-clear-at-2026-08-21';
export const BETA_THINKING_DISPLAY_UPDATES = 'thinking-display-updates-2026-08-18';

export type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: string } };

// Minimal tool-def shape shared by client tools (`name` + input_schema) and
// Anthropic server tools (`type` + `name`). `[k: string]` keeps the real defs
// assignable without re-typing every registry shape.
export type ToolDefLike = { name?: string; type?: string; description?: string; defer_loading?: boolean; [k: string]: unknown };

// Identity for diffing. Client tools are keyed by name; server tools by
// versioned type + name so a `web_search_20260209` → `_20260309` bump reads as
// a different tool, not a definition change.
export function toolKey(def: ToolDefLike): string {
  const name = typeof def.name === 'string' ? def.name : '';
  const type = typeof def.type === 'string' ? def.type : '';
  return type && type !== 'custom' ? `${type}:${name}` : name;
}

// Stable name-sort. Anthropic binds `tools` as a name-sorted SET, so order is
// free for the binding check — but a deterministic order keeps the cached
// tools[] prefix byte-identical across requests regardless of REGISTRY /
// MCP-listTools insertion order.
export function sortToolDefs<T extends ToolDefLike>(defs: readonly T[]): T[] {
  return [...defs].sort((a, b) => {
    const ka = toolKey(a);
    const kb = toolKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// ── system-block freeze ──

export interface SystemDelta {
  changed: boolean;
  added: string[];    // full text of blocks present now but not in the frozen set
  removed: string[];  // full text of frozen blocks no longer present
}

// Set-diff on block text (cache_control is not part of the prefix identity).
// A block whose text was edited shows up once in each list.
export function diffSystemBlocks(frozen: readonly SystemBlock[], fresh: readonly SystemBlock[]): SystemDelta {
  const frozenSet = new Set(frozen.map((b) => b.text));
  const freshSet = new Set(fresh.map((b) => b.text));
  const added = fresh.filter((b) => !frozenSet.has(b.text)).map((b) => b.text);
  const removed = frozen.filter((b) => !freshSet.has(b.text)).map((b) => b.text);
  return { changed: added.length > 0 || removed.length > 0, added, removed };
}

const REMOVED_EXCERPT_CHARS = 160;

function firstLineExcerpt(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > REMOVED_EXCERPT_CHARS ? `${line.slice(0, REMOVED_EXCERPT_CHARS)}…` : line;
}

// Text of the appended `role: 'system'` message that carries a system-prompt
// change. Full text for added/updated sections (they must carry operator
// authority verbatim); a one-line excerpt for removed ones — the model only
// needs to know which section stopped applying, not re-read it.
export function renderSystemDelta(delta: SystemDelta): string {
  const parts: string[] = [
    '[Arco operator-context update] The operator changed part of your standing instructions after this conversation started. ' +
    'The sections below supersede any earlier version of the same section; everything else in your system prompt still applies.',
  ];
  if (delta.added.length > 0) {
    parts.push('--- Updated / added ---');
    parts.push(...delta.added);
  }
  if (delta.removed.length > 0) {
    parts.push('--- No longer applies ---');
    parts.push(...delta.removed.map((t) => `• ${firstLineExcerpt(t)}`));
  }
  return parts.join('\n\n');
}

// ── tools freeze ──

export interface ToolSetDelta {
  // Defs whose key is not in the frozen wire array at all → append with
  // defer_loading:true AND surface with tool_addition.
  declare: ToolDefLike[];
  // Keys already declared (deferred or previously removed) that must become
  // visible again → tool_addition only.
  addKeys: string[];
  // Keys visible now that the fresh set no longer contains → tool_removal.
  removeKeys: string[];
  // Keys present in both whose definition JSON differs. Ignored while frozen
  // (the frozen def wins); reported so the log shows what was dropped.
  definitionChanged: string[];
}

function canonicalDef(def: ToolDefLike): string {
  // defer_loading is Arco's wire annotation, not part of the tool's identity.
  const { defer_loading: _defer, ...rest } = def;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

export function diffToolSets(
  frozen: readonly ToolDefLike[],
  active: ReadonlySet<string>,
  fresh: readonly ToolDefLike[],
): ToolSetDelta {
  const frozenByKey = new Map(frozen.map((d) => [toolKey(d), d] as const));
  const freshByKey = new Map(fresh.map((d) => [toolKey(d), d] as const));
  const declare: ToolDefLike[] = [];
  const addKeys: string[] = [];
  const definitionChanged: string[] = [];
  for (const [key, def] of freshByKey) {
    const known = frozenByKey.get(key);
    if (!known) {
      declare.push(def);
      continue;
    }
    if (!active.has(key)) addKeys.push(key);
    else if (canonicalDef(known) !== canonicalDef(def)) definitionChanged.push(key);
  }
  const removeKeys = [...active].filter((key) => !freshByKey.has(key));
  return { declare, addKeys: addKeys.sort(), removeKeys: removeKeys.sort(), definitionChanged: definitionChanged.sort() };
}

// A tool declared after the freeze rides the wire array with defer_loading so
// it extends the bound prefix without changing what the model has already
// seen ("adding a defer_loading tool nothing has referenced yet" keeps later
// thinking valid). Its tool_addition block is what actually loads it.
export function markDeferred<T extends ToolDefLike>(def: T): T {
  return { ...def, defer_loading: true };
}

// The `name` a tool_reference uses. Server tools reference their `name`
// (`web_search`), not the versioned type.
function referenceName(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

export type ToolChangeBlock =
  | { type: 'tool_addition'; tool: { type: 'tool_reference'; name: string } }
  | { type: 'tool_removal'; tool: { type: 'tool_reference'; name: string } };

export function buildToolChangeBlocks(addKeys: readonly string[], removeKeys: readonly string[]): ToolChangeBlock[] {
  const blocks: ToolChangeBlock[] = [];
  for (const key of removeKeys) blocks.push({ type: 'tool_removal', tool: { type: 'tool_reference', name: referenceName(key) } });
  for (const key of addKeys) blocks.push({ type: 'tool_addition', tool: { type: 'tool_reference', name: referenceName(key) } });
  return blocks;
}

// ── appended system messages ──

// Arco-authored `role: 'system'` message. `clear_at` is the turn-scoped
// form (beta); `arco` is a private marker the worker uses to recognise its
// own messages (never sent — stripped by `toWireMessage`).
export type ArcoSystemMessage = {
  role: 'system';
  content: Array<{ type: 'text'; text: string } | ToolChangeBlock>;
  clear_at?: 'next_user_message';
  arco?: 'system_delta' | 'tool_set_change' | 'turn_notice';
};

export function buildPrefixUpdateMessage(
  deltaText: string | null,
  toolBlocks: readonly ToolChangeBlock[],
): ArcoSystemMessage | null {
  if (!deltaText && toolBlocks.length === 0) return null;
  const content: ArcoSystemMessage['content'] = [];
  if (deltaText) content.push({ type: 'text', text: deltaText });
  content.push(...toolBlocks);
  return {
    role: 'system',
    content,
    arco: deltaText && toolBlocks.length > 0 ? 'system_delta' : deltaText ? 'system_delta' : 'tool_set_change',
  };
}

export function buildTurnNoticeMessage(text: string): ArcoSystemMessage {
  return { role: 'system', clear_at: 'next_user_message', content: [{ type: 'text', text }], arco: 'turn_notice' };
}

// Strip Arco-private fields before the wire. Cheap: only system messages
// carry them, everything else is returned by reference.
export function toWireMessages(messages: readonly unknown[]): unknown[] {
  return messages.map((m) => {
    const msg = m as { role?: string; arco?: unknown };
    if (msg.role !== 'system' || msg.arco === undefined) return m;
    const { arco: _arco, ...wire } = msg as Record<string, unknown>;
    return wire;
  });
}

export function isArcoSystemMessage(m: unknown): m is ArcoSystemMessage {
  return !!m && typeof m === 'object' && (m as { role?: string }).role === 'system';
}

// A `role: 'system'` message must be last in `messages` or followed by an
// assistant turn; pushing a user message directly after one is a 400. Pop
// trailing system messages before appending a user turn — removing trailing
// entries binds nothing (no later block exists), and the prefix diff on the
// next request re-detects and re-appends whatever they carried.
export function popTrailingSystemMessages(messages: unknown[]): number {
  let popped = 0;
  while (messages.length > 0 && isArcoSystemMessage(messages[messages.length - 1])) {
    messages.pop();
    popped++;
  }
  return popped;
}

// Not-yet-sent per-turn text when the model has no `role: 'system'` support:
// a trailing text block on the user message, left in place forever.
export function appendTextToLastUserMessage(messages: Array<{ role?: string; content?: unknown }>, text: string): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return false;
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content }, { type: 'text', text }];
    return true;
  }
  if (!Array.isArray(last.content)) return false;
  (last.content as Array<{ type: string; text?: string }>).push({ type: 'text', text });
  return true;
}

// ── thinking-binding controls ──

// Every response under the binding-controls beta carries a top-level
// `input_transformations` array (empty when nothing was dropped). Summarise
// for the ctx_action detail; unknown entry shapes are counted, not thrown on.
export interface InputTransformationSummary {
  count: number;
  prefixMismatch: number;
  modelMismatch: number;
  other: number;
  detail: string;
}

export function summarizeInputTransformations(raw: unknown): InputTransformationSummary | null {
  if (!Array.isArray(raw)) return null;
  let prefixMismatch = 0;
  let modelMismatch = 0;
  let other = 0;
  const parts: string[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    const type = typeof entry?.type === 'string' ? entry.type : '?';
    const path = typeof entry?.path === 'string' ? entry.path : '?';
    const reason = typeof entry?.reason === 'string' ? entry.reason : '?';
    if (reason === 'prefix_binding_mismatch') prefixMismatch++;
    else if (reason === 'model_binding_mismatch') modelMismatch++;
    else other++;
    parts.push(`${type}@${path} (${reason})`);
  }
  return { count: raw.length, prefixMismatch, modelMismatch, other, detail: parts.join(', ') };
}

// The preserved-thinking rejection (enforced account without the beta, or an
// undecryptable signature). Anthropic's wording: "Invalid `signature` in
// `thinking` block" — optionally followed by "bound to a different
// conversation" and a `block_binding` hint. Match the stable leading clause.
//
// The second wording is the narrower last-message rule: "`thinking` or
// `redacted_thinking` blocks in the latest assistant message cannot be
// modified. These blocks must remain as they were in the original response."
// It shares none of the first form's vocabulary (no "invalid", no
// "signature"), so it fell through to the fatal branch and wedged the tab —
// every later turn, count_tokens AND Compact replayed the same rejected
// history (2026-09-05). Any history edit that reaches the API is recoverable
// the same way: drop the thinking blocks and retry once.
export function isThinkingBindingError(message: string): boolean {
  const m = message.toLowerCase();
  return (m.includes('invalid') && m.includes('signature') && m.includes('thinking'))
    || m.includes('bound to a different conversation')
    || m.includes('prefix_mismatch_behavior')
    || (m.includes('latest assistant message') && m.includes('cannot be modified'));
}

// A 400 that names one of the append-only wire features the worker added —
// the org isn't allowlisted for a beta, or a model turned out not to support
// `role: 'system'` / tool_reference blocks. Recovery is "thaw": drop the
// Arco system messages and fall back to the pre-plan rebuild-per-request
// behaviour for the rest of the worker's life.
export function isPrefixFeatureRejection(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('tool_addition')
    || m.includes('tool_removal')
    || m.includes('tool_reference')
    || m.includes('defer_loading')
    || m.includes('clear_at')
    || m.includes('block_binding')
    || (m.includes("role 'system'") || m.includes('role "system"') || m.includes('role: system'));
}

// One-time recovery for a binding 400: drop every thinking block from history
// (text / tool_use / tool_result stay) so the retry carries nothing bound.
// A message left empty gets the same placeholder the trailing-strip uses.
export function stripAllThinkingBlocks(
  messages: Array<{ role?: string; content?: unknown }>,
  placeholder: string,
): { messages: number; blocks: number } {
  let touched = 0;
  let blocks = 0;
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const kept = (msg.content as Array<{ type?: string }>).filter((b) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking');
    const removed = msg.content.length - kept.length;
    if (removed === 0) continue;
    touched++;
    blocks += removed;
    msg.content = kept.length > 0 ? kept : [{ type: 'text', text: placeholder }];
  }
  return { messages: touched, blocks };
}

// Drop Arco's own system messages (thaw recovery). Removing them from the
// middle is a history edit, but thaw only runs after the API already rejected
// the request, so nothing bound survives anyway.
export function removeArcoSystemMessages(messages: unknown[]): number {
  let removed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isArcoSystemMessage(messages[i])) {
      messages.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

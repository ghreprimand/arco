// Phase P0 (WORKBENCH_EXPANSION_PLAN) — extracted from worker.ts to keep that
// file under the 2000-line cap. Content-block types and the pure helpers that
// build/transform them: image blocks, user-message assembly, server-tool defs,
// context-management edits, the tool-loop continuation predicate, and the
// trailing-thinking stripper. No worker state here.

import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { modelImagePath } from '../attachments.js';
import { getNativeToolDefinitions } from './tools.js';
import { isServerToolResultType } from './retainedContext.js';

export type ToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
};

export type ImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string };
};

export type ServerToolUseBlock = {
  type: 'server_tool_use';
  id: string;
  name: string;
  input: unknown;
  caller?: unknown;
};

export type ServerToolResultBlock = {
  type:
    | 'web_search_tool_result'
    | 'web_fetch_tool_result'
    | 'tool_search_tool_result'
    | 'code_execution_tool_result'
    | 'bash_code_execution_tool_result'
    | 'text_editor_code_execution_tool_result'
    | 'container_upload';
  tool_use_id?: string;
  content?: unknown;
  file_id?: string;
  [key: string]: unknown;
};

export type AnyContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | ImageBlock
  | ToolUseBlock
  | ServerToolUseBlock
  | ServerToolResultBlock
  | CompactionBlock;

// Server-side compaction (`compact_20260112`, opt-in claudeNativeCompact). The
// API returns the summary as its own assistant block and REQUIRES it back
// verbatim on every later request: it ignores everything before the block, so
// dropping it (pre-2026-09-25 the stream parser had no branch for it) made
// every request resend the full history and re-compact every round. Kept in
// stream order inside the assistant message like thinking/tool blocks, never
// rendered as assistant text. `content` is null only if the stream ends before
// the single compaction_delta lands.
export type CompactionBlock = { type: 'compaction'; content: string | null; [key: string]: unknown };

export function isCompactionBlock(b: unknown): b is CompactionBlock {
  return isRecord(b) && b.type === 'compaction';
}

// True once any assistant message carries a server compaction block — the
// compact beta must then ride every later request (a compaction block without
// it is an unknown block type), even if the operator has since turned the
// per-tab toggle off.
export function historyHasCompactionBlock(messages: readonly { role?: string; content?: unknown }[]): boolean {
  return messages.some((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(isCompactionBlock));
}

// `usage.iterations` on a compacting response: one `{type:'compaction'}` entry
// (the summarizer pass: input it read, summary it wrote) before the normal
// `{type:'message'}` entry. Top-level input/output EXCLUDE the compaction pass.
export function summarizeCompactionIterations(raw: unknown): { inputTokens: number; outputTokens: number } | null {
  if (!Array.isArray(raw)) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let found = false;
  for (const it of raw) {
    if (!isRecord(it) || it.type !== 'compaction') continue;
    found = true;
    if (typeof it.input_tokens === 'number') inputTokens += it.input_tokens;
    if (typeof it.output_tokens === 'number') outputTokens += it.output_tokens;
  }
  return found ? { inputTokens, outputTokens } : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export type ClaudeNativeToolDef =
  | ReturnType<typeof getNativeToolDefinitions>[number]
  | { type: 'web_search_20260209'; name: 'web_search'; allowed_callers: ['direct']; max_uses?: number }
  | { type: 'web_fetch_20260309'; name: 'web_fetch'; allowed_callers: ['direct']; max_uses?: number }
  | { type: 'code_execution_20260120' | 'code_execution_20250825'; name: 'code_execution' };

// Default web-search / web-fetch budget for ordinary turns. Operators can
// override it per-tab via CONFIG (`WorkflowConfig.webSearchMaxUses`), and the
// Deep Research primitive (WORKBENCH_EXPANSION_PLAN.md §B2) overrides it
// per-spawn via the same field tied to the operator's `maxRounds` — see
// buildClaudeServerTools below. This is an Arco-set ceiling, not an Anthropic
// default: each turn rebuilds the server-tool defs with this `max_uses`.
const DEFAULT_WEB_TOOL_MAX_USES = 15;

export const CLAUDE_CODE_SERVER_TOOLS: ClaudeNativeToolDef[] = buildClaudeServerTools();

// Build the Anthropic server-tool defs. `webSearchMaxUses`, when provided,
// overrides the web_search / web_fetch `max_uses` budget (Deep Research uses
// this to enforce its round cap mechanically server-side, not just by prompt).
// Unset ⇒ the historical default of 10 so ordinary turns are unchanged.
export function buildClaudeServerTools(webSearchMaxUses?: number): ClaudeNativeToolDef[] {
  const maxUses = typeof webSearchMaxUses === 'number' && webSearchMaxUses > 0
    ? webSearchMaxUses
    : DEFAULT_WEB_TOOL_MAX_USES;
  return [
    { type: 'web_search_20260209', name: 'web_search', allowed_callers: ['direct'], max_uses: maxUses },
    { type: 'web_fetch_20260309', name: 'web_fetch', allowed_callers: ['direct'], max_uses: maxUses },
    { type: 'code_execution_20260120', name: 'code_execution' },
  ];
}

// Chat-mode web tools. Deliberately NOT buildClaudeServerTools(): a Chat tab
// gets web_search + web_fetch and nothing else, so `code_execution` (which
// would hand a projectless chat a sandboxed interpreter the operator never
// armed) stays out of the set.
export function buildChatWebTools(webSearchMaxUses?: number): ClaudeNativeToolDef[] {
  return buildClaudeServerTools(webSearchMaxUses).filter(
    (t) => t.name === 'web_search' || t.name === 'web_fetch',
  );
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// Anthropic rejects an image whose BASE64 payload exceeds 5 MB ("image exceeds
// 5 MB maximum: N bytes > 5242880 bytes") — the limit is on the encoded
// string, so a 5 MB raw file (≈6.7 MB base64) would still 400. Capping the
// encoded size is the only cap that actually keeps the request valid; raw
// files above ~3.75 MB fold to a text ref. Uploads get a downscaled
// `.model.<ext>` sibling (attachments.ts) that fits, so this now only trips
// when no ImageMagick/sips is available, the derivation failed, or it hadn't
// finished when the (synchronous) builder ran.
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_RAW_BYTES = Math.floor(MAX_IMAGE_BASE64_BYTES / 4) * 3;

// Sniff the real media type from magic bytes. The extension lies often enough
// (a `.png` that is really a JPEG screenshot) and Anthropic 400s a
// media_type / payload mismatch, which wedges the long-lived history.
export function sniffImageMediaType(buf: Uint8Array): ImageBlock['source']['media_type'] | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
    && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return 'image/gif';
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return null;
}

// Why an image-extension attachment was folded to a text ref instead of a
// block. Non-image extensions are not "skipped" — they're plain file refs.
export type SkippedImage = { path: string; reason: 'empty' | 'oversized' | 'unrecognized' | 'unreadable'; bytes?: number };

// Read a local image into an Anthropic image content block. Returns null if
// the path isn't a recognized image extension, the file isn't readable, is
// empty, is over the encoded-size cap, or its bytes aren't PNG/JPEG/GIF/WEBP —
// caller falls back to a text reference so the model at least sees the path.
// Every one of those would otherwise be a block Anthropic 400s, and once
// pushed into the long-lived messages[] it 400s every later turn (2026-08-07
// incident: an empty laptop paste upload encoded to `data: ''`).
function buildImageBlock(path: string, skipped?: SkippedImage[]): ImageBlock | null {
  if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return null;
  try {
    // The upload-time downscaled sibling when there is one (attachments.ts),
    // so a big screenshot fits the cap instead of folding to a path. The
    // media type below is sniffed from these bytes, so a JPEG re-encode of a
    // .png types itself. `skipped` keeps naming the original.
    const src = modelImagePath(path);
    // Size check BEFORE the read so a huge file never lands in memory.
    const size = statSync(src).size;
    if (size === 0) { skipped?.push({ path, reason: 'empty' }); return null; }
    if (size > MAX_IMAGE_RAW_BYTES) { skipped?.push({ path, reason: 'oversized', bytes: size }); return null; }
    const buf = readFileSync(src);
    if (buf.length === 0) { skipped?.push({ path, reason: 'empty' }); return null; }
    const mediaType = sniffImageMediaType(buf);
    if (!mediaType) { skipped?.push({ path, reason: 'unrecognized', bytes: buf.length }); return null; }
    const data = buf.toString('base64');
    if (data.length > MAX_IMAGE_BASE64_BYTES) { skipped?.push({ path, reason: 'oversized', bytes: buf.length }); return null; }
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  } catch {
    skipped?.push({ path, reason: 'unreadable' });
    return null;
  }
}

// Pre-request repair for an image block ALREADY in history (the builder guard
// above only protects new attachments). Oversized → a text placeholder (the
// API would 400 it on every later request); a media_type that disagrees with
// the payload's magic bytes → retyped in place. Payloads whose magic isn't
// recognized are left alone — only a positive sniff overrides the declared type.
export function repairImageBlock(block: Record<string, unknown>): { action: 'keep' } | { action: 'retyped' } | { action: 'replace'; text: string } {
  if (block.type !== 'image' || !isRecord(block.source) || block.source.type !== 'base64') return { action: 'keep' };
  const src = block.source as { data?: unknown; media_type?: unknown };
  if (typeof src.data !== 'string') return { action: 'keep' };
  if (src.data.length > MAX_IMAGE_BASE64_BYTES) {
    return { action: 'replace', text: `[image omitted by Arco: ${src.data.length} base64 bytes exceeds the 5 MB API limit]` };
  }
  if (src.data.length === 0) return { action: 'keep' };
  const head = Buffer.from(src.data.slice(0, 24), 'base64');
  const sniffed = sniffImageMediaType(head);
  if (sniffed && sniffed !== src.media_type) {
    src.media_type = sniffed;
    return { action: 'retyped' };
  }
  return { action: 'keep' };
}

// Operator-facing one-liner for folded images (worker emits it as a
// system_notice so a dropped screenshot is never silent).
export function describeSkippedImages(skipped: readonly SkippedImage[]): string | null {
  if (skipped.length === 0) return null;
  const why = (s: SkippedImage): string => {
    switch (s.reason) {
      case 'empty': return 'empty file';
      case 'oversized': return `${((s.bytes ?? 0) / (1024 * 1024)).toFixed(1)} MB — over the ${(MAX_IMAGE_RAW_BYTES / (1024 * 1024)).toFixed(2)} MB cap (5 MB base64 API limit)`;
      case 'unrecognized': return 'not a PNG/JPEG/GIF/WEBP by content';
      case 'unreadable': return 'unreadable';
    }
  };
  return `Image attachment(s) sent as a file path, not an image: ${skipped.map((s) => `${s.path} (${why(s)})`).join('; ')}.`;
}

export type ContextManagementCapabilities = {
  supportsClearThinking: boolean;
  supportsClearToolUses: boolean;
  supportsCompact: boolean;
} | null;

export function buildContextManagementEditsForRequest(
  caps: ContextManagementCapabilities,
  compactEnabled: boolean,
): Array<{ type: string }> {
  if (!caps) return [];
  const edits: Array<{ type: string }> = [];
  // Deliberately do not include clear_thinking_20251015 or
  // clear_tool_uses_20250919 by default. They save context, but they are not a
  // transparent Claude Code parity feature for active research turns: in the
  // observed Opus 4.8 failure, `clear_tool_uses` let web_search evidence be
  // replaced with "Search result was cleared", causing repeated searches and
  // stale-source conclusions. Compact remains the safe server-managed pressure
  // valve because it preserves the conversation at summary granularity.
  if (caps.supportsCompact && compactEnabled) {
    edits.push({ type: 'compact_20260112' });
  }
  return edits;
}

// Whether the `compact-2026-01-12` beta string belongs on the request's
// anthropic-beta header. Same gate as the context_management edit: the model
// must advertise compact support AND the per-tab toggle must be the explicit
// opt-in true. Pure so workerParity.test.ts can guard it without a live worker.
export function shouldSendCompactBeta(
  caps: ContextManagementCapabilities,
  compactEnabled: boolean,
  historyHasCompaction = false,
): boolean {
  return (!!caps?.supportsCompact && compactEnabled) || historyHasCompaction;
}

export function shouldContinueNativeToolLoop(
  contentBlocks: readonly { type?: string }[],
  stopReason: string | null | undefined,
): boolean {
  // Both are truncation stops: a tool_use cut off mid-input may carry a
  // partial/unparsed input, so never dispatch it. `model_context_window_exceeded`
  // is the context-window twin of max_tokens (the response hit the window, not
  // the output cap); looping on it would resend an even larger prompt.
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') return false;
  if (contentBlocks.some((b) => b.type === 'tool_use')) return true;
  return stopReason === 'pause_turn';
}

// Pure core of `ClaudeNativeWorker.pruneOrphanToolUse`, exported for unit
// testing. An assistant message is orphaned — and wedges every later
// messages.create — when it carries a tool call with no matching result:
//   • a client `tool_use` whose `tool_result` lives in the FOLLOWING user
//     message, so a TRAILING assistant tool_use can never be answered; or
//   • a `server_tool_use` (web_search / web_fetch / code_execution) whose
//     `*_tool_result` belongs in the SAME message but is absent because the
//     round was interrupted or aborted before the result streamed in.
// Anthropic rejects the latter with "web_search tool use ... was found without
// a corresponding web_search_tool_result block" on EVERY later request, which
// permanently wedges a long-lived Native worker until it replays from disk.
// Returns the unpaired ids (client + server); empty ⇒ the message is
// well-formed and the caller must keep it (a completed server-tool turn pairs
// its call with a result in-message and must NOT be dropped).
export function orphanToolUseIds(
  content: readonly { type?: string; id?: string; tool_use_id?: string }[],
): string[] {
  const clientIds = content.filter((b) => b?.type === 'tool_use').map((b) => b.id ?? '');
  const serverResultIds = new Set(
    content
      .filter((b) => typeof b?.type === 'string' && isServerToolResultType(b.type))
      .map((b) => b.tool_use_id ?? ''),
  );
  const orphanServerIds = content
    .filter((b) => b?.type === 'server_tool_use')
    .map((b) => b.id ?? '')
    .filter((id) => !serverResultIds.has(id));
  return [...clientIds, ...orphanServerIds];
}

// §2.1 delta 1 — FULL-LIST orphan detection. `orphanToolUseIds` above inspects a
// single message; the recovery pruner `pruneOrphanToolUse` only re-checks the
// TRAILING assistant message. Neither catches a MID-LIST orphan — an assistant
// `tool_use` whose paired `tool_result` is missing from the IMMEDIATELY
// FOLLOWING user message — which is exactly the shape a history splice (e.g. a
// Fold that cut between a tool_use and its result) would produce, and the
// 25bffd1 class of wedge (an orphan that 400s every later messages.create).
//
// Walks the whole array and returns every orphaned tool-call id:
//   • a client `tool_use` whose id is absent from the next message's
//     `tool_result` blocks, and
//   • an in-message `server_tool_use` without its `*_tool_result`.
// Pure; empty result ⇒ the array is well-formed. Used as an orphan-free guard
// after the Fold splice (the clean reseed shape never carries tool blocks, so
// it is a no-op there — defense-in-depth + the detector the recovery path can
// adopt). Reuses isServerToolResultType for the server pairing, same as
// orphanToolUseIds.
export function fullListOrphanToolUseIds(
  messages: readonly { role?: string; content?: unknown }[],
): string[] {
  const orphans: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const content = m.content as Array<{ type?: string; id?: string; tool_use_id?: string }>;
    // In-message server-tool orphans (call + result share the assistant message).
    const serverResultIds = new Set(
      content.filter((b) => typeof b?.type === 'string' && isServerToolResultType(b.type)).map((b) => b.tool_use_id ?? ''),
    );
    for (const b of content) {
      if (b?.type === 'server_tool_use' && !serverResultIds.has(b.id ?? '')) orphans.push(b.id ?? '');
    }
    // Client tool_use must be answered by tool_result in the NEXT message.
    const clientIds = content.filter((b) => b?.type === 'tool_use').map((b) => b.id ?? '');
    if (clientIds.length === 0) continue;
    const next = messages[i + 1] as { content?: unknown } | undefined;
    const nextResultIds = new Set<string>(
      next && Array.isArray(next.content)
        ? (next.content as Array<{ type?: string; tool_use_id?: string }>)
            .filter((b) => b?.type === 'tool_result')
            .map((b) => b.tool_use_id ?? '')
        : [],
    );
    for (const id of clientIds) if (!nextResultIds.has(id)) orphans.push(id);
  }
  return orphans;
}

// Placeholder substituted for an assistant message that is ALL thinking blocks
// (would otherwise strip to empty, which is also an invalid assistant message).
export const THINKING_ONLY_PLACEHOLDER = '[thinking-only turn omitted by Arco]';

// Pure core of `ClaudeNativeWorker.stripTrailingThinkingBlocks`, exported for
// unit testing. Anthropic rejects an assistant message whose content array
// ENDS with a `thinking` / `redacted_thinking` block. Removes the contiguous
// trailing run of thinking blocks; thinking blocks that precede a tool_use /
// text are preserved (with signatures) for reasoning continuity. Returns the
// (possibly new) content array and how many blocks were dropped — `stripped`
// is 0 and the original array is returned by reference when nothing changed.
export function stripTrailingThinkingFromContent(
  content: readonly { type?: string }[],
): { content: { type?: string }[]; stripped: number } {
  let end = content.length;
  while (end > 0) {
    const t = content[end - 1]?.type;
    if (t === 'thinking' || t === 'redacted_thinking') end--;
    else break;
  }
  if (end === content.length) return { content: content as { type?: string }[], stripped: 0 };
  const stripped = content.length - end;
  const next = end > 0
    ? content.slice(0, end)
    : [{ type: 'text', text: THINKING_ONLY_PLACEHOLDER }];
  return { content: next as { type?: string }[], stripped };
}

// Compose a user message: when no image attachments, keep the simple text
// shape; otherwise build a content[] with text + image blocks (and any
// non-image attachments folded into the text as `[attached file: ...]`
// references, matching exec-mode codex / appserver behavior).
// `skipped`, when passed, collects image-extension attachments that were
// folded to a text ref (empty / oversized / unrecognized) for a system_notice.
export function buildUserMessageContent(prompt: string, attachments: string[] | undefined, skipped?: SkippedImage[]): string | AnyContentBlock[] {
  if (!attachments || attachments.length === 0) return prompt;
  const images: ImageBlock[] = [];
  const nonImages: string[] = [];
  for (const p of attachments) {
    const block = buildImageBlock(p, skipped);
    if (block) images.push(block);
    else nonImages.push(p);
  }
  const refs = nonImages.map((p) => `[attached file: ${p}]`).join('\n');
  const text = [prompt, refs].filter((part) => part.length > 0).join('\n\n');
  if (images.length === 0) {
    return text;
  }
  const blocks: AnyContentBlock[] = [...images];
  if (text.length > 0) blocks.push({ type: 'text', text });
  return blocks;
}

export type Role = 'user' | 'assistant';
export type MessageParam = { role: Role; content: string | AnyContentBlock[] };

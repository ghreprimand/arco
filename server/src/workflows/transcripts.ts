import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { ChatMessage, TokenUsage } from '@arco/shared';
import { UUID_PATTERN } from '../server/constants.js';
import { readLatestCodexTokenCount, rawUsageToTokenUsage } from '../codexRolloutTokens.js';

// Claude message.content is either a string or a list of content blocks;
// reviewer-primitive-derived user turns also prepend synthetic blocks
// (permission-mode / Continue from where you left off). Strip them to a
// single-line preview. Also strips the Arco safety-reminder footer and
// skips synthetic content entirely — Claude injects slash-command stdout,
// image-attachment placeholders, and other machine-generated "user" turns
// into the JSONL. None of those help the operator identify the conversation.
// ULTRACODE_PLAN.md — Arco prepends `ultracode: ` to the prompt to trigger
// the CLI's WorkflowTool keyword. That prefix lands verbatim in Claude's
// session JSONL. Left in, it (a) shows as an ugly prefix the operator never
// typed and (b) breaks the content-signature dedup that reconciles transcript-
// hydrated rows against the clean event-stream `user_message_echo` — so the
// operator's message renders twice (once clean, once prefixed) on reload.
// Strip it at the JSONL→chat boundary so every transcript consumer sees the
// raw prompt.
const ULTRACODE_PROMPT_PREFIX = /^ultracode:[ \t]+/i;
export function stripUltracodePrefix(s: string): string {
  return s.replace(ULTRACODE_PROMPT_PREFIX, '');
}

export function extractUserText(content: unknown): string {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = (content as Array<{ text?: string }>)
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join(' ');
  }
  // Strip Arco's safety-reminder footer before anything else.
  const marker = '[Arco safety reminders';
  const idx = text.indexOf(marker);
  if (idx !== -1) {
    const before = text.slice(0, idx).trimEnd();
    text = before.endsWith('---') ? before.slice(0, -3).trimEnd() : before;
  }
  const trimmed = text.trim();
  // Treat common synthetic-turn shapes as empty so the tail-scan keeps
  // walking backwards to the nearest real operator message.
  if (!trimmed) return '';
  if (/^<(local-command-stdout|local-command-stderr|command-message|command-name|local-command)\b/.test(trimmed)) return '';
  if (/^\[Image:\s*source:/.test(trimmed)) return '';
  if (/^\[Request interrupted/.test(trimmed)) return '';
  if (trimmed.startsWith('<bash-stdout>') || trimmed.startsWith('<bash-stderr>')) return '';
  return stripUltracodePrefix(trimmed.replace(/\s+/g, ' '));
}

export function extractTranscriptText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === 'text' && typeof rec.text === 'string') {
      parts.push(rec.text);
    } else if (rec.type === 'tool_use' && typeof rec.name === 'string') {
      parts.push(`*[${rec.name}]*`);
    } else if (rec.type === 'tool_result' && typeof rec.content === 'string') {
      parts.push(`> ${rec.content.slice(0, 400)}${rec.content.length > 400 ? '…' : ''}`);
    }
  }
  return parts.join('\n').trim();
}

export async function loadTranscript(path: string): Promise<ChatMessage[]> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return [];
  }
  const text = buf.toString('utf-8');
  const messages: ChatMessage[] = [];
  let seen = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const timestamp = typeof entry.timestamp === 'string'
      ? (Date.parse(entry.timestamp) || Date.now())
      : Date.now();
    if (entry.type === 'user' && entry.message) {
      const content = stripUltracodePrefix(extractTranscriptText(entry.message.content));
      if (!content) continue;
      messages.push({ id: `hist-${seen++}`, role: 'user', content, isStreaming: false, timestamp });
    } else if (entry.type === 'assistant' && entry.message) {
      const content = extractTranscriptText(entry.message.content);
      if (!content) continue;
      messages.push({ id: `hist-${seen++}`, role: 'assistant', content, isStreaming: false, timestamp });
    }
  }
  return messages;
}

// Codex rollout hydration — parallel to Claude's loadTranscript. Rollout
// entries we care about for chat:
//   event_msg::user_message  → role=user, payload.message
//   event_msg::agent_message → role=assistant, payload.message
// Everything else (reasoning, function_call, token_count, turn_context,
// session_meta) is skipped for v1 — the aim is a legible conversation
// rebuild, not a full trace. Tool_use rendering is a separate follow-up
// (matches the Claude path: loadTranscript also drops tool blocks).
export async function loadCodexTranscript(path: string): Promise<ChatMessage[]> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return [];
  }
  const messages: ChatMessage[] = [];
  let seen = 0;
  for (const line of buf.toString('utf-8').split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'event_msg' || !entry.payload) continue;
    const p = entry.payload;
    const timestamp = typeof entry.timestamp === 'string'
      ? (Date.parse(entry.timestamp) || Date.now())
      : Date.now();
    if (p.type === 'user_message' && typeof p.message === 'string') {
      const content = p.message.trim();
      if (!content) continue;
      messages.push({ id: `hist-${seen++}`, role: 'user', content, isStreaming: false, timestamp });
    } else if (p.type === 'agent_message' && typeof p.message === 'string') {
      const content = p.message.trim();
      if (!content) continue;
      messages.push({ id: `hist-${seen++}`, role: 'assistant', content, isStreaming: false, timestamp });
    }
  }
  return messages;
}

// Resolve a Codex rollout path from a session UUID. Rollout files live at
// ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl, with the UUID
// embedded in the filename suffix. We walk newest-first (Codex sessions being
// resumed are almost always recent) and return on the first match so the
// typical hit is O(days_scanned * files_per_day) with early exit.
export async function findCodexRolloutPath(sessionId: string, codexHome?: string): Promise<string | null> {
  if (!UUID_PATTERN.test(sessionId)) return null;
  const root = join(codexHome || join(homedir(), '.codex'), 'sessions');
  const years = (await readdir(root).catch(() => [])).filter((y) => /^\d{4}$/.test(y)).sort().reverse();
  const suffix = `-${sessionId}.jsonl`;
  for (const y of years) {
    const months = (await readdir(join(root, y)).catch(() => [])).filter((m) => /^\d{2}$/.test(m)).sort().reverse();
    for (const m of months) {
      const days = (await readdir(join(root, y, m)).catch(() => [])).filter((d) => /^\d{2}$/.test(d)).sort().reverse();
      for (const d of days) {
        const dayDir = join(root, y, m, d);
        const files = await readdir(dayDir).catch(() => []);
        for (const f of files) {
          if (f.startsWith('rollout-') && f.endsWith(suffix)) {
            return join(dayDir, f);
          }
        }
      }
    }
  }
  return null;
}

export async function latestCodexTokenSnapshot(sessionId: string, codexHome?: string): Promise<{ tokens: TokenUsage; modelContextWindow?: number } | null> {
  const path = await findCodexRolloutPath(sessionId, codexHome);
  if (!path) return null;
  const info = await readLatestCodexTokenCount(path);
  if (!info?.last_token_usage) return null;
  const tokens = rawUsageToTokenUsage(info.last_token_usage);
  if (!tokens.input && !tokens.output) return null;
  return {
    tokens,
    ...(typeof info.model_context_window === 'number' ? { modelContextWindow: info.model_context_window } : {}),
  };
}

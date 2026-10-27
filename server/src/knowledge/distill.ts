// Knowledge "distill from session" DRAFT - docs/ARCHITECTURE.md
//
// Mirrors runDocEdit.ts: spawns a SHORT-LIVED, READ-ONLY worker for ONE bounded
// turn. Its entire output is a DRAFT article (title + body + tag suggestions)
// distilled from the current workflow transcript, returned verbatim in the
// `knowledge_distill_proposed` event.
//
// THE FENCE (CLAUDE.md hard fences + plan Appendix B): the agent only DRAFTS.
// It has NO Write/Edit tool and NO access to the knowledge store. The draft
// lands in the wizard as editable fields; the operator edits and explicitly
// Saves through the normal POST /api/knowledge create path. There is no
// auto-commit, no background curation, no "learn from this session" automation
// anywhere in this file. This is the sanctioned, operator-in-the-loop cousin of
// the rejected self-writing memory — operator-initiated + bounded + the only
// persist path is a human Save ⇒ clears the four-question test.

import { WorkerManager } from '../workers/WorkerManager.js';
import {
  KNOWLEDGE_DISTILL_CONTEXT_LIMIT,
  type ServerMessage,
  type ProviderName,
  type ModelName,
  type EffortLevel,
} from '@arco/shared';

export interface DistillerConfig {
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  providerAccountRef?: string;
  codexHome?: string;
}

export interface DistillContext {
  workflowId: string;
  cwd: string;
  manager: WorkerManager;
  broadcast: (msg: ServerMessage) => void;
}

export interface DistillHandle {
  distillId: string;
  settled: Promise<{ title: string; body: string; tags: string[]; error?: string }>;
}

// Read-only local tool sets — NO Write/Edit/Bash. Identical posture to
// runDocEdit / the recall summarizer.
function toolsFor(provider: ProviderName): string[] | undefined {
  if (provider === 'claude' || provider === 'ollama' || provider === 'llamacpp' || provider === 'lmstudio' || (provider === 'strata' || provider === 'deepseek')) {
    return ['Read', 'Grep', 'Glob'];
  }
  return undefined;
}

function clampTranscript(s: string): string {
  if (s.length <= KNOWLEDGE_DISTILL_CONTEXT_LIMIT) return s;
  // Keep the TAIL — the most recent exchanges are the likeliest to hold the
  // fact worth capturing.
  return '[... earlier transcript trimmed ...]\n' + s.slice(s.length - KNOWLEDGE_DISTILL_CONTEXT_LIMIT);
}

function buildFraming(transcript: string, focus?: string): string {
  const focusLine = focus?.trim()
    ? `\nThe operator asked you to focus on: ${focus.trim()}\n`
    : '';
  return `You are drafting ONE knowledge-base article for an operator-owned project knowledge base — a curated companion to CLAUDE.md (repo layout, gotchas, deploy steps, conventions). Read the session transcript below and distill a single, reusable, durable fact or how-to worth remembering across future sessions.
${focusLine}
Output format — return ONLY a markdown article, nothing else:
- First line: a single \`# Title\` H1 (short, specific).
- Then the article body in markdown: the durable fact / steps / gotcha, written so a future agent with no memory of this session can use it.
- On the LAST line, a tags line of the exact form: \`tags: a, b, c\` (3-6 short lowercase tags).

Hard rules:
- This is a DRAFT. The operator will edit and approve it before anything is saved. Do NOT claim it has been saved.
- Capture DURABLE project knowledge, not a recap of this conversation. No "in this session we…" framing.
- No preamble, no commentary, no code fences around the whole article.
- You have read-only tools (Read / Grep / Glob) to verify a detail if needed; you CANNOT write or edit any file.

--- SESSION TRANSCRIPT (read-only) ---
${clampTranscript(transcript)}

Now output ONLY the draft article (H1 title, body, trailing tags line).`;
}

// Parse the drafted markdown into { title, body, tags }. Best-effort and
// forgiving — a malformed draft still round-trips into editable fields rather
// than failing.
export function parseDraft(raw: string): { title: string; body: string; tags: string[] } {
  let text = raw.trim();
  // Strip an outer code fence if the model wrapped the whole thing.
  const fenceOpen = /^```[^\n]*\n/;
  if (fenceOpen.test(text) && text.endsWith('```')) {
    text = text.replace(fenceOpen, '').replace(/\n?```$/, '').trim();
  }
  const lines = text.split('\n');
  let title = '';
  if (lines.length && /^#\s+/.test(lines[0])) {
    title = lines[0].replace(/^#\s+/, '').trim();
    lines.shift();
  }
  let tags: string[] = [];
  // Pull a trailing `tags: a, b, c` line if present.
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
    const m = lines[i].match(/^\s*tags:\s*(.+)$/i);
    if (m) {
      tags = m[1].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
      lines.splice(i, 1);
      break;
    }
  }
  return { title, body: lines.join('\n').trim(), tags };
}

export function runDistill(
  ctx: DistillContext,
  args: { drafter: DistillerConfig; transcript: string; focus?: string },
): DistillHandle {
  const distillId = `distill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();

  ctx.broadcast({ type: 'knowledge_distill_started', workflowId: ctx.workflowId, distillId, startedAt });

  const spec = {
    id: distillId,
    task: buildFraming(args.transcript, args.focus),
    model: args.drafter.model,
    effort: args.drafter.effort,
    provider: args.drafter.provider,
    tools: toolsFor(args.drafter.provider),
  };

  let collected = '';
  const settled = ctx.manager.spawn(
    spec,
    (ev) => {
      if (ev.type === 'worker_text') collected += ev.text;
      else if (ev.type === 'worker_system_notice') {
        ctx.broadcast({ type: 'system_notice', workflowId: ctx.workflowId, content: ev.notice });
      }
    },
    {
      cwd: ctx.cwd,
      workflowId: ctx.workflowId,
      skipPermissions: args.drafter.provider === 'ollama',
      sandbox: 'read-only',
      outputStyle: 'normal',
      ...(args.drafter.provider === 'codex' && args.drafter.codexHome
        ? { providerAccountRef: args.drafter.providerAccountRef, codexHome: args.drafter.codexHome }
        : {}),
    },
  ).then((r) => {
    const completedAt = Date.now();
    if (r.error) {
      ctx.broadcast({
        type: 'knowledge_distill_proposed',
        workflowId: ctx.workflowId,
        distillId,
        title: '',
        body: '',
        tags: [],
        error: r.error,
        completedAt,
      });
      return { title: '', body: '', tags: [], error: r.error };
    }
    const parsed = parseDraft(collected || r.text || '');
    ctx.broadcast({
      type: 'knowledge_distill_proposed',
      workflowId: ctx.workflowId,
      distillId,
      title: parsed.title,
      body: parsed.body,
      tags: parsed.tags,
      completedAt,
    });
    return parsed;
  });

  return { distillId, settled };
}

// Phase 5 Lite — the Review primitive.
//
// Spawns a short-lived reviewer worker with read-only tools over a slice of
// the tab's events.jsonl. Output is NOT mirrored into chat (that would
// conflate the reviewer's commentary with the primary's work); instead the
// reviewer's text is collected internally and persisted as a markdown
// artifact under `<cwd>/.arco/workflows/<wfid>/artifacts/review-<ts>.md`.
// The Review tab reads the artifact via the existing
// `GET /api/workflows/artifact` endpoint.
//
// Framing follows docs/ARCHITECTURE.md: Summary / Concerns / Verdict. The
// reviewer is told to surface concerns, not rewrite the work.

import { promises as fs } from 'fs';
import path from 'path';
import { WorkerManager } from '../workers/WorkerManager.js';
import type { WorkerResult } from '../workers/WorkerManager.js';
import { artifactsDir } from '../workers/limits.js';
import { runWithFallbackChain, buildChain } from '../providers/fallbackChain.js';
import type { FallbackLeg } from '../providers/fallbackChain.js';
import { REVIEW_FORMAT_SCHEMA, parseStructuredReview, reconstructStructuredReview } from './reviewSchema.js';
import type {
  ServerMessage,
  ProviderName,
  ModelName,
  EffortLevel,
  ReviewContextRef,
  FallbackLegConfig,
} from '@arco/shared';

export interface ReviewerConfig {
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  providerAccountRef?: string;
  codexHome?: string;
}

// Flatten a structured context ref to a single string for artifact
// frontmatter. The UI reads this only for display; server-side scoping
// uses the structured form.
function contextRefToString(ref: ReviewContextRef): string {
  switch (ref.kind) {
    case 'last-turn': return 'last-turn';
    case 'last-n': return `last-${ref.n}-turns`;
    case 'current-session': return 'current-session';
    case 'full': return 'full-transcript';
    case 'git-diff': return 'git-diff';
    case 'plan-whole': return `plan-whole/${ref.mode}`;
    case 'plan-phase': return `plan-phase/${ref.mode}/${ref.heading.slice(0, 60)}`;
    case 'plan-items': return `plan-items/${ref.mode}/${ref.itemIds.length}-selected`;
    case 'cluster-plan-whole': return `cluster-plan-whole/${ref.mode}`;
    case 'cluster-plan-phase': return `cluster-plan-phase/${ref.mode}/${ref.heading.slice(0, 60)}`;
    case 'since-event': return `since-event/${ref.anchorEventSeq}`;
    case 'preview-capture': return `preview-capture/${ref.reportName}`;
  }
}

export interface ReviewContext {
  workflowId: string;
  cwd: string;
  manager: WorkerManager;
  broadcast: (msg: ServerMessage) => void;
}

export interface ReviewHandle {
  reviewId: string;
  artifactName: string;
  settled: Promise<{ verdict?: 'PASS' | 'MINOR' | 'BLOCKING'; error?: string }>;
}

const BASE_FRAMING = `You are reviewing another agent's output. Your job is to surface concerns, not to rewrite the work. Read the content below and return a markdown document with exactly these three sections:

## Summary
One paragraph: what the agent did / produced.

## Concerns
Specific issues — correctness, clarity, security, missing considerations. Leave empty (just "None.") if nothing material.

## Verdict
One of: PASS / MINOR / BLOCKING. Followed by a one-line justification.

Keep the review focused. Do not produce code edits. Do not invoke write/edit tools. If you want to reference a file, cite it as \`path:line\`.

After the three sections, if (and only if) you raised specific file-anchored concerns, append a fenced findings block so the operator can jump straight to each one:

\`\`\`findings
[
  { "file": "path/relative/to/cwd.ts", "line": 42, "severity": "warning", "note": "one-line description of the concern" }
]
\`\`\`

Rules for the block: it is a JSON array; \`severity\` is one of "info" | "warning" | "error"; \`line\` is a positive integer; \`file\` is repo-relative. Include only concerns you can anchor to a real file and line. Omit the block entirely if you have no file-anchored findings — the prose above is what matters; the block is an optional convenience.`;

// Local-reviewer addendum. Frontier reviewers (Claude/Codex/Gemini) tend to
// pull files via tools by default; smaller local models opine purely on the
// diff text in the prompt and miss orphan files, seed-data drift, and broken
// wiring. The checklist nudges them to verify against the live tree.
const LOCAL_REVIEWER_ADDENDUM = `

---

**You have read-only tools (Read, Grep, Glob, WebSearch, WebFetch). USE THEM.** Do not review purely from the diff text shown below — the diff is a *claim* about what was done, not the truth. Verify by reading the actual files.

Before finalizing your verdict, walk through this checklist:

- **Orphans / dead code**: \`grep\` the directories the diff touches for stray test scripts, debug files, duplicate seed files, or duplicate implementations the worker may have created and forgotten.
- **Seed / fixture sanity**: if migrations or seed data are involved, confirm the names/IDs they reference (e.g. \`SELECT id FROM categories WHERE name='Coffee'\`) actually exist in the current schema.
- **Wiring**: any new endpoint, route, component, or import — verify it's actually mounted/imported by something, not just defined in isolation.
- **Typos in identifiers**: SQL keywords, column names referenced in \`ON CONFLICT\` / FK clauses, prop names — spot-check against the schema or sibling code.

A PASS verdict means you used the tools and nothing came back wrong. If you only read the diff, the right verdict is MINOR with "did not verify against the tree" as the justification.`;

function buildFraming(provider: ProviderName): string {
  if (provider === 'ollama' || provider === 'llamacpp' || provider === 'lmstudio' || (provider === 'strata' || provider === 'deepseek')) {
    return BASE_FRAMING + LOCAL_REVIEWER_ADDENDUM;
  }
  return BASE_FRAMING;
}

// Read-only Claude tool set — matches the plan's "read-only tools" contract.
// Codex has no tools allow-list; the spawn below passes `sandbox: 'read-only'`
// so Codex's `-s read-only` flag enforces the same guarantee.
const READ_ONLY_CLAUDE_TOOLS = ['Read', 'Grep', 'Glob', 'LSP'];

// Read-only Ollama tool set — same shape as the Claude allowlist, but Ollama's
// runtime executes the tools server-side itself (Path A, plan §8.1). Excludes
// Write and Bash; includes the web tools so the reviewer can pull external
// references when justifying its verdict. ollama.ts intersects this with its
// registry; an empty/missing list under no-cwd spawns falls through to the
// pre-§5.4 single-shot text path.
const READ_ONLY_OLLAMA_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];

// llama.cpp uses the same server-side tool registry as Ollama (llamacpp.ts
// intersects spec.tools with its registry at line ~828). Same allowlist.
const READ_ONLY_LLAMACPP_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];

// M13 — LM Studio reuses the same server-side ollamaTools registry as
// Ollama/llama.cpp (lmstudio.ts intersects spec.tools with its registry). Same
// read-only allowlist.
const READ_ONLY_LMSTUDIO_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];

function detectVerdict(body: string): 'PASS' | 'MINOR' | 'BLOCKING' | undefined {
  const m = body.match(/verdict[^\n]*?\n+\s*\*?\*?(PASS|MINOR|BLOCKING)\b/i);
  if (m) return m[1].toUpperCase() as 'PASS' | 'MINOR' | 'BLOCKING';
  const inline = body.match(/\b(PASS|MINOR|BLOCKING)\b/);
  return inline ? (inline[1] as 'PASS' | 'MINOR' | 'BLOCKING') : undefined;
}

function formatFrontmatter(args: Record<string, string | number | undefined>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    const stringified = typeof v === 'string' ? JSON.stringify(v) : String(v);
    lines.push(`${k}: ${stringified}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

export function runReviewer(
  ctx: ReviewContext,
  args: {
    reviewer: ReviewerConfig;
    // §C2 — optional operator-configured fallback legs for the BOUNDED reviewer
    // job. Resolved by the WS handler from settings.fallbackChains.reviewer. The
    // effective chain is `[reviewer, ...these minus a leg equal to reviewer]`.
    // Unset/empty ⇒ single-leg ⇒ today's behavior. Codex legs that need account
    // routing should arrive with providerAccountRef/codexHome already resolved.
    reviewerFallbacks?: FallbackLegConfig[];
    primary: { provider: ProviderName; model: ModelName; effort: EffortLevel };
    contextRef: ReviewContextRef;
    // Human-readable scope label that appears in the reviewer framing so
    // the reviewer knows what they're evaluating (e.g. "last 5 turns",
    // "current session (12 turns)", "git diff").
    contextLabel: string;
    // Pre-formatted markdown body that gets dropped into the reviewer's
    // input below "## Content to review". Caller is responsible for the
    // turn layout, code fences, and any git-diff block layering.
    content: string;
    // docs/GOTCHAS.md - the source tab's north-star, inherited so the
    // reviewer judges the work against the session's standing objective. Unlike
    // outputStyle (forced 'normal' below), the north-star is deliberately passed
    // through. Absent / blank ⇒ no block. Zero authority — steering context only.
    goal?: string;
  },
): ReviewHandle {
  const reviewId = `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactName = `review-${ts}.md`;
  const startedAt = Date.now();

  ctx.broadcast({
    type: 'review_started',
    workflowId: ctx.workflowId,
    reviewId,
    reviewer: args.reviewer,
    contextRef: args.contextRef,
    startedAt,
  });

  // Reviewer input — framing + scoped transcript slice. The caller
  // formats the body (turns, git diff, or both); we only prepend the
  // framing and the scope metadata so the reviewer knows exactly what
  // it's looking at. Content is quoted verbatim — no summarization step.
  const reviewInput = [
    buildFraming(args.reviewer.provider),
    '',
    '---',
    '',
    '## Content to review',
    '',
    `**Context scope:** ${args.contextLabel}.`,
    `**Primary agent:** ${args.primary.provider} / ${args.primary.model} @ ${args.primary.effort}`,
    '',
    args.content,
  ].join('\n');

  // §C2 — build the effective fallback chain. The primary leg is the operator's
  // chosen reviewer; the operator-configured fallbacks follow (de-duped against
  // the primary). When no fallbacks are configured, the chain is just the one
  // reviewer leg — identical to pre-C2 behavior.
  const primaryLeg: FallbackLeg = {
    provider: args.reviewer.provider,
    model: args.reviewer.model,
    effort: args.reviewer.effort,
    providerAccountRef: args.reviewer.providerAccountRef,
    codexHome: args.reviewer.codexHome,
  };
  const chain = buildChain(primaryLeg, args.reviewerFallbacks);

  // `collected` accumulates worker_text for the LEG CURRENTLY RUNNING. Reset at
  // the start of every leg so a failed leg's partial output never bleeds into a
  // successful fallback leg's artifact.
  let collected = '';

  const spawnLeg = (leg: FallbackLeg): Promise<WorkerResult> => {
    collected = '';
    const spec = {
      id: reviewId,
      task: reviewInput,
      model: leg.model,
      effort: leg.effort ?? args.reviewer.effort,
      provider: leg.provider,
      tools: leg.provider === 'claude' ? READ_ONLY_CLAUDE_TOOLS
           : leg.provider === 'ollama' ? READ_ONLY_OLLAMA_TOOLS
           : leg.provider === 'llamacpp' ? READ_ONLY_LLAMACPP_TOOLS
           : (leg.provider === 'lmstudio' || (leg.provider === 'strata' || leg.provider === 'deepseek')) ? READ_ONLY_LMSTUDIO_TOOLS
           : undefined,
    };
    return ctx.manager.spawn(
      spec,
      (ev) => {
        if (ev.type === 'worker_text') collected += ev.text;
        else if (ev.type === 'worker_system_notice') {
          ctx.broadcast({
            type: 'system_notice',
            workflowId: ctx.workflowId,
            content: ev.notice,
          });
        }
      },
      {
        cwd: ctx.cwd,
        workflowId: ctx.workflowId,
        // Reviewer is read-only. Claude gates via the `tools` allow-list set
        // above; Codex gates via `-s read-only` (sandbox); Ollama gates via the
        // tools allow-list (READ_ONLY_OLLAMA_TOOLS, no Write/Bash). Other
        // providers ignore the sandbox field.
        //
        // skipPermissions: Ollama's SAFE mode (skipPermissions=false) returns a
        // denial string for tool calls instead of executing them — useful for
        // primary workflows where the operator wants narrate-only behavior, but
        // it would prevent the reviewer from reading the codebase it's supposed
        // to review. Override to true for Ollama specifically; the read-only
        // allowlist is what enforces safety, not SAFE mode. Claude/Codex keep
        // skipPermissions=false because their own runtimes treat the
        // tools-allowlist + sandbox as the read-only contract.
        skipPermissions: leg.provider === 'ollama',
        sandbox: 'read-only',
        // docs/PROVIDERS.md - on the Ollama leg, constrain the
        // reviewer's FINAL answer to the review schema (sampler-level grammar)
        // so the verdict + findings come back as guaranteed-valid JSON instead
        // of regex-scraped prose — the single biggest reliability win for the
        // small local models this primitive targets. The provider runs the
        // tool-loop free (so the reviewer can still Read/Grep the tree) and
        // only applies `format` on a dedicated tool-free synthesis turn. Other
        // providers ignore this field and keep the free-text path. Fail-safe:
        // if the model returns non-conforming output, the .then() below falls
        // back to detectVerdict on the raw text.
        ...(leg.provider === 'ollama' ? { ollamaFormat: REVIEW_FORMAT_SCHEMA as Record<string, unknown> } : {}),
        // docs/PROVIDERS.md - hard exclusion. Reviewer output is read
        // carefully by an operator; caveman/lite would regress comprehension.
        // Forced regardless of source-tab `outputStyle`. Not a config knob.
        outputStyle: 'normal',
        // docs/GOTCHAS.md - inherit the source tab's north-star (unlike
        // outputStyle) so the reviewer evaluates against the standing objective.
        goal: args.goal,
        ...(leg.provider === 'codex' && leg.codexHome
          ? { providerAccountRef: leg.providerAccountRef, codexHome: leg.codexHome }
          : {}),
      },
    );
  };

  const settled = runWithFallbackChain({
    legs: chain,
    isError: (r) => r.error,
    provider: (leg) => leg.provider,
    spawnLeg,
    onFellBack: ({ from, to, reason }) => {
      // §C2 — log every advance to chat + events.jsonl. Bounded-only, never a
      // live primary turn (reviewers run off the primary path entirely).
      ctx.broadcast({
        type: 'provider_fell_back',
        workflowId: ctx.workflowId,
        from: { provider: from.provider, model: from.model },
        to: { provider: to.provider, model: to.model },
        reason,
        note: `Reviewer fell back: ${from.provider}/${from.model} → ${to.provider}/${to.model} (${reason})`,
      });
    },
  }).then(async ({ result: r, legUsed }) => {
    const completedAt = Date.now();
    if (r.error) {
      ctx.broadcast({
        type: 'review_artifact_ready',
        workflowId: ctx.workflowId,
        reviewId,
        artifactName,
        error: r.error,
        completedAt,
      });
      return { error: r.error };
    }
    let body = (collected.trim() || r.text || '').trim();
    let verdict = detectVerdict(body);
    // M5 — when the leg that produced this artifact was Ollama, its final
    // answer was schema-constrained JSON (see ollamaFormat above). Parse it and,
    // on success, reconstruct the canonical Summary/Concerns/Verdict markdown so
    // the on-disk artifact + the Review tab renderer + parseReviewFindings all
    // work unchanged — and lift the verdict straight from the validated JSON
    // (no regex). Fail-safe: a non-conforming reply (e.g. a model that ignored
    // `format`) leaves `body`/`verdict` as the free-text path above. Logged so
    // the parse outcome is visible in the reviewing workflow's transcript.
    if (legUsed.provider === 'ollama') {
      const structured = parseStructuredReview(body);
      if (structured) {
        body = reconstructStructuredReview(structured);
        verdict = structured.verdict;
        ctx.broadcast({
          type: 'system_notice',
          workflowId: ctx.workflowId,
          content: `Review: parsed schema-constrained Ollama output (verdict ${structured.verdict}, ${structured.findings.length} finding${structured.findings.length === 1 ? '' : 's'}).`,
        });
      } else {
        ctx.broadcast({
          type: 'system_notice',
          workflowId: ctx.workflowId,
          content: 'Review: Ollama output was not schema-conforming; falling back to free-text verdict parsing.',
        });
      }
    }
    const frontmatter = formatFrontmatter({
      reviewId,
      createdAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: r.durationMs,
      contextRef: contextRefToString(args.contextRef),
      // Reflect the leg that ACTUALLY produced the artifact (may differ from
      // the configured primary after a fallback).
      reviewer: `${legUsed.provider}/${legUsed.model}@${legUsed.effort ?? args.reviewer.effort}`,
      primary: `${args.primary.provider}/${args.primary.model}@${args.primary.effort}`,
      verdict,
    });
    const dir = artifactsDir(ctx.cwd, ctx.workflowId);
    const full = path.join(dir, artifactName);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(full, frontmatter + body + '\n', 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.broadcast({
        type: 'review_artifact_ready',
        workflowId: ctx.workflowId,
        reviewId,
        artifactName,
        error: `artifact write failed: ${msg}`,
        completedAt,
      });
      return { error: msg };
    }
    ctx.broadcast({
      type: 'review_artifact_ready',
      workflowId: ctx.workflowId,
      reviewId,
      artifactName,
      ...(verdict ? { verdict } : {}),
      completedAt,
    });
    return { ...(verdict ? { verdict } : {}) };
  });

  return { reviewId, artifactName, settled };
}

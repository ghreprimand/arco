// Deep Research primitive — WORKBENCH_EXPANSION_PLAN.md §B2.
//
// Mirrors runReviewer.ts: spawns a short-lived, read-only worker whose ONE
// bounded native agentic turn plans queries → searches the web → reads
// results → synthesizes a CITED markdown report. Output is persisted as a
// `research-<ts>.md` artifact under
// `<cwd>/.arco/workflows/<wfid>/artifacts/` and surfaced in the RESEARCH
// tab via the existing `GET /api/workflows/artifact` endpoint.
//
// The "bounded rounds" are the provider's natural bounded tool-use iterations.
// Arco enforces a HARD ceiling (`maxRounds`):
//   - Claude Native: threaded through as `webSearchMaxUses` → the web_search /
//     web_fetch `max_uses` budget. A MECHANICAL stop, not just a prompt cap.
//   - Codex: `buildThreadConfigOverrides()` returns `{ web_search: 'live' }`
//     and exposes NO per-turn `max_uses` knob, so Codex's hard stop is the
//     single bounded turn + the prompt-stated cap. This provider asymmetry is
//     acceptable but must be honest (no silent caps) — it is documented here
//     and in docs/PRIMITIVES.md. The model's own "sufficient" signal is
//     advisory only.
//
// Fence note (CLAUDE.md "hard fences"): there is NO orchestrator LLM, NO
// second-LLM synthesis step, and NO LLM "is it done?" judge. One provider,
// one bounded turn, deterministic round ceiling, operator-initiated, output is
// an operator-reviewed artifact. The dig-deeper follow-up appends to the same
// artifact (also one bounded turn). Clears the four-question test.

import { promises as fs } from 'fs';
import path from 'path';
import { WorkerManager } from '../workers/WorkerManager.js';
import type { WorkerResult } from '../workers/WorkerManager.js';
import { artifactsDir } from '../workers/limits.js';
import { runWithFallbackChain, buildChain } from '../providers/fallbackChain.js';
import type { FallbackLeg } from '../providers/fallbackChain.js';
import { RESEARCH_DEFAULT_ROUNDS } from '@arco/shared';
import type {
  ServerMessage,
  ProviderName,
  ModelName,
  EffortLevel,
  FallbackLegConfig,
} from '@arco/shared';

export interface ResearcherConfig {
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  providerAccountRef?: string;
  codexHome?: string;
}

export interface ResearchContext {
  workflowId: string;
  cwd: string;
  manager: WorkerManager;
  broadcast: (msg: ServerMessage) => void;
}

export interface ResearchHandle {
  researchId: string;
  artifactName: string;
  settled: Promise<{ roundsUsed: number; sourceCount: number; error?: string }>;
}

function buildFraming(topic: string, maxRounds: number): string {
  return `You are a research agent. Produce a CITED markdown research report on the topic below in ONE bounded turn.

Workflow (all inside this single turn):
1. PLAN a small set of focused web-search queries for the topic.
2. SEARCH the web and READ the most relevant results (use your web_search / web_fetch tools).
3. SYNTHESIZE a clear, well-structured markdown report grounded in what you actually read.

HARD STOP: you may perform at most ${maxRounds} web-search/fetch rounds. This ceiling is NON-NEGOTIABLE — the server enforces it mechanically where it can. Do not exceed it. Your own sense that the research is "sufficient" is advisory: you may stop earlier, but you may NOT go past the cap.

CITATIONS (required): every non-obvious claim must carry an inline citation as a markdown link or a bare URL, e.g. \`[source](https://example.com/article)\`. The report's source count is derived by counting the unique URLs you cite, so cite real URLs you actually retrieved — do not fabricate links.

Report structure (markdown):
## Summary
2-4 sentences answering the topic directly.
## Findings
The substance, organized into sections with inline citations.
## Sources
A bullet list of the unique URLs you cited.

You also have read-only LOCAL tools (Read / Grep / Glob) for any local context the topic references. Do NOT write or edit files — the server persists your report. Topic:

${topic}`;
}

function buildFollowUpFraming(question: string, priorBody: string, maxRounds: number): string {
  return `You are extending an EXISTING research report with a focused follow-up. Below is the prior report (with its cited sources). Answer ONLY the follow-up question, grounding new claims in the existing sources where possible and running at most ${maxRounds} additional web-search/fetch rounds where they are not (this cap is enforced mechanically where possible — do not exceed it; your "sufficient" signal is advisory).

Output ONLY a new addendum section — do NOT restate or rewrite the existing report. Start your output with a level-2 heading of exactly this form:

## Addendum — <short follow-up label>

Then the addendum body, with inline markdown-link / bare-URL citations for any new claims. End with a short \`### Sources\` sub-list of any NEW URLs you cited. The server appends your output verbatim to the existing artifact.

--- PRIOR REPORT (read-only context) ---

${priorBody}

--- FOLLOW-UP QUESTION ---

${question}`;
}

// Read-only LOCAL tool sets — mirror runReviewer's per-provider selection.
// The provider's NATIVE web search is a server tool enabled separately
// (Claude: web_search_20260209 server tool; Codex: web_search:'live'); it is
// NOT listed in the Claude allowlist. Ollama / llama.cpp execute their tools
// server-side and DO need WebSearch/WebFetch in the allowlist.
const READ_ONLY_CLAUDE_TOOLS = ['Read', 'Grep', 'Glob', 'LSP'];
const READ_ONLY_OLLAMA_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
const READ_ONLY_LLAMACPP_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
const READ_ONLY_LMSTUDIO_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];

function toolsFor(provider: ProviderName): string[] | undefined {
  if (provider === 'claude') return READ_ONLY_CLAUDE_TOOLS;
  if (provider === 'ollama') return READ_ONLY_OLLAMA_TOOLS;
  if (provider === 'llamacpp') return READ_ONLY_LLAMACPP_TOOLS;
  if (provider === 'lmstudio' || (provider === 'strata' || provider === 'deepseek')) return READ_ONLY_LMSTUDIO_TOOLS;
  return undefined;
}

// Best-effort unique-URL count from the report body. Used for `sourceCount`.
function countSources(body: string): number {
  const urls = body.match(/https?:\/\/[^\s)<>\]"']+/g) ?? [];
  const cleaned = urls.map((u) => u.replace(/[.,;]+$/, ''));
  return new Set(cleaned).size;
}

function formatFrontmatter(args: Record<string, string | number | boolean | undefined>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    const stringified = typeof v === 'string' ? JSON.stringify(v) : String(v);
    lines.push(`${k}: ${stringified}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

export function runResearch(
  ctx: ResearchContext,
  args: {
    researcher: ResearcherConfig;
    // §C2 — optional operator-configured fallback legs for the BOUNDED research
    // job. Resolved by the WS handler from settings.fallbackChains.research. The
    // effective chain is `[researcher, ...these minus a leg equal to researcher]`.
    // Unset/empty ⇒ single-leg ⇒ today's behavior.
    researcherFallbacks?: FallbackLegConfig[];
    topic: string;
    maxRounds: number;
    // Dig-deeper follow-up. When set, `seedArtifactName` names the existing
    // artifact to append to; `followUp` is the operator's narrow question and
    // `priorBody` is the existing artifact body (already read by the caller).
    seedArtifactName?: string;
    followUp?: string;
    priorBody?: string;
  },
): ResearchHandle {
  const researchId = `res-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const isFollowUp = Boolean(args.seedArtifactName && args.followUp);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  // Follow-up appends to the SAME artifact; a fresh run gets a new dated name.
  const artifactName = isFollowUp ? args.seedArtifactName! : `research-${ts}.md`;
  const startedAt = Date.now();
  const maxRounds = args.maxRounds > 0 ? args.maxRounds : RESEARCH_DEFAULT_ROUNDS;

  ctx.broadcast({
    type: 'research_started',
    workflowId: ctx.workflowId,
    researchId,
    researcher: args.researcher,
    topic: isFollowUp ? (args.followUp ?? args.topic) : args.topic,
    maxRounds,
    isFollowUp,
    artifactName,
    startedAt,
  });

  const task = isFollowUp
    ? buildFollowUpFraming(args.followUp ?? '', args.priorBody ?? '', maxRounds)
    : buildFraming(args.topic, maxRounds);

  // §C2 — build the effective fallback chain. The primary leg is the operator's
  // chosen researcher; configured fallbacks follow (de-duped). No fallbacks ⇒
  // single-leg chain ⇒ pre-C2 behavior.
  const primaryLeg: FallbackLeg = {
    provider: args.researcher.provider,
    model: args.researcher.model,
    effort: args.researcher.effort,
    providerAccountRef: args.researcher.providerAccountRef,
    codexHome: args.researcher.codexHome,
  };
  const chain = buildChain(primaryLeg, args.researcherFallbacks);

  // `collected`/`toolRounds` track the LEG CURRENTLY RUNNING; reset per leg so a
  // failed leg's partial output / progress count doesn't carry into a fallback.
  let collected = '';
  let toolRounds = 0;

  const spawnLeg = (leg: FallbackLeg): Promise<WorkerResult> => {
    collected = '';
    toolRounds = 0;
    const spec = {
      id: researchId,
      task,
      model: leg.model,
      effort: leg.effort ?? args.researcher.effort,
      provider: leg.provider,
      tools: toolsFor(leg.provider),
    };
    return ctx.manager.spawn(
      spec,
      (ev) => {
        if (ev.type === 'worker_text') {
          collected += ev.text;
        } else if (ev.type === 'worker_tool_use') {
          // Coarse progress signal — count web search/fetch invocations and
          // surface a research_progress event so the RESEARCH tab can show
          // "searching… (n)" without parsing raw tool events. We only count the
          // 'started' status (or status-less, for providers that don't stamp it)
          // so a single tool call isn't tallied twice.
          const t = (ev.tool || '').toLowerCase();
          const isWebTool = t.includes('web_search') || t.includes('websearch')
            || t.includes('web_fetch') || t.includes('webfetch');
          const counts = !ev.status || ev.status === 'started';
          if (isWebTool && counts) {
            toolRounds += 1;
            ctx.broadcast({
              type: 'research_progress',
              workflowId: ctx.workflowId,
              researchId,
              round: toolRounds,
              note: `searching (${toolRounds}/${maxRounds})`,
            });
          }
        } else if (ev.type === 'worker_system_notice') {
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
        // Read-only research run. Claude gates via the `tools` allowlist; Codex
        // gates via `-s read-only`; Ollama gates via its allowlist (no Write/
        // Bash). skipPermissions=true for Ollama so its SAFE mode doesn't refuse
        // the read/search tools (same rationale as runReviewer).
        skipPermissions: leg.provider === 'ollama',
        sandbox: 'read-only',
        // OUTPUT_STYLE_PLAN.md §6 — research reports are read carefully; never
        // caveman/lite. Forced regardless of source-tab outputStyle.
        outputStyle: 'normal',
        // Mechanical web-tool ceiling for Claude Native (other transports ignore;
        // see the Codex asymmetry note at the top of this file).
        webSearchMaxUses: maxRounds,
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
      // §C2 — log every advance to chat + events.jsonl. Bounded-only.
      ctx.broadcast({
        type: 'provider_fell_back',
        workflowId: ctx.workflowId,
        from: { provider: from.provider, model: from.model },
        to: { provider: to.provider, model: to.model },
        reason,
        note: `Research fell back: ${from.provider}/${from.model} → ${to.provider}/${to.model} (${reason})`,
      });
    },
  }).then(async ({ result: r, legUsed }) => {
    const completedAt = Date.now();
    if (r.error) {
      ctx.broadcast({
        type: 'research_complete',
        workflowId: ctx.workflowId,
        researchId,
        artifactName,
        roundsUsed: toolRounds,
        sourceCount: 0,
        isFollowUp,
        error: r.error,
        completedAt,
      });
      return { roundsUsed: toolRounds, sourceCount: 0, error: r.error };
    }

    const body = (collected.trim() || r.text || '').trim();
    const dir = artifactsDir(ctx.cwd, ctx.workflowId);
    const full = path.join(dir, artifactName);

    try {
      await fs.mkdir(dir, { recursive: true });
      if (isFollowUp) {
        // Append a dated addendum to the SAME artifact rather than rewrite.
        const stamp = new Date(completedAt).toISOString();
        const addendum = `\n\n---\n\n<!-- dig-deeper follow-up appended ${stamp} (research ${researchId}) -->\n\n${body}\n`;
        await fs.appendFile(full, addendum, 'utf8');
      } else {
        const frontmatter = formatFrontmatter({
          researchId,
          createdAt: new Date(startedAt).toISOString(),
          completedAt: new Date(completedAt).toISOString(),
          durationMs: r.durationMs,
          // Reflect the leg that ACTUALLY produced the report (may differ from
          // the configured researcher after a §C2 fallback).
          researcher: `${legUsed.provider}/${legUsed.model}@${legUsed.effort ?? args.researcher.effort}`,
          topic: args.topic,
          maxRounds,
          roundsUsed: toolRounds,
          sourceCount: countSources(body),
          isFollowUp,
        });
        await fs.writeFile(full, frontmatter + body + '\n', 'utf8');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.broadcast({
        type: 'research_complete',
        workflowId: ctx.workflowId,
        researchId,
        artifactName,
        roundsUsed: toolRounds,
        sourceCount: 0,
        isFollowUp,
        error: `artifact write failed: ${msg}`,
        completedAt,
      });
      return { roundsUsed: toolRounds, sourceCount: 0, error: msg };
    }

    // For a follow-up, sourceCount reflects new URLs in the addendum body.
    const sourceCount = countSources(body);
    ctx.broadcast({
      type: 'research_complete',
      workflowId: ctx.workflowId,
      researchId,
      artifactName,
      roundsUsed: toolRounds,
      sourceCount,
      isFollowUp,
      completedAt,
    });
    return { roundsUsed: toolRounds, sourceCount };
  });

  return { researchId, artifactName, settled };
}

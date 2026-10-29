// Phase 6 Lite — the Handoff primitive's context-export core.
//
// Produces a handoff document via one of two paths:
//
//   'original-worker'  — the primary that did the work self-reflects on its
//                        own session via --resume. It has full context (every
//                        thinking block, every tool call, every decision),
//                        can run git + read project docs + write the handoff
//                        itself, and can update project files (DEVLOG.md,
//                        PLAN.md) as part of the same turn. Highest fidelity.
//                        Default for both Handoff and Spawn.
//
//   'fresh-summarizer' — a short-lived worker reads a rendered transcript
//                        (USER: / AGENT: text extracted from events.jsonl)
//                        and writes the handoff. Lower fidelity but doesn't
//                        require the original session to be resumable. Useful
//                        fallback when the primary is Ollama, or when the
//                        session is otherwise unavailable.
//
// Both paths persist to `<cwd>/.arco/workflows/<wfid>/handoffs/handoff-<ts>.md`.

import { promises as fs } from 'fs';
import path from 'path';
import { WorkerManager } from '../workers/WorkerManager.js';
import { runPrimaryTurn, type PrimaryConfig } from './seedWorker.js';
import { loadEffectivePrompt, renderPrompt } from '../handoffPrompts.js';
import { probeProjectFacts } from '../providers/claude-native/workspaceFacts.js';
import { seedClaudeNativeWorkerFromForeignEvents } from '../providers/claude-native/index.js';
import { releaseCodexAppServerWorker } from '../providers/codex-appserver/index.js';
import type {
  ServerMessage,
  ProviderName,
  ModelName,
  EffortLevel,
  ExportContextMode,
  WorkerConfig,
} from '@arco/shared';

export interface SummarizerConfig {
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  providerAccountRef?: string;
  codexHome?: string;
  // docs/GOTCHAS.md - the source tab's north-star, inherited so the
  // fresh summarizer preserves the session's standing objective in the handoff
  // artifact (the continuation reads it). Absent / blank ⇒ no block.
  goal?: string;
}

export interface ExportContext {
  // workflowId = where events stamp + artifact lives. For Handoff this is
  // the workflow being rotated; for Spawn this is the newly-created workflow.
  workflowId: string;
  cwd: string;
  manager: WorkerManager;
  broadcast: (msg: ServerMessage) => void;
}

// For 'original-worker' mode: the source primary whose session we'll resume
// to run the reflection turn. For Handoff, this is the workflow being rotated.
// For Spawn, this is the parent workflow. Its manager owns the reflection
// subprocess; its cwd is where git + project-doc reads execute.
export interface OriginalPrimaryContext {
  primary: PrimaryConfig;
  // CLI session id (Claude UUID / Codex thread_id) to `--resume` against.
  // Empty for transport='native' since Native sessions are in-process and
  // never write a CLI rollout — the worker is resumed by replaying
  // events.jsonl into messages[] instead.
  sessionId: string;
  cwd: string;
  // Resolved Claude transport when primary.provider === 'claude'. Defaults
  // to 'cli' so existing callers (and non-Claude providers) get the legacy
  // CLI --resume path. 'native' switches to the in-memory messages-replay
  // path — see runOriginalWorkerNative below.
  transport?: 'cli' | 'native';
  // For transport='native' + Spawn: replay this source's events.jsonl into
  // the target workflow's worker before the reflection turn fires. Omitted
  // for Handoff (target == parent → existing in-memory worker is reused).
  // Phase 8 — `maxSeq` truncates the parent's events.jsonl replay at the
  // operator-supplied HISTORY cutoff so the seeded worker only carries
  // history up to that point.
  nativeReplaySource?: { cwd: string; workflowId: string; maxSeq?: number };
  // Codex sessions live under CODEX_HOME; original-worker reflection must
  // resume in the same account home that created the source thread.
  providerAccountRef?: string;
  codexHome?: string;
  // Workflow that owns the source thread's live app-server (if any). Defaults
  // to ctx.workflowId (Handoff); Spawn passes the parent's id.
  sourceWorkflowId?: string;
  // docs/GOTCHAS.md - the source tab's north-star, inherited into the
  // reflection turn so the handoff artifact carries the standing objective.
  // Absent / blank ⇒ no block.
  goal?: string;
}

export interface ExportHandle {
  handoffId: string;
  artifactName: string;
  settled: Promise<{ body?: string; error?: string }>;
  abort: () => void;
}

// Shared mutable abort target. The worker id isn't known until the turn spawns
// (inside an async prompt-load), so abort() records intent and the spawn site
// kills immediately if intent already arrived.
interface AbortState {
  workerId: string | undefined;
  killed: boolean;
  originalWorkerTimedOut?: boolean;
}

// The original-worker reflection prompt and the fresh-summarizer framing
// live as `DEFAULT_TEMPLATES` in `server/src/handoffPrompts.ts`. Operators
// override either via `<cwd>/.arco/handoff.prompt.md` (project) or
// `~/.arco/handoff.prompt.md` (global); same convention with
// `handoff.summarizer.prompt.md` for the summarizer mode. `loadEffectivePrompt`
// resolves the cascade and falls back to the default template — keeping the
// "current hard-coded builders" gate from the plan.

// H54 — the project's detected primary verify command, fed into the handoff
// seed template's {{verifyCommand}} so the successor is told the REAL build/test
// command instead of a hard-coded `npm run dev`. Best-effort; undefined falls
// back to `npm run dev` in renderPrompt.
async function detectVerifyCommand(cwd: string): Promise<string | undefined> {
  try {
    return (await probeProjectFacts(cwd)).primaryVerify;
  } catch {
    return undefined;
  }
}

const DEFAULT_ORIGINAL_WORKER_TIMEOUT_MS = 180_000;

function originalWorkerTimeoutMs(): number {
  const configured = Number(process.env.ARCO_HANDOFF_ORIGINAL_WORKER_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(30_000, Math.min(configured, 600_000));
  }
  return DEFAULT_ORIGINAL_WORKER_TIMEOUT_MS;
}

function originalWorkerTimeoutError(timeoutMs: number): string {
  return `original-worker reflection timed out after ${Math.round(timeoutMs / 1000)}s`;
}

function runWithOriginalWorkerTimeout(
  ctx: ExportContext,
  ab: AbortState,
  originalRun: Promise<{ body?: string; error?: string }>,
): Promise<{ body?: string; error?: string }> {
  const timeoutMs = originalWorkerTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ body?: string; error?: string }>((resolve) => {
    timer = setTimeout(() => {
      ab.originalWorkerTimedOut = true;
      if (ab.workerId) ctx.manager.kill(ab.workerId);
      resolve({ error: originalWorkerTimeoutError(timeoutMs) });
    }, timeoutMs);
  });

  return Promise.race([originalRun, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function runOriginalWorker(
  ctx: ExportContext,
  original: OriginalPrimaryContext,
  handoffId: string,
  artifactName: string,
  ab: AbortState,
): Promise<{ body?: string; error?: string }> {
  // Native parents resume by replaying events.jsonl into messages[], not
  // via CLI --resume — the Native worker is in-process and never wrote a
  // rollout to disk. Branch before the sessionId-required guard below.
  if (original.primary.provider === 'claude' && original.transport === 'native') {
    return runOriginalWorkerNative(ctx, original, handoffId, artifactName, ab);
  }
  if (original.primary.provider !== 'claude' && original.primary.provider !== 'codex') {
    const err = `original-worker mode needs a resumable CLI session; provider=${original.primary.provider} isn't supported. Try fresh-summarizer mode.`;
    ctx.broadcast({
      type: 'handoff_artifact_ready',
      workflowId: ctx.workflowId,
      handoffId,
      artifactName,
      error: err,
      completedAt: Date.now(),
    });
    return Promise.resolve({ error: err });
  }
  if (!original.sessionId) {
    const err = 'original-worker mode needs a live primary session — none recorded on this workflow yet.';
    ctx.broadcast({
      type: 'handoff_artifact_ready',
      workflowId: ctx.workflowId,
      handoffId,
      artifactName,
      error: err,
      completedAt: Date.now(),
    });
    return Promise.resolve({ error: err });
  }

  const absolutePath = path.resolve(
    path.join(ctx.cwd, '.arco', 'workflows', ctx.workflowId, 'handoffs', artifactName),
  );

  // Make sure the handoffs directory exists before the primary tries to write
  // to it. The primary's Write tool will create parents but on some provider
  // paths (Codex with restrictive sandbox) the pre-existing dir is cleaner.
  return Promise.all([
    fs.mkdir(path.dirname(absolutePath), { recursive: true }),
    loadEffectivePrompt('original-worker', ctx.cwd),
    detectVerifyCommand(ctx.cwd),
    // The reflection resumes the thread via `codex exec`; an app-server tab
    // still holds the thread's single-writer lock, which made the resume fail
    // instantly (0.3s empty turn → "did not write handoff"). Release it first.
    original.primary.provider === 'codex'
      ? releaseCodexAppServerWorker(original.sourceWorkflowId ?? ctx.workflowId)
      : undefined,
  ])
    .then(([, eff, verifyCommand]) => {
      const reflectionPrompt = renderPrompt(eff.template, {
        cwd: ctx.cwd,
        wfid: ctx.workflowId,
        handoffPath: absolutePath,
        verifyCommand,
      });
      const turn = runPrimaryTurn(
        {
          workflowId: ctx.workflowId,
          cwd: original.cwd,
          manager: ctx.manager,
          broadcast: ctx.broadcast,
        },
        {
          primary: original.primary,
          prompt: reflectionPrompt,
          resumeSessionId: original.sessionId,
          // docs/PROVIDERS.md - handoff seed output becomes the
          // *input* to the next worker; output-side terseness has no
          // benefit and risks lost detail. Forced normal regardless of
          // source-tab outputStyle.
          outputStyle: 'normal',
          // docs/GOTCHAS.md - inherit the source tab's north-star (unlike
          // outputStyle) so the reflection is framed by the standing objective.
          goal: original.goal,
          ...(original.primary.provider === 'codex' && original.codexHome
            ? { providerAccountRef: original.providerAccountRef, codexHome: original.codexHome }
            : {}),
        },
      );
      if (ab.originalWorkerTimedOut) {
        ctx.manager.kill(turn.workerId);
      } else {
        ab.workerId = turn.workerId;
        if (ab.killed) ctx.manager.kill(turn.workerId);
      }
      return turn.settled;
    })
    .then(async (r) => {
      if (ab.originalWorkerTimedOut) {
        return { error: originalWorkerTimeoutError(originalWorkerTimeoutMs()) };
      }
      const completedAt = Date.now();
      if (r.error) {
        ctx.broadcast({
          type: 'handoff_artifact_ready',
          workflowId: ctx.workflowId,
          handoffId,
          artifactName,
          error: `original-worker reflection failed: ${r.error}`,
          completedAt,
        });
        return { error: r.error };
      }
      // Primary should have used Write to create the file. If missing, the
      // reflection didn't follow instructions — surface that clearly.
      try {
        const body = (await fs.readFile(absolutePath, 'utf8')).trim();
        if (!body) {
          const err = 'original-worker wrote an empty handoff file';
          ctx.broadcast({
            type: 'handoff_artifact_ready',
            workflowId: ctx.workflowId,
            handoffId,
            artifactName,
            error: err,
            completedAt,
          });
          return { error: err };
        }
        ctx.broadcast({
          type: 'handoff_artifact_ready',
          workflowId: ctx.workflowId,
          handoffId,
          artifactName,
          completedAt,
        });
        return { body };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const full = `original-worker did not write ${artifactName} (${msg}). Check chat — the primary may have ended without calling Write.`;
        ctx.broadcast({
          type: 'handoff_artifact_ready',
          workflowId: ctx.workflowId,
          handoffId,
          artifactName,
          error: full,
          completedAt,
        });
        return { error: full };
      }
    });
}

// Native-parent original-worker. The Anthropic SDK worker is in-process per
// workflow (cached by workflowId), so resume isn't a CLI --resume — it's a
// messages[] snapshot. For Spawn, the parent's events.jsonl gets replayed
// into the child's worker before the reflection turn fires; for Handoff,
// the existing in-memory worker for the same workflow already carries the
// parent's history and we just run the reflection on it.
//
// runPrimaryTurn does the rest — same broadcast surface as the CLI path,
// same artifact-write contract (the Native Write tool resolves the absolute
// path inside ctx.cwd and creates the handoffs dir). Worker disposal is the
// caller's responsibility — handleHandoffRequest / handleSpawnFromHere
// dispose between reflection and the post-handoff pre-warm so the new
// session starts on a fresh worker rather than inheriting reflection state.
async function runOriginalWorkerNative(
  ctx: ExportContext,
  original: OriginalPrimaryContext,
  handoffId: string,
  artifactName: string,
  ab: AbortState,
): Promise<{ body?: string; error?: string }> {
  const absolutePath = path.resolve(
    path.join(ctx.cwd, '.arco', 'workflows', ctx.workflowId, 'handoffs', artifactName),
  );

  try {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    if (original.nativeReplaySource) {
      // Spawn: hydrate the child worker from parent's events before the
      // reflection turn fires. baseConfig only needs cwd/model/etc to
      // pass acquireWorker's invariants; runPrimaryTurn's spawn issues an
      // updateConfig with the full operator config on the actual turn.
      const baseConfig: WorkerConfig = {
        provider: 'claude',
        model: original.primary.model,
        effort: original.primary.effort,
        cwd: ctx.cwd,
        workflowId: ctx.workflowId,
        claudeTransport: 'native',
      };
      await seedClaudeNativeWorkerFromForeignEvents(ctx.workflowId, baseConfig, original.nativeReplaySource, original.nativeReplaySource.maxSeq);
    }

    const eff = await loadEffectivePrompt('original-worker', ctx.cwd);
    const verifyCommand = await detectVerifyCommand(ctx.cwd);
    const reflectionPrompt = renderPrompt(eff.template, {
      cwd: ctx.cwd,
      wfid: ctx.workflowId,
      handoffPath: absolutePath,
      verifyCommand,
    });

    const turn = runPrimaryTurn(
      {
        // Reflection events stream to ctx.workflowId — for Handoff this is
        // the rotating workflow; for Spawn this is the new child tab.
        workflowId: ctx.workflowId,
        // Native tools' Write/Read jail to ctx.cwd, so the reflection runs
        // at the target workflow's cwd (not original.cwd as the CLI path
        // does — the absolutePath above lives under ctx.cwd).
        cwd: ctx.cwd,
        manager: ctx.manager,
        broadcast: ctx.broadcast,
      },
      {
        primary: original.primary,
        prompt: reflectionPrompt,
        // No CLI session to resume — the Native worker carries history in
        // messages[] (seeded above for Spawn; in-memory for Handoff).
        resumeSessionId: undefined,
        claudeTransport: 'native',
        // docs/PROVIDERS.md - handoff seed output feeds the next
        // worker; forced normal regardless of source-tab outputStyle.
        outputStyle: 'normal',
        // docs/GOTCHAS.md - inherit the source tab's north-star.
        goal: original.goal,
        ...(original.primary.provider === 'codex' && original.codexHome
          ? { providerAccountRef: original.providerAccountRef, codexHome: original.codexHome }
          : {}),
      },
    );
    if (ab.originalWorkerTimedOut) {
      ctx.manager.kill(turn.workerId);
    } else {
      ab.workerId = turn.workerId;
      if (ab.killed) ctx.manager.kill(turn.workerId);
    }

    const r = await turn.settled;
    if (ab.originalWorkerTimedOut) {
      return { error: originalWorkerTimeoutError(originalWorkerTimeoutMs()) };
    }
    const completedAt = Date.now();
    if (r.error) {
      ctx.broadcast({
        type: 'handoff_artifact_ready',
        workflowId: ctx.workflowId,
        handoffId,
        artifactName,
        error: `original-worker reflection failed: ${r.error}`,
        completedAt,
      });
      return { error: r.error };
    }

    try {
      const body = (await fs.readFile(absolutePath, 'utf8')).trim();
      if (!body) {
        const err = 'original-worker wrote an empty handoff file';
        ctx.broadcast({
          type: 'handoff_artifact_ready',
          workflowId: ctx.workflowId,
          handoffId,
          artifactName,
          error: err,
          completedAt,
        });
        return { error: err };
      }
      ctx.broadcast({
        type: 'handoff_artifact_ready',
        workflowId: ctx.workflowId,
        handoffId,
        artifactName,
        completedAt,
      });
      return { body };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const full = `original-worker did not write ${artifactName} (${msg}). Check chat — the primary may have ended without calling Write.`;
      ctx.broadcast({
        type: 'handoff_artifact_ready',
        workflowId: ctx.workflowId,
        handoffId,
        artifactName,
        error: full,
        completedAt,
      });
      return { error: full };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ab.originalWorkerTimedOut) {
      return { error: originalWorkerTimeoutError(originalWorkerTimeoutMs()) };
    }
    ctx.broadcast({
      type: 'handoff_artifact_ready',
      workflowId: ctx.workflowId,
      handoffId,
      artifactName,
      error: `original-worker (native) setup failed: ${msg}`,
      completedAt: Date.now(),
    });
    return { error: msg };
  }
}

function runFreshSummarizer(
  ctx: ExportContext,
  args: {
    summarizer: SummarizerConfig;
    transcript: ServerMessage[];
  },
  handoffId: string,
  artifactName: string,
  ab: AbortState,
): Promise<{ body?: string; error?: string }> {
  const rendered = renderTranscript(args.transcript);
  // WP2 — derive the tool-call digest from the SAME (post-cutoff) raw events so
  // the fresh summarizer sees file edits / commands / git ops, not just text.
  const actionsDigest = buildActionsTakenDigest(args.transcript);
  const artifactPath = path.join(ctx.cwd, '.arco', 'workflows', ctx.workflowId, 'handoffs', artifactName);

  let collected = '';
  // Load the summarizer template (operator override or default) before
  // spawning so the framing the worker reads is the operator's choice.
  return Promise.all([
    loadEffectivePrompt('fresh-summarizer', ctx.cwd),
    detectVerifyCommand(ctx.cwd),
  ]).then(([eff, verifyCommand]) => {
    const framing = renderPrompt(eff.template, {
      cwd: ctx.cwd,
      wfid: ctx.workflowId,
      handoffPath: artifactPath,
      verifyCommand,
    });
    const summarizerInput = buildFreshSummarizerInput(framing, rendered, actionsDigest);
    ab.workerId = handoffId;
    if (ab.killed) ctx.manager.kill(handoffId);
    return ctx.manager.spawn(
      {
        id: handoffId,
        task: summarizerInput,
        model: args.summarizer.model,
        effort: args.summarizer.effort,
        provider: args.summarizer.provider,
        tools: args.summarizer.provider === 'claude' || args.summarizer.provider === 'ollama'
          ? ['Read', 'Grep', 'Glob']
          : undefined,
      },
      (ev) => {
        if (ev.type === 'worker_text') collected += ev.text;
      },
      {
        cwd: ctx.cwd,
        workflowId: ctx.workflowId,
        skipPermissions: false,
        // The summarizer only reads a transcript and returns prose — the artifact
        // is written by the handoff machinery, not the worker. Marking it
        // read-only is correct for every provider (Codex gains `-s read-only`;
        // Claude already runs the Read/Grep/Glob allowlist above; the field is
        // inert elsewhere) AND is load-bearing for Cursor: it routes the spawn to
        // the stateless `cursor-agent -p` one-shot instead of the long-lived ACP
        // worker cache, which — because this spawn carries the primary tab's
        // workflowId — would otherwise run the summary INSIDE the operator's live
        // Cursor session. See providers/index.ts (Phase 5 routing).
        sandbox: 'read-only',
        // docs/PROVIDERS.md - fresh-summarizer output becomes the
        // *input* to the next worker; forced normal regardless of source
        // tab's outputStyle.
        outputStyle: 'normal',
        // docs/GOTCHAS.md - inherit the source tab's north-star so the
        // handoff artifact preserves the standing objective for the continuation.
        goal: args.summarizer.goal,
        ...(args.summarizer.provider === 'codex' && args.summarizer.codexHome
          ? { providerAccountRef: args.summarizer.providerAccountRef, codexHome: args.summarizer.codexHome }
          : {}),
      },
    );
  }).then(async (r) => {
    const completedAt = Date.now();
    if (r.error) {
      ctx.broadcast({
        type: 'handoff_artifact_ready',
        workflowId: ctx.workflowId,
        handoffId,
        artifactName,
        error: r.error,
        completedAt,
      });
      return { error: r.error };
    }
    const body = (collected.trim() || r.text || '').trim();
    if (!body) {
      const err = 'Summarizer returned empty handoff body';
      ctx.broadcast({
        type: 'handoff_artifact_ready',
        workflowId: ctx.workflowId,
        handoffId,
        artifactName,
        error: err,
        completedAt,
      });
      return { error: err };
    }
    try {
      await fs.mkdir(path.dirname(artifactPath), { recursive: true });
      await fs.writeFile(artifactPath, body + '\n', 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.broadcast({
        type: 'handoff_artifact_ready',
        workflowId: ctx.workflowId,
        handoffId,
        artifactName,
        error: `handoff write failed: ${msg}`,
        completedAt,
      });
      return { error: msg };
    }
    ctx.broadcast({
      type: 'handoff_artifact_ready',
      workflowId: ctx.workflowId,
      handoffId,
      artifactName,
      completedAt,
    });
    return { body };
  });
}

// preserveThinking (plan §8.4): when true, accumulated `primary_thinking`
// events are wrapped in `<think>...</think>` and prefixed onto the AGENT
// block. Qwen3.6's Thinking Preservation only works if prior assistant
// messages carry their reasoning, so the Ollama-as-primary path needs
// this; UI display + handoff summarizers explicitly don't (the operator
// shouldn't have to scroll past reasoning chains in chat). Default false
// preserves existing behavior for every other consumer.
export function renderTranscript(
  events: ServerMessage[],
  opts?: { preserveThinking?: boolean },
): string {
  const parts: string[] = [];
  let thinkBuf: string[] = [];
  let replyBuf: string[] = [];
  const flushReply = (): void => {
    if (thinkBuf.length === 0 && replyBuf.length === 0) return;
    let body = '';
    if (opts?.preserveThinking && thinkBuf.length > 0) {
      const reasoning = thinkBuf.join('').trim();
      if (reasoning) body = `<think>${reasoning}</think>\n\n`;
    }
    body += replyBuf.join('').trim();
    parts.push('AGENT: ' + body);
    thinkBuf = [];
    replyBuf = [];
  };
  for (const ev of events) {
    if (ev.type === 'user_message_echo') {
      flushReply();
      parts.push('USER: ' + ev.content.trim());
    } else if (ev.type === 'primary_text' && ev.phase === 'passthrough') {
      replyBuf.push(ev.text);
    } else if (ev.type === 'primary_thinking') {
      thinkBuf.push(ev.text);
    } else if (ev.type === 'primary_complete') {
      flushReply();
    }
  }
  flushReply();
  return parts.join('\n\n');
}

// Per-turn structured summary of prior workflow activity. Walks the
// events.jsonl-shaped event list and groups tool usage between
// user_message_echo boundaries, producing one block per prior operator
// turn. Used by the llama.cpp provider (Layer 2) to give cross-turn memory
// to local thinking models — renderTranscript drops tool history entirely,
// so without this the next turn's worker only sees the operator's text and
// the model's final reply (which is why Qwen3.6 said "no conversation
// history" when asked about work it had just done).
//
// Deterministic: no LLM call, just walks events and extracts file paths /
// commands / counts. Cheap enough to run on every spawn.
export function summarizePriorTurns(events: ServerMessage[]): string {
  interface Turn {
    userText: string;
    toolCounts: Map<string, number>;
    filesRead: Set<string>;
    filesWritten: Set<string>;
    bashCmds: string[];
    finalReply: string;
  }
  const turns: Turn[] = [];
  for (const ev of events) {
    if (ev.type === 'user_message_echo') {
      turns.push({
        userText: ev.content.trim(),
        toolCounts: new Map<string, number>(),
        filesRead: new Set<string>(),
        filesWritten: new Set<string>(),
        bashCmds: [],
        finalReply: '',
      });
      continue;
    }
    const cur: Turn | undefined = turns[turns.length - 1];
    if (!cur) continue;
    if (ev.type === 'primary_text' && ev.phase === 'passthrough') {
      cur.finalReply += ev.text;
    } else if (ev.type === 'primary_tool_use') {
      const name = ev.tool;
      cur.toolCounts.set(name, (cur.toolCounts.get(name) ?? 0) + 1);
      try {
        const args = JSON.parse(ev.input) as Record<string, unknown>;
        if ((name === 'Read' || name === 'NotebookEdit') && typeof args.file_path === 'string') {
          cur.filesRead.add(args.file_path);
        }
        if ((name === 'Write' || name === 'Edit') && typeof args.file_path === 'string') {
          cur.filesWritten.add(args.file_path);
        }
        if (name === 'Bash' && typeof args.command === 'string') {
          cur.bashCmds.push((args.command as string).split('\n')[0].slice(0, 120));
        }
      } catch { /* malformed input, skip extraction */ }
    }
  }
  if (turns.length === 0) return '';

  const lines: string[] = ['## Prior turns in this workflow (auto-summary)'];
  turns.forEach((t, i) => {
    const head = t.userText.length > 120 ? t.userText.slice(0, 120) + '…' : t.userText;
    lines.push('');
    lines.push(`### Turn ${i + 1}: ${head}`);
    if (t.toolCounts.size > 0) {
      const counts: string[] = [];
      for (const [k, v] of t.toolCounts) counts.push(`${k}×${v}`);
      lines.push(`- Tools: ${counts.join(', ')}`);
    }
    if (t.filesWritten.size > 0) {
      lines.push(`- Files written: ${[...t.filesWritten].join(', ')}`);
    }
    if (t.filesRead.size > 0) {
      const reads = [...t.filesRead];
      const shown = reads.slice(0, 8);
      const extra = reads.length > 8 ? ` (+${reads.length - 8} more)` : '';
      lines.push(`- Files read: ${shown.join(', ')}${extra}`);
    }
    if (t.bashCmds.length > 0) {
      const shown = t.bashCmds.slice(-6);
      lines.push(`- Bash: ${shown.map((c) => '`' + c + '`').join('; ')}`);
    }
    if (t.finalReply.trim().length > 0) {
      const reply = t.finalReply.trim().replace(/\s+/g, ' ').slice(0, 240);
      lines.push(`- Your reply: "${reply}${t.finalReply.length > 240 ? '…' : ''}"`);
    }
  });
  return lines.join('\n');
}

// WP2 — "Actions taken" digest for the fresh-summarizer. renderTranscript
// drops every tool call (only USER/AGENT text survives), so a fresh agent
// reading just the conversation can't see the file edits / Bash commands / git
// ops that are the actual substance of a coding session — and the worker that
// *would* have that context is the degraded one we're deliberately routing
// around. Walk the same raw events with summarizePriorTurns' structured
// extraction (files read/written, commands run, tool counts) and relabel its
// header so the summarizer prompt can point at it as ground truth. Returns ''
// when there's no tool activity (header stays out of the input).
function buildActionsTakenDigest(events: ServerMessage[]): string {
  const summary = summarizePriorTurns(events);
  if (!summary) return '';
  // summarizePriorTurns emits "## Prior turns in this workflow (auto-summary)";
  // re-title it to the section name the fresh-summarizer prompt references.
  return summary.replace(
    /^## Prior turns in this workflow \(auto-summary\)/,
    '## Actions taken (files read/written, commands run, tools used)',
  );
}

function buildFreshSummarizerInput(framing: string, transcript: string, actions: string): string {
  const parts: string[] = [framing, '', '---', ''];
  // Lead with the deterministic actions digest — the prompt treats it as the
  // authoritative record of what was done (the conversation transcript is the
  // narrative; the digest is the receipts).
  if (actions) {
    parts.push(actions, '', '---', '');
  }
  parts.push('## Transcript', '', transcript || '(empty transcript)');
  return parts.join('\n');
}

export function runExportContext(
  ctx: ExportContext,
  args: {
    mode: ExportContextMode;
    // fresh-summarizer config + input. Unused for original-worker.
    summarizer: SummarizerConfig;
    transcript: ServerMessage[];
    // original-worker config. Required for `'original-worker'` mode; unused
    // for `'fresh-summarizer'`.
    original?: OriginalPrimaryContext;
    // Phase 8 — when set, drop transcript events with seq > cutoffEventSeq
    // before rendering. Used by HISTORY's "SPAWN FROM HERE" so the spawned
    // primary only sees parent history up to the chosen point. Affects
    // fresh-summarizer directly (rendered transcript is truncated) and
    // Native original-worker via OriginalPrimaryContext.nativeReplaySource.
    // CLI original-worker silently ignores — see SpawnFromHereRequestMessage.
    cutoffEventSeq?: number;
  },
): ExportHandle {
  // Truncate the transcript view at the operator-supplied cutoff. Done once
  // here so every downstream consumer (fresh-summarizer's renderTranscript,
  // future paths) reads the same shortened slice.
  if (typeof args.cutoffEventSeq === 'number') {
    const cutoff = args.cutoffEventSeq;
    args = {
      ...args,
      transcript: args.transcript.filter((e) => {
        const seq = (e as { seq?: number }).seq;
        return typeof seq !== 'number' || seq <= cutoff;
      }),
    };
  }
  const handoffId = `hof-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactName = `handoff-${ts}.md`;
  const startedAt = Date.now();

  // fresh-summarizer spawns the worker with id === handoffId; original-worker
  // mints its own id and records it on `ab` once runPrimaryTurn spawns. abort()
  // covers both, plus the pre-spawn race (records intent; spawn site kills).
  const ab: AbortState = { workerId: handoffId, killed: false };
  const abort = (): void => {
    ab.killed = true;
    if (ab.workerId) ctx.manager.kill(ab.workerId);
  };

  ctx.broadcast({
    type: 'handoff_started',
    workflowId: ctx.workflowId,
    handoffId,
    mode: args.mode,
    startedAt,
  });

  if (args.mode === 'original-worker') {
    if (!args.original) {
      const err = 'original-worker mode requires an OriginalPrimaryContext (caller bug).';
      ctx.broadcast({
        type: 'handoff_artifact_ready',
        workflowId: ctx.workflowId,
        handoffId,
        artifactName,
        error: err,
        completedAt: Date.now(),
      });
      return { handoffId, artifactName, settled: Promise.resolve({ error: err }), abort };
    }
    return {
      handoffId,
      artifactName,
      settled: runWithOriginalWorkerTimeout(
        ctx,
        ab,
        runOriginalWorker(ctx, args.original, handoffId, artifactName, ab),
      ).then((r) => {
        if (!r.error || ab.killed) return r;
        ctx.broadcast({
          type: 'system_notice',
          workflowId: ctx.workflowId,
          content: `[HANDOFF] Original-worker reflection failed (${r.error}). Falling back to fresh summarizer.`,
        });
        return runFreshSummarizer(ctx, args, handoffId, artifactName, ab);
      }),
      abort,
    };
  }

  if (args.mode !== 'fresh-summarizer') {
    const completedAt = Date.now();
    ctx.broadcast({
      type: 'handoff_artifact_ready',
      workflowId: ctx.workflowId,
      handoffId,
      artifactName,
      error: `Handoff mode "${args.mode}" is not implemented yet — use 'original-worker' or 'fresh-summarizer'.`,
      completedAt,
    });
    return {
      handoffId,
      artifactName,
      settled: Promise.resolve({ error: `mode ${args.mode} not implemented` }),
      abort,
    };
  }

  return {
    handoffId,
    artifactName,
    settled: runFreshSummarizer(ctx, args, handoffId, artifactName, ab),
    abort,
  };
}

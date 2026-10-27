// Compare primitive - docs/ARCHITECTURE.md
//
// Mirrors runReviewer.ts / runResearch.ts: a BOUNDED, read-only, operator-
// initiated job. The difference is the fan-out — ONE prompt races against N
// independent legs, each a separate {provider, model, effort}. Each leg spawns
// its OWN short-lived worker with a UNIQUE worker id and NO shared session:
// the legs never see each other's output, never resume any prior session, and
// run concurrently. Each leg streams its answer into its own pane via
// compare_leg_delta events keyed by (compareId, legIndex).
//
// Fence note (CLAUDE.md "hard fences"): NO orchestrator LLM, NO "LLM judges the
// winner" step. Legs are read-only / no-tools by default (the race is meant to
// be a cheap, side-effect-free answer comparison, NOT a tool-using agent run) —
// the same bounded-job contract as the reviewer. The winner is an OPERATOR vote
// (handled in the WS layer, recorded to events.jsonl). The optional synthesize
// step is one more bounded leg the operator explicitly asks for. Never wired
// into the primary turn loop. Clears the four-question test.

import { WorkerManager } from '../workers/WorkerManager.js';
import type { WorkerResult } from '../workers/WorkerManager.js';
import type {
  ServerMessage,
  CompareLegConfig,
} from '@arco/shared';

export interface CompareContext {
  workflowId: string;
  cwd: string;
  manager: WorkerManager;
  broadcast: (msg: ServerMessage) => void;
}

export interface CompareHandle {
  compareId: string;
  // Per-leg worker ids so the cancel path can kill each still-running leg.
  legWorkerIds: string[];
  settled: Promise<{ succeededLegs: number }>;
}

// Mutable record the WS layer keeps alive after the race settles, so the
// operator vote can resolve the winner's identity and the optional synthesize
// follow-up can seed one more leg with every answer. runCompare fills `answers`
// as legs complete. Not persisted — events.jsonl is the durable audit trail;
// this is just the in-memory join the vote/synthesize handlers read.
export interface CompareRecord {
  compareId: string;
  prompt: string;
  legs: CompareLegConfig[];
  blind: boolean;
  // Final answer text per leg index ('' until that leg completes / on error).
  answers: string[];
}

// Read-only, no-TOOLS-by-default contract. A compare leg answers a prompt from
// its own knowledge; it does not edit, write, or even read the repo by default
// (that's what makes the race cheap and side-effect-free). Claude gets an EMPTY
// tool allowlist; Codex/Ollama/llama.cpp are additionally gated by the
// read-only sandbox + (Ollama/llama.cpp) the empty allowlist. This is stricter
// than the reviewer's read-only set on purpose — see the fence note above.
const NO_TOOLS: string[] = [];

// Per-compare synthesizer framing builder lives in the WS handler (it needs the
// collected answers); runCompare itself just spawns whatever task it's handed.

export function runCompare(
  ctx: CompareContext,
  args: {
    prompt: string;
    legs: CompareLegConfig[];
    blind: boolean;
    // Codex legs that need account routing arrive with these resolved by the
    // WS handler (keyed positionally to `legs`).
    codexHomes?: Array<string | undefined>;
    // Optional record the WS layer keeps for the vote/synthesize follow-ups.
    // runCompare populates `answers` as legs complete.
    record?: CompareRecord;
  },
): CompareHandle {
  const compareId = `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();
  const legWorkerIds = args.legs.map((_, i) => `${compareId}-leg${i}`);

  ctx.broadcast({
    type: 'compare_started',
    workflowId: ctx.workflowId,
    compareId,
    prompt: args.prompt,
    legs: args.legs,
    blind: args.blind,
    startedAt,
  });

  // Spawn one independent worker per leg. No shared session: every spawn is a
  // brand-new worker id with the same prompt as its ENTIRE input — there is no
  // resumeSessionId, no transcript prepend, and no cross-leg visibility.
  const legPromises = args.legs.map((leg, legIndex) => {
    const legId = legWorkerIds[legIndex];
    let collected = '';
    const legStartedAt = Date.now();

    const spawnP: Promise<WorkerResult> = ctx.manager.spawn(
      {
        id: legId,
        task: args.prompt,
        model: leg.model,
        effort: leg.effort,
        provider: leg.provider,
        tools: NO_TOOLS,
      },
      (ev) => {
        if (ev.type === 'worker_text') {
          collected += ev.text;
          ctx.broadcast({
            type: 'compare_leg_delta',
            workflowId: ctx.workflowId,
            compareId,
            legIndex,
            text: ev.text,
          });
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
        // Read-only, no-tools. Claude gates via the empty `tools` allowlist;
        // Codex gates via `-s read-only`; Ollama gates via the empty allowlist
        // (its SAFE mode also refuses tools). skipPermissions=true for Ollama so
        // SAFE mode doesn't emit denial strings for a prompt that needs none.
        skipPermissions: leg.provider === 'ollama',
        sandbox: 'read-only',
        // docs/PROVIDERS.md - compared answers are read carefully by the
        // operator; never caveman/lite. Forced regardless of source-tab style.
        outputStyle: 'normal',
        ...(leg.provider === 'codex' && args.codexHomes?.[legIndex]
          ? { providerAccountRef: leg.providerAccountRef, codexHome: args.codexHomes[legIndex] }
          : {}),
      },
    );

    return spawnP.then((r) => {
      const completedAt = Date.now();
      const text = (collected.trim() || r.text || '').trim();
      const ok = !r.error;
      if (args.record && ok) args.record.answers[legIndex] = text;
      ctx.broadcast({
        type: 'compare_leg_complete',
        workflowId: ctx.workflowId,
        compareId,
        legIndex,
        text,
        durationMs: completedAt - legStartedAt,
        ...(r.error ? { error: r.error } : {}),
        completedAt,
      });
      return ok;
    }).catch((err) => {
      // A spawn that rejects (rather than resolving with .error) still needs a
      // terminal leg event so the pane doesn't hang on "running" forever.
      const completedAt = Date.now();
      ctx.broadcast({
        type: 'compare_leg_complete',
        workflowId: ctx.workflowId,
        compareId,
        legIndex,
        text: collected.trim(),
        durationMs: completedAt - legStartedAt,
        error: err instanceof Error ? err.message : String(err),
        completedAt,
      });
      return false;
    });
  });

  // allSettled-style: wait for every leg, then announce the race is done. One
  // failed leg never blocks the others (independent jobs).
  const settled = Promise.all(legPromises).then((results) => {
    const succeededLegs = results.filter(Boolean).length;
    ctx.broadcast({
      type: 'compare_complete',
      workflowId: ctx.workflowId,
      compareId,
      succeededLegs,
      completedAt: Date.now(),
    });
    return { succeededLegs };
  });

  return { compareId, legWorkerIds, settled };
}

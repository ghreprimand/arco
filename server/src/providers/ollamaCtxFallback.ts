// M9 (LOCAL_AI_MASTER_PLAN) — Context-window fallback. The REACTIVE escape
// hatch that sits underneath M8's PROACTIVE compaction: when a turn is
// dispatched and Ollama returns a context-overflow 400 ANYWAY, instead of
// failing the turn we re-dispatch to a target with a LARGER effective num_ctx
// window. Reference algorithm: litellm `context_window_fallbacks` (mined, NOT
// depended on) — Excellence-plan LE-8.
//
// DESIGN SHAPE (mirrors ollamaResilience.ts): this module owns the *decision*
// surface — given the failing turn's window + the per-backend probed-window
// substrate M4 already maintains (showCache + servesModel), pick the next
// larger-window target. It deliberately does NOT own the HTTP fetch or the
// re-dispatch — that stays in ollama.ts's streamWithFailover so the streaming
// path is unchanged. The wrapper calls planCtxEscalation(), then re-runs
// streamOneTurn against the chosen target.
//
// LOAD-BEARING INVARIANTS (cite these — they are the fences the prompt names):
//   - overflow-400-is-not-a-host-fault: a 400 keeps the host HOT. M9 escalates
//     the *window*; it never cools the backend (M4's classifyOllamaError already
//     maps 400 → not-retryable, not-cooling — preserved). We hook BEFORE the
//     terminal this.fail(), not the cooldown path.
//   - escalate-don't-recompact: if M8 already compacted this turn, a subsequent
//     overflow means "compaction wasn't enough → bigger window", NOT "compact
//     again". M9 never touches the transcript; it only changes the target.
//   - bounded-to-avoid-loop: a small max number of escalations (default 2) so a
//     misconfigured fleet can't loop forever. Exhaustion falls through to M4's
//     existing terminal failure with an actionable message.
//   - trusted-ceiling: the same-backend num_ctx bump never requests above the
//     model's PROBED Modelfile ceiling (M3's trusted-only rule). A peer is only
//     chosen when its probed window is strictly larger than the failing window.

// The daemon's silent default window when no trusted num_ctx is sent — the same
// 2048 figure M6 uses as the CTX-bar denominator fallback (single source of
// truth in ollamaTokens.ts). Used to reason about "did the turn run on a smaller
// window than the model can serve" when the failing window is unknown.
import { OLLAMA_DEFAULT_WINDOW } from './ollamaTokens.js';
export { OLLAMA_DEFAULT_WINDOW };

// Per-backend window knowledge as the chat path already has it: the probed
// /api/show num_ctx (M3 trusted ceiling) keyed by base URL, plus whether the
// backend serves the requested model (M4's servesModel). `undefined` window =
// unprobed/unknown.
export interface CtxBackendInfo {
  baseUrl: string;
  label: string;
  // The model's probed Modelfile num_ctx on THIS backend (trusted ceiling), or
  // undefined when /api/show yielded nothing (daemon default applies → unknown).
  probedNumCtx: number | undefined;
  // M4's servesModel verdict: true = serves it, false = definitively not,
  // undefined = unknown (optimistic — but for a window UPGRADE we require a
  // known-larger probe, so an unknown-window peer is NOT a valid escalation
  // target; guessing a bigger window risks a second overflow).
  serves: boolean | undefined;
}

// The escalation strategies, in the exact order LE-8 specifies. Readable so the
// events.jsonl line can name which rule fired (guardrail: deterministic).
export type CtxEscalationKind =
  // Same backend, same model, request the model's FULL probed window — the
  // failing turn ran on a smaller window (operator preset below the ceiling, or
  // the daemon 2048 default). Bump to the trusted ceiling. Only valid when the
  // ceiling is strictly larger than the window the turn used.
  | 'numctx_bump'
  // A PEER backend whose probed window for the same model is strictly larger
  // than the failing window. Re-dispatch there (it may have the model loaded
  // with a bigger Modelfile num_ctx).
  | 'peer_backend';

export interface CtxEscalationTarget {
  kind: CtxEscalationKind;
  baseUrl: string;
  label: string;
  // The effective num_ctx the re-dispatch will run against (the new, larger
  // window). For 'numctx_bump' this is forced onto the request; for
  // 'peer_backend' it's the peer's probed ceiling (informational + the request
  // there applies its own preset/clamp against the same probe).
  toWindow: number;
  // Human-readable reason for the context_window_fallback event line.
  reason: string;
}

export interface CtxEscalationInput {
  // The window (num_ctx) the FAILING turn actually ran against — the effective
  // value after M3's clamp, or the daemon default when none was sent. May be
  // undefined when the failing backend's window was unknown (M8 defers to M9 on
  // exactly this case): then any KNOWN-larger probe is a strict upgrade.
  failedWindow: number | undefined;
  // The backend the failing turn ran on.
  failedBase: string;
  // The probed ceiling on the failed backend (for the same-backend bump).
  failedProbedNumCtx: number | undefined;
  // All candidate backends with their per-backend window + serves knowledge.
  backends: CtxBackendInfo[];
  // Backends already escalated-to this turn (don't re-pick a target that itself
  // just overflowed — bounds the loop alongside maxEscalations).
  alreadyEscalated: ReadonlySet<string>;
}

// Decide the next larger-window target, or null when none exists (→ caller
// falls through to terminal failure). Strategy order per LE-8:
//   1. numctx_bump — same backend/model, request the FULL probed ceiling, when
//      that ceiling is strictly larger than the window the turn used. This is
//      the cheapest, most-likely fix: the operator's preset (or the daemon
//      default) was simply below what the model was built to handle.
//   2. peer_backend — a different backend whose probed window for the same model
//      is strictly larger than the failing window.
// We do NOT invent a small→large model-name mapping: LE-8 mentions "a bigger
// model" as an option but no mapping config exists in Archon, and the scope
// discipline is to reuse M4's probed-window substrate rather than build one.
export function planCtxEscalation(input: CtxEscalationInput): CtxEscalationTarget | null {
  const { failedWindow, failedBase, failedProbedNumCtx, backends, alreadyEscalated } = input;

  // The effective window the failing turn ran on. When unknown (probe failed on
  // the failed backend), treat it as the daemon default for the "strictly
  // larger" comparison — a known probe above 2048 is then a real upgrade.
  const effectiveFailed = failedWindow ?? OLLAMA_DEFAULT_WINDOW;

  // ── Strategy 1: same-backend num_ctx bump to the trusted ceiling ──────────
  // Honor the trusted-ceiling rule: only request what the model was probed to
  // handle, never a guess above it. Valid only when the ceiling exceeds the
  // window the turn used (otherwise re-dispatching the same window would just
  // overflow again). We allow re-targeting the same base for THIS strategy even
  // if it's in alreadyEscalated for peer purposes — but to keep the loop bound
  // honest, a bump is offered only once per base (the caller records the base in
  // alreadyEscalated after using it, so a second overflow on the bumped window
  // won't re-bump the same host).
  if (
    !alreadyEscalated.has(failedBase) &&
    typeof failedProbedNumCtx === 'number' &&
    Number.isFinite(failedProbedNumCtx) &&
    failedProbedNumCtx > effectiveFailed
  ) {
    const failedInfo = backends.find((b) => b.baseUrl === failedBase);
    return {
      kind: 'numctx_bump',
      baseUrl: failedBase,
      label: failedInfo?.label ?? failedBase,
      toWindow: failedProbedNumCtx,
      reason:
        `same backend, bump num_ctx ${effectiveFailed} → ${failedProbedNumCtx} ` +
        `(model's probed trusted ceiling; failing turn ran below it)`,
    };
  }

  // ── Strategy 2: a peer backend with a strictly-larger probed window ───────
  // Require a KNOWN probe (a bigger window must be trusted, not optimistic — an
  // unknown-window peer could overflow a second time). Among qualifying peers,
  // pick the LARGEST window (give the escalation the best chance to fit).
  const peers = backends
    .filter((b) => b.baseUrl !== failedBase)
    .filter((b) => !alreadyEscalated.has(b.baseUrl))
    .filter((b) => b.serves !== false) // serves it or unknown-serves (request reveals truth)
    .filter(
      (b) =>
        typeof b.probedNumCtx === 'number' &&
        Number.isFinite(b.probedNumCtx) &&
        (b.probedNumCtx as number) > effectiveFailed,
    )
    .sort((a, b) => (b.probedNumCtx as number) - (a.probedNumCtx as number));

  const peer = peers[0];
  if (peer) {
    return {
      kind: 'peer_backend',
      baseUrl: peer.baseUrl,
      label: peer.label,
      toWindow: peer.probedNumCtx as number,
      reason:
        `peer backend "${peer.label}" serves the model with a larger probed window ` +
        `(${peer.probedNumCtx} vs ${effectiveFailed})`,
    };
  }

  return null;
}

// Default escalation cap (bounded-to-avoid-loop). At most this many window
// escalations per operator turn before falling through to terminal failure.
// Small on purpose — a 1–3 backend home fleet needs 1–2 hops at most (bump the
// local ceiling, then maybe a bigger-window peer). Overridable via env for the
// rare larger fleet, clamped to a sane range.
export const MAX_CTX_ESCALATIONS = (() => {
  const env = process.env.ARCHON_OLLAMA_CTX_MAX_ESCALATIONS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 4) return n;
  }
  return 2;
})();

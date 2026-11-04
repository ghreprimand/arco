// §5.1 — cron-style invariants for the operator primitives (Review / Handoff /
// Spawn). NOT an autonomous scheduler: this borrows one hardening invariant from
// Hermes' cron — a model/provider drift guard at dispatch.
//
// The problem it closes: the operator picks a reviewer / summarizer model in a
// dialog, then (catalog refresh, provider downgrade, a model retired upstream)
// that selection no longer resolves by the time the primitive actually fires. A
// scheduled cron target that vanished is the canonical case; here the gap is
// shorter but the failure is the same — the primitive would dispatch onto a
// silent fallback or fail opaquely deep in the worker. We re-resolve the
// selection against the LIVE catalog at dispatch and flag it for the operator.
//
// Discipline: deterministic, operator-visible (a system_notice persisted to
// events.jsonl), non-blocking (we FLAG and proceed — the operator can cancel and
// re-pick), and FAIL-OPEN (a cold catalog, a probe error, or an unsupported
// provider never flags; we must never block a primitive on a catalog hiccup).
//
// The `context_from`-chaining half of §5.1 is already satisfied by the existing
// `[HANDOFF —` / spawn seed framing, so this module covers only the drift guard.

export type PrimitiveKind = 'review' | 'handoff' | 'spawn';

export interface DriftCheck {
  drifted: boolean;
  reason?: string;
}

// Pure operator-facing flag text for a drifted dispatch (the system_notice body).
export function driftFlag(
  primitive: PrimitiveKind,
  provider: string,
  model: string,
  reason: string,
): string {
  const label = primitive === 'review' ? 'REVIEW' : primitive === 'handoff' ? 'HANDOFF' : 'SPAWN';
  return `[${label} — MODEL DRIFT] ${reason} (selected ${provider}:${model}). Dispatching anyway — cancel and re-pick if that isn't what you intended.`;
}

// Resolution-drift guard. `isKnown` is injected (the live catalog probe) so this
// module stays pure and unit-testable. Returns `drifted:true` only when the probe
// can affirmatively say the model is gone; every uncertain case fails open.
export async function checkModelDrift(
  provider: string,
  model: string,
  isKnown: ((p: string, m: string) => Promise<boolean>) | null,
): Promise<DriftCheck> {
  if (!isKnown || !provider || !model) return { drifted: false };
  let known = true;
  try {
    known = await isKnown(provider, model);
  } catch {
    return { drifted: false }; // fail-open on a probe error
  }
  if (known) return { drifted: false };
  return {
    drifted: true,
    reason: `model "${model}" is no longer in ${provider}'s live catalog — it may have been renamed or retired since you selected it`,
  };
}

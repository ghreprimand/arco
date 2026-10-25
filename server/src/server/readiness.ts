// ARCHON_OPS_PLAN.md §B2 — process readiness state.
//
// Module-level singleton (same mutable-cell pattern as index.ts's `capabilities`
// cell) tracking whether the server has finished the boot work that must complete
// before it can take real traffic. Backs GET /readyz, the `archon service status`
// readiness line, and the A1 `core.readiness` diagnostics check.
//
// Readiness is EXACTLY two components — `capabilities` + `stores`:
//   - `capabilities`: the provider-capabilities probe (a pre-listen() top-level
//     await in index.ts, so it's always done by the time we're listening).
//   - `stores`: workflow-store recovery from disk (the post-listen() async).
// These are the two things downstream requests assume exist. Best-effort boot
// prefetches (settings cascade, model catalogs, recall backfill) are deliberately
// NOT gated here: they degrade gracefully and must never hold readiness false.
//
// Dependency-light + side-effect-free besides its own module state.

export type ReadinessComponent = 'capabilities' | 'stores';

const REQUIRED: readonly ReadinessComponent[] = ['capabilities', 'stores'];

// Module-load timestamp ≈ process boot for uptime purposes. Good enough — the
// module is imported during index.ts's import graph, before listen().
const BOOTED_AT = Date.now();

const state: Record<ReadinessComponent, boolean> = {
  capabilities: false,
  stores: false,
};

// Flip a component ready. Idempotent — re-marking an already-ready component is
// a no-op (e.g. a recovery .finally that also ran .then).
export function markReady(component: ReadinessComponent): void {
  state[component] = true;
}

// True iff ALL required components are ready.
export function isReady(): boolean {
  return REQUIRED.every((c) => state[c]);
}

export function readinessSnapshot(): {
  ready: boolean;
  components: Record<ReadinessComponent, boolean>;
  pending: ReadinessComponent[];
  bootedAt: number;
  uptimeSec: number;
} {
  return {
    ready: isReady(),
    components: { ...state },
    pending: REQUIRED.filter((c) => !state[c]),
    bootedAt: BOOTED_AT,
    uptimeSec: Math.floor((Date.now() - BOOTED_AT) / 1000),
  };
}

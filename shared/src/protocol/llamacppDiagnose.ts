// ── llama.cpp serve-failure diagnosis (DD13) ──
//
// When the llama.cpp lifecycle manager's last launch failed, its stderr tail
// usually says WHY in a way the operator can act on: a port was taken, the GGUF
// path was wrong, the context was too large for VRAM, the box ran out of memory.
// DD13 runs a small ORDERED set of (pattern → cause + suggestions + structured
// fixes) over that tail so the model-health panel can render "here's what broke
// and here's the one-click fix" instead of a raw stack of log lines.
//
// FENCE (four-question test): operator-triggered (computed only when the panel is
// fetched, off a log the operator's own launch produced); deterministic (a fixed,
// readable, ordered regex registry — NO model judgment); visible (the diagnosis
// rides the existing model-health payload); reversible (every fix is an ordinary
// catalog edit the operator applies and can re-edit). This is NOT a quality
// verdict and NOT an auto-remediation — the operator reads it and clicks.
//
// Scope: the llama.cpp subset only. The upstream reference also covered
// vLLM/SGLang; those are deliberately DROPPED — Arco serves GGUF via llama.cpp.

// A structured, one-click remediation. Each maps onto a field the
// LlamacppCatalogEditor already edits (ctxSize / ngl / extraArgs) so applying it
// is an ordinary catalog write + reload — nothing bespoke, nothing irreversible.
//   • set-ctx-size  — lower the context window (ctxSize). For ctx-too-large / OOM.
//   • set-ngl       — offload fewer layers to the GPU (ngl). For OOM / VRAM spill.
//   • add-extra-arg — append a llama-server flag (extraArgs). Escape hatch.
// Advisory-only causes (port-in-use, gguf-missing, binary-missing, unsupported-
// arch) carry NO fix — the remediation is outside the catalog editor (free a
// port, fix a path, install/upgrade) and lives in `suggestions` text instead.
export type LlamacppServeFix =
  | { kind: 'set-ctx-size'; ctxSize: number; label: string }
  | { kind: 'set-ngl'; ngl: number; label: string }
  | { kind: 'add-extra-arg'; arg: string; label: string };

// A recognised failure cause. `unknown` is the Traceback fallback (a failure we
// couldn't classify) — still surfaced so the operator sees the tail, just with no
// targeted suggestion.
export type LlamacppFailureCause =
  | 'port-in-use'
  | 'gguf-missing'
  | 'ctx-too-large'
  | 'oom'
  | 'binary-missing'
  | 'unsupported-arch'
  | 'unknown';

// The diagnosis of a serve failure. `matched` is false only for the `unknown`
// fallback. `message` is a one-line human summary; `suggestions` are plain-text
// steps; `fixes` are the structured one-click ops (possibly empty).
export interface LlamacppServeDiagnosis {
  matched: boolean;
  cause: LlamacppFailureCause;
  message: string;
  suggestions: string[];
  fixes: LlamacppServeFix[];
}

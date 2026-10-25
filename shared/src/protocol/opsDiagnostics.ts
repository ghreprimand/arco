// ── Operations diagnostics (ARCO_OPS_PLAN.md §A1) ──
//
// The shared response contract for GET /api/diagnostics. The server builds a
// DiagnosticsReport from a pure check registry (server/src/diagnostics/checks.ts);
// the System modal's Diagnostics tab renders it.
//
// Named `opsDiagnostics` to avoid colliding with the LSP `diagnostics.ts`
// module (DiagnosticItem / DiagnosticsMessage) — different subsystem, same word.
//
// The A3 model-health types below reuse the Cookbook fit/hardware shapes.

import type { HardwareProfile, FitVerdict } from './cookbook.js';
import type { LlamacppServeDiagnosis } from './llamacppDiagnose.js';
//
// Status semantics (deterministic, operator-readable — four-question fence):
//   ok      — the probe ran and the thing works.
//   warn    — degraded or an optional dependency is absent (e.g. ffmpeg not
//             installed, TS language server not on PATH). Not an error: Arco
//             still functions, the operator just loses a capability.
//   error   — something that should work doesn't (e.g. the data dir is not
//             writable). A thrown probe also lands here with its message.
//   skipped — not probed on this platform/config (e.g. Antigravity CDP detection
//             when no cheap probe exists). Distinct from warn: nothing is wrong,
//             we simply didn't look.
export type DiagnosticStatus = 'ok' | 'warn' | 'error' | 'skipped';

// The fixed groups. Order here is the render order in the UI.
// `security` (A4) appends after `storage` so the exposure-posture group renders
// last; the status vocab + DiagnosticCheck/DiagnosticGroup shapes are reused.
export type DiagnosticGroupId =
  | 'core'
  | 'providers'
  | 'local-tools'
  | 'workbench'
  | 'storage'
  | 'security';

// One probe result. `detail` is always present (a short human sentence); `hint`
// is an optional remediation pointer ("install ffmpeg", "run gh auth login").
export interface DiagnosticCheck {
  id: string;
  group: DiagnosticGroupId;
  label: string;
  status: DiagnosticStatus;
  detail: string;
  hint?: string;
}

export interface DiagnosticGroup {
  id: DiagnosticGroupId;
  label: string;
  checks: DiagnosticCheck[];
}

export interface DiagnosticsReport {
  groups: DiagnosticGroup[];
  // ms epoch the report was generated.
  generatedAt: number;
  // Arco package version (package.json `version`).
  arcoVersion: string;
  // `${process.platform}/${process.arch}` — e.g. "linux/x64", "darwin/arm64".
  platform: string;
}

// ── Support bundle (ARCO_OPS_PLAN.md §A2 + Appendix D) ──
//
// A paste-ready, REDACTED snapshot of this machine's diagnostics + versions,
// suitable for an issue or another agent. Built server-side by
// server/src/diagnostics/supportBundle.ts from an EXPLICIT ALLOWLIST of safe
// fields (Appendix D: allowlist, never a denylist). It must contain NO tokens,
// secrets, auth material, env secrets, or local private paths — the embedded
// DiagnosticsReport has every free-text `detail`/`hint` path-redacted (home dir
// → `~`), and a defense-in-depth secret-scrub runs over the serialized text.
//
// Every field here is hand-picked. We never serialize raw settings, raw env, or
// raw token objects into this shape.
export interface SupportBundleRuntime {
  // `process.version` — e.g. "v22.14.0".
  node: string;
  // Best-effort transport/service mode. Service mode itself lands in Part B; for
  // now this is "dev (tsx watch)" when running under tsx, else "unknown".
  serviceMode: string;
}

export interface SupportBundle {
  // ms epoch the bundle was generated.
  generatedAt: number;
  // Arco package version (package.json `version`).
  arcoVersion: string;
  // Short git rev of the Arco checkout (e.g. "9ed6aef"), or "unknown".
  gitRev: string;
  // `${os}/${arch}` — e.g. "linux/x64".
  platform: string;
  runtime: SupportBundleRuntime;
  // The A1 diagnostics report, PATH-REDACTED (home dir → `~`).
  diagnostics: DiagnosticsReport;
  // Optional free-text notes (also redacted). Currently a fixed redaction
  // disclaimer line.
  notes?: string;
}

// GET /api/diagnostics/support-bundle returns both the typed JSON and the
// human-readable text rendering (what the Copy button actually copies).
export interface SupportBundleResponse {
  json: SupportBundle;
  text: string;
}

// ── Local model health panel (ARCO_OPS_PLAN.md §A3) ──
//
// A model-operator-focused readout: "what can I run now / what's running / what
// failed last time / is my config stale?". Distinct from the A1 Diagnostics tab
// (one-line status per dep): this payload is RICHER and STRUCTURED — three
// subsystems (Ollama / llama.cpp / Cookbook), each carrying concrete fields plus
// a roll-up `DiagnosticStatus`. Built server-side by
// server/src/diagnostics/modelHealth.ts, reusing the existing ollama /
// llamacppManager / cookbook probes (READ-ONLY; never spawns a model).
//
// Status framing reuses the A1 vocabulary (`ok|warn|error|skipped`), but the
// fences differ for a *model-operator* lens: a missing/unreachable subsystem is
// `warn`/`skipped` (the operator just isn't using it), NOT `error`; a stale
// config or a fit mismatch is a `warn` carrying an actionable hint. `error` is
// reserved for "the subsystem is configured and should work but its last launch
// failed" (e.g. llama.cpp manager state `failed`).

// One installed/registered model surfaced in the panel. `name` is the tag
// (Ollama) or alias (llama.cpp). `detail` is an optional one-liner (the GGUF
// basename, a capability hint, etc.).
export interface ModelHealthModel {
  name: string;
  detail?: string;
}

// Ollama sub-report. `reachable` is the daemon ping result; when false, `models`
// is empty and the roll-up is `warn` (daemon not running is not an error — the
// operator may simply not use Ollama).
export interface OllamaHealth {
  status: DiagnosticStatus;
  // Resolved base URL (settings.ollama.baseUrl or OLLAMA_URL_BASE). Path-safe to
  // surface — it's a host:port the operator configured, not a secret.
  baseUrl: string;
  reachable: boolean;
  // Installed-model count + names (from /api/tags). Empty when unreachable.
  modelCount: number;
  models: ModelHealthModel[];
  // Daemon version when cheaply available (/api/version); omitted otherwise.
  version?: string;
  // Human one-liner mirroring the roll-up.
  detail: string;
  hint?: string;
}

// llama.cpp lifecycle-manager snapshot + catalog + last-launch forensics. The
// manager owns at most one running llama-server; `managerState` is its current
// state. `lastLaunchArgs` / `lastStderrTail` answer "what failed last time?".
export interface LlamacppHealth {
  status: DiagnosticStatus;
  // Resolved llama-server binary path (which lookup), or null if not on PATH.
  binaryPath: string | null;
  // Registered loadouts from ~/.arco/llamacpp.json (alias + GGUF basename).
  modelCount: number;
  models: ModelHealthModel[];
  // Lifecycle-manager state + the live-load fields when a model is resident.
  managerState: 'idle' | 'loading' | 'ready' | 'failed';
  loadedAlias?: string;
  port?: number;
  pid?: number;
  loadedAt?: number;
  lastUsedAt?: number;
  // The argv of the most recent llama-server spawn (retained in-process by the
  // manager). Absent if no spawn has happened this server lifetime.
  lastLaunchArgs?: string[];
  // Tail of ~/.arco/llamacpp.log (the manager's spawn/stderr sink) — the last
  // ~40 lines, redaction-free paths since this is a local-operator panel. Absent
  // if the log doesn't exist yet.
  lastStderrTail?: string;
  // Whether the manager's spawned port currently has a listener (best-effort).
  portReachable?: boolean;
  // The manager's last error string, when state is `failed`.
  error?: string;
  // DD13 serve-failure diagnosis of `lastStderrTail`, present only when the last
  // launch failed (managerState `failed`) and the tail matched a known cause.
  // Carries the cause + plain-text suggestions + structured one-click fixes the
  // panel renders against the catalog editor's ctxSize / ngl / extraArgs fields.
  diagnosis?: LlamacppServeDiagnosis;
  detail: string;
  hint?: string;
}

// One fit-mismatch warning: a registered/selected model that doesn't fit the
// detected hardware at a useful context. `alias` is the catalog alias; `verdict`
// is the FitVerdict; `detail` explains the mismatch.
export interface ModelFitWarning {
  alias: string;
  verdict: FitVerdict;
  detail: string;
}

// Cookbook sub-report: downloaded models, the detected hardware profile, and
// fit-mismatch warnings. `activeLlamaServer` mirrors the manager's running state
// (the Cookbook's only "active process" concept — there is no separate Cookbook
// daemon). `staleCleanup` describes the stale-orphan-listener reaping the
// llamacpp manager performs on the next spawn (informational; the panel doesn't
// trigger it).
export interface CookbookHealth {
  status: DiagnosticStatus;
  hardware: HardwareProfile;
  // GGUF files present under ~/.arco/models (the Cookbook download target).
  downloadedModelCount: number;
  downloadedModels: ModelHealthModel[];
  // Fit mismatches across the registered llama.cpp catalog vs detected hardware.
  fitWarnings: ModelFitWarning[];
  detail: string;
  hint?: string;
}

// The full A3 report. Each sub-object is independently wrapped server-side so one
// subsystem failure degrades to a `warn` sub-report rather than failing the call.
export interface ModelHealthReport {
  ollama: OllamaHealth;
  llamacpp: LlamacppHealth;
  cookbook: CookbookHealth;
  // ms epoch the report was generated.
  generatedAt: number;
  platform: string;
}

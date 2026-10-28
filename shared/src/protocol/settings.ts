// ── Operator settings / provider accounts / advanced options ──

import type { EffortLevel, ModelName, ProviderName } from './providers.js';
import type { FallbackChainsConfig } from './fallback.js';

export const UI_SCALES = [0.9, 1, 1.1, 1.2, 1.3, 1.5] as const;
export const DEFAULT_UI_SCALE = 1.1;
export function normalizeUiScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_UI_SCALE;
  return UI_SCALES.reduce((best, step) => Math.abs(step - value) < Math.abs(best - value) ? step : best);
}

export interface AdvancedOptions {
  additionalDirectories?: string[];
  fallbackModel?: ModelName;
}

// Provider-native skill exposed in the composer. `invocation` is deliberately
// server-resolved: Claude Code uses `/name`, while Codex uses `$name`.
export interface ToolboxEntry {
  name: string;
  displayName?: string;
  description: string;
  provider: 'claude' | 'codex';
  source: 'plugin' | 'user' | 'project' | 'builtin' | 'system' | 'admin';
  invocation: string;
  pluginName?: string;
  path?: string;
  enabled?: boolean;
}

export interface ToolboxResponse {
  provider: 'claude' | 'codex' | null;
  transport: string | null;
  supported: boolean;
  reason?: string;
  entries: ToolboxEntry[];
}

// Operator-level settings persisted to ~/.arco/settings.json.
export interface WorkflowDefaults {
  primaryProvider?: ProviderName;
  primaryModel?: ModelName;
  primaryEffort?: EffortLevel;
  providerAccountRef?: string;
  skipPermissions?: boolean;
  fastMode?: boolean;
  // Native-only efficiency knobs surfaced on the New-tab picker so the
  // operator's preference becomes the default for future Claude tabs.
  // The fields are stored on every workflow created from the New tab
  // regardless of provider — they're no-ops on CLI / Codex / Gemini /
  // Ollama / llama.cpp tabs (only Native honors them) but a transport
  // flip on the same tab picks them up automatically.
  efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive';
  outputStyle?: 'normal' | 'lite' | 'terse';
  zaiTransport?: 'native' | 'appserver';
}

export interface ProviderAccountBrowser {
  command: string;
  args?: string[];
}

export interface ProviderAccountProfile {
  id: string;
  label: string;
  shortLabel?: string;
  // Codex-only today. Expands ~ on the server. Example:
  // ~/.arco/provider-accounts/codex-work
  codexHome?: string;
  authBrowser?: ProviderAccountBrowser;
}

export interface ProviderAccountsConfig {
  codex?: ProviderAccountProfile[];
  claude?: ProviderAccountProfile[];
}

export interface ArcoSettings {
  // Global release notifications; the environment opt-out takes precedence.
  updateCheck?: boolean;
  updateCheckDismissed?: string;
  enabledProviders: Record<ProviderName, boolean>;
  workflowDefaults?: WorkflowDefaults;
  providerAccounts?: ProviderAccountsConfig;
  // Active UI theme id. Validated server-side against VALID_THEME_IDS.
  themeId?: string;
  // Operator-dismissed CLI version bumps. Shape: { claude: "1.5.0", … }.
  // When current CLI version matches the stored value, the CONFIG tab dot
  // stays dark; a newer version re-arms it.
  acknowledgedCliVersions?: Partial<Record<'claude' | 'gemini' | 'codex', string>>;
  // Operator display name. When set (and non-empty after trim), the chat
  // role label "> OPERATOR" is replaced by "> <name>" (uppercased).
  // Sanitized server-side: trimmed, single-line, max 32 chars.
  operatorName?: string;
  // The browser root for the working-directory selector (WorkflowCreator) and
  // the value the Settings folder-picker writes. An absolute path; when unset
  // the selector falls back to ~/Projects, then $HOME. NOT confined to $HOME —
  // `/api/list-dirs` already browses anywhere and a project can live on /mnt or
  // an SMB mount. Fixes the cross-machine case where the box's home isn't where
  // work lives (e.g. a Mac whose code is outside ~/Projects).
  defaultWorkingDirectory?: string;
  // Explicit project folders; registration never moves or deletes their files.
  projects?: string[];
  // First-run setup was completed, skipped, or bypassed by an existing user.
  onboardingComplete?: boolean;
  providerConfirmed?: boolean;
  // Optional font-pack override. When set to a valid pack id, applyTheme
  // substitutes the active theme's display/body/code fonts with the pack's.
  // Validated against VALID_FONT_PACK_IDS.
  fontPackOverride?: string | null;
  // Global interface scale, selected from UI_SCALES.
  uiScale?: number;
  // Operator override for the active theme's frosted-glass backdrop-filter.
  // 'on'/'off' force it; absent = follow the theme's own `frosted` default.
  // Applied via the data-frosted attribute (see client themes/apply.ts).
  frostedOverride?: 'on' | 'off';
  // Operator-tunable panel opacity for frosted-glass mode. Higher = more
  // opaque / less see-through. Clamped server-side to 0.3–0.95 so panels can't
  // go fully opaque (defeats the blur) or invisibly thin. Absent = the built-in
  // 0.6 default. Only has an effect when frosted glass is on (any theme).
  frostedOpacity?: number;
  // Global theme-brightness shifts, in signed points (0 = stock). Applied by
  // client themes/apply.ts. Two independent knobs so the operator can tune
  // readability both ways: `bgBrightness` shifts the background surfaces
  // (`color-bg*` tokens) via HSL lightness; `textBrightness` shifts everything
  // drawn on top (text, accents, borders — all non-bg color tokens) via HSV
  // value (brightens the colour without washing to white until the very top of
  // the range). Positive = brighter, negative = darker. The UI sliders scope
  // each axis (bg −30…+30, text −30…+80); clamped server-side to −100…100
  // (rounded) as a safety bound. Absent / 0 = no shift. Independent of theme +
  // frosted glass.
  bgBrightness?: number;
  textBrightness?: number;
  // Global "crisp text" toggle. When true, client themes/apply.ts sets
  // data-crisp="1" on <html>; global.css then neutralizes every text-shadow so
  // the phosphor/glow themes (which lean on inherited text-shadow) stop softening
  // small text. Structural box-shadow glow on borders/LEDs is untouched. Absent /
  // false = the theme's own glow. Independent of theme + frosted glass.
  crispText?: boolean;
  // Phosphor-only decoration. Absent = effects on, softness 50. Classic
  // preferences and appearance are unaffected; crispText overrides emission.
  phosphorEffects?: boolean;
  phosphorSoftness?: number;
  // Phase 2 — keys reserved for future phases. Define the schema; consumers
  // are wired in their respective phases. The cascade reader sanitizes these
  // pass-through (with shape checks) so a hand-edited project settings.json
  // can pin them today even if no UI consumes them yet.
  // Phase 3: path to a Handoff prompt override file (project- or operator-
  // level), relative to the cwd where the cascade resolves it.
  handoffPromptPath?: string;
  // Phase 4: pre-pin the visible-queue UX mode for a project before Phase 4
  // ships. 'visible' = strip above composer; 'hidden' = today's silent queue.
  queueMode?: 'visible' | 'hidden';
  // Phase 1+: extra directories to scan for skills, beyond the project
  // <cwd>/.arco/skills and the global ~/.arco/skills paths.
  skillsExtraPaths?: string[];
  // Phase 7: per-project Claude transport pin. 'cli' = current CLI worker,
  // 'native' = direct-API. `nativeWarningSeen` is the flag the CONFIG-tab
  // toggle (Phase 7a §11) sets after the operator dismisses the first-time-
  // enable warning so it doesn't fire again — cleared when a tab is flipped
  // back to `'cli'` so a re-enable on any tab re-shows the warning.
  claude?: { transport?: 'cli' | 'native'; nativeWarningSeen?: boolean };
  // Phase 6: per-project Codex transport pin. 'exec' = current per-turn
  // `codex exec --json` worker (default); 'appserver' = long-lived
  // `codex app-server` JSON-RPC worker that unlocks non-destructive
  // mid-turn steer + structured interrupt. `appserverWarningSeen` is the
  // flag the CONFIG-tab toggle (Phase 6e) sets after the operator dismisses
  // the first-time-enable warning so it doesn't fire again — cleared when a
  // tab is flipped back to `'exec'` so a re-enable re-shows the warning.
  // See docs/PROVIDERS.md.
  codex?: { transport?: 'exec' | 'appserver'; appserverWarningSeen?: boolean };
  // docs/PROVIDERS.md - default transport for new Z.ai tabs. Native is the
  // hardcoded fallback when absent; appserver remains selectable as fallback.
  zai?: { transport?: 'native' | 'appserver' };
  // Global auto-handoff default for newly-created tabs (mirror of the
  // TRANSPORT DEFAULTS pattern). Per-tab `config.autoHandoff` always wins;
  // this only seeds tabs that have never been touched. Absent / partial ⇒
  // the hardcoded fallback (enabled true / warn 75% / auto 90%) fills the
  // gaps. Cascade-readable so a project `.arco/settings.json` can pin it.
  // WP5 — `mode` is the global default for HOW an auto-handoff is performed
  // ('original-worker' resume vs 'fresh-summarizer'). Per-tab
  // config.autoHandoff.mode wins; absent here ⇒ the provider-resumable
  // fallback applies at fire time. The summarizer MODEL stays in the separate
  // top-level `handoffSummarizer` (below) — do not duplicate it here.
  autoHandoffDefaults?: { enabled?: boolean; warnAt?: number; autoAt?: number; mode?: 'original-worker' | 'fresh-summarizer' };
  // WP2 — global default for the fresh-summarizer worker that WRITES a handoff
  // doc. A handoff fires precisely when the current worker is low on context;
  // letting that degraded worker summarize itself is the failure mode this
  // setting exists to dodge. When set, a STRONG fresh agent (e.g. Opus) writes
  // the handoff instead. Resolution: per-request override → this default →
  // the tab's current primary. `model`/`effort` are optional — the resolver
  // fills them from the tab's primary when absent. Cascade-readable so a
  // project `.arco/settings.json` can pin it.
  handoffSummarizer?: { provider: ProviderName; model?: ModelName; effort?: EffortLevel };
  // Global default for Claude Native's Anthropic server-side compaction
  // (`compact_20260112`) on newly-created tabs. Per-tab
  // `config.claudeNativeCompact` always wins; this only seeds tabs that have
  // never set the toggle. Absent ⇒ the hardcoded `false` fallback applies, so
  // there's zero behavior change for operators who never configure one.
  // Defaults OFF — the server-side beta fires mid-turn at a flat ~150K tokens
  // and can evict a Read-heavy coding tab's working set (NATIVE_COMPACTION_PLAN
  // §1). Cascade-readable so a project `.arco/settings.json` can pin it.
  claudeNativeCompactDefault?: boolean;
  // Ollama daemon endpoint(s).
  //
  // `baseUrl` is the legacy single-backend field — overrides OLLAMA_URL_BASE
  // when set, then falls back to http://localhost:11434.
  //
  // M4 (multi-backend routing) adds `backends[]`: an operator-configured list
  // of Ollama daemons that serve (overlapping) model sets. When non-empty it
  // supersedes `baseUrl` for the chat path — the provider weighted-shuffles
  // across the healthy backends that serve the requested model, fails over to
  // a healthy peer with zero backoff, and reactively cools a failing backend
  // for a short TTL. When empty/unset the provider synthesizes a single
  // backend from the `baseUrl`→env→localhost cascade, so an operator who never
  // configures `backends` sees IDENTICAL behavior to pre-M4 (degenerate
  // one-backend case). See docs/PROVIDERS.md §Ollama multi-backend.
  //
  // `modelHostMap` is an OPTIONAL affinity hint: model-name (or substring) →
  // backend labels that serve it. It's a hint layered on top of live
  // per-backend `/api/tags` knowledge — used to bias selection when an
  // operator knows a model only lives on one host and wants to skip the
  // round-trip discovery. Selection still verifies the backend is healthy.
  //
  // M7 (utility / task model) adds `utility`: an OPTIONAL cheap/small model the
  // operator names for discrete, bounded BACKGROUND jobs (the M8 compaction
  // summary; later, model-titles + recall summaries) so the expensive primary
  // stays free. OFF by default — when `utility` (or `utility.model`) is unset,
  // those jobs keep their existing behavior (no utility model ⇒ no change). It
  // is NOT a per-turn `distill` (CLAUDE.md fence): operator-configured, opt-in,
  // bounded (stream:false + token cap + windowed prompt), per-call-logged to
  // events.jsonl, reversible. `baseUrl` optionally pins the small model to a
  // dedicated host that keeps it warm; unset ⇒ it weighted-shuffles across the
  // configured `backends` like a normal turn. See docs/PROVIDERS.md §Ollama
  // utility model + Excellence LE-3.
  ollama?: {
    baseUrl?: string;
    backends?: OllamaBackendConfig[];
    modelHostMap?: Record<string, string[]>;
    utility?: OllamaUtilityConfig;
    // WP3 — operator-facing surface for M8 auto-compaction. Until now these
    // knobs were env-only (ARCO_OLLAMA_*); this exposes them in settings.
    // Precedence at resolution: this settings field (if set) > env var (if
    // set) > the hardcoded default. Absent ⇒ env/default behavior unchanged.
    compaction?: OllamaCompactionConfig;
  };
  // M13 — LM Studio endpoint. Mirrors the legacy single-backend Ollama
  // `baseUrl` cascade: when set it overrides LMSTUDIO_URL_BASE, which in turn
  // falls back to http://localhost:1234/v1. LM Studio's app serves an
  // OpenAI-compatible REST API there (/v1/chat/completions, /v1/models,
  // /v1/embeddings); Arco talks to it over that surface rather than the
  // native lmstudio.js SDK (the standing LE-7 verdict — reuse the HTTP
  // provider plumbing, don't track the app's ws:// API version). The base
  // SHOULD include the /v1 suffix; the provider tolerates a bare host:port
  // by appending /v1 when absent. See docs/PROVIDERS.md § LM Studio.
  strata?: { baseUrl?: string };
  deepseek?: { baseUrl?: string };
  lmstudio?: {
    baseUrl?: string;
  };
  // docs/ARCHITECTURE.md - per-role provider fallback chains for
  // BOUNDED jobs only (reviewer / research). Hand-edited into settings.json;
  // the server READS these and never writes them. For a job, the effective
  // chain is `[primaryLeg, ...the role's configured legs minus one equal to the
  // primary]`. An unset role (or unset `fallbackChains`) ⇒ single-leg chain ⇒
  // today's behavior (no fallback, no regression). NO settings-editor UI in
  // C2 — opt in by hand-editing ~/.arco/settings.json. The live primary turn
  // is NEVER routed through a chain (fence: no mid-conversation provider swap).
  fallbackChains?: FallbackChainsConfig;
  // Slice 6a — operator-preferred top-row tab order. Holds workflowIds AND
  // clusterIds (the top row mixes both). On client load, top-row tabs are
  // sorted by this list; entries not present here fall to the end in their
  // natural creation order. Persisted via the existing /api/settings POST.
  tabOrder?: string[];
  // Outside-project media is opt-in and requires explicit mediaAllowedRoots.
  // Provider state, runtime secrets and pseudo-files remain inaccessible.
  mediaUnconfined?: boolean;
  // Global, explicit outside-project media folders; the switch alone grants none.
  mediaAllowedRoots?: string[];
  // Ops L2 — operator-pinned local services. Pins are a MACHINE-LEVEL inventory
  // (the Services tab is global, not workflow-scoped), keyed by a stable
  // (cwd, port) identity so a service surviving a restart re-matches and a
  // pinned-but-dead service renders as an offline row. The client sends the
  // FULL new array on each pin/unpin; the server replaces it wholesale (same
  // as `tabOrder` — a sequence, not a deep-merged map). No alias/rename in L2:
  // the discovery source has no label persistence.
  pinnedServices?: PinnedService[];
  // DD7 — project-trust default for repos with no recorded decision in
  // ~/.arco/trust.json. USER-SCOPE ONLY: read exclusively from the global
  // settings.json (never a project layer — a cloned repo must not be able to
  // self-grant trust by shipping a settings.json that sets this to 'always').
  // 'ask' (the absent default) ⇒ suppress the repo's CLAUDE.md / project skills
  // / project settings layer and raise a one-time operator prompt; 'always' ⇒
  // trust every unrecorded repo (legacy behavior); 'never' ⇒ silently suppress
  // without prompting. A per-cwd decision in trust.json always overrides this.
  defaultProjectTrust?: 'ask' | 'always' | 'never';
}

// M4 — one Ollama backend descriptor. `baseUrl` is required; everything else
// is optional with sensible defaults at the consumer:
//   - weight: relative selection weight in the weighted shuffle (default 1).
//     A workstation might be weight:3, a laptop weight:1.
//   - enable: false removes the backend from selection entirely (default true)
//     — a soft off-switch the operator can flip without deleting the entry.
//   - label: friendly name for events.jsonl / the model-host affinity map.
//     Defaults to the host:port of baseUrl when omitted.
//   - tailscaleHost: optional explicit Tailscale machine name to resolve when
//     the configured host is unreachable by DNS (Phase 8 fallback). When unset
//     the provider derives the candidate from the baseUrl hostname.
export interface OllamaBackendConfig {
  baseUrl: string;
  weight?: number;
  enable?: boolean;
  label?: string;
  tailscaleHost?: string;
}

// M7 — the utility / task model config. `model` is the cheap small-model alias
// or colon-tag (e.g. "qwen3:3b"); when absent the utility model is OFF and
// jobs fall back to their existing behavior. `baseUrl` optionally pins it to a
// dedicated backend; unset ⇒ the job uses the configured `backends` fleet.
export interface OllamaUtilityConfig {
  model?: string;
  baseUrl?: string;
  // Opt-in (default OFF, separate from arming the model for compaction): after
  // a workflow's first turns, generate a 5–8-word RESUME-picker title on the
  // utility model (workflows/modelTitles.ts). One-shot per session; an
  // operator rename always wins; every call is a visible system_notice.
  titles?: boolean;
  // Master pause (2026-09-29). `false` ⇒ every utility job behaves as if no
  // utility model were configured (compaction → deterministic digest, titles
  // skipped, fit calculator reserves nothing) while model/baseUrl/titles stay
  // saved for re-enabling. Absent ⇒ enabled, so pre-existing configs keep
  // working. Motivating case: the remote host (tank's 3070) is busy mining.
  enabled?: boolean;
}

// WP3 — operator-facing M8 auto-compaction knobs. Each mirrors an
// ARCO_OLLAMA_* env var (see ollamaRecovery.defaultCompactionConfig); a set
// field overrides the env, an unset field falls through to env→hardcoded.
// Sanitizer clamps to the SAME bounds the env parser uses. The byte-cap
// (maxToolCallArgChars) is intentionally omitted — it's a rarely-tuned safety
// floor better left to the env knob than a UI control.
export interface OllamaCompactionConfig {
  enabled?: boolean;       // master switch (env ARCO_OLLAMA_AUTO_COMPACT)
  threshold?: number;      // hard trigger, fraction of window 0-1 (default 0.85)
  warn?: number;           // early-warning fraction 0-1 (default 0.75)
  keepLast?: number;       // trailing messages kept verbatim (default 10)
  maxRecoveries?: number;  // max auto-compactions per turn (default 1)
  summaryTokens?: number;  // utility-summary output cap (default 1024)
}

// Ops L2 — a pinned local service. Identity = (cwd, port); `cwd` may be null
// (the process's cwd was unreadable when pinned).
export interface PinnedService {
  cwd: string | null;  // the service's cwd (the stable half of the identity)
  port: number;        // the listening port
  pinnedAt: number;    // epoch ms
}

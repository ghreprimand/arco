import { retiredProviderReason } from '@arco/shared';
// Three-layer operator-settings cascade.
//
// Read order: defaults → ~/.arco/settings.json (global) → <cwd>/.arco/
// settings.json (project) → in-memory overrides (none in Phase 2 — patches
// write through to the global file).
//
// Deep-merge for nested objects; arrays replace. (Documented in
// docs/OPERATIONS.md § Settings cascade.)
//
// HMR: fs.watch on the parent directory of each file (atomic-rename writers
// would skip a file-level watcher). Linux fires multiple events per save and
// also fires on temp files; we filter by basename and debounce 200ms. ENOENT
// from a transient temp/rename is non-fatal — we silently retry on the next
// real read.

import { promises as fs } from 'fs';
import { mkdirSync, realpathSync, watch as fsWatch, type FSWatcher } from 'fs';
import path from 'path';
import { homedir } from 'os';
import type { ArcoSettings, ProviderName, ModelName, WorkflowDefaults, EffortLevel, ProviderAccountsConfig, ProviderAccountProfile, FallbackChainsConfig, FallbackLegConfig, PinnedService, OllamaBackendConfig, OllamaUtilityConfig, OllamaCompactionConfig } from '@arco/shared';
import { VALID_THEME_IDS, VALID_FONT_PACK_IDS, normalizeLegacyThemeId, DEFAULT_UI_SCALE, normalizeUiScale } from '@arco/shared';
import { describeConfigValue } from './configValue.js';
import { atomicWriteFile, withFileLock } from './atomicFile.js';
import { arcoHome } from './arcoHome.js';

const GLOBAL_SETTINGS_DIR = arcoHome();
const GLOBAL_SETTINGS_BASENAME = 'settings.json';
const GLOBAL_SETTINGS_PATH = path.join(GLOBAL_SETTINGS_DIR, GLOBAL_SETTINGS_BASENAME);
const PROJECT_SETTINGS_DIRNAME = '.arco';
const PROJECT_SETTINGS_BASENAME = 'settings.json';

const ALL_PROVIDERS: ProviderName[] = ['claude',  'ollama', 'codex',  'llamacpp', 'lmstudio', 'strata', 'deepseek', 'cursor'];
const EFFORT_LEVELS: EffortLevel[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function defaults(): ArcoSettings {
  return {
    fontPackOverride: 'victor-mono-uniform',
    textBrightness: 30,
    codex: { transport: 'appserver' },
    claude: { transport: 'native' },
    uiScale: DEFAULT_UI_SCALE,
    enabledProviders: { claude: true,  ollama: true, codex: true,  llamacpp: true, lmstudio: true, strata: true, deepseek: true, cursor: true },
  };
}

// Sanitize untrusted workflowDefaults so a hand-edited settings.json or a
// stale client payload can't inject bogus enum values. Unknown fields are
// dropped silently; invalid enum values become undefined.
function sanitizeWorkflowDefaults(raw: unknown): WorkflowDefaults | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: WorkflowDefaults = {};
  // Accept either the new primary* keys or the legacy orchestrator* keys —
  // settings.json written by pre-Phase-8 builds uses the old names.
  const provider = r.primaryProvider ?? r.orchestratorProvider;
  const model = r.primaryModel ?? r.orchestratorModel;
  const effort = r.primaryEffort ?? r.orchestratorEffort;
  if (typeof provider === 'string' && ((ALL_PROVIDERS as string[]).includes(provider) || retiredProviderReason(provider))) {
    out.primaryProvider = provider as ProviderName;
  }
  // A removed provider's model must not become another provider's default.
  const unsupportedProvider = typeof provider === 'string' && !(ALL_PROVIDERS as string[]).includes(provider) && !retiredProviderReason(provider);
  if (!unsupportedProvider && typeof model === 'string' && model.length > 0) {
    out.primaryModel = model as WorkflowDefaults['primaryModel'];
  }
  if (typeof effort === 'string' && (EFFORT_LEVELS as string[]).includes(effort)) {
    out.primaryEffort = effort as EffortLevel;
  }
  if (typeof r.providerAccountRef === 'string' && r.providerAccountRef.trim().length > 0) {
    out.providerAccountRef = r.providerAccountRef.trim();
  }
  if (typeof r.skipPermissions === 'boolean') out.skipPermissions = r.skipPermissions;
  if (typeof r.fastMode === 'boolean') out.fastMode = r.fastMode;
  // Provider-supported efficiency/style defaults surfaced on the New-tab
  // picker. Stored even when the current default provider does not honor a
  // field so a later provider/transport flip can pick it up automatically.
  // 2026-05-10: legacy `'caveman'` aliased to `'terse'` on read so a
  // hand-edited settings.json from before the rename keeps working.
  if (r.efficiencyToolFilter === 'off' || r.efficiencyToolFilter === 'conservative' || r.efficiencyToolFilter === 'aggressive') {
    out.efficiencyToolFilter = r.efficiencyToolFilter;
  }
  if (r.outputStyle === 'normal' || r.outputStyle === 'lite' || r.outputStyle === 'terse') {
    out.outputStyle = r.outputStyle;
  } else if (r.outputStyle === 'caveman') {
    out.outputStyle = 'terse';
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

// docs/ARCHITECTURE.md - per-role fallback chains for bounded jobs.
// Hand-edited; lenient read (drop bogus legs, keep the good ones). A leg needs
// a valid provider + a non-empty model; effort / account fields are optional
// and pass through with light shape checks. An empty array survives so the
// operator can hold a chain with everything filtered out (the runner treats it
// as no-fallback). Capped at 8 legs/role — a chain longer than that is almost
// certainly a config mistake and we don't want to spawn dozens of legs.
function sanitizeFallbackLeg(raw: unknown): FallbackLegConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== 'string' || !(ALL_PROVIDERS as string[]).includes(r.provider) && !retiredProviderReason(r.provider)) return undefined;
  if (typeof r.model !== 'string' || r.model.trim().length === 0) return undefined;
  const leg: FallbackLegConfig = { provider: r.provider as ProviderName, model: r.model.trim() };
  if (typeof r.effort === 'string' && (EFFORT_LEVELS as string[]).includes(r.effort)) {
    leg.effort = r.effort as EffortLevel;
  }
  if (typeof r.providerAccountRef === 'string' && r.providerAccountRef.trim().length > 0) {
    leg.providerAccountRef = r.providerAccountRef.trim();
  }
  if (typeof r.codexHome === 'string' && r.codexHome.trim().length > 0) {
    leg.codexHome = r.codexHome.trim();
  }
  return leg;
}

function sanitizeFallbackLegArray(raw: unknown): FallbackLegConfig[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: FallbackLegConfig[] = [];
  for (const v of raw) {
    const leg = sanitizeFallbackLeg(v);
    if (leg) out.push(leg);
    if (out.length >= 8) break;
  }
  return out;
}

function sanitizeFallbackChains(raw: unknown): FallbackChainsConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: FallbackChainsConfig = {};
  for (const role of ['reviewer', 'research', 'seed'] as const) {
    const legs = sanitizeFallbackLegArray(r[role]);
    if (legs) out[role] = legs;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Theme id sanitizer. Lenient on read; strict on patch.
function sanitizeThemeId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return normalizeLegacyThemeId(raw);
}

// Frosted-glass override sanitizer. Only 'on'/'off' are valid; anything else
// (including absent) leaves it unset so the client follows the theme default.
function sanitizeFrostedOverride(raw: unknown): 'on' | 'off' | undefined {
  return raw === 'on' || raw === 'off' ? raw : undefined;
}

// Frosted-glass panel-opacity sanitizer. Clamp to a still-translucent range so
// a hand-edited settings.json can't make panels fully opaque (which defeats the
// blur) or invisibly thin. Absent / non-numeric leaves it unset (0.6 default).
function sanitizeFrostedOpacity(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(0.95, Math.max(0.3, raw));
}

// Global theme-brightness shift, in signed points. Clamped −100…100 and
// rounded (a generous safety bound; the UI sliders constrain each axis to its
// own range). 0 = no shift. Shared by bgBrightness + textBrightness.
// See ArcoSettings + client themes/apply.ts.
function sanitizeBrightness(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.round(Math.min(100, Math.max(-100, raw)));
}

// Font-pack id sanitizer. Same shape as theme id — lenient read, strict patch.
function sanitizeFontPackId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return (VALID_FONT_PACK_IDS as readonly string[]).includes(raw) ? raw : undefined;
}

// Operator name: trimmed, single-line, capped at 32 chars. Empty / whitespace
// reads as "unset" so the chat falls back to the default "OPERATOR" label.
function sanitizeOperatorName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 32);
  return cleaned.length > 0 ? cleaned : undefined;
}

// The working-directory selector's browser root. Must be a non-empty absolute
// path; anything else clears the browsing default.
// Deliberately NOT confined to $HOME — list-dirs browses anywhere already.
function sanitizeDefaultWorkingDirectory(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 1024);
  if (!cleaned || !path.isAbsolute(cleaned)) return undefined;
  return cleaned;
}

// Registered projects: absolute paths, de-duplicated, bounded. Order is the
// operator's; the list is replaced whole by a patch (the routes in
// http/projectRoutes.ts do the add/remove read-modify-write).
export function sanitizeProjects(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    const cleaned = sanitizeDefaultWorkingDirectory(entry);
    if (!cleaned) continue;
    const normalized = path.resolve(cleaned);
    if (!out.includes(normalized)) out.push(normalized);
    if (out.length >= 200) break;
  }
  return out;
}

// Named discovery roots use the same absolute-path policy as projects. Existing
// aliases collapse to their real path; missing mounts retain their normalized path.
export function sanitizeProjectRoots(raw: unknown): NonNullable<ArcoSettings['projectRoots']> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const roots: NonNullable<ArcoSettings['projectRoots']> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const clean = sanitizeDefaultWorkingDirectory(item.path);
    if (!clean) continue;
    let folder = path.resolve(clean);
    try { folder = realpathSync(folder); } catch { /* retain missing mounts */ }
    let homeFolder = path.resolve(homedir());
    try { homeFolder = realpathSync(homeFolder); } catch { /* retain missing home */ }
    if (folder === path.parse(folder).root || folder === homeFolder) continue;
    const key = process.platform === 'win32' ? folder.toLowerCase() : folder;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = typeof item.name === 'string' ? item.name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60) : '';
    roots.push({ name: name || path.basename(folder) || folder, path: folder });
    if (roots.length >= 32) break;
  }
  return roots;
}

// Explicit media folders are absolute, normalized, distinct and bounded.
function sanitizeMediaAllowedRoots(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    const cleaned = sanitizeDefaultWorkingDirectory(entry);
    if (!cleaned) continue;
    const normalized = path.resolve(cleaned);
    if (!out.includes(normalized)) out.push(normalized);
    if (out.length >= 32) break;
  }
  return out;
}

function sanitizeAcknowledgedCliVersions(raw: unknown): ArcoSettings['acknowledgedCliVersions'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: NonNullable<ArcoSettings['acknowledgedCliVersions']> = {};
  for (const p of ['claude',  'codex'] as const) {
    const v = r[p];
    if (typeof v === 'string' && v.length > 0) out[p] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

function sanitizeAccountBrowser(raw: unknown): ProviderAccountProfile['authBrowser'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.command !== 'string') return undefined;
  const command = r.command.trim();
  if (!command || command.length > 256 || /[\r\n]/.test(command)) return undefined;
  const args = Array.isArray(r.args)
    ? r.args
        .filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\r\n]/.test(v))
        .slice(0, 16)
    : undefined;
  return args && args.length > 0 ? { command, args } : { command };
}

function sanitizeAccountProfile(raw: unknown, provider: 'codex' | 'claude'): ProviderAccountProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!ACCOUNT_ID_PATTERN.test(id)) return null;
  const labelRaw = typeof r.label === 'string' ? r.label.trim().replace(/[\r\n\t]+/g, ' ') : id;
  const label = (labelRaw || id).slice(0, 32);
  const shortRaw = typeof r.shortLabel === 'string' ? r.shortLabel.trim().replace(/[\r\n\t]+/g, ' ') : '';
  const out: ProviderAccountProfile = {
    id,
    label,
    ...(shortRaw ? { shortLabel: shortRaw.slice(0, 4) } : {}),
  };
  if (provider === 'codex' && typeof r.codexHome === 'string') {
    const codexHome = r.codexHome.trim();
    if (codexHome && codexHome.length <= 512 && !/[\r\n]/.test(codexHome)) out.codexHome = codexHome;
  }
  const authBrowser = sanitizeAccountBrowser(r.authBrowser);
  if (authBrowser) out.authBrowser = authBrowser;
  return out;
}

function sanitizeProviderAccounts(raw: unknown): ProviderAccountsConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: ProviderAccountsConfig = {};
  for (const provider of ['codex', 'claude'] as const) {
    const arr = r[provider];
    if (!Array.isArray(arr)) continue;
    const seen = new Set<string>();
    const profiles: ProviderAccountProfile[] = [];
    for (const item of arr) {
      const profile = sanitizeAccountProfile(item, provider);
      if (!profile || seen.has(profile.id)) continue;
      seen.add(profile.id);
      profiles.push(profile);
      if (profiles.length >= 8) break;
    }
    if (profiles.length > 0) out[provider] = profiles;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Phase 2 placeholder-key sanitizers. Shape-check only; consumers ship in
// later phases. Pass-through preserves the value across read/patch cycles.
function sanitizeHandoffPromptPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeQueueMode(raw: unknown): 'visible' | 'hidden' | undefined {
  return raw === 'visible' || raw === 'hidden' ? raw : undefined;
}

// DD7 — user-scope default for repos with no recorded trust decision.
function sanitizeDefaultProjectTrust(raw: unknown): 'ask' | 'always' | 'never' | undefined {
  return raw === 'ask' || raw === 'always' || raw === 'never' ? raw : undefined;
}

function sanitizeSkillsExtraPaths(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

// Part N2 — Media Studio access fence. Boolean-only; anything else reads as
// undefined (the consumer treats undefined as open: `mediaUnconfined !== false`).
function sanitizeMediaUnconfined(raw: unknown): boolean | undefined {
  return typeof raw === 'boolean' ? raw : undefined;
}

function sanitizeClaudeConfig(raw: unknown): { transport?: 'cli' | 'native'; nativeWarningSeen?: boolean } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: { transport?: 'cli' | 'native'; nativeWarningSeen?: boolean } = {};
  if (r.transport === 'cli' || r.transport === 'native') out.transport = r.transport;
  // Phase 7a — first-time-enable warning seen flag. Boolean-only; absent
  // / truthy-but-non-boolean reads as undefined (next native enable shows
  // the warning).
  if (typeof r.nativeWarningSeen === 'boolean') out.nativeWarningSeen = r.nativeWarningSeen;
  return Object.keys(out).length > 0 ? out : undefined;
}

// Codex transport selector. 'exec' is the per-turn worker;
// 'appserver' opts into the long-lived `codex app-server` worker. Same
// pass-through shape as `claude.transport` (Phase 7); cascade-readable so
// `<cwd>/.arco/settings.json` can pin per-project.
function sanitizeCodexConfig(raw: unknown): { transport?: 'exec' | 'appserver'; appserverWarningSeen?: boolean } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: { transport?: 'exec' | 'appserver'; appserverWarningSeen?: boolean } = {};
  if (r.transport === 'exec' || r.transport === 'appserver') out.transport = r.transport;
  // Phase 6e — first-time-enable warning seen flag. Boolean-only; absent /
  // truthy-but-non-boolean reads as undefined (next appserver enable shows
  // the warning).
  if (typeof r.appserverWarningSeen === 'boolean') out.appserverWarningSeen = r.appserverWarningSeen;
  return Object.keys(out).length > 0 ? out : undefined;
}

// Global auto-handoff default. Mirrors the per-tab slider bounds in the
// CONFIG tab (warn 60–85, auto 75–95) so a hand-edited settings.json can't
// pin a threshold the UI can't represent. Each field is independent — a
// partial object (e.g. just `enabled: false`) is valid; missing fields fall
// through to the hardcoded default at seed time.
function sanitizeAutoHandoffDefaults(raw: unknown): { enabled?: boolean; warnAt?: number; autoAt?: number; mode?: 'original-worker' | 'fresh-summarizer' } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: { enabled?: boolean; warnAt?: number; autoAt?: number; mode?: 'original-worker' | 'fresh-summarizer' } = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (typeof r.warnAt === 'number' && Number.isFinite(r.warnAt)) {
    out.warnAt = Math.min(85, Math.max(60, Math.round(r.warnAt)));
  }
  if (typeof r.autoAt === 'number' && Number.isFinite(r.autoAt)) {
    out.autoAt = Math.min(95, Math.max(75, Math.round(r.autoAt)));
  }
  // WP5 — only the two literal modes pass; anything else is dropped so a
  // hand-edited settings.json can't smuggle an invalid mode into resolution.
  if (r.mode === 'original-worker' || r.mode === 'fresh-summarizer') out.mode = r.mode;
  return Object.keys(out).length > 0 ? out : undefined;
}

// Global default for Claude Native's Anthropic server-side compaction beta on
// newly-created tabs. A plain boolean — defaults OFF when absent/invalid so a
// hand-edited settings.json can't accidentally re-enable the mid-turn eviction
// path (NATIVE_COMPACTION_PLAN §1). Per-tab config.claudeNativeCompact wins.
function sanitizeClaudeNativeCompactDefault(raw: unknown): boolean | undefined {
  return typeof raw === 'boolean' ? raw : undefined;
}

// WP2 — global default fresh-summarizer config. A handoff fires when the
// current worker is degraded (low on context), so summarizing with that same
// worker is the failure mode; this lets the operator pin a STRONG fresh agent
// to write the handoff instead. `provider` is required (drop the whole thing
// if it's missing/invalid — mirrors sanitizeAutoHandoffDefaults' all-or-
// nothing strictness on its required shape); `model`/`effort` are optional and
// pass through with light shape checks (the resolver fills them from the tab's
// primary when absent).
function sanitizeHandoffSummarizer(raw: unknown): { provider: ProviderName; model?: ModelName; effort?: EffortLevel } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== 'string' || !(ALL_PROVIDERS as string[]).includes(r.provider) && !retiredProviderReason(r.provider)) return undefined;
  const out: { provider: ProviderName; model?: ModelName; effort?: EffortLevel } = { provider: r.provider as ProviderName };
  if (typeof r.model === 'string' && r.model.trim().length > 0) {
    out.model = r.model.trim() as ModelName;
  }
  if (typeof r.effort === 'string' && (EFFORT_LEVELS as string[]).includes(r.effort)) {
    out.effort = r.effort as EffortLevel;
  }
  return out;
}

// M4 — sanitize one backend descriptor. baseUrl is required + URL-shaped;
// weight (positive number), enable (boolean), label (string), tailscaleHost
// (string) are optional. A malformed entry is dropped wholesale rather than
// half-accepted, so a hand-edited settings.json can't smuggle a bogus backend.
function sanitizeOllamaBackend(raw: unknown): OllamaBackendConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.baseUrl !== 'string') return undefined;
  const baseUrl = r.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+(?::\d+)?$/.test(baseUrl)) return undefined;
  const out: OllamaBackendConfig = { baseUrl };
  if (typeof r.weight === 'number' && Number.isFinite(r.weight) && r.weight > 0) out.weight = r.weight;
  if (typeof r.enable === 'boolean') out.enable = r.enable;
  if (typeof r.label === 'string' && r.label.trim().length > 0) out.label = r.label.trim().slice(0, 48);
  if (typeof r.tailscaleHost === 'string' && r.tailscaleHost.trim().length > 0) {
    out.tailscaleHost = r.tailscaleHost.trim().slice(0, 128);
  }
  return out;
}

// M4 — model→host affinity hint. A map of model-name (or substring) → backend
// labels. Drop non-string keys, non-array values, and non-string label
// entries. Capped at 64 models / 8 labels each — a map larger than that is a
// config mistake. Empty after filtering ⇒ undefined (no hint).
function sanitizeModelHostMap(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string[]> = {};
  let count = 0;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= 64) break;
    if (typeof key !== 'string' || key.trim().length === 0) continue;
    if (!Array.isArray(val)) continue;
    const labels = val
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim().slice(0, 48))
      .slice(0, 8);
    if (labels.length === 0) continue;
    out[key.trim().slice(0, 128)] = labels;
    count++;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// M7 — the utility / task model config. `model` is the cheap small-model alias;
// `baseUrl` optionally pins it to a dedicated backend. A missing/blank model
// drops the whole config (the default-OFF state) so a hand-edited
// `utility: {}` can't half-arm it.
function sanitizeOllamaUtility(raw: unknown): OllamaUtilityConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.model !== 'string') return undefined;
  const model = r.model.trim();
  if (!model) return undefined;
  const out: OllamaUtilityConfig = { model: model.slice(0, 128) };
  if (typeof r.baseUrl === 'string') {
    const trimmed = r.baseUrl.trim().replace(/\/+$/, '');
    if (/^https?:\/\/[^/\s]+(?::\d+)?$/.test(trimmed)) out.baseUrl = trimmed;
  }
  if (r.titles === true) out.titles = true;
  if (r.enabled === false) out.enabled = false;
  return out;
}

// WP3 — operator-facing M8 auto-compaction knobs. Clamps to the SAME bounds
// the env parser uses in ollamaRecovery.defaultCompactionConfig, dropping
// out-of-range/invalid fields rather than failing (a half-valid object still
// contributes its good fields; the rest fall through to env→hardcoded). An
// empty object after filtering ⇒ undefined.
function sanitizeOllamaCompaction(raw: unknown): OllamaCompactionConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: OllamaCompactionConfig = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  const clampFloat = (v: unknown, min: number, max: number): number | undefined => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return undefined;
    return v;
  };
  const clampInt = (v: unknown, min: number, max: number): number | undefined => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return undefined;
    return v;
  };
  const threshold = clampFloat(r.threshold, 0.5, 0.99);
  if (threshold !== undefined) out.threshold = threshold;
  const warn = clampFloat(r.warn, 0.4, 0.98);
  if (warn !== undefined) out.warn = warn;
  const keepLast = clampInt(r.keepLast, 2, 100);
  if (keepLast !== undefined) out.keepLast = keepLast;
  const maxRecoveries = clampInt(r.maxRecoveries, 0, 10);
  if (maxRecoveries !== undefined) out.maxRecoveries = maxRecoveries;
  const summaryTokens = clampInt(r.summaryTokens, 128, 4096);
  if (summaryTokens !== undefined) out.summaryTokens = summaryTokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

// M13 — LM Studio config. Unlike Ollama's baseUrl (host:port only), LM Studio's
// OpenAI-compatible REST surface lives under a path (/v1), so the regex allows
// an optional path segment. The provider's normalizeBase() appends /v1 when
// absent, so a bare "http://host:1234" is also accepted and upgraded at use.
// DD12 — accept either a literal URL (slash-normalized) or an UNRESOLVED
// `!cmd` / `${ENV}` ref (kept raw; resolved + URL-validated by the consumer at
// use time). Anything else is dropped.
function sanitizeBaseUrlOrRef(raw: string, urlRe: RegExp): string | undefined {
  const trimmedRaw = raw.trim();
  if (!trimmedRaw) return undefined;
  const noSlash = trimmedRaw.replace(/\/+$/, '');
  if (urlRe.test(noSlash)) return noSlash;
  const kind = describeConfigValue(trimmedRaw).kind;
  return kind === 'command' || kind === 'env' ? trimmedRaw : undefined;
}

function sanitizeLmstudioConfig(raw: unknown): { baseUrl?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: { baseUrl?: string } = {};
  if (typeof r.baseUrl === 'string') {
    const v = sanitizeBaseUrlOrRef(r.baseUrl, /^https?:\/\/[^/\s]+(?::\d+)?(?:\/[^\s]*)?$/);
    if (v) out.baseUrl = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeOllamaConfig(raw: unknown): { baseUrl?: string; backends?: OllamaBackendConfig[]; modelHostMap?: Record<string, string[]>; utility?: OllamaUtilityConfig; compaction?: OllamaCompactionConfig } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: { baseUrl?: string; backends?: OllamaBackendConfig[]; modelHostMap?: Record<string, string[]>; utility?: OllamaUtilityConfig; compaction?: OllamaCompactionConfig } = {};
  if (typeof r.baseUrl === 'string') {
    const v = sanitizeBaseUrlOrRef(r.baseUrl, /^https?:\/\/[^/\s]+(?::\d+)?$/);
    if (v) out.baseUrl = v;
  }
  if (Array.isArray(r.backends)) {
    const backends: OllamaBackendConfig[] = [];
    const seen = new Set<string>();
    for (const b of r.backends) {
      const sanitized = sanitizeOllamaBackend(b);
      // De-dup on baseUrl so a doubled entry doesn't double a host's weight.
      if (sanitized && !seen.has(sanitized.baseUrl)) {
        seen.add(sanitized.baseUrl);
        backends.push(sanitized);
      }
      if (backends.length >= 16) break; // 16 local Ollama daemons is absurd; cap defensively
    }
    if (backends.length > 0) out.backends = backends;
  }
  const modelHostMap = sanitizeModelHostMap(r.modelHostMap);
  if (modelHostMap) out.modelHostMap = modelHostMap;
  const utility = sanitizeOllamaUtility(r.utility);
  if (utility) out.utility = utility;
  const compaction = sanitizeOllamaCompaction(r.compaction);
  if (compaction) out.compaction = compaction;
  return Object.keys(out).length > 0 ? out : undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge: objects merge recursively, arrays replace, scalars replace.
// Only iterates own enumerable string keys. Returns a fresh object.
function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) continue;
    const prev = out[k];
    if (isPlainObject(v) && isPlainObject(prev)) {
      out[k] = deepMerge(prev, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function readJsonFile(p: string, label: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    console.error(`[arco] ${label} settings.json malformed; ignoring:`, err instanceof Error ? err.message : err);
    return {};
  }
}

function projectSettingsPath(cwd: string): string {
  return path.join(cwd, PROJECT_SETTINGS_DIRNAME, PROJECT_SETTINGS_BASENAME);
}

function mergeWithDefaults(partial: Record<string, unknown>): ArcoSettings {
  const base = defaults();
  const enabled: ArcoSettings['enabledProviders'] = { ...base.enabledProviders };
  const ep = partial.enabledProviders;
  if (ep && typeof ep === 'object') {
    for (const key of ALL_PROVIDERS) {
      const v = (ep as Record<string, unknown>)[key];
      if (typeof v === 'boolean') enabled[key] = v;
    }
  }
  const result: ArcoSettings = { enabledProviders: enabled, fontPackOverride: base.fontPackOverride };
  result.uiScale = normalizeUiScale(partial.uiScale);
  const wd = sanitizeWorkflowDefaults(partial.workflowDefaults);
  if (wd) result.workflowDefaults = wd;
  const providerAccounts = sanitizeProviderAccounts(partial.providerAccounts);
  if (providerAccounts) result.providerAccounts = providerAccounts;
  const theme = sanitizeThemeId(partial.themeId);
  if (theme !== undefined) result.themeId = theme;
  const ack = sanitizeAcknowledgedCliVersions(partial.acknowledgedCliVersions);
  if (ack) result.acknowledgedCliVersions = ack;
  const opName = sanitizeOperatorName(partial.operatorName);
  if (opName) result.operatorName = opName;
  const projects = sanitizeProjects(partial.projects);
  result.updateCheck = partial.updateCheck !== false;
  if (typeof partial.updateCheckDismissed === 'string' && /^v[0-9A-Za-z.+-]{1,100}$/.test(partial.updateCheckDismissed)) result.updateCheckDismissed = partial.updateCheckDismissed;
  if (partial.providerConfirmed === true) result.providerConfirmed = true;
  if (partial.onboardingComplete === true) result.onboardingComplete = true;
  if (projects?.length) result.projects = projects;
  const defaultWd = sanitizeDefaultWorkingDirectory(partial.defaultWorkingDirectory);
  if (defaultWd) result.defaultWorkingDirectory = defaultWd;
  const roots = sanitizeProjectRoots(partial.projectRoots);
  if (roots !== undefined) result.projectRoots = roots;
  else if (defaultWd) result.projectRoots = sanitizeProjectRoots([{ name: path.basename(defaultWd), path: defaultWd }]);
  const fontPack = sanitizeFontPackId(partial.fontPackOverride);
  if (partial.fontPackOverride === null) result.fontPackOverride = null;
  else if (fontPack !== undefined) result.fontPackOverride = fontPack;
  const frosted = sanitizeFrostedOverride(partial.frostedOverride);
  if (frosted !== undefined) result.frostedOverride = frosted;
  const frostedOpacity = sanitizeFrostedOpacity(partial.frostedOpacity);
  if (frostedOpacity !== undefined) result.frostedOpacity = frostedOpacity;
  const bgBrightness = sanitizeBrightness(partial.bgBrightness);
  if (bgBrightness !== undefined) result.bgBrightness = bgBrightness;
  const textBrightness = sanitizeBrightness(partial.textBrightness);
  result.textBrightness = textBrightness ?? base.textBrightness;
  if (typeof partial.crispText === 'boolean') result.crispText = partial.crispText;
  if (typeof partial.phosphorEffects === 'boolean') result.phosphorEffects = partial.phosphorEffects;
  if (typeof partial.phosphorSoftness === 'number' && Number.isFinite(partial.phosphorSoftness)) result.phosphorSoftness = Math.min(100, Math.max(0, partial.phosphorSoftness));
  const handoffPromptPath = sanitizeHandoffPromptPath(partial.handoffPromptPath);
  if (handoffPromptPath) result.handoffPromptPath = handoffPromptPath;
  const queueMode = sanitizeQueueMode(partial.queueMode);
  if (queueMode) result.queueMode = queueMode;
  const skillsExtraPaths = sanitizeSkillsExtraPaths(partial.skillsExtraPaths);
  if (skillsExtraPaths) result.skillsExtraPaths = skillsExtraPaths;
  const mediaUnconfined = sanitizeMediaUnconfined(partial.mediaUnconfined);
  if (mediaUnconfined !== undefined) result.mediaUnconfined = mediaUnconfined;
  const mediaAllowedRoots = sanitizeMediaAllowedRoots(partial.mediaAllowedRoots);
  if (mediaAllowedRoots) result.mediaAllowedRoots = mediaAllowedRoots;
  const claude = sanitizeClaudeConfig(partial.claude);
  result.claude = { ...base.claude, ...claude };
  const codex = sanitizeCodexConfig(partial.codex);
  result.codex = { ...base.codex, ...codex };

  const autoHandoffDefaults = sanitizeAutoHandoffDefaults(partial.autoHandoffDefaults);
  if (autoHandoffDefaults) result.autoHandoffDefaults = autoHandoffDefaults;
  const claudeNativeCompactDefault = sanitizeClaudeNativeCompactDefault(partial.claudeNativeCompactDefault);
  if (claudeNativeCompactDefault !== undefined) result.claudeNativeCompactDefault = claudeNativeCompactDefault;
  const handoffSummarizer = sanitizeHandoffSummarizer(partial.handoffSummarizer);
  if (handoffSummarizer) result.handoffSummarizer = handoffSummarizer;
  const ollama = sanitizeOllamaConfig(partial.ollama);
  if (ollama) result.ollama = ollama;
  const lmstudio = sanitizeLmstudioConfig(partial.lmstudio);
  if (lmstudio) result.lmstudio = lmstudio;
  const strata = sanitizeLmstudioConfig(partial.strata);
  if (strata) result.strata = strata;
  const deepseek = sanitizeLmstudioConfig(partial.deepseek);
  if (deepseek) result.deepseek = deepseek;
  const tabOrder = sanitizeTabOrder(partial.tabOrder);
  if (tabOrder) result.tabOrder = tabOrder;
  const pinnedServices = sanitizePinnedServices(partial.pinnedServices);
  if (pinnedServices) result.pinnedServices = pinnedServices;
  const fallbackChains = sanitizeFallbackChains(partial.fallbackChains);
  if (fallbackChains) result.fallbackChains = fallbackChains;
  const defaultProjectTrust = sanitizeDefaultProjectTrust(partial.defaultProjectTrust);
  if (defaultProjectTrust) result.defaultProjectTrust = defaultProjectTrust;
  return result;
}

// Slice 6a — operator-preferred top-row tab order. Holds workflowIds AND
// clusterIds. Cap at 256 entries to keep the round-trip cheap; drop unknown
// types defensively.
function sanitizeTabOrder(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed || trimmed.length > 64) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 256) break;
  }
  return out.length > 0 ? out : undefined;
}

// Ops L2 — operator-pinned local services. Machine-level inventory keyed by a
// stable (cwd, port) identity. Lenient read: drop any entry lacking a finite
// integer `port` or a finite `pinnedAt`; `cwd` may be a string or null
// (defensively coerce other types to null). Capped at 100 entries — a pin list
// longer than that is almost certainly a mistake and we don't want it to bloat
// the round-trip. The array REPLACES wholesale on patch (a sequence, not a
// deep-merged map), so the client always sends the full new list.
function sanitizePinnedServices(raw: unknown): PinnedService[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PinnedService[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    if (typeof r.port !== 'number' || !Number.isInteger(r.port)) continue;
    if (typeof r.pinnedAt !== 'number' || !Number.isFinite(r.pinnedAt)) continue;
    const cwd = typeof r.cwd === 'string' ? r.cwd : null;
    // Dedup on the (cwd, port) identity — a double-pin is a no-op.
    const key = `${cwd ?? ''}|${r.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ cwd, port: r.port, pinnedAt: r.pinnedAt });
    if (out.length >= 100) break;
  }
  return out.length > 0 ? out : undefined;
}

// Read effective settings. With no cwd argument, returns the global cascade
// (defaults → global). With a cwd, layers <cwd>/.arco/settings.json on top
// before sanitization. Project-only overrides for nested objects merge key-
// by-key with global; arrays replace.
export async function readSettings(
  cwd?: string,
  opts?: { includeProject?: boolean },
): Promise<ArcoSettings> {
  const global = await readJsonFile(GLOBAL_SETTINGS_PATH, 'global');
  if (!cwd) return mergeWithDefaults(global);
  // DD7 — turn-path callers pass `includeProject: false` for an untrusted repo
  // so a cloned `.arco/settings.json` can't pin transport / skillsExtraPaths /
  // handoffPromptPath into the model turn. Default true preserves every other
  // caller (UI reads, etc.). The trust decision itself is resolved upstream from
  // global scope only, so this never recurses.
  if (opts?.includeProject === false) return mergeWithDefaults(global);
  const project = await readJsonFile(projectSettingsPath(cwd), 'project');
  const merged = deepMerge(global, project);
  return mergeWithDefaults(merged);
}

export async function writeSettings(next: ArcoSettings): Promise<void> {
  await atomicWriteFile(GLOBAL_SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n');
}

// Read-modify-write over one global file. MUST run under the settings file
// lock — see `patchSettings` below.
async function patchSettingsUnlocked(patch: Partial<ArcoSettings>): Promise<ArcoSettings> {
  // Patches always target the global file. Project-level settings are hand-
  // edited (Phase 2 has no UI for them); the cascade reader picks up edits
  // via fs.watch HMR.
  const current = await readSettings();
  const merged: ArcoSettings = {
    enabledProviders: {
      ...current.enabledProviders,
      ...(patch.enabledProviders ?? {}),
    },
  };
  merged.updateCheck = typeof patch.updateCheck === 'boolean' ? patch.updateCheck : current.updateCheck !== false;
  merged.updateCheckDismissed = typeof patch.updateCheckDismissed === 'string' && /^v[0-9A-Za-z.+-]{1,100}$/.test(patch.updateCheckDismissed) ? patch.updateCheckDismissed : current.updateCheckDismissed;
  if (patch.providerConfirmed === true || current.providerConfirmed === true) merged.providerConfirmed = true;
  if (patch.onboardingComplete === true || current.onboardingComplete === true) merged.onboardingComplete = true;
  if (patch.workflowDefaults !== undefined) {
    const sanitized = sanitizeWorkflowDefaults(patch.workflowDefaults);
    if (sanitized) merged.workflowDefaults = sanitized;
  } else if (current.workflowDefaults) {
    merged.workflowDefaults = current.workflowDefaults;
  }
  if ('providerAccounts' in patch) {
    const sanitized = sanitizeProviderAccounts(patch.providerAccounts);
    if (sanitized) merged.providerAccounts = sanitized;
  } else if (current.providerAccounts) {
    merged.providerAccounts = current.providerAccounts;
  }
  if ('themeId' in patch) {
    if (patch.themeId === null || patch.themeId === undefined) {
      // Cleared — leave unset so the client falls back to DEFAULT_THEME_ID.
    } else if (typeof patch.themeId !== 'string'
        || !(VALID_THEME_IDS as readonly string[]).includes(patch.themeId)) {
      throw new Error(`invalid themeId: ${String(patch.themeId)}`);
    } else {
      merged.themeId = patch.themeId;
    }
  } else if (current.themeId !== undefined) {
    merged.themeId = current.themeId;
  }
  if ('acknowledgedCliVersions' in patch) {
    const sanitized = sanitizeAcknowledgedCliVersions(patch.acknowledgedCliVersions);
    const next = { ...(current.acknowledgedCliVersions ?? {}), ...(sanitized ?? {}) };
    if (Object.keys(next).length > 0) merged.acknowledgedCliVersions = next;
  } else if (current.acknowledgedCliVersions) {
    merged.acknowledgedCliVersions = current.acknowledgedCliVersions;
  }
  if ('operatorName' in patch) {
    const opName = sanitizeOperatorName(patch.operatorName);
    if (opName) merged.operatorName = opName;
    // empty / whitespace clears the field
  } else if (current.operatorName) {
    merged.operatorName = current.operatorName;
  }
  if ('projects' in patch) {
    const projects = sanitizeProjects(patch.projects);
    if (projects && projects.length > 0) merged.projects = projects;
    // null / empty list clears the registry
  } else if (current.projects && current.projects.length > 0) {
    merged.projects = current.projects;
  }
  // Snapshot the migrated legacy roots before changing the browsing default.
  // Explicit [] survives every later patch and never resurrects the legacy root.
  if ('projectRoots' in patch) {
    if (!Array.isArray(patch.projectRoots) || patch.projectRoots.some(root => !root || !sanitizeProjectRoots([root])?.length)) {
      throw new Error('project locations require absolute folder paths below the filesystem and home roots');
    }
    const canonical = patch.projectRoots.map(root => sanitizeProjectRoots([root])![0].path);
    const seen = new Set<string>();
    for (const folder of canonical) {
      const key = process.platform === 'win32' ? folder.toLowerCase() : folder;
      if (seen.has(key)) throw new Error('A project location already uses this folder. Edit that location instead; no locations were changed.');
      seen.add(key);
    }
  }
  merged.projectRoots = 'projectRoots' in patch ? sanitizeProjectRoots(patch.projectRoots) ?? [] : current.projectRoots ?? [];
  if ('defaultWorkingDirectory' in patch) {
    const d = sanitizeDefaultWorkingDirectory(patch.defaultWorkingDirectory);
    if (d) merged.defaultWorkingDirectory = d;
    // empty / non-absolute clears the field
  } else if (current.defaultWorkingDirectory) {
    merged.defaultWorkingDirectory = current.defaultWorkingDirectory;
  }
  if ('uiScale' in patch) {
    if (typeof patch.uiScale !== 'number' || !Number.isFinite(patch.uiScale)) throw new Error('invalid uiScale');
    merged.uiScale = normalizeUiScale(patch.uiScale);
  } else {
    merged.uiScale = current.uiScale;
  }
  if ('fontPackOverride' in patch) {
    if (patch.fontPackOverride === null || patch.fontPackOverride === undefined) {
      // Persist an explicit theme-default choice separately from a missing setting.
      merged.fontPackOverride = null;
    } else if (typeof patch.fontPackOverride !== 'string'
        || !(VALID_FONT_PACK_IDS as readonly string[]).includes(patch.fontPackOverride)) {
      throw new Error(`invalid fontPackOverride: ${String(patch.fontPackOverride)}`);
    } else {
      merged.fontPackOverride = patch.fontPackOverride;
    }
  } else if (current.fontPackOverride !== undefined) {
    merged.fontPackOverride = current.fontPackOverride;
  }
  if ('frostedOverride' in patch) {
    if (patch.frostedOverride === null || patch.frostedOverride === undefined) {
      // explicit clear — leave unset so the client follows the theme default
    } else if (patch.frostedOverride !== 'on' && patch.frostedOverride !== 'off') {
      throw new Error(`invalid frostedOverride: ${String(patch.frostedOverride)}`);
    } else {
      merged.frostedOverride = patch.frostedOverride;
    }
  } else if (current.frostedOverride !== undefined) {
    merged.frostedOverride = current.frostedOverride;
  }
  if ('frostedOpacity' in patch) {
    if (patch.frostedOpacity === null || patch.frostedOpacity === undefined) {
      // explicit clear — fall back to the built-in 0.6 default
    } else {
      const v = sanitizeFrostedOpacity(patch.frostedOpacity);
      if (v === undefined) throw new Error(`invalid frostedOpacity: ${String(patch.frostedOpacity)}`);
      merged.frostedOpacity = v;
    }
  } else if (current.frostedOpacity !== undefined) {
    merged.frostedOpacity = current.frostedOpacity;
  }
  for (const key of ['bgBrightness', 'textBrightness'] as const) {
    if (key in patch) {
      if (patch[key] === null || patch[key] === undefined) {
        // explicit clear — fall back to 0 (no shift)
      } else {
        const v = sanitizeBrightness(patch[key]);
        if (v === undefined) throw new Error(`invalid ${key}: ${String(patch[key])}`);
        merged[key] = v;
      }
    } else if (current[key] !== undefined) {
      merged[key] = current[key];
    }
  }
  for (const key of ['phosphorEffects', 'phosphorSoftness'] as const) {
    if (key in patch) {
      const v = patch[key];
      if (v === null || v === undefined) continue;
      if (key === 'phosphorEffects' && typeof v === 'boolean') merged.phosphorEffects = v;
      else if (key === 'phosphorSoftness' && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) merged.phosphorSoftness = v;
      else throw new Error(`invalid ${key}: ${String(v)}`);
    } else if (key === 'phosphorEffects' && current.phosphorEffects !== undefined) merged.phosphorEffects = current.phosphorEffects;
    else if (key === 'phosphorSoftness' && current.phosphorSoftness !== undefined) merged.phosphorSoftness = current.phosphorSoftness;
  }
  if ('crispText' in patch) {
    if (typeof patch.crispText === 'boolean') {
      merged.crispText = patch.crispText;
    } else if (patch.crispText !== null && patch.crispText !== undefined) {
      throw new Error(`invalid crispText: ${String(patch.crispText)}`);
    }
    // null/undefined = explicit clear → leave unset (falls back to false)
  } else if (current.crispText !== undefined) {
    merged.crispText = current.crispText;
  }
  // Phase 2 placeholder keys: pass through whatever's already on disk so a
  // POST /api/settings (which only patches UI-managed fields today) doesn't
  // accidentally drop a hand-edited value.
  if (current.handoffPromptPath) merged.handoffPromptPath = current.handoffPromptPath;
  if (current.queueMode) merged.queueMode = current.queueMode;
  if (current.skillsExtraPaths) merged.skillsExtraPaths = current.skillsExtraPaths;
  // Part N2 — media access fence. The Settings toggle writes a boolean here;
  // an absent key passes through whatever's on disk (so an unrelated patch
  // doesn't flip the fence). The field is OMITTED when open (undefined ⇒ open),
  // so the toggle only persists the explicit `false` (locked) state.
  if ('mediaUnconfined' in patch) {
    const v = sanitizeMediaUnconfined(patch.mediaUnconfined);
    if (v !== undefined) merged.mediaUnconfined = v;
  } else if (current.mediaUnconfined !== undefined) {
    merged.mediaUnconfined = current.mediaUnconfined;
  }
  if ('mediaAllowedRoots' in patch) {
    merged.mediaAllowedRoots = sanitizeMediaAllowedRoots(patch.mediaAllowedRoots) ?? [];
  } else if (current.mediaAllowedRoots) {
    merged.mediaAllowedRoots = current.mediaAllowedRoots;
  }

  // §C2 — fallback chains are hand-edited only (no UI patches them in C2);
  // pass through whatever's on disk so a UI-driven POST /api/settings doesn't
  // drop the operator's chains.
  if (current.fallbackChains) merged.fallbackChains = current.fallbackChains;
  // Phase 7a — claude sub-config: patch keys merge over current; absent
  // keys pass through. Sanitizer drops invalid values silently. The
  // TRANSPORT DEFAULTS row + CONFIG-tab toggle write through here.
  if ('claude' in patch) {
    const sanitizedPatch = sanitizeClaudeConfig(patch.claude) ?? {};
    const next = { ...(current.claude ?? {}), ...sanitizedPatch };
    if (Object.keys(next).length > 0) merged.claude = next;
  } else if (current.claude) {
    merged.claude = current.claude;
  }
  // Phase 6e — codex sub-config: patch keys merge over current; absent keys
  // pass through. Sanitizer drops invalid values silently. The CONFIG-tab
  // toggle writes to `codex.appserverWarningSeen` (boolean) here.
  if ('codex' in patch) {
    const sanitizedPatch = sanitizeCodexConfig(patch.codex) ?? {};
    const next = { ...(current.codex ?? {}), ...sanitizedPatch };
    if (Object.keys(next).length > 0) merged.codex = next;
  } else if (current.codex) {
    merged.codex = current.codex;
  }
  // Global auto-handoff default. Patch keys merge over current; absent keys
  // pass through. The AUTO-HANDOFF DEFAULTS section in SettingsPanel writes
  // here. A `null` field on a patch object survives sanitize-as-undefined and
  // is dropped by the merge, so the operator can't half-clear it — they POST
  // the full {enabled,warnAt,autoAt} they want.
  if ('autoHandoffDefaults' in patch) {
    const sanitizedPatch = sanitizeAutoHandoffDefaults(patch.autoHandoffDefaults) ?? {};
    const next = { ...(current.autoHandoffDefaults ?? {}), ...sanitizedPatch };
    if (Object.keys(next).length > 0) merged.autoHandoffDefaults = next;
  } else if (current.autoHandoffDefaults) {
    merged.autoHandoffDefaults = current.autoHandoffDefaults;
  }
  // Global Claude Native server-side-compaction default. Plain boolean: a
  // sanitized patch value replaces current; an invalid patch value clears it
  // (back to the hardcoded OFF fallback). Absent from patch ⇒ pass through.
  if ('claudeNativeCompactDefault' in patch) {
    const sanitized = sanitizeClaudeNativeCompactDefault(patch.claudeNativeCompactDefault);
    if (sanitized !== undefined) merged.claudeNativeCompactDefault = sanitized;
  } else if (current.claudeNativeCompactDefault !== undefined) {
    merged.claudeNativeCompactDefault = current.claudeNativeCompactDefault;
  }
  // WP2 — global fresh-summarizer default. Patch keys merge over current, then
  // the combined object is re-sanitized so a patch that drops `provider` (or
  // pins a bogus one) can't half-arm the setting. `model`/`effort` are optional,
  // so a provider-only patch is a valid full state.
  if ('handoffSummarizer' in patch) {
    // WP5 — an explicit `null` clears the pin (falls back to the tab's primary).
    // Otherwise patch keys merge over current, then re-sanitize so a dropped /
    // bogus provider can't half-arm it.
    if (patch.handoffSummarizer === null) {
      // leave merged.handoffSummarizer unset → cleared
    } else {
      const next = { ...(current.handoffSummarizer ?? {}), ...(patch.handoffSummarizer ?? {}) };
      const sanitized = sanitizeHandoffSummarizer(next);
      if (sanitized) merged.handoffSummarizer = sanitized;
    }
  } else if (current.handoffSummarizer) {
    merged.handoffSummarizer = current.handoffSummarizer;
  }
  if ('ollama' in patch) {
    const sanitizedPatch = sanitizeOllamaConfig(patch.ollama) ?? {};
    const next = { ...(current.ollama ?? {}), ...sanitizedPatch };
    // Explicit `null` on a sub-key clears it: the sanitizer drops nulls and a
    // shallow merge can't delete by omission, so the UI sends e.g.
    // `{ ollama: { utility: null } }` to reset the compaction utility model
    // back to the deterministic-digest default.
    const po = patch.ollama;
    if (po && typeof po === 'object' && (po as Record<string, unknown>).utility === null) {
      delete next.utility;
    }
    if (Object.keys(next).length > 0) merged.ollama = next;
  } else if (current.ollama) {
    merged.ollama = current.ollama;
  }
  // An empty Strata patch resets the endpoint to its env/default cascade.
  if ('deepseek' in patch) merged.deepseek = sanitizeLmstudioConfig(patch.deepseek) ?? {};
  if ('strata' in patch) {
    merged.strata = sanitizeLmstudioConfig(patch.strata) ?? {};
  }
  // M13 — LM Studio config. Same merge semantics as ollama: a patch of
  // `{ lmstudio: {} }` clears the configured baseUrl (so the SettingsPanel can
  // reset to the env/localhost default), a patch with a baseUrl overrides it.
  if ('lmstudio' in patch) {
    const sanitizedPatch = sanitizeLmstudioConfig(patch.lmstudio) ?? {};
    const next = { ...(current.lmstudio ?? {}), ...sanitizedPatch };
    if (Object.keys(next).length > 0) merged.lmstudio = next;
  } else if (current.lmstudio) {
    merged.lmstudio = current.lmstudio;
  }
  // Slice 6a — tab order. PATCH overrides the previous list outright (it's a
  // sequence, not a key/value map). Empty array clears.
  if ('tabOrder' in patch) {
    const sanitized = sanitizeTabOrder(patch.tabOrder);
    if (sanitized) merged.tabOrder = sanitized;
  } else if (current.tabOrder) {
    merged.tabOrder = current.tabOrder;
  }
  // Ops L2 — pinned services. PATCH replaces the previous list outright (it's a
  // machine-level inventory the client owns end-to-end; it sends the full new
  // array on each pin/unpin). An empty array clears all pins.
  if ('pinnedServices' in patch) {
    const sanitized = sanitizePinnedServices(patch.pinnedServices);
    if (sanitized) merged.pinnedServices = sanitized;
  } else if (current.pinnedServices) {
    merged.pinnedServices = current.pinnedServices;
  }
  await writeSettings(merged);
  return merged;
}

// Serialized read-modify-write. Without the lock, two in-flight patches both
// read the pre-patch file and the second write silently drops the first one's
// mutation — reachable from two ConfigTab toggles in quick succession, or two
// browser tabs saving at once (the atomic write itself can't prevent this;
// only ordering can). See atomicFile.ts § withFileLock.
export function patchSettings(patch: Partial<ArcoSettings>): Promise<ArcoSettings> {
  return withFileLock(GLOBAL_SETTINGS_PATH, () => patchSettingsUnlocked(patch));
}

// ── Watchers (HMR) ───────────────────────────────────────────────────────
//
// One global watcher and one per-cwd project watcher. Both watch the parent
// directory (atomic rename writers replace the inode, breaking file-level
// watchers); we filter by basename. Debounced 200ms — Linux fires multiple
// events per save and atomic writers add temp-file events.

type SettingsChangeKind = 'global' | 'project';
type SettingsChangeListener = (kind: SettingsChangeKind, cwd?: string) => void;

const listeners = new Set<SettingsChangeListener>();

export function onSettingsChange(listener: SettingsChangeListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function fire(kind: SettingsChangeKind, cwd?: string): void {
  for (const l of listeners) {
    try { l(kind, cwd); } catch (err) { console.error('[arco] settings listener threw:', err); }
  }
}

let globalWatcher: FSWatcher | null = null;
let globalDebounce: NodeJS.Timeout | null = null;

export function installGlobalSettingsWatcher(): void {
  if (globalWatcher) return;
  try { mkdirSync(GLOBAL_SETTINGS_DIR, { recursive: true }); } catch { /* swallow; watch will surface */ }
  try {
    globalWatcher = fsWatch(GLOBAL_SETTINGS_DIR, { persistent: false }, (_event, filename) => {
      if (filename !== GLOBAL_SETTINGS_BASENAME) return;
      if (globalDebounce) clearTimeout(globalDebounce);
      globalDebounce = setTimeout(() => { globalDebounce = null; fire('global'); }, 200);
    });
    globalWatcher.on('error', (err) => {
      console.error('[arco] global settings watcher error:', err);
    });
  } catch (err) {
    console.error('[arco] global settings watcher start failed:', err);
  }
}

interface ProjectWatcher {
  watcher: FSWatcher;
  refCount: number;
  debounce: NodeJS.Timeout | null;
}
const projectWatchers = new Map<string, ProjectWatcher>();

// Acquire a watcher for <cwd>/.arco/. Ref-counted: every workflow living
// in that cwd holds one ref; the last release closes the watcher.
export function acquireProjectSettingsWatcher(cwd: string): void {
  if (!cwd) return;
  const existing = projectWatchers.get(cwd);
  if (existing) {
    existing.refCount += 1;
    return;
  }
  const dir = path.join(cwd, PROJECT_SETTINGS_DIRNAME);
  // .arco/ may not exist yet on a fresh project. mkdirSync is idempotent
  // (recursive: true won't error on EEXIST). Safe because it's the same dir
  // skills/plans use; we're not introducing a new artifact.
  try { mkdirSync(dir, { recursive: true }); } catch { /* fall through */ }
  let watcher: FSWatcher;
  try {
    watcher = fsWatch(dir, { persistent: false });
  } catch (err) {
    console.error(`[arco] project settings watcher start failed for ${dir}:`, err);
    return;
  }
  const state: ProjectWatcher = { watcher, refCount: 1, debounce: null };
  watcher.on('change', (_event, filename) => {
    if (filename !== PROJECT_SETTINGS_BASENAME) return;
    if (state.debounce) clearTimeout(state.debounce);
    state.debounce = setTimeout(() => { state.debounce = null; fire('project', cwd); }, 200);
  });
  watcher.on('error', (err) => {
    console.error(`[arco] project settings watcher error for ${dir}:`, err);
  });
  projectWatchers.set(cwd, state);
}

export function releaseProjectSettingsWatcher(cwd: string): void {
  const state = projectWatchers.get(cwd);
  if (!state) return;
  state.refCount -= 1;
  if (state.refCount > 0) return;
  if (state.debounce) clearTimeout(state.debounce);
  try { state.watcher.close(); } catch { /* already closed */ }
  projectWatchers.delete(cwd);
}


// Keep registration read-modify-write inside the settings lock so simultaneous
// folder creation cannot replace another request's registration.
export function updateRegisteredProjects(update: (projects: string[]) => string[]): Promise<ArcoSettings> {
  return withFileLock(GLOBAL_SETTINGS_PATH, async () => {
    const current = await readSettings();
    return patchSettingsUnlocked({ projects: update(current.projects ?? []) });
  });
}

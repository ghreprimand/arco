// The settings of a new cluster member. Four paths create members:
// CREATE WITH FRESH WORKERS and ADD WORKERS copy a template tab, REPLACE copies
// the member it replaces, and CREATE FROM SCRATCH builds each member from the
// creator's list. The handlers in clusterHandlers.ts validate their messages
// with the shared checks below (model, Codex account, member tuning) and call
// these functions; what differs between the paths is named here rather than
// repeated. Pinned by clusterMemberCreation.test.ts (through the handlers) and
// clusterMembers.test.ts (these functions).

import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  MEMBER_FOCUS_MAX,
  TERMINAL_CODEX_ACCOUNT,
  isAutoCompactionPolicy,
  isMemberTier,
  normalizeOutputStyle,
  storedOutputStyle,
  type ClusterMemberProvider,
  type ClusterMemberTuning,
  type EffortLevel,
  type ModelName,
  type WorkflowConfig,
} from '@arco/shared';

// Resolves a Codex account reference to a profile id, or null.
export type CodexAccountResolver = (ref: string | undefined, cwd: string) => Promise<string | null>;

export interface ProviderChoice {
  // The template's provider (Claude when it is not a cluster provider).
  inherited: ClusterMemberProvider;
  // The provider after the operator's choice.
  provider: ClusterMemberProvider;
  // The operator named a provider in the request.
  requested: boolean;
}

export interface TemplateMemberRequest {
  template: WorkflowConfig;
  cwd: string;
  choice: ProviderChoice;
  model?: string;
  effort?: string;
  accountRef?: string;
  isolated: boolean;
  // 'fresh' (CREATE WITH FRESH WORKERS, ADD WORKERS): a new name, no
  // auto-compaction override, and no account unless the member is Codex.
  // 'replacement' (REPLACE): the old member's name and auto-compaction are
  // kept, spawn tokens are cleared, and a non-Codex account is kept.
  kind: 'fresh' | 'replacement';
  // The member's name: required wording for 'fresh'; for 'replacement' a
  // non-empty name renames the member.
  name?: string;
  // Settings from the dialog; absent fields keep the path's default.
  tuning?: ClusterMemberTuning;
  resolveCodexAccount: CodexAccountResolver;
}

export async function memberConfigFromTemplate(r: TemplateMemberRequest): Promise<WorkflowConfig> {
  const config: WorkflowConfig = r.kind === 'fresh'
    ? { ...r.template, autoCompaction: undefined, name: r.name ?? r.template.name, workingDirectory: r.cwd, resumeSessionId: undefined, resumeWorkflowId: undefined }
    : { ...r.template, workingDirectory: r.cwd, resumeSessionId: undefined, resumeWorkflowId: undefined, researchSpawnToken: undefined, templateSpawnToken: undefined };
  delete config.goalRun;
  if (r.kind === 'replacement' && r.name && r.name.trim()) config.name = r.name.trim();
  if (r.tuning) applyMemberTuning(config, r.tuning);
  if (r.choice.requested || r.choice.provider !== r.choice.inherited) {
    // WorkflowConfig stores undefined for the default Claude provider.
    config.primaryProvider = r.choice.provider === 'claude' ? undefined : r.choice.provider;
    if (r.choice.provider !== 'codex') config.providerAccountRef = undefined;
  }
  if (r.model !== undefined) config.primaryModel = r.model as ModelName;
  if (r.effort !== undefined) config.primaryEffort = r.effort as EffortLevel;
  if (r.isolated) {
    // An isolated member is a Claude Native tab with no project access.
    config.primaryProvider = undefined;
    config.claudeTransport = 'native';
    config.ultracode = false;
    if (r.kind === 'fresh') { config.resumeSessionId = undefined; config.resumeWorkflowId = undefined; }
    else config.providerAccountRef = undefined;
  }
  if ((config.primaryProvider ?? 'claude') === 'codex') {
    // An account the operator picked was checked by memberAccountRefusal and
    // is used as picked; the template's own reference is looked up and kept
    // when the lookup finds nothing.
    if (r.accountRef !== undefined) config.providerAccountRef = r.accountRef;
    else {
      const id = await r.resolveCodexAccount(config.providerAccountRef, r.cwd);
      if (id) config.providerAccountRef = id;
    }
  } else if (r.kind === 'fresh') {
    config.providerAccountRef = undefined;
  }
  return config;
}

export interface ScratchMemberSpec {
  provider: ClusterMemberProvider;
  model: string;
  effort?: string;
  providerAccountRef?: string;
  displayName?: string;
  skipPermissions?: boolean;
  fastMode?: boolean;
  efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive';
  outputStyle?: import('@arco/shared').OutputStyle;
  accessMode?: string;
}

// CREATE FROM SCRATCH: only what the creator's list says, with defaults
// (effort medium, skip-permissions on, "Member #n").
export async function memberConfigFromSpec(m: ScratchMemberSpec, index: number, cwd: string, resolveCodexAccount: CodexAccountResolver): Promise<WorkflowConfig> {
  const displayName = (m.displayName ?? '').trim();
  const config: WorkflowConfig = {
    name: displayName.length > 0 ? displayName : `Member #${index + 1}`,
    primaryProvider: m.provider === 'claude' ? undefined : m.provider,
    primaryModel: m.model as ModelName,
    primaryEffort: (m.effort ?? 'medium') as EffortLevel,
    skipPermissions: m.skipPermissions ?? true,
    workingDirectory: cwd,
    ...(m.fastMode ? { fastMode: true } : {}),
    ...(m.efficiencyToolFilter && m.efficiencyToolFilter !== 'off' ? { efficiencyToolFilter: m.efficiencyToolFilter } : {}),
    ...(storedOutputStyle(m.outputStyle) ? { outputStyle: storedOutputStyle(m.outputStyle) } : {}),
  };
  if (m.accessMode === 'isolated') {
    config.claudeTransport = 'native';
    config.ultracode = false;
  }
  if (m.provider === 'codex') {
    // A picked account was checked by memberAccountRefusal; no pick takes the first configured one.
    const id = m.providerAccountRef ?? await resolveCodexAccount(undefined, cwd);
    if (id) config.providerAccountRef = id;
  }
  return config;
}

// The provider a model id belongs to, when the id says so.
export function inferClusterProviderFromModel(modelId: string): ClusterMemberProvider | undefined {
  const id = modelId.trim();
  if (!id) return undefined;
  // Cursor-exclusive ids first: bare `auto` (the Auto+Composer default) and the
  // grok-* family only reach Arco through Cursor today. Cursor also proxies the
  // claude-*/gpt-* families, so those prefixes cannot tell Cursor from the
  // native provider; a Cursor member on such a model is never a mismatch.
  if (id === 'auto' || id.startsWith('grok-') || id.startsWith('grok/')) return 'cursor';
  if ((CLAUDE_MODELS as readonly string[]).includes(id) || id.startsWith('claude-')) return 'claude';
  if ((CODEX_MODELS as readonly string[]).includes(id) || id.startsWith('gpt-')) return 'codex';
  return undefined;
}

export type ModelCatalogCheck = (provider: ClusterMemberProvider, model: string) => Promise<boolean>;

// The one model check of every path (create, add, replace), as a refusal code
// or null: an empty model, a model of another provider, a model the catalog
// does not list.
export async function memberModelRefusal(provider: ClusterMemberProvider, model: unknown, isKnownModel: ModelCatalogCheck): Promise<string | null> {
  if (typeof model !== 'string' || model.trim().length === 0) return 'missing_model';
  const inferred = inferClusterProviderFromModel(model);
  if (provider !== 'cursor' && inferred && inferred !== provider) return `provider_model_mismatch:${provider}:${model}`;
  if (!(await isKnownModel(provider, model))) return `unknown_model:${model}`;
  return null;
}

// Template paths (CREATE WITH FRESH WORKERS, ADD WORKERS, REPLACE): a model in
// the request gets the shared check; no model keeps the template's, which is
// only possible when the provider stays the same.
export async function templateModelRefusal(choice: ProviderChoice, model: unknown, isKnownModel: ModelCatalogCheck): Promise<string | null> {
  if (model !== undefined) return memberModelRefusal(choice.provider, model, isKnownModel);
  return choice.provider !== choice.inherited ? 'missing_model' : null;
}

export type CodexAccountCheck = (ref: string, cwd: string) => Promise<boolean>;

// A Codex account the operator picked must exist; there is no fallback to
// another account. Accounts named for other providers are ignored.
export async function memberAccountRefusal(provider: ClusterMemberProvider, ref: unknown, cwd: string, isKnownAccount: CodexAccountCheck): Promise<string | null> {
  if (provider !== 'codex' || ref === undefined) return null;
  if (typeof ref !== 'string' || ref.trim().length === 0) return `unknown_account:${String(ref)}`;
  if (ref === TERMINAL_CODEX_ACCOUNT) return null;
  return (await isKnownAccount(ref, cwd)) ? null : `unknown_account:${ref}`;
}

const TOOL_FILTERS = ['off', 'conservative', 'aggressive'];

// Shape check of the member tuning in an ADD WORKERS or REPLACE request.
export function memberTuningRefusal(t: ClusterMemberTuning): string | null {
  if (t.tier !== undefined && t.tier !== null && !isMemberTier(t.tier)) return `invalid_tier:${String(t.tier)}`;
  if (t.focus !== undefined && (typeof t.focus !== 'string' || t.focus.trim().length > MEMBER_FOCUS_MAX)) return 'invalid_focus';
  // A stale client's 'lite' is accepted and stored as 'plain'.
  if (t.outputStyle !== undefined && !normalizeOutputStyle(t.outputStyle)) return 'invalid_output_style';
  if (t.efficiencyToolFilter !== undefined && !TOOL_FILTERS.includes(t.efficiencyToolFilter)) return 'invalid_tool_filter';
  if (t.fastMode !== undefined && typeof t.fastMode !== 'boolean') return 'invalid_fast_mode';
  if (t.autoCompaction !== undefined && t.autoCompaction !== null && !isAutoCompactionPolicy(t.autoCompaction)) return 'invalid_auto_compaction';
  return null;
}

// The tab settings of the tuning; tier and focus are cluster metadata and are
// saved by the handler. OFF, the default output style (DEFAULT_OUTPUT_STYLE)
// and fast mode off are stored as unset, as CREATE FROM SCRATCH stores them.
export function applyMemberTuning(config: WorkflowConfig, t: ClusterMemberTuning): void {
  if (t.outputStyle !== undefined) config.outputStyle = storedOutputStyle(t.outputStyle);
  if (t.efficiencyToolFilter !== undefined) config.efficiencyToolFilter = t.efficiencyToolFilter === 'off' ? undefined : t.efficiencyToolFilter;
  if (t.fastMode !== undefined) config.fastMode = t.fastMode ? true : undefined;
  if (t.autoCompaction !== undefined) config.autoCompaction = t.autoCompaction ?? undefined;
}

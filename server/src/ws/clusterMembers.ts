// The settings of a new cluster member. Four paths create members:
// CREATE WITH FRESH WORKERS and ADD WORKERS copy a template tab, REPLACE copies
// the member it replaces, and CREATE FROM SCRATCH builds each member from the
// creator's list. The handlers in clusterHandlers.ts validate their messages
// and call these functions; what differs between the paths is named here
// rather than repeated. Pinned by clusterMemberCreation.test.ts (through the
// handlers) and clusterMembers.test.ts (these functions).

import type { ClusterMemberProvider, EffortLevel, ModelName, WorkflowConfig } from '@arco/shared';

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
  name?: string;
  resolveCodexAccount: CodexAccountResolver;
}

export async function memberConfigFromTemplate(r: TemplateMemberRequest): Promise<WorkflowConfig> {
  const config: WorkflowConfig = r.kind === 'fresh'
    ? { ...r.template, autoCompaction: undefined, name: r.name ?? r.template.name, workingDirectory: r.cwd, resumeSessionId: undefined, resumeWorkflowId: undefined }
    : { ...r.template, workingDirectory: r.cwd, resumeSessionId: undefined, resumeWorkflowId: undefined, researchSpawnToken: undefined, templateSpawnToken: undefined };
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
    const id = await r.resolveCodexAccount(r.accountRef ?? config.providerAccountRef, r.cwd);
    if (id) config.providerAccountRef = id;
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
  outputStyle?: 'normal' | 'lite' | 'terse';
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
    ...(m.outputStyle && m.outputStyle !== 'normal' ? { outputStyle: m.outputStyle } : {}),
  };
  if (m.accessMode === 'isolated') {
    config.claudeTransport = 'native';
    config.ultracode = false;
  }
  if (m.provider === 'codex') {
    const id = await resolveCodexAccount(m.providerAccountRef, cwd);
    if (id) config.providerAccountRef = id;
  }
  return config;
}

export interface MemberModelCheck {
  op: string;
  choice: ProviderChoice;
  model: string | undefined;
  isKnownModel: (provider: ClusterMemberProvider, model: string) => Promise<boolean>;
  // REPLACE checks no empty model (the catalog check refuses it) and words a
  // provider change without a model differently.
  rejectEmptyModel: boolean;
  changedWithoutModel: string;
}

// The model checks after the provider is resolved, as an error message or null.
export async function memberModelProblem(c: MemberModelCheck): Promise<string | null> {
  if (c.model !== undefined) {
    if (c.rejectEmptyModel && (typeof c.model !== 'string' || c.model.trim().length === 0)) return `${c.op} rejected: unknown_model`;
    if (!(await c.isKnownModel(c.choice.provider, c.model))) return `${c.op} rejected: unknown_model:${c.model}`;
  }
  if (c.choice.provider !== c.choice.inherited && c.model === undefined) return `${c.op} rejected: ${c.changedWithoutModel}`;
  return null;
}

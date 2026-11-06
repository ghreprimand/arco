import { resolveOutputStyle, type AutoCompactionPolicy, type ClusterMemberProvider, type ClusterMemberTuning, type MemberTier, type WorkflowConfig } from '@arco/shared';

// The member settings ADD WORKERS and REPLACE show besides provider, model,
// effort, account and access. ADD WORKERS starts from the first member's tab
// settings with no tier, focus or own auto-compaction; REPLACE starts from
// the member it replaces. The request always carries every value, so what the
// dialog shows is what the new member gets.
export interface MemberSettings {
  tier: MemberTier | '';
  focus: string;
  outputStyle: import('@arco/shared').OutputStyle;
  efficiencyToolFilter: 'off' | 'conservative' | 'aggressive';
  fastMode: boolean;
  // null follows the cluster default.
  autoCompaction: AutoCompactionPolicy | null;
}

// `keepAutoCompaction`: REPLACE starts from the old member's own policy;
// ADD WORKERS starts from the cluster default.
export function memberSettingsFrom(
  config: Partial<WorkflowConfig> | undefined,
  identity: { tier?: MemberTier; focus?: string; keepAutoCompaction?: boolean } = {},
): MemberSettings {
  return {
    tier: identity.tier ?? '',
    focus: identity.focus ?? '',
    outputStyle: resolveOutputStyle(config?.outputStyle),
    efficiencyToolFilter: config?.efficiencyToolFilter ?? 'off',
    fastMode: config?.fastMode === true,
    autoCompaction: identity.keepAutoCompaction ? config?.autoCompaction ?? null : null,
  };
}

// Which settings apply to a provider: fast mode and the tool-result filter
// are Claude settings; every provider applies the output style.
export function memberSettingsShown(provider: ClusterMemberProvider): { fastMode: boolean; toolFilter: boolean; outputStyle: boolean } {
  return { fastMode: provider === 'claude', toolFilter: provider === 'claude', outputStyle: true };
}

// The request fields. A setting the provider does not use is sent as off, so
// a hidden value from the old member or the template is not carried over.
export function memberTuning(v: MemberSettings, provider: ClusterMemberProvider): Required<ClusterMemberTuning> {
  const shown = memberSettingsShown(provider);
  return {
    tier: v.tier || null,
    focus: v.focus.trim(),
    outputStyle: v.outputStyle,
    efficiencyToolFilter: shown.toolFilter ? v.efficiencyToolFilter : 'off',
    fastMode: shown.fastMode ? v.fastMode : false,
    autoCompaction: v.autoCompaction,
  };
}

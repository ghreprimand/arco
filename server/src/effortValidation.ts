import { CLAUDE_EFFORTS, CLAUDE_MODEL_EFFORTS, CODEX_MODEL_INFO, EFFORT_RANK, type EffortLevel, type ProviderName } from '@arco/shared';
import { getCachedClaudeModelEfforts } from './providers/claude-native/catalog.js';
import { getCachedCodexModelCapabilities } from './providers/codex-appserver/catalog.js';

// Follow the model catalog and the same static overrides as the picker.
export function allowedWorkflowEfforts(provider: ProviderName | undefined, model: string): EffortLevel[] {
  if (!provider || provider === 'claude') {
    const known = CLAUDE_MODEL_EFFORTS[model];
    const live = getCachedClaudeModelEfforts(model);
    if (live?.length) return known ? CLAUDE_EFFORTS.filter((level) => known.includes(level) || live.includes(level)) : live;
    return known ?? CLAUDE_EFFORTS;
  }
  if (provider === 'codex') {
    const live = getCachedCodexModelCapabilities(model)?.supportedReasoningEfforts;
    const supported = live?.filter((level): level is EffortLevel => level !== 'none' && Object.hasOwn(EFFORT_RANK, level));
    if (supported?.length) return supported;
    return CODEX_MODEL_INFO[model]?.supportedEfforts ?? Object.keys(EFFORT_RANK).filter((level) => level !== 'none') as EffortLevel[];
  }
  return Object.keys(EFFORT_RANK) as EffortLevel[];
}

export function normalizedWorkflowEffort(provider: ProviderName | undefined, model: string, effort: unknown): EffortLevel {
  const levels = allowedWorkflowEfforts(provider, model);
  if (typeof effort === 'string' && levels.includes(effort as EffortLevel)) return effort as EffortLevel;
  if (typeof effort === 'string' && Object.hasOwn(EFFORT_RANK, effort)) {
    const rank = EFFORT_RANK[effort as EffortLevel];
    return levels.reduce((best, next) => Math.abs(EFFORT_RANK[next] - rank) < Math.abs(EFFORT_RANK[best] - rank) ? next : best);
  }
  return levels.includes('medium') ? 'medium' : levels[0] ?? 'medium';
}

// The settings one primary turn runs with, resolved once per turn so they stay
// stable while queued messages drain. Which value wins: the tab's own choice,
// then the settings files, then the default. Native-only switches are off on
// every other transport. Pinned by turnSettings.test.ts; handleUserMessage in
// turnEngine.ts reads the settings files and passes them in.

import { effectiveCodexTransport, resolveAutoCompactionPolicy, resolveOutputStyle, type AutoCompactionPolicy, type WorkflowConfig } from '@arco/shared';

// Claude Native compacts inside a long turn at this share of the context
// window when the tab and its cluster leave auto-compaction on Provider.
export const NATIVE_IN_TURN_COMPACT_DEFAULT_PERCENT = 70;

// The in-turn compaction threshold for one Claude Native turn, or undefined
// when it is off: the tab's or cluster's Arco auto-compaction threshold when
// one is set (Off means off), 70% under Provider, and never while the Claude
// API compaction beta is on (the provider compacts then) or on Chat turns.
export function resolveNativeInTurnCompactPercent(input: {
  native: boolean; chat: boolean; claudeNativeCompact: boolean;
  worker: AutoCompactionPolicy | undefined; cluster: AutoCompactionPolicy | undefined;
}): number | undefined {
  if (!input.native || input.chat || input.claudeNativeCompact) return undefined;
  const explicit = resolveAutoCompactionPolicy(input.worker, input.cluster);
  if (explicit) return explicit.enabled ? explicit.thresholdPercent : undefined;
  return NATIVE_IN_TURN_COMPACT_DEFAULT_PERCENT;
}

export interface TurnSettingsInput {
  provider: string;
  config: Pick<WorkflowConfig,
    'kind' | 'voiceOperator' | 'codexTransport' | 'claudeTransport' | 'ultracode' | 'claudeNativeCompact' | 'claudeNativeForceInterleavedThinkingBeta'
    | 'claudeNativeThinkingDisplay' | 'efficiencyToolFilter' | 'efficiencyFactForce' | 'efficiencyConfigProtection'
    | 'efficiencySandbox' | 'reviewSafeMode' | 'outputStyle' | 'goal' | 'ollamaParams'>;
  // The merged settings files (null when they could not be read).
  cascade: { codex?: { transport?: string }; claude?: { transport?: string } } | null;
  isolatedMember: boolean;
  primitive?: string;
}

export interface TurnSettings {
  codexTransport: 'exec' | 'appserver';
  ultracode: boolean;
  claudeTransport: 'cli' | 'native';
  claudeNativeCompact: boolean;
  claudeNativeForceInterleavedThinkingBeta: boolean;
  claudeNativeThinkingDisplay: 'omitted' | 'summarized' | 'updates' | undefined;
  efficiencyToolFilter: 'off' | 'conservative' | 'aggressive';
  efficiencyFactForce: 'on' | 'off';
  efficiencyConfigProtection: 'on' | 'off';
  efficiencySandbox: 'off' | 'on';
  reviewSafeMode: 'off' | 'on';
  outputStyle: import('@arco/shared').OutputStyle;
  goal: string | undefined;
  ollamaParams: Record<string, unknown> | undefined;
}

export function resolveTurnSettings({ provider, config, cascade, isolatedMember, primitive }: TurnSettingsInput): TurnSettings {
  // The CONFIG tab's transport choice wins over settings.json.
  const requestedCodexTransport = config.codexTransport === 'appserver' || config.codexTransport === 'exec'
    ? config.codexTransport
    : cascade?.codex?.transport === 'appserver' ? 'appserver' : 'exec';
  const codexTransport = effectiveCodexTransport(requestedCodexTransport, config.kind === 'chat', config.voiceOperator);
  // Sticky ultracode forces the CLI transport (the harness WorkflowTool lives
  // only in the `claude` binary); the base transport is restored when it is off.
  const ultracode = provider === 'claude' && config.ultracode === true;
  const claudeTransport = ultracode
    ? 'cli'
    : config.claudeTransport === 'native' || config.claudeTransport === 'cli'
      ? config.claudeTransport
      : cascade?.claude?.transport === 'native' ? 'native' : 'cli';
  const native = claudeTransport === 'native';
  // Every provider applies the output style; a tab with no saved style uses
  // DEFAULT_OUTPUT_STYLE. DOCS and GIT turns always use normal output.
  return {
    codexTransport,
    ultracode,
    claudeTransport,
    // Server-side compaction and the interleaved-thinking beta: Native only, off when absent.
    claudeNativeCompact: native ? config.claudeNativeCompact === true : false,
    claudeNativeForceInterleavedThinkingBeta: native ? config.claudeNativeForceInterleavedThinkingBeta === true : false,
    claudeNativeThinkingDisplay: native ? config.claudeNativeThinkingDisplay : undefined,
    // The efficiency gates live in the Native worker; zero elsewhere.
    efficiencyToolFilter: native ? (config.efficiencyToolFilter ?? 'off') : 'off',
    efficiencyFactForce: native ? (config.efficiencyFactForce ?? 'off') : 'off',
    efficiencyConfigProtection: native ? (config.efficiencyConfigProtection ?? 'on') : 'off',
    efficiencySandbox: native && !isolatedMember ? (config.efficiencySandbox ?? 'off') : 'off',
    reviewSafeMode: native ? (config.reviewSafeMode ?? 'off') : 'off',
    outputStyle: primitive === 'docs' || primitive === 'git' ? 'normal' : resolveOutputStyle(config.outputStyle),
    // The north star rides every path, DOCS and GIT included; an isolated member has none.
    goal: isolatedMember ? undefined : config.goal,
    // Only the Ollama request builder reads the param preset.
    ollamaParams: provider === 'ollama' ? config.ollamaParams : undefined,
  };
}

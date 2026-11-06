// The settings one primary turn runs with, resolved once per turn so they stay
// stable while queued messages drain. Which value wins: the tab's own choice,
// then the settings files, then the default. Native-only switches are off on
// every other transport. Pinned by turnSettings.test.ts; handleUserMessage in
// turnEngine.ts reads the settings files and passes them in.

import { resolveOutputStyle, type WorkflowConfig } from '@arco/shared';

export interface TurnSettingsInput {
  provider: string;
  config: Pick<WorkflowConfig,
    'codexTransport' | 'claudeTransport' | 'ultracode' | 'claudeNativeCompact' | 'claudeNativeForceInterleavedThinkingBeta'
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
  const codexTransport = config.codexTransport === 'appserver' || config.codexTransport === 'exec'
    ? config.codexTransport
    : cascade?.codex?.transport === 'appserver' ? 'appserver' : 'exec';
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

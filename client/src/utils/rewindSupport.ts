import type { WorkflowConfig } from '@arco/shared';
import { selectedClaudeTransport } from './claudeAuth';

// REWIND CONVERSATION moves a Claude Native worker's conversation head back;
// the server refuses every other provider and the Claude CLI transport. The
// button stays visible and says why when it cannot be used.
export function rewindUnavailableReason(
  config: Pick<WorkflowConfig, 'primaryProvider' | 'claudeTransport' | 'ultracode'>,
  claudeTransportSetting?: 'native' | 'cli',
): string | null {
  const provider = config.primaryProvider ?? 'claude';
  if (provider !== 'claude') return 'Available for Claude Native workers only.';
  if (selectedClaudeTransport(config.claudeTransport, claudeTransportSetting, !!config.ultracode) !== 'native') {
    return 'Available for Claude Native workers only; this worker uses the Claude CLI.';
  }
  return null;
}

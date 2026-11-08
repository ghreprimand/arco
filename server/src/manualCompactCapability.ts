import type { ProviderName } from '@arco/shared';

// Shared admission for manual COMPACT and its remote advertisement. Provider
// handlers still validate the live session and effective transport at dispatch.
export function supportsManualCompact(provider: ProviderName, claudeNative = true): boolean {
  return provider === 'codex' || provider === 'cursor' || provider === 'ollama'
    || (provider === 'claude' && claudeNative);
}

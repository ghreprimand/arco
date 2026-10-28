import type { AuthStatusByProvider, ProviderName } from '@arco/shared';

export const USAGE_PROVIDERS = ['claude', 'gemini', 'codex', 'cursor', 'ollama'] as const;

export function hasEnabledUsageProvider(
  auth: AuthStatusByProvider | null | undefined,
  isEnabled: (provider: ProviderName) => boolean,
): boolean {
  return USAGE_PROVIDERS.some((provider) => isEnabled(provider) && !!auth?.[provider]?.loggedIn);
}

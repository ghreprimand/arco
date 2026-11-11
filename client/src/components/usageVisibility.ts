import { LOCAL_STATUS_PROVIDERS } from '@arco/shared';
import type { AuthStatusByProvider, ProviderName } from '@arco/shared';

export const USAGE_PROVIDERS = ['claude',  'codex', 'cursor'] as const;

export function hasEnabledUsageProvider(
  auth: AuthStatusByProvider | null | undefined,
  isEnabled: (provider: ProviderName) => boolean,
): boolean {
  return LOCAL_STATUS_PROVIDERS.some(isEnabled) || USAGE_PROVIDERS.some((provider) => isEnabled(provider) && !!auth?.[provider]?.loggedIn);
}

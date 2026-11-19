import { LOCAL_STATUS_PROVIDERS } from '@arco/shared';
import type { ProviderName } from '@arco/shared';

export const USAGE_PROVIDERS = ['claude',  'codex', 'cursor'] as const;

// Enabled providers stay in the top bar whether or not they are signed in.
export function hasEnabledUsageProvider(isEnabled: (provider: ProviderName) => boolean): boolean {
  return LOCAL_STATUS_PROVIDERS.some(isEnabled) || USAGE_PROVIDERS.some(isEnabled);
}

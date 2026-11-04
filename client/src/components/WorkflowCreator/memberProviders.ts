import { CLUSTER_MEMBER_PROVIDERS } from '@arco/shared';
import type { AuthStatusByProvider, ClusterMemberProvider, ProviderName } from '@arco/shared';

// Providers that can be cluster members, in display order, with plain names.
export const MEMBER_PROVIDER_NAMES: Record<ClusterMemberProvider, string> = {
  claude: 'Claude', codex: 'Codex', cursor: 'Cursor', ollama: 'Ollama', llamacpp: 'llama.cpp',
};

// A member provider is offered only when it is enabled in Settings and its
// connection check reports a usable login or reachable runtime.
export function memberProviderAvailable(
  provider: ClusterMemberProvider,
  authStatus: AuthStatusByProvider | null | undefined,
  isProviderEnabled: (p: ProviderName) => boolean,
): boolean {
  return isProviderEnabled(provider) && Boolean(authStatus?.[provider]?.loggedIn);
}

export function availableMemberProviders(
  authStatus: AuthStatusByProvider | null | undefined,
  isProviderEnabled: (p: ProviderName) => boolean,
): ClusterMemberProvider[] {
  return CLUSTER_MEMBER_PROVIDERS.filter((p) => memberProviderAvailable(p, authStatus, isProviderEnabled));
}

// Primary providers in the creator's picker order.
export const PRIMARY_PROVIDER_ORDER: ProviderName[] = ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek'];

// The same availability rule as members, for the single-workflow and chat
// primary provider: enabled in Settings and reported connected.
export function primaryProviderAvailable(
  provider: ProviderName,
  authStatus: AuthStatusByProvider | null | undefined,
  isProviderEnabled: (p: ProviderName) => boolean,
): boolean {
  return isProviderEnabled(provider) && Boolean(authStatus?.[provider]?.loggedIn);
}

export function availablePrimaryProviders(
  authStatus: AuthStatusByProvider | null | undefined,
  isProviderEnabled: (p: ProviderName) => boolean,
): ProviderName[] {
  return PRIMARY_PROVIDER_ORDER.filter((p) => primaryProviderAvailable(p, authStatus, isProviderEnabled));
}

// Picker options: every available provider, plus the current one when it is
// unavailable so a saved or explicit choice stays visible instead of being
// silently replaced.
export function primaryProviderOptions(
  current: ProviderName,
  authStatus: AuthStatusByProvider | null | undefined,
  isProviderEnabled: (p: ProviderName) => boolean,
): ProviderName[] {
  const available = availablePrimaryProviders(authStatus, isProviderEnabled);
  return available.includes(current) ? available : [current, ...available];
}

// The provider a creator with no saved or explicit choice starts on: the
// first available one, or null when none is connected (nothing to pick).
export function firstAvailablePrimaryProvider(
  authStatus: AuthStatusByProvider | null | undefined,
  isProviderEnabled: (p: ProviderName) => boolean,
): ProviderName | null {
  return availablePrimaryProviders(authStatus, isProviderEnabled)[0] ?? null;
}

// Plain reason shown beside a disabled launch button, or null when the
// provider can launch. `null` auth status means the check has not answered.
export function primaryProviderProblem(
  provider: ProviderName,
  authStatus: AuthStatusByProvider | null | undefined,
  isProviderEnabled: (p: ProviderName) => boolean,
  displayName: string,
): string | null {
  if (!authStatus) return 'Checking provider connections.';
  if (!isProviderEnabled(provider)) return `${displayName} is turned off in Settings. Choose a connected provider or turn it on.`;
  if (!authStatus[provider]?.loggedIn) {
    return availablePrimaryProviders(authStatus, isProviderEnabled).length === 0
      ? `No provider is connected. Connect one in Connections to launch.`
      : `${displayName} is not connected. Choose a connected provider or sign in from Connections.`;
  }
  return null;
}

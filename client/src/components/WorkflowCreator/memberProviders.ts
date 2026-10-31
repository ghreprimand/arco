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

import type { ArcoSettings, AuthLoginTarget, AuthStatus } from '@arco/shared';
import { useAppStore } from '../stores/appStore';

// The explicit status check Connections runs for one provider, published to
// the shared store so the top bar, pickers and Settings all see it at once.
// Returns the checked status, or null when the check failed or its reply was
// not a status (the previous status is left in place).
export async function checkProviderStatus(target: AuthLoginTarget): Promise<AuthStatus | null> {
  try {
    const res = await fetch(`/api/connections/check?provider=${target}`, { method: 'POST' });
    const body = await res.json();
    if (!res.ok || body?.provider !== target || typeof body?.status?.loggedIn !== 'boolean') return null;
    const state = useAppStore.getState();
    if (state.authStatus) state.setAuthStatus({ ...state.authStatus, [target]: body.status });
    if (body.settings?.enabledProviders) state.setSettings(body.settings as ArcoSettings);
    return body.status as AuthStatus;
  } catch {
    return null;
  }
}

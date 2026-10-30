import type { ClaudeNativeAuthStatus } from '@arco/shared';
import { loadTokens, nativeCredentialBinding } from './auth.js';
import { getClaudeAuthProblem, REFRESH_LEAD_MS_EXPORT } from './oauth.js';

let lastStatus: ClaudeNativeAuthStatus | undefined;

// Metadata only: never refresh, start OAuth, query allowance or send inference.
export async function getClaudeNativeAuthStatus(): Promise<ClaudeNativeAuthStatus> {
  try {
    const tokens = await loadTokens();
    if (tokens && (typeof tokens.accessToken !== 'string' || !tokens.accessToken
      || typeof tokens.refreshToken !== 'string' || !tokens.refreshToken
      || !Number.isFinite(tokens.expiresAt))) throw new Error('Invalid Native credential metadata');
    const problem = getClaudeAuthProblem();
    const status: ClaudeNativeAuthStatus = {
      state: !tokens ? 'missing' : problem ? 'needs-attention' : tokens.expiresAt <= Date.now() + REFRESH_LEAD_MS_EXPORT ? 'refresh-needed' : 'present',
      credentialsPresent: !!tokens,
      execution: 'unverified',
      binding: nativeCredentialBinding(tokens),
      checkedAt: Date.now(),
      ...(tokens ? { expiresAt: tokens.expiresAt, scopes: typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : [] } : {}),
      ...(tokens && problem ? { problemSince: problem.since, error: 'Native authentication reported a problem. Open Native settings to recover.' } : {}),
    };
    lastStatus = status;
    return status;
  } catch {
    return {
      ...(lastStatus ?? { credentialsPresent: false, execution: 'unverified', binding: nativeCredentialBinding(), checkedAt: Date.now() }),
      state: 'unknown', probeFailed: true, stale: !!lastStatus,
      error: 'Native credential status could not be read. The previous result may be out of date.',
    };
  }
}

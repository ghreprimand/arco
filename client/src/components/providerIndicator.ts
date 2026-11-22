import type { ArcoSettings, AuthStatus, AuthStatusByProvider, Capabilities, ProviderName } from '@arco/shared';
import { claudeAuthPresentation } from '../utils/claudeAuth';

// One rule for which providers the top bar and the Versions list show: an
// enabled provider stays, a disabled one disappears. `null` settings (still
// loading) fail open, as the Versions list always has.
export function providerShown(settings: Pick<ArcoSettings, 'enabledProviders'> | null | undefined, provider: ProviderName): boolean {
  return settings?.enabledProviders?.[provider] !== false;
}

// Whether the runtime a provider needs is installed, as the Versions list
// reads it: 'unknown' means not installed, 'broken' means installed but the
// version probe failed. Claude Native needs no CLI.
export function providerRuntime(provider: 'claude' | 'codex' | 'cursor' | 'antigravity-cli', capabilities: Capabilities | null | undefined, claudeTransport: 'native' | 'cli'): 'installed' | 'missing' | 'broken' | 'checking' {
  if (!capabilities) return 'checking';
  if (provider === 'claude' && claudeTransport === 'native') return 'installed';
  const version = provider === 'claude' ? capabilities.cliVersion : provider === 'codex' ? capabilities.codexVersion : provider === 'cursor' ? capabilities.cursorVersion : capabilities.antigravityVersion;
  if (!version || version === 'unknown') return 'missing';
  return version === 'broken' ? 'broken' : 'installed';
}

export type IndicatorState = 'checking' | 'unknown' | 'ready' | 'sign-in' | 'rejected' | 'runtime';

export interface ProviderIndicator {
  provider: 'claude' | 'codex' | 'cursor' | 'antigravity-cli';
  letter: 'A' | 'C' | 'X' | 'G';
  name: string;
  state: IndicatorState;
  // What the provider needs, in words, without the provider name; the
  // indicator's hover text and accessible name put the name in front.
  text: string;
  // Click or tap opens the provider's Connections entry.
  attention: boolean;
}

const NAMES = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', 'antigravity-cli': 'Antigravity CLI' } as const;
const LETTERS = { claude: 'A', codex: 'C', cursor: 'X', 'antigravity-cli': 'G' } as const;

export interface IndicatorInput {
  auth: AuthStatusByProvider | null | undefined;
  capabilities: Capabilities | null | undefined;
  claudeTransport: 'native' | 'cli';
  // The active tab's Codex profile, when it uses one.
  codexAccount?: string;
  now?: number;
}

function codexStatus(auth: AuthStatus | undefined, account?: string): AuthStatus | undefined {
  if (!auth || !account || !auth.accountStatuses?.length) return auth;
  const entry = auth.accountStatuses.find((a) => a.id === account);
  return entry ? { ...auth, loggedIn: entry.loggedIn, email: entry.email, error: entry.error } : auth;
}

export function providerIndicator(provider: 'claude' | 'codex' | 'cursor' | 'antigravity-cli', input: IndicatorInput): ProviderIndicator {
  const base = { provider, letter: LETTERS[provider], name: NAMES[provider] };
  const runtime = providerRuntime(provider, input.capabilities, input.claudeTransport);
  if (runtime === 'missing') return { ...base, state: 'runtime', attention: true, text: 'CLI not installed. Open Connections to set it up.' };
  if (runtime === 'broken') return { ...base, state: 'runtime', attention: true, text: 'CLI installed but does not run. Open Connections to repair it.' };
  if (!input.auth) return { ...base, state: 'checking', attention: false, text: 'Checking status' };
  if (provider === 'claude') {
    const view = claudeAuthPresentation(input.auth.claude, input.claudeTransport, input.now);
    if (view.attention === 'native') {
      const rejected = input.auth.claude?.native?.state === 'needs-attention';
      return { ...base, state: rejected ? 'rejected' : 'sign-in', attention: true, text: `Native ${rejected ? 'sign-in needs attention' : 'sign-in needed'}. Open Connections to sign in.` };
    }
    if (view.attention === 'cli') return { ...base, state: 'sign-in', attention: true, text: 'CLI signed out. Open Connections to sign in.' };
    const transport = input.claudeTransport === 'native' ? 'Native' : 'CLI';
    if (view.dotState === 'live' || view.nativeAvailable || view.showDot) return { ...base, state: 'ready', attention: false, text: `${transport} ready` };
    return { ...base, state: 'checking', attention: false, text: `${transport} status unknown` };
  }
  const status = provider === 'codex' ? codexStatus(input.auth.codex, input.codexAccount) : provider === 'cursor' ? input.auth.cursor : input.auth['antigravity-cli'];
  if (!status) return { ...base, state: 'checking', attention: false, text: 'Checking status' };
  if (status.loggedIn) return { ...base, state: 'ready', attention: false, text: 'ready' };
  // A finished check that could not tell (a locked keyring, say) has a
  // recovery step, so it opens Connections; a check still pending does not.
  if (status.probeFailed) {
    return status.error
      ? { ...base, state: 'unknown', attention: true, text: `status unknown: ${status.error} Open Connections to check again.` }
      : { ...base, state: 'checking', attention: false, text: 'status unknown' };
  }
  if (status.signInRejected) return { ...base, state: 'rejected', attention: true, text: `${NAMES[provider]} rejected the saved sign-in. Open Connections to sign in again.` };
  return { ...base, state: 'sign-in', attention: true, text: `sign-in needed. Open Connections to sign in.` };
}

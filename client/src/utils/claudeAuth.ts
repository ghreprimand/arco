import type { AuthStatus, ClaudeNativeAuthStatus } from '@arco/shared';

const STATUS_STALE_MS = 6 * 60 * 1000;

export function selectedClaudeTransport(tab?: 'native' | 'cli', setting?: 'native' | 'cli', forceCli = false): 'native' | 'cli' {
  return forceCli ? 'cli' : tab ?? setting ?? 'native';
}

export function nativeAuthText(status: ClaudeNativeAuthStatus | undefined, now = Date.now()): string {
  if (!status || status.probeFailed) return status?.stale ? 'Status unknown; previous credential result is stale' : 'Status unknown';
  if (status.stale || now - status.checkedAt > STATUS_STALE_MS) return 'Status stale; refresh to check credentials';
  switch (status.state) {
    case 'missing': return 'No Native credentials stored';
    case 'present': return 'Credentials present; execution unverified';
    case 'refresh-needed': return 'Credentials present; refresh needed on next use; execution unverified';
    case 'needs-attention': return 'Authentication problem reported; review Native sign-in';
    default: return 'Status unknown';
  }
}

export function claudeAuthPresentation(status: AuthStatus | undefined, transport: 'native' | 'cli', now = Date.now()) {
  // The legacy top-level answer was CLI-only. Optional nested fields allow
  // older saved/client fixtures without inventing a Native verdict.
  const cli = status?.cli ?? status;
  const cliUnknown = !cli || !!cli.probeFailed || !!status?.cli?.stale
    || (!!status?.cli?.checkedAt && now - status.cli.checkedAt > STATUS_STALE_MS);
  const cliText = cliUnknown ? 'Status unknown or stale' : cli?.loggedIn ? 'Signed in' : 'Signed out';
  const native = status?.native;
  const nativeUnknown = !native || !!native.probeFailed || !!native.stale || now - native.checkedAt > STATUS_STALE_MS || native.state === 'unknown';
  const attention = transport === 'cli'
    ? (!cliUnknown && !cli?.loggedIn ? 'cli' : undefined)
    : (!nativeUnknown && (native?.state === 'missing' || native?.state === 'needs-attention') ? 'native' : undefined);
  const dotState = transport === 'cli'
    ? (cliUnknown ? 'ready' : cli?.loggedIn ? 'live' : 'down')
    : (!nativeUnknown && (native?.state === 'missing' || native?.state === 'needs-attention') ? 'down' : 'ready');
  return {
    attention, dotState: dotState as 'ready' | 'live' | 'down',
    nativeText: nativeAuthText(native, now), cliText,
    nativeAvailable: !nativeUnknown && !!native?.credentialsPresent && ['present', 'refresh-needed'].includes(native.state),
    showDot: !!(status?.loggedIn || native?.credentialsPresent || cli?.loggedIn),
    label: transport === 'native' ? 'Claude Native' : 'Claude CLI',
  };
}

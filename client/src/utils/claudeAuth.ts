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

export interface ClaudeConnection {
  // Whether the selected transport can be used for a first chat.
  connected: boolean;
  // Native is selected and has no usable credentials: sign-in is the next step.
  needsNativeSignIn: boolean;
  // The CLI is signed in, so switching the transport to CLI would work.
  cliSignedIn: boolean;
  text: string;
}

// Claude status as the selected transport sees it. A status without Native
// evidence (older servers, fixtures) keeps the CLI-only answer. An unknown
// Native result falls back to that answer rather than locking anyone out.
export function claudeConnection(status: AuthStatus | undefined, transport: 'native' | 'cli', now = Date.now()): ClaudeConnection {
  const cli = status?.cli ?? status;
  const cliSignedIn = !!cli?.loggedIn && !cli.probeFailed && !(status?.cli?.stale);
  if (transport === 'cli') {
    return { connected: cliSignedIn, needsNativeSignIn: false, cliSignedIn, text: cliSignedIn ? 'CLI connected' : 'CLI: sign-in needed' };
  }
  if (!status?.native) {
    const ok = !!status?.loggedIn && !status.probeFailed;
    return { connected: ok, needsNativeSignIn: false, cliSignedIn, text: ok ? 'Connected' : 'Not connected' };
  }
  const view = claudeAuthPresentation(status, 'native', now);
  if (view.nativeAvailable) return { connected: true, needsNativeSignIn: false, cliSignedIn, text: 'Native credentials detected' };
  if (view.attention === 'native') {
    return { connected: false, needsNativeSignIn: true, cliSignedIn, text: status.native.state === 'needs-attention' ? 'Native needs attention' : 'Native: sign-in needed' };
  }
  return { connected: !!status.loggedIn && !status.probeFailed, needsNativeSignIn: false, cliSignedIn, text: 'Status unknown' };
}

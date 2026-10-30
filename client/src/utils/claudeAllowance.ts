import type { AuthStatusByProvider, UsageInfo } from '@arco/shared';

let latestRequest = 0;
let forcedRequest: Promise<UsageInfo | null> | undefined;

export function invalidateClaudeAllowanceRequests(): void {
  latestRequest++;
  forcedRequest = undefined;
}

export function allowanceBindingChanged(usage: UsageInfo | null, auth: AuthStatusByProvider | null): boolean {
  if (!usage || !auth) return false;
  const bindings = usage.credentialContext ? Object.values(usage.credentialContext) : usage.binding ? [usage.binding] : [];
  return bindings.some(binding => {
    const source = binding.source === 'claude-native' ? auth.claude?.native : auth.claude?.cli;
    if (!source) return false;
    const observedAt = 'bindingCheckedAt' in source ? source.bindingCheckedAt ?? source.checkedAt : source.checkedAt;
    // A successful check can include an owned refresh after it starts. Its
    // final snapshot is newer evidence than an auth read during that refresh.
    const snapshotAt = usage.available ? usage.fetchedAt : usage.checkedAt ?? usage.fetchedAt;
    return binding.revision !== source.binding.revision && (observedAt ?? 0) >= snapshotAt;
  });
}

// The poll and explicit refresh share one ordering fence. A late response from
// an earlier check cannot replace a newer source/binding in the global meter.
export function refreshClaudeAllowance(force = false): Promise<UsageInfo | null> {
  if (forcedRequest) return forcedRequest;
  const request = ++latestRequest;
  const run = (async () => {
    try {
      const response = await fetch(`/api/usage${force ? '?force=1' : ''}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Allowance check failed');
      const usage = await response.json() as UsageInfo;
      return request === latestRequest ? usage : null;
    } catch (error) { if (request !== latestRequest) return null; throw error; }
  })();
  if (!force) return run;
  const joined = run.finally(() => { if (forcedRequest === joined) forcedRequest = undefined; });
  forcedRequest = joined;
  return joined;
}

export function allowanceSource(usage: UsageInfo | null): string {
  return usage?.source === 'claude-native' ? 'Native OAuth credentials'
    : usage?.source === 'claude-cli' ? 'CLI OAuth credentials'
    : usage?.source === 'unavailable' ? 'No allowance source available' : 'Source not reported';
}

export function allowanceFreshness(usage: UsageInfo | null, now = Date.now()): string {
  if (!usage) return 'waiting for data';
  if (usage.stale || now - usage.fetchedAt > 2 * 60 * 1000) return 'stale';
  return usage.freshness ?? 'freshness not reported';
}

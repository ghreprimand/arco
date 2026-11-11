// Since 0.2 the release tag identifies the app, while engine packages keep
// their own version. Display-only metadata; this never installs a feed asset.
export function strataEngineReleaseVersion(feed: unknown, release: unknown): string | undefined {
  const f = feed as { schema_version?: number; feed?: string; engine?: { packages?: Array<{ version?: unknown }> } } | null;
  const numeric = (s: unknown): s is string => typeof s === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(s);
  if (f?.schema_version === 1 && f.feed === 'strata-updates' && Array.isArray(f.engine?.packages)) {
    const versions = f.engine.packages.map((p) => p?.version).filter(numeric);
    versions.sort((a, b) => {
      const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
      for (let i = 0; i < Math.max(aa.length, bb.length); i++) { const delta = (bb[i] ?? 0) - (aa[i] ?? 0); if (delta) return delta; }
      return 0;
    });
    if (versions.length) return versions[0];
  }
  const r = release as { tag_name?: unknown; body?: unknown } | null;
  const stated = typeof r?.body === 'string' ? r.body.match(/\bEngine package version\s+v?(\d+\.\d+\.\d+(?:\.\d+)?)/i)?.[1] : undefined;
  if (stated) return stated;
  // Legacy 0.1 releases used the engine version as the overall tag. A new
  // app tag without engine metadata must stay unknown, never be compared.
  const tag = typeof r?.tag_name === 'string' ? r.tag_name.replace(/^v/, '') : '';
  return /^0\.1\.\d+(?:\.\d+)?$/.test(tag) ? tag : undefined;
}

// llama.cpp changed its semantic-version format without resetting build order.
// Release tags are bNNNNN; old binaries expose NNNNN (commit), newer ones
// include an explicit build field. Never substitute semver for a missing build.
export function llamacppBuild(version: string): number | undefined {
  const value = /\bbuild[ \t]*[:=]?[ \t]*(\d+)\b/i.exec(version)?.[1]
    ?? /^(?:b|v)?(\d+)(?:\s*\(|\s*$)/i.exec(version.trim())?.[1];
  const build = value === undefined ? undefined : Number(value);
  return build !== undefined && Number.isSafeInteger(build) ? build : undefined;
}

export function compareLlamacppBuild(a: string, b: string): number | undefined {
  const aa = llamacppBuild(a), bb = llamacppBuild(b);
  return aa === undefined || bb === undefined ? undefined : aa < bb ? -1 : aa > bb ? 1 : 0;
}

// Platform-build resolution for npm-installed provider CLIs.
//
// Why this exists: the codex CLI (and any npm package built the same way) ships
// as a thin JS wrapper whose real binary lives in a *platform-specific
// optionalDependency* (`@openai/codex-linux-x64`, aliased to
// `npm:@openai/codex@<version>-linux-x64`). npm treats a missing optional dep as
// a non-error, so if the wrapper is installable but that platform's build is
// not, `npm install -g <pkg>@latest` exits 0 and leaves a CLI that throws on
// every invocation.
//
// The failure is a *publish race*, which is why it keeps recurring: upstream
// moves the `latest` tag when the wrapper is published, and the six platform
// tarballs land separately. Observed directly on 2026-09-04 — at 19:12 local,
// `@openai/codex@0.153.3` was `latest` with no `0.153.3-linux-x64` in the
// registry (the `linux-x64` dist-tag still read 0.153.2); by 19:35 the build had
// appeared and the same install succeeded. Anyone who clicks update inside that
// window gets a broken codex, and clicking again later silently fixes it, which
// is exactly the "broke again / worked again" pattern the operator sees.
//
// So the resolver's job is not to route around a permanently-missing build; it
// is to notice the window and decline to install into it, keeping the operator
// on a CLI that runs until the build shows up.
//
// Everything here is deterministic registry lookup — no model involvement.

const NPM_REGISTRY = 'https://registry.npmjs.org';
const MANIFEST_TIMEOUT_MS = 6_000;
// The abbreviated packument for a busy package is multiple MB, so it is only
// fetched on the walk-back path (i.e. when `latest` is already known bad).
const PACKUMENT_TIMEOUT_MS = 20_000;
// How far back to look for a version that does have a build for this platform.
// A walk-back is a downgrade, not a fix — during a publish race the answer is
// one or two versions back. Cap it so a package that genuinely stopped shipping
// this platform fails loudly instead of silently installing something ancient.
const MAX_WALK_BACK = 25;

/** `linux-x64`, `darwin-arm64`, `win32-x64`, … — matches the npm naming convention. */
export function platformKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`;
}

export interface PlatformDep {
  /** Dependency name as the wrapper's `require.resolve` sees it. */
  name: string;
  /** Package actually fetched from the registry (differs when aliased). */
  realName: string;
  /** Version of `realName` to fetch. */
  realVersion: string;
}

/**
 * Pick the optionalDependency that carries *this package's own* native binary
 * for this platform. Handles both plain entries (`"@foo/bar-linux-x64": "1.2.3"`)
 * and npm aliases (`"@foo/bar-linux-x64": "npm:@foo/bar@1.2.3-linux-x64"`),
 * matching the platform suffix on the alias target as well as the dependency
 * name so a package that encodes it in only one of the two is still found.
 *
 * `ownPackage` is the narrowing that keeps this honest. Plenty of CLIs pull in
 * *someone else's* platform build as an optional dep and run fine without it —
 * @google/gemini-cli optionally depends on `@lydell/node-pty-linux-x64`, and
 * treating that as its binary would downgrade gemini over a package that has
 * nothing to do with whether `gemini` starts. Only a build the package publishes
 * for itself is load-bearing, so only that one gates the install.
 */
export function findPlatformDep(
  optionalDependencies: Record<string, string> | undefined,
  key = platformKey(),
  ownPackage?: string,
): PlatformDep | null {
  for (const [name, spec] of Object.entries(optionalDependencies ?? {})) {
    const alias = /^npm:(.+)@([^@]+)$/.exec(spec);
    const realName = alias ? alias[1] : name;
    const realVersion = alias ? alias[2] : spec;
    if (!name.endsWith(`-${key}`) && !realVersion.endsWith(`-${key}`)) continue;
    // Self-published means either the alias points back at the package itself
    // (codex's `npm:@openai/codex@…-linux-x64`) or the dep is the package name
    // with a platform suffix (`@foo/bar` → `@foo/bar-linux-x64`).
    if (ownPackage && realName !== ownPackage && !name.startsWith(`${ownPackage}-`)) continue;
    return { name, realName, realVersion };
  }
  return null;
}

async function fetchJson(url: string, timeoutMs: number, abbreviated = false): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      // The abbreviated packument omits README/maintainer bulk. Still large,
      // but roughly an order of magnitude smaller than the full document.
      headers: abbreviated ? { Accept: 'application/vnd.npm.install-v1+json' } : {},
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Registry path-encodes the scope slash. */
function encodePkg(pkg: string): string {
  return pkg.replace('/', '%2F');
}

interface Manifest {
  version?: string;
  optionalDependencies?: Record<string, string>;
}

/** Plain `x.y.z` only — prereleases and the `-linux-x64` build entries are not install targets. */
const PLAIN_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function compareVersions(a: string, b: string): number {
  const pa = PLAIN_SEMVER.exec(a)!;
  const pb = PLAIN_SEMVER.exec(b)!;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

export interface ResolvedInstall {
  /** Version to hand `npm install -g <pkg>@<version>`. */
  version: string;
  /** Registry `latest`, for reporting when we had to walk back off it. */
  latest?: string;
  /** The platform build this version needs, when the package has one. */
  platformDep?: PlatformDep;
  /** True when `version` is deliberately older than `latest`. */
  degraded: boolean;
  /** Operator-facing one-liner explaining a non-obvious choice. Null when boring. */
  notice: string | null;
}

/**
 * Decide which version of `pkg` can actually be installed and run on this
 * machine. Returns null when the registry is unreachable — the caller should
 * fall back to plain `@latest` rather than block the update on a network blip.
 */
export async function resolveInstallableVersion(pkg: string): Promise<ResolvedInstall | null> {
  const latestManifest = await fetchJson(`${NPM_REGISTRY}/${encodePkg(pkg)}/latest`, MANIFEST_TIMEOUT_MS) as Manifest | null;
  const latest = latestManifest?.version;
  if (!latest) return null;

  const dep = findPlatformDep(latestManifest?.optionalDependencies, platformKey(), pkg);
  // No self-published native binary (pure-JS CLIs, and CLIs whose only platform
  // deps belong to third parties) — nothing to verify, `latest` is the answer.
  if (!dep) return { version: latest, latest, degraded: false, notice: null };

  const published = await fetchJson(`${NPM_REGISTRY}/${encodePkg(dep.realName)}/${dep.realVersion}`, MANIFEST_TIMEOUT_MS);
  if (published) return { version: latest, latest, platformDep: dep, degraded: false, notice: null };

  // `latest` has no build for this platform — almost always because the tarballs
  // have not finished publishing. Walk back to the newest version that does have
  // one so the operator ends up on a CLI that runs, and say so plainly enough
  // that "retry in a bit" is the obvious next move.
  const packument = await fetchJson(`${NPM_REGISTRY}/${encodePkg(pkg)}`, PACKUMENT_TIMEOUT_MS, true) as
    { versions?: Record<string, Manifest> } | null;
  const versions = packument?.versions;
  if (!versions) {
    return {
      version: latest,
      latest,
      platformDep: dep,
      degraded: false,
      notice: `${pkg}@${latest} has no ${platformKey()} build published yet and the version list could not be read`,
    };
  }

  const candidates = Object.keys(versions)
    .filter((v) => PLAIN_SEMVER.test(v))
    .sort(compareVersions)
    .reverse()
    .slice(0, MAX_WALK_BACK);

  for (const candidate of candidates) {
    if (candidate === latest) continue;
    const candidateDep = findPlatformDep(versions[candidate]?.optionalDependencies, platformKey(), pkg);
    // The build entries live in this same packument under their suffixed
    // version, so availability is answerable without another round-trip.
    if (candidateDep && versions[candidateDep.realVersion]) {
      return {
        version: candidate,
        latest,
        platformDep: candidateDep,
        degraded: true,
        notice: `${pkg}@${latest} has no ${platformKey()} build published yet — installed ${candidate} instead (newest with one). Re-run the update once upstream finishes publishing.`,
      };
    }
  }

  return {
    version: latest,
    latest,
    platformDep: dep,
    degraded: false,
    notice: `${pkg}@${latest} has no ${platformKey()} build and neither do the ${MAX_WALK_BACK} versions before it`,
  };
}

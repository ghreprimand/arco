// H21 — OSV malware pre-check at MCP registry-add. An operator pasting an MCP
// server command (`npx -y @scope/foo`, `uvx some-pkg`) is one supply-chain step
// from running an attacker's package. Before persisting the registry entry we
// ask OSV (osv.dev) whether the referenced package is a KNOWN-MALICIOUS one
// (an `MAL-…` advisory) and, if so, block-with-override: the operator must
// explicitly acknowledge before the add proceeds.
//
// Discipline (armed-B):
//   • Operator-armed override — never silently blocks; the operator can proceed.
//   • Deterministic           — flags only on an affirmative OSV malware ID.
//   • FAIL-OPEN               — a network error / timeout / parse failure never
//                               blocks the add (we warn-or-allow, never wedge the
//                               operator out of adding a server because osv.dev
//                               was unreachable).
//   • Malware only            — ordinary CVEs do NOT block (an MCP server with a
//                               garden-variety vuln is the operator's call); we
//                               key strictly on the `MAL-` advisory prefix.

const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';

export interface PackageRef {
  name: string;
  ecosystem: 'npm' | 'PyPI';
}

// Strip a version/tag suffix from a package spec, preserving an `@scope/name`.
// `@scope/name@1.2.3` → `@scope/name`; `pkg@1.0` → `pkg`; `pkg` → `pkg`.
function stripVersion(spec: string): string {
  if (spec.startsWith('@')) {
    const at = spec.indexOf('@', 1);
    return at === -1 ? spec : spec.slice(0, at);
  }
  const at = spec.indexOf('@');
  return at === -1 ? spec : spec.slice(0, at);
}

const NPX_VALUE_FLAGS = new Set(['-p', '--package', '-c', '--call']);

// Extract the package(s) a registry command would fetch. Only npx (npm) and uvx
// (PyPI) are recognized — a bare binary / absolute path references nothing OSV
// can check and returns []. Conservative: takes the first positional package
// spec (and any `-p/--package <spec>` values for npx).
export function extractPackages(command: string, args: string[]): PackageRef[] {
  const base = command.split(/[\\/]/).pop() ?? command;
  const isNpx = base === 'npx' || base === 'npx.cmd';
  const isUvx = base === 'uvx' || base === 'uvx.cmd';
  if (!isNpx && !isUvx) return [];
  const ecosystem: PackageRef['ecosystem'] = isNpx ? 'npm' : 'PyPI';
  const out: PackageRef[] = [];
  const seen = new Set<string>();
  const push = (spec: string) => {
    const name = stripVersion(spec.trim());
    if (!name || name.startsWith('-') || seen.has(name)) return;
    seen.add(name);
    out.push({ name, ecosystem });
  };
  let tookPositional = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-y' || a === '--yes') continue;
    if (isNpx && NPX_VALUE_FLAGS.has(a)) {
      const v = args[i + 1];
      if (v) { push(v); i++; }
      continue;
    }
    if (a.startsWith('-')) {
      // An unknown flag that takes a value would mis-parse; we only special-case
      // the known value-flags above. Bare flags are skipped.
      continue;
    }
    // First positional is the package spec; for npx, anything after it is the
    // binary's own argv (not a package).
    if (!tookPositional) { push(a); tookPositional = true; }
    break;
  }
  return out;
}

interface OsvBatchResponse {
  results?: Array<{ vulns?: Array<{ id?: string }> }>;
}

// True when an advisory id denotes OSV malware (the `MAL-` prefix).
export function isMalwareId(id: string | undefined): boolean {
  return typeof id === 'string' && id.toUpperCase().startsWith('MAL-');
}

export interface MalwareHit {
  name: string;
  ecosystem: string;
  ids: string[];
}

export interface OsvCheckResult {
  // Packages with at least one MAL- advisory. Empty ⇒ clean OR check skipped.
  malicious: MalwareHit[];
  // True when OSV was actually consulted (vs. nothing to check / failed open).
  checked: boolean;
  // Set when the network/parse failed — caller treats as fail-open (allow).
  error?: string;
}

// Query OSV for the given packages and return only MAL- (malware) matches.
// Fail-open: any error resolves to { malicious: [], checked:false, error }.
export async function checkPackagesForMalware(
  packages: PackageRef[],
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<OsvCheckResult> {
  if (packages.length === 0) return { malicious: [], checked: false };
  const doFetch = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 10_000);
  try {
    const body = JSON.stringify({
      queries: packages.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem } })),
    });
    const res = await doFetch(OSV_BATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return { malicious: [], checked: false, error: `OSV HTTP ${res.status}` };
    const json = (await res.json()) as OsvBatchResponse;
    const results = json.results ?? [];
    const malicious: MalwareHit[] = [];
    results.forEach((r, i) => {
      const pkg = packages[i];
      if (!pkg) return;
      const ids = (r.vulns ?? []).map((v) => v.id).filter(isMalwareId) as string[];
      if (ids.length > 0) malicious.push({ name: pkg.name, ecosystem: pkg.ecosystem, ids });
    });
    return { malicious, checked: true };
  } catch (err) {
    return { malicious: [], checked: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Convenience: extract + check in one call. Fail-open throughout.
export async function checkCommandForMalware(
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<OsvCheckResult> {
  return checkPackagesForMalware(extractPackages(command, args), opts);
}

import { execFile } from 'child_process';
import type { DiscoveredEndpoint, EndpointDiscoverResponse } from '@archon/shared';

// Workbench Expansion §D2 — OpenAI-compatible / Ollama endpoint auto-discovery.
//
// Probes a BOUNDED candidate set for model-list endpoints so the operator's
// workstation Ollama over Tailscale shows up as a suggestion in CONFIG instead
// of a hand-typed base URL. Mirrors Odysseus's discovery (bounded port list,
// private-ranges-only, short timeouts, dead-host cooldown).
//
// LOAD-BEARING FENCES (the design depends on these — do not relax):
//   • Bounded probing — NOT a port scanner. Candidate hosts = discovered
//     tailscale peers + localhost ONLY (LAN /24 sweeping deferred, see below).
//     Candidate ports = a fixed list (PROBE_PORTS). Host × port is the whole
//     set; |hosts| is small (peers are few), |ports| = 12.
//   • Private ranges ONLY. Every candidate host must pass isPrivateHost():
//     loopback, tailnet CGNAT 100.64/10, RFC1918 (10/8, 172.16/12,
//     192.168/16). A public IP is NEVER probed (the SSRF-equivalent fence).
//   • Operator-triggered. discoverEndpoints() runs only when the settings UI
//     calls GET /api/endpoints/discover. NO setInterval / background daemon.
//   • Suggestions only. The route returns endpoints; the operator clicks one to
//     fill settings.ollama.baseUrl and still hits Save. No auto-switch.
//   • 60s result cache + per-host dead-host cooldown (DEAD_HOST_COOLDOWN_MS).
//   • tailscale absent (ENOENT) ⇒ skip peers, still probe localhost. Never
//     crashes.
//
// LAN /24 sweeping is intentionally DEFERRED — even one /24 is 254 hosts × 12
// ports = 3048 probes, which drifts toward a port scanner and is slow on a cold
// cache. Tailscale-peers + localhost cover the documented Mac↔workstation use
// case. Revisit only with an explicit operator opt-in and a tighter bound.

// Fixed port list: Ollama's default + the OpenAI-compatible 8000-8010 band.
// 12 ports total. This is the ONLY port set — there is no scan.
export const PROBE_PORTS: readonly number[] = [
  11434, // Ollama default
  8000, 8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009, 8010, // OpenAI-compat band
];

// Per-probe timeout: a probe that doesn't answer fast is treated as dead.
const PROBE_TIMEOUT_MS = 700;
// Max probes in flight at once — bounds fd/socket pressure.
const PROBE_CONCURRENCY = 8;
// Overall deadline for one discoverEndpoints() call — a hard ceiling so the
// route can't hang the settings UI even if many candidates stall.
const OVERALL_DEADLINE_MS = 8000;
// `tailscale status --json` own timeout.
const TAILSCALE_TIMEOUT_MS = 2500;

// Result cache + dead-host cooldown windows.
const RESULT_CACHE_MS = 60_000;
const DEAD_HOST_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------- pure helpers

// True if `host` is loopback, tailnet CGNAT (100.64/10), or RFC1918. Used
// to reject any peer IP outside private ranges BEFORE it becomes a probe
// target. Non-IP literals (e.g. 'localhost') are accepted only when explicitly
// loopback; an unparseable/foreign host returns false.
export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map((s) => Number(s));
  if (o.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = o;
  // Loopback 127/8
  if (a === 127) return true;
  // RFC1918
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Tailnet CGNAT 100.64/10  (100.64.x – 100.127.x)
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

// A peer extracted from `tailscale status --json`.
export interface TailscalePeer {
  ip: string;
  name?: string;
  online: boolean;
}

// Parse the `Peer` map out of `tailscale status --json` into candidate peers.
// Each peer's first v4 TailscaleIP (the 100.x) is the host. Offline peers
// (Online:false) are kept here but the candidate-builder drops them — we keep
// the flag so callers/tests can see the distinction. Tolerant of shape drift:
// a malformed blob yields an empty list, never throws.
export function parseTailscalePeers(json: unknown): TailscalePeer[] {
  if (!json || typeof json !== 'object') return [];
  const peerMap = (json as Record<string, unknown>).Peer;
  if (!peerMap || typeof peerMap !== 'object') return [];
  const out: TailscalePeer[] = [];
  for (const raw of Object.values(peerMap as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const ips = Array.isArray(p.TailscaleIPs) ? (p.TailscaleIPs as unknown[]) : [];
    // First IPv4 (the 100.x); skip IPv6 entries.
    const v4 = ips.find((x) => typeof x === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(x));
    if (typeof v4 !== 'string') continue;
    const dns = typeof p.DNSName === 'string' ? p.DNSName : undefined;
    const host = typeof p.HostName === 'string' ? p.HostName : undefined;
    out.push({
      ip: v4,
      name: (dns || host || undefined)?.replace(/\.$/, ''),
      online: p.Online === true,
    });
  }
  return out;
}

export interface Candidate {
  host: string;
  port: number;
  source: 'localhost' | 'tailscale';
  peerName?: string;
}

// Build the BOUNDED host × port candidate set: localhost + online,
// private-range tailscale peers, each crossed with PROBE_PORTS. Offline peers
// and non-private IPs are dropped here. Deduped by host so a peer that resolves
// to the same IP isn't probed twice.
export function buildCandidates(peers: TailscalePeer[]): Candidate[] {
  const out: Candidate[] = [];
  // localhost is always a candidate.
  for (const port of PROBE_PORTS) {
    out.push({ host: '127.0.0.1', port, source: 'localhost' });
  }
  const seenHosts = new Set<string>(['127.0.0.1']);
  for (const peer of peers) {
    if (!peer.online) continue;
    if (!isPrivateHost(peer.ip)) continue; // SSRF fence: public IPs rejected
    if (seenHosts.has(peer.ip)) continue;
    seenHosts.add(peer.ip);
    for (const port of PROBE_PORTS) {
      out.push({ host: peer.ip, port, source: 'tailscale', peerName: peer.name });
    }
  }
  return out;
}

// Parse a /api/tags or /v1/models JSON body into model names. Returns null when
// the body matches neither shape (treated as "not a model endpoint").
export function parseModelList(api: 'ollama' | 'openai', body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (api === 'ollama') {
    if (!Array.isArray(b.models)) return null;
    return b.models
      .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>).name : undefined))
      .filter((n): n is string => typeof n === 'string');
  }
  // openai
  if (!Array.isArray(b.data)) return null;
  return b.data
    .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>).id : undefined))
    .filter((n): n is string => typeof n === 'string');
}

// --------------------------------------------------------------- network I/O

// Probe a single candidate. Races /api/tags (Ollama) then /v1/models (OpenAI)
// against PROBE_TIMEOUT_MS. Returns the first that answers 200 with a parseable
// model list, else null. NEVER throws — a refused/timed-out/garbage response is
// just "not discovered". `host` MUST already be private-range-filtered upstream
// (buildCandidates enforces it); the timeout makes a closed port fail fast.
export async function probeCandidate(cand: Candidate): Promise<DiscoveredEndpoint | null> {
  const baseUrl = `http://${cand.host}:${cand.port}`;
  const attempts: Array<{ api: 'ollama' | 'openai'; path: string }> = [
    { api: 'ollama', path: '/api/tags' },
    { api: 'openai', path: '/v1/models' },
  ];
  for (const { api, path } of attempts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}${path}`, { signal: ctrl.signal });
      if (!res.ok) continue;
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        continue;
      }
      const models = parseModelList(api, body);
      if (!models) continue;
      return {
        baseUrl,
        host: cand.host,
        port: cand.port,
        api,
        modelCount: models.length,
        sampleModels: models.slice(0, 5),
        source: cand.source,
        peerName: cand.peerName,
      };
    } catch {
      // refused / aborted / DNS — try the next path, then give up.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Run `tailscale status --json`. execFile/argv ONLY — never a shell string.
// ENOENT (CLI absent) or any error ⇒ null, so discovery degrades to localhost.
async function runTailscaleStatus(): Promise<unknown | null> {
  return new Promise((resolve) => {
    execFile(
      'tailscale',
      ['status', '--json'],
      { timeout: TAILSCALE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

// Bounded-concurrency map: at most `limit` of `fn` in flight at once.
async function pooledMap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ----------------------------------------------------- cache + dead-host state

interface CacheState {
  at: number;
  payload: EndpointDiscoverResponse;
}
let resultCache: CacheState | null = null;
// host → epoch-ms when the cooldown lifts. A host probed and found fully dead
// (no port answered) is skipped until then.
const deadHostUntil = new Map<string, number>();

// Test seam: reset module state so the smoke can exercise probeCandidate /
// helpers without stale cache bleed.
export function _resetDiscoveryStateForTest(): void {
  resultCache = null;
  deadHostUntil.clear();
}

// ----------------------------------------------------------- public entrypoint

// Operator-triggered discovery. Returns cached result inside RESULT_CACHE_MS.
// Otherwise: read tailscale peers (graceful if absent), build the bounded
// candidate set, drop hosts in dead-host cooldown, probe with bounded
// concurrency under an overall deadline, cache + return. Suggestions only —
// this function never touches settings.
export async function discoverEndpoints(): Promise<EndpointDiscoverResponse> {
  const now = Date.now();
  if (resultCache && now - resultCache.at < RESULT_CACHE_MS) {
    return { ...resultCache.payload, cached: true };
  }

  const statusJson = await runTailscaleStatus();
  const tailscaleAvailable = statusJson !== null;
  const peers = parseTailscalePeers(statusJson);
  const candidates = buildCandidates(peers).filter((c) => {
    const until = deadHostUntil.get(c.host);
    return !(until && Date.now() < until);
  });

  // Overall deadline: abort outstanding probes once OVERALL_DEADLINE_MS elapses
  // so a slow/stalled host can't hang the route. Probes that don't finish in
  // time are treated as "not discovered" for this call.
  const deadline = Date.now() + OVERALL_DEADLINE_MS;
  const probed = await pooledMap(candidates, PROBE_CONCURRENCY, async (c) => {
    if (Date.now() >= deadline) return null;
    return probeCandidate(c);
  });

  // Track per-host liveness for the dead-host cooldown: a host where NO port
  // answered enters cooldown; a host that answered on any port is cleared.
  const answeredHosts = new Set<string>();
  const endpoints: DiscoveredEndpoint[] = [];
  const seenBaseUrls = new Set<string>();
  for (const ep of probed) {
    if (!ep) continue;
    answeredHosts.add(ep.host);
    if (seenBaseUrls.has(ep.baseUrl)) continue;
    seenBaseUrls.add(ep.baseUrl);
    endpoints.push(ep);
  }
  const cooldownUntil = Date.now() + DEAD_HOST_COOLDOWN_MS;
  for (const host of new Set(candidates.map((c) => c.host))) {
    if (answeredHosts.has(host)) {
      deadHostUntil.delete(host);
    } else {
      deadHostUntil.set(host, cooldownUntil);
    }
  }

  const payload: EndpointDiscoverResponse = {
    endpoints,
    tailscaleAvailable,
    cached: false,
  };
  resultCache = { at: Date.now(), payload };
  return payload;
}

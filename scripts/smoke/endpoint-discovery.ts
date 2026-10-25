// Workbench Expansion §D2 — Endpoint auto-discovery smoke.
//
// Two legs, NO live tailscale + NO live Ollama:
//
//   1. UNIT CORE (no network): feed a hand-written `tailscale status --json`
//      blob with 3 peers — one normal private peer, one PUBLIC-IP peer that
//      MUST be filtered out, one Online:false peer that MUST be dropped from
//      the candidate set. Assert peer extraction, the private-range predicate,
//      and that the candidate set is BOUNDED (hosts × fixed ports), not a sweep.
//
//   2. REAL LOCAL PROBE (loopback only): spin a throwaway http server that
//      answers /v1/models, point probeCandidate at 127.0.0.1:<port>, assert it's
//      discovered as 'openai' with the right model info; then probe a closed
//      port and assert it fails fast (within the per-probe timeout) and is NOT
//      discovered. Tear the server down cleanly.
//
// Run: npm run smoke:endpoint-discovery  (no dev server needed)

import { createServer, type Server } from 'http';
import { step, assert, assertEq, summary } from './lib.js';
import {
  parseTailscalePeers,
  isPrivateHost,
  buildCandidates,
  parseModelList,
  probeCandidate,
  PROBE_PORTS,
  type Candidate,
} from '../../server/src/providers/endpointDiscovery.js';

// Representative `tailscale status --json` blob.
//   workstation — private 100.x CGNAT, online → MUST be a candidate.
//   public-vps  — a PUBLIC routable IP (203.0.113.x), online → MUST be filtered.
//   laptop      — private 100.x, Online:false → MUST be dropped (offline).
const statusBlob = {
  Self: { TailscaleIPs: ['100.64.0.1'], HostName: 'self' },
  Peer: {
    'key-workstation': {
      TailscaleIPs: ['100.100.1.2', 'fd7a:115c:a1e0::1'],
      HostName: 'workstation',
      DNSName: 'workstation.tailnet.ts.net.',
      Online: true,
    },
    'key-public-vps': {
      // A public IP must NEVER become a probe target (SSRF-equivalent fence).
      TailscaleIPs: ['203.0.113.7'],
      HostName: 'public-vps',
      Online: true,
    },
    'key-laptop': {
      TailscaleIPs: ['100.100.5.9'],
      HostName: 'laptop',
      Online: false,
    },
  },
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

async function main() {
  await step('parseTailscalePeers extracts the v4 100.x + name + online flag', () => {
    const peers = parseTailscalePeers(statusBlob);
    assertEq(peers.length, 3, 'three peers parsed');
    const ws = peers.find((p) => p.name === 'workstation.tailnet.ts.net');
    assert(ws, 'workstation peer present (DNSName, trailing dot stripped)');
    assertEq(ws!.ip, '100.100.1.2', 'first v4 IP chosen (IPv6 skipped)');
    assertEq(ws!.online, true, 'workstation online');
    const laptop = peers.find((p) => p.name === 'laptop');
    assertEq(laptop!.online, false, 'laptop offline flag preserved');
  });

  await step('isPrivateHost accepts loopback / CGNAT / RFC1918, rejects public', () => {
    // The predicate: loopback, tailnet CGNAT 100.64.0.0/10, RFC1918.
    assert(isPrivateHost('127.0.0.1'), 'loopback');
    assert(isPrivateHost('localhost'), 'localhost literal');
    assert(isPrivateHost('100.100.1.2'), 'tailnet CGNAT 100.64/10');
    assert(isPrivateHost('100.64.0.1'), 'CGNAT low edge');
    assert(isPrivateHost('100.127.255.255'), 'CGNAT high edge');
    assert(isPrivateHost('10.0.0.5'), '10/8');
    assert(isPrivateHost('172.16.0.1'), '172.16/12 low');
    assert(isPrivateHost('172.31.255.1'), '172.16/12 high');
    assert(isPrivateHost('192.168.1.1'), '192.168/16');
    // Rejections — these must NEVER be probed.
    assert(!isPrivateHost('203.0.113.7'), 'public TEST-NET rejected');
    assert(!isPrivateHost('8.8.8.8'), 'public 8.8.8.8 rejected');
    assert(!isPrivateHost('100.128.0.1'), 'just above CGNAT rejected');
    assert(!isPrivateHost('172.32.0.1'), 'just above 172.16/12 rejected');
    assert(!isPrivateHost('example.com'), 'foreign hostname rejected');
  });

  await step('buildCandidates is BOUNDED: localhost + online private peers × fixed ports', () => {
    const peers = parseTailscalePeers(statusBlob);
    const cands = buildCandidates(peers);
    const hosts = new Set(cands.map((c) => c.host));
    // Expected hosts: 127.0.0.1 + workstation only. public-vps filtered (SSRF),
    // laptop dropped (offline).
    assert(hosts.has('127.0.0.1'), 'localhost is always a candidate');
    assert(hosts.has('100.100.1.2'), 'online private peer is a candidate');
    assert(!hosts.has('203.0.113.7'), 'PUBLIC peer NOT a candidate (filtered)');
    assert(!hosts.has('100.100.5.9'), 'OFFLINE peer NOT a candidate (dropped)');
    assertEq(hosts.size, 2, 'exactly 2 candidate hosts');
    // Bounded: |hosts| × |PROBE_PORTS|, not a port sweep.
    assertEq(PROBE_PORTS.length, 12, 'fixed port list is 12 ports');
    assertEq(cands.length, 2 * PROBE_PORTS.length, 'candidate count = hosts × fixed ports');
    // No port outside the fixed list snuck in.
    const portSet = new Set(PROBE_PORTS);
    assert(cands.every((c) => portSet.has(c.port)), 'every candidate port is in the fixed list');
  });

  await step('buildCandidates with no peers → localhost only (tailscale-absent shape)', () => {
    const cands = buildCandidates([]);
    const hosts = new Set(cands.map((c) => c.host));
    assertEq(hosts.size, 1, 'only localhost');
    assert(hosts.has('127.0.0.1'), 'localhost present');
    assertEq(cands.length, PROBE_PORTS.length, 'localhost × fixed ports');
  });

  await step('parseModelList handles both shapes + rejects non-model bodies', () => {
    assertEq(JSON.stringify(parseModelList('ollama', { models: [{ name: 'qwen' }, { name: 'llama' }] })),
      JSON.stringify(['qwen', 'llama']), 'ollama /api/tags shape');
    assertEq(JSON.stringify(parseModelList('openai', { data: [{ id: 'gpt-x' }] })),
      JSON.stringify(['gpt-x']), 'openai /v1/models shape');
    assertEq(parseModelList('ollama', { something: 1 }), null, 'wrong shape → null');
    assertEq(parseModelList('openai', { foo: 'bar' }), null, 'wrong shape → null');
  });

  // ---- Real local probe leg ------------------------------------------------
  let server: Server | null = null;
  let livePort = 0;
  await step('real probe: a live /v1/models responder on loopback IS discovered', async () => {
    server = createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'local-model-a' }, { id: 'local-model-b' }] }));
        return;
      }
      // Make /api/tags miss so the prober falls through to /v1/models.
      res.writeHead(404);
      res.end();
    });
    livePort = await listen(server);
    const cand: Candidate = { host: '127.0.0.1', port: livePort, source: 'localhost' };
    const ep = await probeCandidate(cand);
    assert(ep, 'endpoint discovered');
    assertEq(ep!.api, 'openai', 'detected as openai (via /v1/models)');
    assertEq(ep!.baseUrl, `http://127.0.0.1:${livePort}`, 'baseUrl matches');
    assertEq(ep!.modelCount, 2, 'two models reported');
    assert(ep!.sampleModels.includes('local-model-a'), 'sample models carried');
    assertEq(ep!.source, 'localhost', 'source preserved');
  });

  await step('real probe: a CLOSED port fails fast and is NOT discovered', async () => {
    // Close the live server, then probe what is now a closed port.
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const t0 = Date.now();
    const ep = await probeCandidate({ host: '127.0.0.1', port: livePort, source: 'localhost' });
    const dt = Date.now() - t0;
    assertEq(ep, null, 'closed port → not discovered');
    // Fails fast: connection-refused returns immediately, and even a stall is
    // bounded by the per-probe timeout (≈700ms each, two paths). Generous
    // ceiling here to stay non-flaky on slow CI while still proving "fast".
    assert(dt < 3000, `closed-port probe returned fast (${dt}ms)`);
  });

  // Safety net: ensure the server is torn down even if a step above bailed.
  if (server) {
    await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
  }

  summary('endpoint-discovery');
}

main();

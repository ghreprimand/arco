// ANTIGRAVITY_RPC_INTEGRATION_PLAN.md Phase D — cluster bridge discovery.
//
// Verifies:
//   1. Antigravity remains fenced out of ClusterMemberProvider.
//   2. The disabled fallback CLI bridge skeleton exists and is not enabled by
//      default.
//   3. Live Antigravity RPC discovery invokes read-only methods only.
//   4. Registration/config candidates are static-scanned/reported but not
//      invoked against the desktop app.
//
// Exits 0 on successful discovery, 1 on failed assertions, 2 if live
// Antigravity desktop/RPC is unavailable.

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { isClusterMemberProvider } from '@archon/shared';
import { antigravityManager } from '../../server/src/providers/antigravityManager.js';
import { probeAntigravityRpcToolBridge } from '../../server/src/providers/antigravityRpc.js';
import {
  ANTIGRAVITY_RPC_READONLY_DISCOVERY_METHODS,
  ANTIGRAVITY_RPC_TOOL_REGISTRATION_CANDIDATES,
  antigravityClusterBridgeEnabled,
  buildAntigravityClusterToolStub,
} from '../../server/src/providers/antigravityClusterBridge.js';

const LANGUAGE_SERVER_BINARY = process.env.ANTIGRAVITY_LANGUAGE_SERVER_BINARY
  ?? '/opt/antigravity/resources/app/extensions/antigravity/bin/language_server_linux_x64';

let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`); };
const pass = (msg: string) => { console.log(`  PASS  ${msg}`); };

function staticMethodScan(): string[] {
  if (!existsSync(LANGUAGE_SERVER_BINARY)) return [];
  const r = spawnSync('bash', [
    '-lc',
    'strings -a "$1" | grep -oE "_LanguageServerService_[A-Za-z0-9]+_Handler" | sed -E "s/^_LanguageServerService_//; s/_Handler$//" | sort -u',
    'bash',
    LANGUAGE_SERVER_BINARY,
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  console.log('Antigravity Phase D smoke (cluster bridge discovery)');
  console.log('====================================================');
  console.log('');

  if (isClusterMemberProvider('antigravity')) {
    fail('shared cluster provider fence rejects antigravity');
  } else {
    pass('shared cluster provider fence rejects antigravity');
  }

  if (antigravityClusterBridgeEnabled()) {
    fail('ARCHON_ANTIGRAVITY_CLUSTER_BRIDGE is disabled by default');
  } else {
    pass('ARCHON_ANTIGRAVITY_CLUSTER_BRIDGE is disabled by default');
  }

  const stub = buildAntigravityClusterToolStub();
  for (const name of ['peer_list', 'peer_send', 'peer_read', 'cluster_plan_tick', 'cluster_plan_write']) {
    if (!stub.includes(name)) fail(`fallback CLI stub includes ${name}`);
  }
  if (failures === 0) pass('fallback CLI stub exposes all five cluster commands');

  const methods = staticMethodScan();
  if (methods.length > 0) {
    const mcpMethods = methods.filter((m) => /Mcp|Tool|Plugin/i.test(m));
    const registrationMethods = methods.filter((m) => /Register.*Tool|RegisterLocal|RegisterDynamic|Set.*Tool/i.test(m));
    console.log('');
    console.log(`Static language-server method scan: ${methods.length} method(s), ${mcpMethods.length} MCP/tool/plugin-shaped method(s)`);
    console.log(`  MCP/tool/plugin methods: ${mcpMethods.slice(0, 30).join(', ') || '(none)'}`);
    console.log(`  registration-shaped methods: ${registrationMethods.join(', ') || '(none)'}`);
  } else {
    console.log('');
    console.log(`Static language-server method scan skipped (binary not readable at ${LANGUAGE_SERVER_BINARY})`);
  }

  const diag = await antigravityManager.diagnostics();
  console.log('');
  console.log('Diagnostics:');
  console.log(`  installed:         ${diag.installed}`);
  console.log(`  desktop reachable: ${diag.cdp.reachable} (port :${diag.cdpPort})`);
  console.log(`  profile mode:      ${diag.profileMode}`);
  if (!diag.available) {
    console.log(`Antigravity desktop/RPC unavailable: ${diag.reason ?? 'unknown'}`);
    console.log('Live RPC discovery not run. Launch Antigravity and re-run this smoke.');
    process.exit(2);
  }

  try {
    const probe = await probeAntigravityRpcToolBridge();
    console.log('');
    console.log('Live RPC discovery:');
    console.log(`  endpoint: pid=${probe.endpoint.pid}, port=${probe.endpoint.httpPort}`);
    console.log(`  live methods invoked: ${probe.liveInvokedMethods.join(', ') || '(none)'}`);
    console.log(`  read-only methods ok: ${probe.readonlyMethods.filter((m) => m.ok).map((m) => m.method).join(', ') || '(none)'}`);
    console.log(`  registration candidates skipped: ${probe.registrationCandidates.map((m) => m.method).join(', ')}`);
    console.log(`  custom/local registration: ${probe.customToolRegistration}`);
    console.log(`  MCP surface: ${JSON.stringify(probe.mcpSurface)}`);
    console.log(`  conclusion: ${probe.conclusion}`);

    const readonlyAllowlist = new Set<string>(ANTIGRAVITY_RPC_READONLY_DISCOVERY_METHODS);
    const unexpectedLive = probe.liveInvokedMethods.filter((m) => !readonlyAllowlist.has(m));
    if (unexpectedLive.length > 0) {
      fail(`live discovery invoked non-read-only methods: ${unexpectedLive.join(', ')}`);
    } else {
      pass('live discovery invoked read-only methods only');
    }

    const candidateSet = new Set<string>(ANTIGRAVITY_RPC_TOOL_REGISTRATION_CANDIDATES);
    const invokedCandidates = probe.liveInvokedMethods.filter((m) => candidateSet.has(m));
    if (invokedCandidates.length > 0) {
      fail(`registration/config candidates were invoked: ${invokedCandidates.join(', ')}`);
    } else {
      pass('registration/config candidates were not invoked');
    }

    const skippedCandidates = probe.registrationCandidates.filter((m) =>
      candidateSet.has(m.method) &&
      m.invoked === false &&
      m.skipped === true &&
      m.source === 'static_candidate'
    );
    if (skippedCandidates.length !== ANTIGRAVITY_RPC_TOOL_REGISTRATION_CANDIDATES.length) {
      fail('all registration/config candidates are reported as static skipped candidates');
    } else {
      pass('all registration/config candidates are reported as static skipped candidates');
    }
  } catch (err) {
    fail(`live RPC discovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log('');
  if (failures === 0) {
    console.log('Phase D discovery smoke passed.');
    process.exit(0);
  }
  console.log(`${failures} Phase D check(s) failed.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

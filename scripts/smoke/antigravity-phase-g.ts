#!/usr/bin/env tsx
// Antigravity Phase G smoke (UI and documentation clarity).
//
// Structural only: verifies operator-facing labels and troubleshooting text
// without requiring the Antigravity desktop app.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function pass(label: string): void {
  console.log(`PASS ${label}`);
}

async function file(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

function assertIncludesAll(label: string, body: string, needles: string[]): void {
  for (const needle of needles) {
    assert.ok(body.includes(needle), `${label} missing: ${needle}`);
  }
  pass(label);
}

function assertMatchesAll(label: string, body: string, patterns: RegExp[]): void {
  for (const pattern of patterns) {
    assert.match(body, pattern, `${label} missing pattern: ${pattern}`);
  }
  pass(label);
}

function assertNoStaleActiveTransportText(label: string, path: string, body: string): void {
  const stale = /\b(CDP transport|DOM[- ]scrap(?:e|ing)|DOM composer injection|chat DOM scraping|Antigravity CDP)\b/i;
  const allowed = /\b(no longer uses CDP|liveness only|liveness probe|debug-port liveness|historical|does not use screen capture|not prompt transport)\b/i;
  const offenders = body
    .split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => stale.test(line) && !allowed.test(line));
  assert.equal(
    offenders.length,
    0,
    `${label} has stale active Antigravity transport wording:\n${offenders.map((o) => `${path}:${o.index}: ${o.line}`).join('\n')}`,
  );
}

async function main(): Promise<void> {
  console.log('Antigravity Phase G smoke (UI/docs)');

  const [
    rightPanel,
    userManual,
    helpContent,
    providers,
    operations,
    rpc,
    antigravityProvider,
  ] = await Promise.all([
    file('client/src/components/RightPanel.tsx'),
    file('client/src/components/UserManual.tsx'),
    file('client/src/help/helpContent.tsx'),
    file('docs/PROVIDERS.md'),
    file('docs/OPERATIONS.md'),
    file('server/src/providers/antigravityRpc.ts'),
    file('server/src/providers/antigravity.ts'),
  ]);

  assertIncludesAll('CONFIG labels: Antigravity RPC diagnostics', rightPanel, [
    'ANTIGRAVITY RPC',
    'Antigravity RPC',
    'DESKTOP REACHABILITY',
    'PROFILE',
    'CONFIGURED MODEL',
    'DISPLAY MODEL',
    'CASCADE STATE',
    'CTX',
    'Antigravity-managed',
    'MODEL ACCESS',
    'WEB SEARCH',
    'SHELL TOOLS',
    'PATH ATTACHMENTS',
    'NATIVE IMAGES',
    'CLUSTER TOOLS',
    'ARTIFACTS',
    'CONTEXT ACCOUNTING',
    'desktop/RPC is not reachable',
  ]);

  assertMatchesAll('CONFIG labels: capability values', rightPanel, [
    /info\.capabilities\.artifacts/,
    /info\.capabilities\.clusterTools/,
    /info\.reachable/,
    /configuredModelDisplayName/,
  ]);

  assertIncludesAll('Activity labels: Antigravity rows', rightPanel, [
    'WEB SEARCH',
    'BASH',
    'READ FILE',
    'WRITE FILE',
    'PERMISSION',
    'WAITING UNBRIDGED',
    'TIMED OUT',
    'waiting_unbridged_tool',
    'timed_out',
    'PermissionRequest',
  ]);

  assertIncludesAll('Trace path notice', rpc, [
    'ANTIGRAVITY_RPC_TRACE_STEPS',
    'step trace:',
    'antigravity-rpc-steps.jsonl',
  ]);

  assertIncludesAll('Attachment and artifact surfacing', antigravityProvider + providers + userManual, [
    'attachments delivered as local file paths',
    'not native Antigravity message parts',
    '[artifact:<name>]',
    'artifacts/images',
    'Metadata:',
    'Generated-image RPC shape',
  ]);

  const troubleshootingCorpus = [userManual, helpContent, providers, operations].join('\n');
  assertIncludesAll('Troubleshooting phrases', troubleshootingCorpus, [
    'App not launched / binary path',
    'Wrong profile or not signed in',
    'ANTIGRAVITY_USE_DEFAULT_PROFILE=1',
    'isolated profile',
    'gemini-3-flash-agent',
    'Gemini 3.5 Flash High',
    'in-app restart',
    'debug port is liveness only',
    'waiting_unbridged_tool',
    'timed_out',
    'Path-only attachments',
    'Artifacts partial',
    'Generated-image RPC shape',
    'Clusters disabled',
  ]);

  for (const [path, body] of [
    ['docs/PROVIDERS.md', providers],
    ['docs/OPERATIONS.md', operations],
    ['client/src/components/UserManual.tsx', userManual],
    ['client/src/help/helpContent.tsx', helpContent],
    ['client/src/components/RightPanel.tsx', rightPanel],
  ] as const) {
    assertNoStaleActiveTransportText('stale transport wording', path, body);
  }
  pass('stale transport wording: active docs/UI');

  console.log('Antigravity Phase G smoke complete.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

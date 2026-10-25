// Codex native compact smoke — operator-triggered `thread/compact/start`.
//
// Pure (no dev server, no live Codex): exercises the two guard surfaces that
// gate the feature. The actual compaction (RPC round-trip + thread/compacted
// resolution + CTX-bar drop) needs a live Codex app-server child and is covered
// by the UI acceptance in PRIMITIVES.md — not reachable headlessly.
//
//   1. compactThread() on a fresh (un-bootstrapped) worker returns a clean
//      structured error rather than throwing or hanging — no thread to compact.
//   2. The WS handler gates: unknown workflow, non-Codex provider, and busy
//      all short-circuit to an `error` BEFORE any RPC / broadcast / file IO.
//
// Run: npm run smoke:codex-compact

import type { WebSocket } from 'ws';
import type { WorkerConfig } from '@archon/shared';
import { step, assert, assertEq, summary } from './lib.js';
import { CodexAppServerWorker } from '../../server/src/providers/codex-appserver/worker.js';
import { handleCompactWorkflow } from '../../server/src/ws/compactHandlers.js';
import { workflows } from '../../server/src/server/state.js';
import type { WorkflowState } from '../../server/src/workflows/types.js';

const fakeSession = {} as Parameters<typeof handleCompactWorkflow>[1];

// Minimal fake ws — records the JSON messages the handler sends. readyState
// OPEN (1) so send() doesn't short-circuit.
function fakeWs() {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: 1,
    send: (s: string) => { sent.push(JSON.parse(s) as Record<string, unknown>); },
  } as unknown as WebSocket;
  return { ws, sent };
}

// The handler only reads wf.primary.provider + wf.busy on the guard paths, so a
// partial cast is enough — these never reach the compact RPC.
function fakeWorkflow(provider: 'claude' | 'codex', busy: boolean, claudeTransport?: 'cli' | 'native'): WorkflowState {
  return {
    primary: { provider },
    busy,
    config: { workingDirectory: '/tmp/archon-compact-smoke-nope', ...(claudeTransport ? { claudeTransport } : {}) },
  } as unknown as WorkflowState;
}

async function main() {
  await step('compactThread() on a fresh worker errors cleanly (no thread yet)', async () => {
    const worker = new CodexAppServerWorker('wf-fresh', {} as unknown as WorkerConfig, undefined);
    const res = await worker.compactThread();
    assertEq(res.ok, false, 'fresh worker compact is rejected');
    assert(/no Codex thread/i.test(res.error ?? ''), `error names the missing thread (got: ${res.error})`);
  });

  await step('handler rejects an unknown workflow', async () => {
    const { ws, sent } = fakeWs();
    await handleCompactWorkflow(ws, fakeSession, { type: 'compact_workflow', workflowId: 'nope-0000' });
    assertEq(sent.length, 1, 'one message sent');
    assertEq(sent[0].type, 'error', 'it is an error');
    assert(/unknown workflow/i.test(String(sent[0].message)), 'names the unknown workflow');
  });

  await step('handler rejects a CLI-transport Claude workflow (needs Native)', async () => {
    // Provider-routed: a Claude tab on the CLI transport has no in-process
    // history to summarize — the handler steers it to Handoff.
    workflows.set('wf-claude-cli', fakeWorkflow('claude', false, 'cli'));
    const { ws, sent } = fakeWs();
    await handleCompactWorkflow(ws, fakeSession, { type: 'compact_workflow', workflowId: 'wf-claude-cli' });
    workflows.delete('wf-claude-cli');
    assertEq(sent[0].type, 'error', 'errors');
    assert(/native transport/i.test(String(sent[0].message)), `says needs Native (got: ${sent[0].message})`);
  });

  await step('handler rejects a busy Codex workflow', async () => {
    workflows.set('wf-codex-busy', fakeWorkflow('codex', true));
    const { ws, sent } = fakeWs();
    await handleCompactWorkflow(ws, fakeSession, { type: 'compact_workflow', workflowId: 'wf-codex-busy' });
    workflows.delete('wf-codex-busy');
    assertEq(sent[0].type, 'error', 'errors');
    assert(/busy/i.test(String(sent[0].message)), 'says busy');
  });

  summary('Codex native compact — guards');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

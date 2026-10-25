#!/usr/bin/env tsx
// Antigravity Phase E smoke (context/session/cache/handoff semantics).
//
// Structural by default: does not require Antigravity desktop or a live turn.
// Verifies that Antigravity session metadata is opaque/provider-scoped, that
// the fresh-cascade persistence helper clears stored cascade ids, and that UI
// / server source paths carry the Phase E gates.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowSessionMetadata } from '@arco/shared';
import {
  appendHistoryEntry,
  arcoInternalSessionInfoForMeta,
  clearProviderCliSessions,
  latestCliSessionFor,
  readMeta,
  reconcileLatestCliSession,
  writeMeta,
  type WorkflowMeta,
} from '../../server/src/workflowMeta.js';

function pass(label: string): void {
  console.log(`PASS ${label}`);
}

async function main(): Promise<void> {
  console.log('Antigravity Phase E smoke (session/context semantics)');

  const metadata = {
    sessionKind: 'antigravity-cascade',
    cascadeId: 'cascade-smoke-old',
    opaqueContext: true,
    arcoAutoCompact: false,
    contextLabel: 'Antigravity-managed',
  } satisfies WorkflowSessionMetadata;
  assert.equal(metadata.sessionKind, 'antigravity-cascade');
  assert.equal(metadata.opaqueContext, true);
  assert.equal(metadata.arcoAutoCompact, false);
  pass('metadata: antigravity-cascade + opaque context');

  const cwd = await mkdtemp(join(tmpdir(), 'arco-antigravity-phase-e-'));
  const workflowId = 'wf-antigravity-phase-e';
  try {
    const now = Date.now();
    const meta: WorkflowMeta = {
      workflowId,
      name: 'Antigravity Phase E Smoke',
      cwd,
      createdAt: now,
      lastActiveAt: now,
      primaryProvider: 'antigravity',
      primaryModel: 'antigravity-desktop',
      primaryEffort: 'medium',
      cliSessions: [],
      history: [],
      operator: 'smoke',
      lastEventSeq: null,
      lastTranscriptSeq: null,
      compactedAt: null,
    };
    await writeMeta(cwd, meta);
    await reconcileLatestCliSession(cwd, workflowId, 'antigravity', 'cascade-smoke-old');
    let stored = await readMeta(cwd, workflowId);
    assert.equal(stored?.cliSessions.at(-1)?.sessionId, 'cascade-smoke-old');
    assert.ok(stored);

    const internal = arcoInternalSessionInfoForMeta(stored);
    assert.equal(internal?.arcoInternal, true);
    assert.equal(internal?.provider, 'antigravity');
    assert.equal(internal?.sessionId, workflowId);
    assert.equal(internal?.arcoWorkflowId, workflowId);
    pass('resume picker: Antigravity meta is exposed as arco-internal workflow-id resume');

    const restoredCascadeId = latestCliSessionFor(stored, 'antigravity')?.sessionId;
    const restoredMetadata = {
      sessionKind: 'antigravity-cascade',
      cascadeId: restoredCascadeId,
      opaqueContext: true,
      arcoAutoCompact: false,
      contextLabel: 'Antigravity-managed',
    } satisfies WorkflowSessionMetadata;
    assert.equal(restoredMetadata.cascadeId, 'cascade-smoke-old');
    pass('workflow-id resume: latest Antigravity cliSession restores cascade metadata');

    await appendHistoryEntry(cwd, workflowId, {
      sessionId: 'cascade-smoke-old',
      provider: 'antigravity',
      startedAt: now,
      endedAt: now + 1,
      turnCount: 1,
      archivedReason: 'fresh-cascade-reset',
    });
    await clearProviderCliSessions(cwd, workflowId, 'antigravity');
    stored = await readMeta(cwd, workflowId);
    assert.equal(stored?.cliSessions.some((s) => s.provider === 'antigravity'), false);
    assert.equal(stored?.history?.at(-1)?.archivedReason, 'fresh-cascade-reset');
    pass('fresh cascade: clears stored Antigravity cascade id and records reset history');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  const serverIndex = await readFile('server/src/index.ts', 'utf8');
  assert.match(serverIndex, /async function maybeAutoHandoff[\s\S]*?wf\.primary\.provider !== 'claude'/);
  assert.match(serverIndex, /async function maybeCalibrate[\s\S]*?wf\.primary\.provider !== 'claude'/);
  assert.match(serverIndex, /handleFreshAntigravityCascadeRequest/);
  pass('server: auto-handoff/calibration remain Claude-gated; fresh reset handler exists');

  const terminalInput = await readFile('client/src/components/TerminalInput.tsx', 'utf8');
  assert.match(terminalInput, /CTX: Antigravity-managed/);
  assert.doesNotMatch(terminalInput, /provider === 'antigravity'[\s\S]{0,300}percentOfWindow/);
  pass('client footer: Antigravity CTX is opaque and percent-free');

  const rightPanel = await readFile('client/src/components/RightPanel.tsx', 'utf8');
  assert.match(rightPanel, /AntigravitySessionSection/);
  assert.match(rightPanel, /FRESH CASCADE/);
  assert.match(rightPanel, /no Arco auto-handoff/);
  pass('client config: fresh-cascade action and opaque wording are present');

  console.log('Antigravity Phase E smoke complete (live desktop turn not run).');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});

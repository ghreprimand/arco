#!/usr/bin/env tsx
// docs/PROVIDERS.md - artifacts/generated images.
//
// Structural coverage always runs. If Antigravity desktop is reachable, the
// smoke also asks for a uniquely named text file in the workflow cwd and
// verifies Arco's provider-side ingestion copied it into artifacts/.
//
// Env:
//   ANTIGRAVITY_PHASE_F_STRUCTURAL_ONLY=1  skip live desktop turn
//   ANTIGRAVITY_PHASE_F_REQUIRE_LIVE=1     exit 2 when live desktop is unavailable

import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerConfig } from '@arco/shared';
import { AntigravityProvider } from '../../server/src/providers/antigravity.js';
import { antigravityManager } from '../../server/src/providers/antigravityManager.js';
import {
  ingestAntigravityArtifacts,
  snapshotAntigravityArtifactFiles,
  type AntigravityArtifactRecord,
} from '../../server/src/providers/antigravityArtifacts.js';

const STAMP = Date.now().toString(36);
const WORKFLOW_ID = `phase-f-${STAMP}`;
const TURN_TIMEOUT_MS = 5 * 60_000;
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function pass(label: string): void {
  console.log(`PASS ${label}`);
}

async function readMetadataRecords(metadataPath: string): Promise<AntigravityArtifactRecord[]> {
  const body = await readFile(metadataPath, 'utf8');
  return body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as AntigravityArtifactRecord);
}

async function structuralSmoke(): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-antigrav-f-struct-'));
  const outsideDir = await mkdtemp(join(tmpdir(), 'arco-antigrav-f-outside-'));
  const fakeCascadeId = `phase-f-fake-cascade-${STAMP}`;
  const fakeBrainDir = join(homedir(), '.gemini', 'antigravity', 'brain', fakeCascadeId);
  try {
    const workflowId = `${WORKFLOW_ID}-struct`;
    await mkdir(join(cwd, 'notes'), { recursive: true });
    await writeFile(join(cwd, 'preexisting.md'), 'do not ingest\n', 'utf8');
    const before = await snapshotAntigravityArtifactFiles(cwd);

    const sourceText = join(cwd, 'notes', `arco-phase-f-${STAMP}.md`);
    const sourceImage = join(cwd, 'notes', `arco-phase-f-${STAMP}.png`);
    const internalNoise = join(cwd, '.arco', 'internal.md');
    await mkdir(join(cwd, '.arco'), { recursive: true });
    await writeFile(sourceText, `# Phase F\n\nmarker ${STAMP}\n`, 'utf8');
    await writeFile(sourceImage, Buffer.from(PNG_BASE64, 'base64'));
    await writeFile(internalNoise, 'must not ingest\n', 'utf8');

    const result = await ingestAntigravityArtifacts({
      cwd,
      workflowId,
      cascadeId: 'cascade-structural',
      prompt: `create markdown and image files named arco-phase-f-${STAMP}`,
      turnStartedAt: Date.now() - 1000,
      workflowSnapshotBefore: before,
    });

    const text = result.records.find((r) => r.kind === 'text');
    const image = result.records.find((r) => r.kind === 'image');
    assert.ok(text, 'text artifact copied');
    assert.ok(image, 'image artifact copied');
    assert.equal(text.detectedFrom, 'workflow-cwd');
    assert.equal(image.detectedFrom, 'workflow-cwd');
    assert.equal(text.copiedPath, join(cwd, '.arco', 'workflows', workflowId, 'artifacts', text.artifactName));
    assert.equal(image.copiedPath, join(cwd, '.arco', 'workflows', workflowId, 'artifacts', 'images', image.artifactName));
    assert.match(await readFile(text.copiedPath, 'utf8'), new RegExp(STAMP));
    await access(image.copiedPath, constants.R_OK);
    assert.equal((await readFile(sourceText, 'utf8')).includes(`marker ${STAMP}`), true);
    assert.equal(result.records.some((r) => r.sourcePath === internalNoise), false);

    const metadata = await readMetadataRecords(result.metadataPath);
    assert.equal(metadata.length, 2);
    assert.ok(metadata.some((r) => r.sourcePath === sourceText && r.copiedPath === text.copiedPath));
    assert.ok(metadata.some((r) => r.sourcePath === sourceImage && r.copiedPath === image.copiedPath));

    pass(`structural text copied: ${text.copiedPath}`);
    pass(`structural image copied: ${image.copiedPath}`);
    pass(`metadata recorded source->copy: ${result.metadataPath}`);

    const explicitInside = join(cwd, 'notes', `explicit-inside-${STAMP}.json`);
    const explicitOutside = join(outsideDir, `secret-${STAMP}.json`);
    const explicitSymlinkEscape = join(cwd, 'notes', `symlink-secret-${STAMP}.json`);
    const explicitBrain = join(fakeBrainDir, `explicit-brain-${STAMP}.json`);
    await mkdir(fakeBrainDir, { recursive: true });
    await writeFile(explicitInside, JSON.stringify({ ok: true, marker: STAMP }), 'utf8');
    await writeFile(explicitOutside, JSON.stringify({ secret: STAMP }), 'utf8');
    await writeFile(explicitBrain, JSON.stringify({ brain: true, marker: STAMP }), 'utf8');
    await symlink(explicitOutside, explicitSymlinkEscape);

    const explicitResult = await ingestAntigravityArtifacts({
      cwd,
      workflowId,
      cascadeId: fakeCascadeId,
      prompt: 'explicit-step structural containment test',
      turnStartedAt: Date.now() - 1000,
      explicitSourcePaths: [explicitInside, explicitOutside, explicitSymlinkEscape, explicitBrain],
    });

    assert.equal(explicitResult.records.length, 2);
    assert.equal(explicitResult.records.every((r) => r.detectedFrom === 'explicit-step'), true);
    assert.ok(explicitResult.records.some((r) => r.sourcePath === explicitInside));
    assert.ok(explicitResult.records.some((r) => r.sourcePath === explicitBrain));
    assert.equal(explicitResult.records.some((r) => r.sourcePath === explicitOutside), false);
    assert.equal(explicitResult.records.some((r) => r.sourcePath === explicitSymlinkEscape), false);
    assert.equal(explicitResult.rejectedCount, 2);

    const metadataAfterExplicit = await readMetadataRecords(result.metadataPath);
    assert.ok(metadataAfterExplicit.some((r) => r.sourcePath === explicitInside));
    assert.ok(metadataAfterExplicit.some((r) => r.sourcePath === explicitBrain));
    assert.equal(metadataAfterExplicit.some((r) => r.sourcePath === explicitOutside), false);
    assert.equal(metadataAfterExplicit.some((r) => r.sourcePath === explicitSymlinkEscape), false);
    pass('explicit-step inside cwd copied');
    pass('explicit-step inside exact brain dir copied');
    pass('explicit-step outside cwd/brain and symlink escape rejected');
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await rm(fakeBrainDir, { recursive: true, force: true });
  }
}

async function runLiveTurn(): Promise<{ cwd: string; targetName: string; records: AntigravityArtifactRecord[]; metadataPath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-antigrav-f-live-'));
  const targetName = `arco-phase-f-live-${STAMP}.txt`;
  const marker = `phase-f-live-marker-${STAMP}`;
  const config: WorkerConfig = {
    provider: 'antigravity',
    model: 'antigravity-desktop',
    cwd,
    workflowId: WORKFLOW_ID,
    skipPermissions: true,
  } as WorkerConfig;

  const proc = AntigravityProvider.create('smoke-phase-f-live', config);
  let text = '';
  let error = '';
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error(`turn timed out after ${TURN_TIMEOUT_MS}ms`));
    }, TURN_TIMEOUT_MS);
    proc.on('system_notice', (notice: string) => console.log(`NOTICE ${notice}`));
    proc.on('result', (r: { text: string }) => {
      text = r.text;
      clearTimeout(timer);
      resolve();
    });
    proc.on('error', (msg: string) => {
      error = msg;
      clearTimeout(timer);
      reject(new Error(msg));
    });
  });

  proc.spawn(`Create a new text file in the project directory named ${targetName}. The file contents must be exactly one line: ${marker}. After saving it, reply with the filename only.`);
  await done;
  console.log(`live text first 300: ${text.slice(0, 300)}`);
  if (error) throw new Error(error);

  const artifactRoot = join(cwd, '.arco', 'workflows', WORKFLOW_ID, 'artifacts');
  const metadataPath = join(artifactRoot, 'antigravity-artifacts.jsonl');
  const records = await readMetadataRecords(metadataPath);
  const target = records.find((r) => r.sourcePath.endsWith(targetName) && r.kind === 'text');
  assert.ok(target, `live metadata contains ${targetName}`);
  assert.match(await readFile(target.copiedPath, 'utf8'), new RegExp(marker));
  assert.equal((await stat(join(cwd, targetName))).isFile(), true);
  pass(`live text copied: ${target.copiedPath}`);
  pass(`live metadata recorded: ${metadataPath}`);
  return { cwd, targetName, records, metadataPath };
}

async function main(): Promise<void> {
  console.log('Antigravity Phase F smoke (artifacts/generated images)');
  console.log(`workflowId: ${WORKFLOW_ID}`);
  await structuralSmoke();

  if (process.env.ANTIGRAVITY_PHASE_F_STRUCTURAL_ONLY === '1') {
    console.log('Live desktop turn skipped by ANTIGRAVITY_PHASE_F_STRUCTURAL_ONLY=1.');
    return;
  }

  const diag = await antigravityManager.diagnostics();
  if (!diag.available) {
    console.log(`Live desktop unavailable: ${diag.reason ?? 'unknown'}`);
    if (process.env.ANTIGRAVITY_PHASE_F_REQUIRE_LIVE === '1') process.exit(2);
    console.log('Live desktop turn skipped; structural artifact/image ingestion passed.');
    return;
  }

  const live = await runLiveTurn();
  console.log(`live cwd retained for inspection: ${live.cwd}`);
  console.log(`live target: ${live.targetName}`);
  console.log(`live metadata: ${live.metadataPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ServerMessage } from '@arco/shared';
import { buildQuickHandoff } from './quickHandoff.js';
import { runExportContext } from './exportContext.js';
import type { WorkerManager } from '../workers/WorkerManager.js';
import { ClaudeProvider } from '../providers/claude.js';

test('quick handoff bounds recent conversation and never starts a writer model', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-quick-'));
  try {
    const events = [
      { type: 'user_message_echo', content: 'old '.repeat(3000), workflowId: 'fixture', timestamp: 1 },
      { type: 'primary_text', text: 'recent response', phase: 'passthrough', workflowId: 'fixture' },
      { type: 'primary_complete', workflowId: 'fixture' },
    ] as ServerMessage[];
    const body = await buildQuickHandoff(cwd, events, 10_000);
    assert.ok(Buffer.byteLength(body) <= 2000);
    assert.match(body, /recent response/);
    assert.match(body, /Prior-turn action digest/);
    const unicode = await buildQuickHandoff(cwd, [{ type: 'user_message_echo', content: '😀'.repeat(3000), workflowId: 'fixture', timestamp: 1 }] as ServerMessage[], 1301);
    assert.ok(Buffer.byteLength(unicode) <= Math.floor(1301 * 0.2));
    const messages: ServerMessage[] = [];
    const manager = { spawn: () => { throw new Error('quick handoff must not spawn a writer'); }, kill: () => {} } as unknown as WorkerManager;
    const handle = runExportContext({ cwd, workflowId: 'fixture', manager, broadcast: (event) => messages.push(event) }, {
      mode: 'quick', transcript: events, contextWindow: 10_000,
      summarizer: { provider: 'ollama', model: 'fixture', effort: 'medium' },
    });
    const result = await handle.settled;
    assert.ok(result.body);
    assert.equal((await readFile(path.join(cwd, '.arco', 'workflows', 'fixture', 'handoffs', handle.artifactName), 'utf8')).trim(), result.body);
    assert.ok(messages.some((event) => event.type === 'handoff_artifact_ready' && !event.error));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('quick handoff includes current branch and dirty files from the selected project', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-quick-git-'));
  try {
    execFileSync('git', ['init', '-b', 'fixture'], { cwd, stdio: 'ignore' });
    await writeFile(path.join(cwd, 'new.txt'), 'fixture');
    const body = await buildQuickHandoff(cwd, [], 10_000);
    assert.match(body, /Branch: fixture/);
    assert.match(body, /\?\? new\.txt/);
    assert.ok(Buffer.byteLength(body) <= 2000);
    await assert.rejects(buildQuickHandoff(cwd, [], 100), /too small/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('written original-worker reflection runs without project tools and Arco writes only the handoff', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-written-'));
  try {
    await writeFile(path.join(cwd, 'DEVLOG.md'), 'unchanged');
    await writeFile(path.join(cwd, 'PLAN.md'), 'unchanged');
    const manager = {
      spawn: (_spec: unknown, emit: (event: unknown) => void, options: { interactionMode?: string; sandbox?: string; disableProviderHooks?: boolean }) => {
        assert.equal(options.interactionMode, 'chat');
        assert.equal(options.sandbox, 'read-only');
        assert.equal(options.disableProviderHooks, true);
        emit({ type: 'worker_text', text: 'A fixture handoff.\n[HANDOFF_COMPLETE]' });
        return Promise.resolve({});
      },
      kill: () => {},
    } as unknown as WorkerManager;
    const handle = runExportContext({ cwd, workflowId: 'fixture', manager, broadcast: () => {} }, {
      mode: 'original-worker', transcript: [], summarizer: { provider: 'claude', model: 'sonnet', effort: 'medium' },
      original: { primary: { provider: 'claude', model: 'sonnet', effort: 'medium' }, sessionId: 'fixture-session', cwd },
    });
    const result = await handle.settled;
    assert.equal(result.body, 'A fixture handoff.');
    assert.equal(await readFile(path.join(cwd, 'DEVLOG.md'), 'utf8'), 'unchanged');
    assert.equal(await readFile(path.join(cwd, 'PLAN.md'), 'utf8'), 'unchanged');
    assert.equal((await readFile(path.join(cwd, '.arco', 'workflows', 'fixture', 'handoffs', handle.artifactName), 'utf8')).trim(), result.body);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('tool-free Claude reflection disables ordinary configured hooks for that invocation', () => {
  const process = ClaudeProvider.create('fixture', { provider: 'claude', model: 'sonnet', effort: 'medium', interactionMode: 'chat', disableProviderHooks: true });
  const args = (process as unknown as { buildArgs: () => string[] }).buildArgs();
  const at = args.indexOf('--settings');
  assert.ok(at >= 0);
  assert.deepEqual(JSON.parse(args[at + 1]!), { disableAllHooks: true });
  const normal = ClaudeProvider.create('fixture-normal', { provider: 'claude', model: 'sonnet', effort: 'medium' });
  assert.equal((normal as unknown as { buildArgs: () => string[] }).buildArgs().includes('--settings'), false);
});

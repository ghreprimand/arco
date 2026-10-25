// Worktree bake-off smoke — no dev server and no model spend.
//
// Exercises the destructive core against a disposable git repository:
// isolated attempt creation, candidate diff, .archon exclusion, deterministic
// promotion, source-drift refusal, and branch-preserving cleanup.

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import type { BakeoffState } from '@archon/shared';
import {
  bakeoffAttemptDiff,
  bakeoffWorktreesRoot,
  createBakeoffAttempts,
  GitBakeoffError,
  promoteBakeoffAttempt,
  removeBakeoffAttempt,
} from '../../server/src/gitBakeoff.js';
import {
  handleBakeoffCleanup,
  handleBakeoffList,
  handleBakeoffStart,
  initBakeoffHandlers,
} from '../../server/src/ws/bakeoffHandlers.js';
import { workflows, workflowCwds } from '../../server/src/server/state.js';
import { flushAll, initWorkflowStore } from '../../server/src/workflowStore.js';
import { assert, assertEq, step, summary } from './lib.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const repo = mkdtempSync(path.join(tmpdir(), 'archon-bakeoff-'));
  const bakeoffId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const specs = [
    { provider: 'claude' as const, model: 'sonnet' as const, effort: 'high' as const },
    { provider: 'codex' as const, model: 'gpt-5.4' as const, effort: 'high' as const },
  ];

  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@archon.local');
    git(repo, 'config', 'user.name', 'Arco Test');
    git(repo, 'checkout', '-q', '-B', 'main');
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'base\n');
    git(repo, 'add', 'tracked.txt');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    await fs.mkdir(path.join(repo, '.archon'), { recursive: true });
    await fs.writeFile(path.join(repo, '.archon', 'events.jsonl'), 'source metadata\n');

    const prepared = await createBakeoffAttempts({ cwd: repo, bakeoffId, specs });
    await step('create: every attempt gets the same base in an isolated branch', async () => {
      assertEq(prepared.baseRef, base, 'base ref');
      assertEq(prepared.attempts.length, 2, 'attempt count');
      assert(prepared.attempts[0].worktreePath !== prepared.attempts[1].worktreePath, 'paths must differ');
      assert(git(prepared.attempts[0].worktreePath, 'rev-parse', 'HEAD') === base, 'attempt 1 base');
      assert(git(prepared.attempts[1].worktreePath, 'rev-parse', 'HEAD') === base, 'attempt 2 base');
      assert(
        git(repo, 'status', '--porcelain').split('\n').every((line) => !line || line.includes('.archon')),
        'source has no project changes',
      );
    });

    const state: BakeoffState = {
      id: bakeoffId,
      sourceWorkflowId: '11111111-2222-4333-8444-555555555555',
      sourceCwd: repo,
      name: 'smoke candidate',
      prompt: 'change the fixture',
      baseRef: prepared.baseRef,
      baseBranch: prepared.baseBranch,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'ready',
      attempts: prepared.attempts,
    };

    await step('diff: includes tracked + untracked project files but excludes .archon metadata', async () => {
      const attempt = prepared.attempts[0];
      await fs.writeFile(path.join(attempt.worktreePath, 'tracked.txt'), 'winner\n');
      await fs.writeFile(path.join(attempt.worktreePath, 'new-file.txt'), 'new\n');
      await fs.mkdir(path.join(attempt.worktreePath, '.archon'), { recursive: true });
      await fs.writeFile(path.join(attempt.worktreePath, '.archon', 'events.jsonl'), 'metadata\n');
      const patch = await bakeoffAttemptDiff(state, attempt);
      assert(patch.includes('winner'), 'tracked edit should appear');
      assert(patch.includes('new-file.txt'), 'untracked project file should appear');
      assert(!patch.includes('events.jsonl'), '.archon metadata must stay out');
    });

    await step('metadata guard: refuses an agent-created commit containing .archon state', async () => {
      const attempt = prepared.attempts[1];
      await fs.mkdir(path.join(attempt.worktreePath, '.archon'), { recursive: true });
      await fs.writeFile(path.join(attempt.worktreePath, '.archon', 'committed.json'), '{}\n');
      git(attempt.worktreePath, 'add', '-f', '.archon/committed.json');
      git(attempt.worktreePath, 'commit', '-q', '-m', 'unsafe metadata');
      let caught: unknown;
      try {
        await promoteBakeoffAttempt(state, attempt);
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof GitBakeoffError, 'expected structured metadata error');
      assertEq((caught as GitBakeoffError).kind, 'unsafe-commits', 'metadata error kind');
    });

    await step('promote: commits candidate project files and merges winner into source', async () => {
      const promoted = await promoteBakeoffAttempt(state, prepared.attempts[0]);
      assert(promoted.mergeCommit.length === 40, 'merge commit should be a full sha');
      assertEq(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'winner\n', 'winner edit merged');
      assertEq(await fs.readFile(path.join(repo, 'new-file.txt'), 'utf8'), 'new\n', 'winner addition merged');
      assert(!git(repo, 'ls-files').split('\n').some((file) => file.startsWith('.archon/')), 'metadata not committed');
      assert(
        git(repo, 'status', '--porcelain').split('\n').every((line) => !line || line.includes('.archon')),
        'source has no project changes after merge',
      );
    });

    await step('drift guard: a bake-off cannot promote after the source HEAD moved', async () => {
      await fs.writeFile(path.join(prepared.attempts[1].worktreePath, 'other.txt'), 'other\n');
      let caught: unknown;
      try {
        await promoteBakeoffAttempt(state, prepared.attempts[1]);
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof GitBakeoffError, 'expected structured error');
      assertEq((caught as GitBakeoffError).kind, 'base-drift', 'drift kind');
    });

    await step('cleanup: removes worktrees while preserving their branches', async () => {
      for (const attempt of prepared.attempts) await removeBakeoffAttempt(repo, attempt);
      for (const attempt of prepared.attempts) {
        await fs.access(path.dirname(attempt.worktreePath));
        assert(git(repo, 'branch', '--list', attempt.branch).includes(attempt.branch), 'branch should survive');
      }
    });

    await step('protocol: start/list/state/cleanup messages drive isolated attempt workflows', async () => {
      const sourceWorkflowId = '11111111-2222-4333-8444-555555555556';
      const received: Array<Record<string, unknown>> = [];
      const fakeWs = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send: (raw: string) => received.push(JSON.parse(raw) as Record<string, unknown>),
      } as unknown as WebSocket;
      const sourceConfig = {
        name: 'Bake-off smoke source',
        primaryProvider: 'claude' as const,
        primaryModel: 'claude-opus-4-7' as const,
        primaryEffort: 'high' as const,
        workingDirectory: repo,
      };
      workflows.set(sourceWorkflowId, {
        config: sourceConfig,
        busy: false,
        primary: { provider: 'claude', model: 'claude-opus-4-7', effort: 'high' },
        observers: new Set([fakeWs]),
      } as never);
      workflowCwds.set(sourceWorkflowId, repo);
      await initWorkflowStore(repo, sourceWorkflowId);
      const session = {
        id: 'bakeoff-smoke-session',
        workflowIds: new Set([sourceWorkflowId]),
        clusterIds: new Set<string>(),
        clusterObserved: new Map<string, Set<string>>(),
      };
      let created = 0;
      initBakeoffHandlers({
        createBlankNativeWorkflow: async (ws, activeSession, config, options) => {
          const workflowId = `bakeoff-smoke-attempt-${++created}`;
          workflows.set(workflowId, {
            config,
            busy: false,
            primary: {
              provider: config.primaryProvider ?? 'claude',
              model: config.primaryModel,
              effort: config.primaryEffort,
            },
            observers: new Set([ws]),
          } as never);
          workflowCwds.set(workflowId, config.workingDirectory!);
          activeSession.workflowIds.add(workflowId);
          ws.send(JSON.stringify({
            type: 'workflow_created',
            workflowId,
            config,
            backgroundCreated: options?.backgroundCreated === true,
          }));
          return workflowId;
        },
        handleUserMessage: async (_ws, _session, workflowId) => {
          const wf = workflows.get(workflowId)!;
          wf.busy = true;
          await fs.writeFile(path.join(wf.config.workingDirectory!, `result-${workflowId}.txt`), 'candidate\n');
          wf.busy = false;
        },
        handleRemoveWorkflow: (workflowId) => {
          workflows.delete(workflowId);
          workflowCwds.delete(workflowId);
          session.workflowIds.delete(workflowId);
        },
      });

      await handleBakeoffStart(fakeWs, session, {
        type: 'bakeoff_start',
        workflowId: sourceWorkflowId,
        name: 'protocol smoke',
        prompt: 'write one candidate file',
        attempts: specs,
      });
      await waitUntil(
        () => received.some((message) =>
          message.type === 'bakeoff_state'
          && (message.bakeoff as BakeoffState).status === 'ready'),
        'ready bakeoff_state',
      );
      const backgroundCreates = received.filter((message) =>
        message.type === 'workflow_created' && message.backgroundCreated === true);
      assertEq(backgroundCreates.length, 2, 'attempt tabs are background-created');
      const ready = [...received].reverse().find((message) =>
        message.type === 'bakeoff_state'
        && (message.bakeoff as BakeoffState).status === 'ready')!;
      const handlerState = ready.bakeoff as BakeoffState;
      assert(handlerState.attempts.every((attempt) => attempt.status === 'done'), 'attempts settle to done');

      await handleBakeoffList(fakeWs, { type: 'bakeoff_list', workflowId: sourceWorkflowId });
      const listed = [...received].reverse().find((message) => message.type === 'bakeoff_list_result');
      assert(
        (listed?.bakeoffs as BakeoffState[]).some((item) => item.id === handlerState.id),
        'durable manifest returns through bakeoff_list_result',
      );

      await handleBakeoffCleanup(fakeWs, {
        type: 'bakeoff_cleanup',
        workflowId: sourceWorkflowId,
        bakeoffId: handlerState.id,
        attemptIds: handlerState.attempts.map((attempt) => attempt.id),
      });
      const removed = [...received].reverse().find((message) => message.type === 'bakeoff_attempts_removed');
      assertEq((removed?.attemptIds as string[]).length, 2, 'cleanup result carries both attempt ids');
      assert(
        handlerState.attempts.every((attempt) =>
          git(repo, 'branch', '--list', attempt.branch).includes(attempt.branch)),
        'protocol cleanup preserves attempt branches',
      );
      workflows.delete(sourceWorkflowId);
      workflowCwds.delete(sourceWorkflowId);
      await flushAll();
    });
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(path.dirname(bakeoffWorktreesRoot(repo)), { recursive: true, force: true });
  }

  summary('worktree bake-off');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Worktree bake-off orchestration. The operator starts a bounded batch, each
// attempt becomes an ordinary visible workflow in its own managed worktree,
// and only an explicit promote message can merge a winner.

import crypto from 'node:crypto';
import type {
  BakeoffCleanupMessage,
  BakeoffListMessage,
  BakeoffPromoteMessage,
  BakeoffStartMessage,
  BakeoffState,
  ProviderName,
  WorkflowConfig,
} from '@arco/shared';
import type { WebSocket } from 'ws';
import { listBakeoffs, readBakeoff, writeBakeoff } from '../bakeoffStore.js';
import {
  createBakeoffAttempts,
  GitBakeoffError,
  promoteBakeoffAttempt,
  removeBakeoffAttempt,
} from '../gitBakeoff.js';
import { broadcastWorkflow, send } from '../server/broadcast.js';
import { workflows } from '../server/state.js';
import type { Session } from '../workflows/types.js';

const MAX_ATTEMPTS = 5;
const MAX_PROMPT_BYTES = 64 * 1024;
const RUNTIME_STARTED_AT = Date.now();
const PROVIDERS = new Set<ProviderName>([
  'claude',
  'codex',
  'gemini',
  'ollama',
  'llamacpp',
  'lmstudio', 'strata', 'deepseek',
  'antigravity',
  'cursor',
]);

interface BakeoffHandlerDeps {
  createBlankNativeWorkflow: (
    ws: WebSocket,
    session: Session,
    config: WorkflowConfig,
    options?: { backgroundCreated?: boolean },
  ) => Promise<string>;
  handleUserMessage: (
    ws: WebSocket,
    session: Session,
    workflowId: string,
    content: string,
    clientMessageId: string | undefined,
    attachments: string[] | undefined,
    interjection: boolean,
    kind: 'steer' | 'follow-up' | 'interrupt' | undefined,
    primitive: 'docs' | 'git' | undefined,
  ) => Promise<void>;
  handleRemoveWorkflow: (workflowId: string) => void;
}

let deps: BakeoffHandlerDeps;
export function initBakeoffHandlers(next: BakeoffHandlerDeps): void {
  deps = next;
}

const mutationTails = new Map<string, Promise<void>>();

async function mutateState(
  cwd: string,
  sourceWorkflowId: string,
  bakeoffId: string,
  fn: (state: BakeoffState) => void | Promise<void>,
): Promise<BakeoffState> {
  const key = `${sourceWorkflowId}:${bakeoffId}`;
  const prior = mutationTails.get(key) ?? Promise.resolve();
  let resolveResult!: (state: BakeoffState) => void;
  let rejectResult!: (err: unknown) => void;
  const result = new Promise<BakeoffState>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const next = prior
    .catch(() => undefined)
    .then(async () => {
      try {
        const state = await readBakeoff(cwd, sourceWorkflowId, bakeoffId);
        if (!state) throw new Error('Bake-off not found.');
        await fn(state);
        state.updatedAt = Date.now();
        await writeBakeoff(state);
        broadcastWorkflow(sourceWorkflowId, {
          type: 'bakeoff_state',
          workflowId: sourceWorkflowId,
          bakeoff: state,
        });
        resolveResult(state);
      } catch (err) {
        rejectResult(err);
      }
    })
    .finally(() => {
      if (mutationTails.get(key) === next) mutationTails.delete(key);
    });
  mutationTails.set(key, next);
  return result;
}

function fail(ws: WebSocket, workflowId: string, error: unknown, bakeoffId?: string): void {
  const message = error instanceof GitBakeoffError || error instanceof Error
    ? error.message
    : String(error);
  send(ws, { type: 'bakeoff_error', workflowId, ...(bakeoffId ? { bakeoffId } : {}), error: message });
}

function attemptConfig(source: WorkflowConfig, state: BakeoffState, index: number): WorkflowConfig {
  const attempt = state.attempts[index];
  const provider = attempt.provider;
  const config: WorkflowConfig = {
    ...source,
    name: `${state.name} · ${attempt.label}`,
    kind: 'workflow',
    primaryProvider: provider === 'claude' ? undefined : provider,
    primaryModel: attempt.model,
    primaryEffort: attempt.effort,
    providerAccountRef: attempt.providerAccountRef,
    workingDirectory: attempt.worktreePath,
    resumeSessionId: undefined,
    resumeWorkflowId: undefined,
    researchSpawnToken: undefined,
    templateSpawnToken: undefined,
    bakeoffId: state.id,
    bakeoffAttemptId: attempt.id,
    bakeoffSourceWorkflowId: state.sourceWorkflowId,
    managedWorktreeSourceCwd: state.sourceCwd,
    // A bake-off is already the bounded fan-out. Never silently multiply it
    // again through Claude's sticky Ultracode fleet or Goal Run continuation.
    ultracode: false,
    goalRun: undefined,
    // Attempt tabs are short-lived comparison runs, not remote-control targets.
    remoteEnabled: false,
  };
  return config;
}

function dispatchedPrompt(prompt: string): string {
  return [
    prompt.trim(),
    '',
    '--- Arco worktree bake-off rules ---',
    'This is one operator-requested attempt in an isolated managed git worktree.',
    'Implement and verify the requested change in this worktree only.',
    'Do not push, merge, create another worktree, or choose a winner.',
    'Do not commit: Arco will create the candidate commit only if the operator promotes this attempt.',
    'Finish with a concise summary of changes and verification so the operator can compare attempts.',
  ].join('\n');
}

function refreshOverallStatus(state: BakeoffState): void {
  if (state.status === 'promoted') return;
  const settled = state.attempts.every((attempt) =>
    attempt.status === 'done'
    || attempt.status === 'failed'
    || attempt.status === 'interrupted'
    || attempt.status === 'cleaned');
  state.status = settled ? 'ready' : 'running';
}

export async function handleBakeoffList(ws: WebSocket, msg: BakeoffListMessage): Promise<void> {
  const source = workflows.get(msg.workflowId);
  if (!source?.config.workingDirectory) {
    fail(ws, msg.workflowId, new Error('Source workflow not found.'));
    return;
  }
  const states = await listBakeoffs(source.config.workingDirectory, msg.workflowId);
  for (const state of states) {
    let changed = false;
    for (const attempt of state.attempts) {
      if (attempt.status !== 'running' || !attempt.workflowId) continue;
      const wf = workflows.get(attempt.workflowId);
      // In this runtime an attempt briefly exists as an idle workflow before
      // handleUserMessage reaches its busy transition. Only an absent workflow
      // or an idle attempt from a prior server runtime is truly orphaned.
      if (!wf || (!wf.busy && (attempt.startedAt ?? 0) < RUNTIME_STARTED_AT)) {
        attempt.status = 'interrupted';
        attempt.completedAt = Date.now();
        changed = true;
      }
    }
    if (changed) {
      refreshOverallStatus(state);
      state.updatedAt = Date.now();
      await writeBakeoff(state);
    }
  }
  send(ws, { type: 'bakeoff_list_result', workflowId: msg.workflowId, bakeoffs: states });
}

export async function handleBakeoffStart(
  ws: WebSocket,
  session: Session,
  msg: BakeoffStartMessage,
): Promise<void> {
  const source = workflows.get(msg.workflowId);
  if (!source?.config.workingDirectory) {
    fail(ws, msg.workflowId, new Error('Source workflow not found.'));
    return;
  }
  if (source.busy) {
    fail(ws, msg.workflowId, new Error('Wait for the source workflow turn to finish before starting a bake-off.'));
    return;
  }
  const prompt = msg.prompt.trim();
  if (!prompt || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
    fail(ws, msg.workflowId, new Error(`Prompt must be 1–${MAX_PROMPT_BYTES} bytes.`));
    return;
  }
  if (!Array.isArray(msg.attempts) || msg.attempts.length < 2 || msg.attempts.length > MAX_ATTEMPTS) {
    fail(ws, msg.workflowId, new Error('Choose between 2 and 5 attempts.'));
    return;
  }
  if (msg.attempts.some((attempt) =>
    !PROVIDERS.has(attempt.provider)
    || typeof attempt.model !== 'string'
    || !attempt.model
    || typeof attempt.effort !== 'string')) {
    fail(ws, msg.workflowId, new Error('One or more attempt configurations are invalid.'));
    return;
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    const prepared = await createBakeoffAttempts({
      cwd: source.config.workingDirectory,
      bakeoffId: id,
      specs: msg.attempts,
    });
    const state: BakeoffState = {
      id,
      sourceWorkflowId: msg.workflowId,
      sourceCwd: source.config.workingDirectory,
      name: (msg.name?.trim() || prompt.split('\n')[0] || 'Bake-off').slice(0, 80),
      prompt,
      baseRef: prepared.baseRef,
      baseBranch: prepared.baseBranch,
      createdAt: now,
      updatedAt: now,
      status: 'creating',
      attempts: prepared.attempts,
    };
    await writeBakeoff(state);
    broadcastWorkflow(msg.workflowId, {
      type: 'bakeoff_state',
      workflowId: msg.workflowId,
      bakeoff: state,
    });

    for (let i = 0; i < state.attempts.length; i++) {
      const attempt = state.attempts[i];
      try {
        const config = attemptConfig(source.config, state, i);
        const workflowId = await deps.createBlankNativeWorkflow(ws, session, config, { backgroundCreated: true });
        attempt.workflowId = workflowId;
        attempt.status = 'running';
        attempt.startedAt = Date.now();
      } catch (err) {
        attempt.status = 'failed';
        attempt.error = err instanceof Error ? err.message : String(err);
        attempt.completedAt = Date.now();
      }
    }
    refreshOverallStatus(state);
    state.updatedAt = Date.now();
    await writeBakeoff(state);
    broadcastWorkflow(msg.workflowId, {
      type: 'bakeoff_state',
      workflowId: msg.workflowId,
      bakeoff: state,
    });

    for (const attempt of state.attempts) {
      if (!attempt.workflowId || attempt.status !== 'running') continue;
      void deps.handleUserMessage(
        ws,
        session,
        attempt.workflowId,
        dispatchedPrompt(prompt),
        crypto.randomUUID(),
        undefined,
        false,
        undefined,
        undefined,
      ).then(async () => {
        await mutateState(state.sourceCwd, state.sourceWorkflowId, state.id, (current) => {
          const target = current.attempts.find((item) => item.id === attempt.id);
          if (!target || target.status !== 'running') return;
          target.status = 'done';
          target.completedAt = Date.now();
          refreshOverallStatus(current);
        });
      }).catch(async (err) => {
        await mutateState(state.sourceCwd, state.sourceWorkflowId, state.id, (current) => {
          const target = current.attempts.find((item) => item.id === attempt.id);
          if (!target || target.status !== 'running') return;
          target.status = 'failed';
          target.error = err instanceof Error ? err.message : String(err);
          target.completedAt = Date.now();
          refreshOverallStatus(current);
        }).catch(() => undefined);
      });
    }
  } catch (err) {
    fail(ws, msg.workflowId, err, id);
  }
}

export async function handleBakeoffPromote(
  ws: WebSocket,
  msg: BakeoffPromoteMessage,
): Promise<void> {
  const source = workflows.get(msg.workflowId);
  const cwd = source?.config.workingDirectory;
  if (!cwd) {
    fail(ws, msg.workflowId, new Error('Source workflow not found.'), msg.bakeoffId);
    return;
  }
  try {
    await mutateState(cwd, msg.workflowId, msg.bakeoffId, async (state) => {
      if (state.winnerAttemptId) throw new Error('This bake-off already has a promoted winner.');
      const attempt = state.attempts.find((item) => item.id === msg.attemptId);
      if (!attempt) throw new Error('Attempt not found.');
      if (attempt.workflowId && workflows.get(attempt.workflowId)?.busy) {
        throw new GitBakeoffError('attempt-busy', 'Wait for the selected attempt to finish before promoting it.');
      }
      const promoted = await promoteBakeoffAttempt(state, attempt);
      state.winnerAttemptId = attempt.id;
      state.promotedAt = Date.now();
      state.mergeCommit = promoted.mergeCommit;
      state.status = 'promoted';
    });
  } catch (err) {
    fail(ws, msg.workflowId, err, msg.bakeoffId);
  }
}

export async function handleBakeoffCleanup(
  ws: WebSocket,
  msg: BakeoffCleanupMessage,
): Promise<void> {
  const source = workflows.get(msg.workflowId);
  const cwd = source?.config.workingDirectory;
  if (!cwd) {
    fail(ws, msg.workflowId, new Error('Source workflow not found.'), msg.bakeoffId);
    return;
  }
  const uniqueIds = [...new Set(msg.attemptIds)].slice(0, MAX_ATTEMPTS);
  if (uniqueIds.length === 0) {
    fail(ws, msg.workflowId, new Error('Choose at least one attempt to clean up.'), msg.bakeoffId);
    return;
  }
  try {
    const removedWorkflowIds: string[] = [];
    await mutateState(cwd, msg.workflowId, msg.bakeoffId, async (state) => {
      const selected = state.attempts.filter((attempt) => uniqueIds.includes(attempt.id));
      if (selected.length !== uniqueIds.length) throw new Error('One or more cleanup attempts were not found.');
      for (const attempt of selected) {
        if (attempt.workflowId && workflows.get(attempt.workflowId)?.busy) {
          throw new GitBakeoffError('attempt-busy', `${attempt.label} is still running.`);
        }
      }
      for (const attempt of selected) {
        if (attempt.workflowId) {
          deps.handleRemoveWorkflow(attempt.workflowId);
          removedWorkflowIds.push(attempt.workflowId);
        }
        await removeBakeoffAttempt(cwd, attempt);
        attempt.status = 'cleaned';
        attempt.completedAt ??= Date.now();
      }
      refreshOverallStatus(state);
    });
    send(ws, {
      type: 'bakeoff_attempts_removed',
      workflowId: msg.workflowId,
      bakeoffId: msg.bakeoffId,
      attemptIds: uniqueIds,
      workflowIds: removedWorkflowIds,
    });
  } catch (err) {
    fail(ws, msg.workflowId, err, msg.bakeoffId);
  }
}

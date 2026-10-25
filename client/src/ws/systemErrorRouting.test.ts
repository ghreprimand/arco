import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage, WorkflowConfig } from '@arco/shared';
import { handleServerMessage, type WsDeps } from './handleServerMessage.js';
import { useAppStore } from '../stores/appStore.js';

// Regression guard for the 2026-07-30 cross-tab provider-refusal incident.
// worker_error lost its workflowId at the server boundary, so the generic
// client error handler appended it to whichever workflow happened to be
// active. A newly opened unrelated tab therefore appeared to have sent the
// rejected request.

const persisted = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return persisted.size; },
    clear: () => persisted.clear(),
    getItem: (key: string) => persisted.get(key) ?? null,
    key: (index: number) => [...persisted.keys()][index] ?? null,
    removeItem: (key: string) => persisted.delete(key),
    setItem: (key: string, value: string) => persisted.set(key, value),
  } satisfies Storage,
});

const deps: WsDeps = {
  wsRef: { current: null },
  scheduleReconnect: () => {},
};

const config = {
  name: 'error-routing-test',
  primaryModel: 'gpt-5.6-sol',
  primaryEffort: 'high',
  primaryProvider: 'codex',
} as unknown as WorkflowConfig;

function resetJobs(...workflowIds: string[]): void {
  useAppStore.setState({ jobs: {}, activeJobId: null, activeClusterId: null });
  for (const workflowId of workflowIds) {
    useAppStore.getState().createJob(workflowId, {
      ...config,
      name: workflowId,
    });
  }
}

function errorsFor(workflowId: string): string[] {
  return useAppStore
    .getState()
    .jobs[workflowId].messages
    .filter((message) => message.role === 'system' && message.content.startsWith('[ERROR]'))
    .map((message) => message.content);
}

const send = (msg: Record<string, unknown>) =>
  handleServerMessage(msg as unknown as ServerMessage, deps);

test('workflow-scoped error lands on its source workflow, not the active tab', () => {
  resetJobs('builder-2', 'break');
  useAppStore.getState().setActiveJob('break');

  send({
    type: 'error',
    workflowId: 'builder-2',
    message: 'provider refused this request',
  });

  assert.deepEqual(errorsFor('builder-2'), ['[ERROR] provider refused this request']);
  assert.deepEqual(errorsFor('break'), []);
});

test('global error retains the active-workflow fallback', () => {
  resetJobs('builder-2', 'break');
  useAppStore.getState().setActiveJob('break');

  send({
    type: 'error',
    message: 'Invalid JSON',
  });

  assert.deepEqual(errorsFor('builder-2'), []);
  assert.deepEqual(errorsFor('break'), ['[ERROR] Invalid JSON']);
});

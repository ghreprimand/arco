import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerConfig } from '@arco/shared';
import { buildThreadStartParams } from './worker.js';

// The workflow worker's thread/start request is pinned: the one-shot evaluator
// adapter has its own locked-down request and must not change this one.
test('workflow worker thread/start keeps its sandbox, approvals, web search and MCP-independent shape', () => {
  const config = { model: 'gpt-6-luna', cwd: '/work/project' } as WorkerConfig;
  const params = buildThreadStartParams(config, { web_search: 'live' });
  assert.deepEqual(params, {
    model: 'gpt-6-luna', modelProvider: null, serviceTier: null, cwd: '/work/project',
    approvalPolicy: 'never', approvalsReviewer: null, sandbox: 'workspace-write', permissions: null,
    config: { web_search: 'live' }, serviceName: null, baseInstructions: null,
    developerInstructions: params.developerInstructions, personality: null, ephemeral: false,
    sessionStartSource: null, environments: null, dynamicTools: null, mockExperimentalField: null, experimentalRawEvents: false,
  });
  assert.equal(buildThreadStartParams({ ...config, sandbox: 'danger-full-access', incognito: true } as WorkerConfig, {}).sandbox, 'danger-full-access');
  assert.equal(buildThreadStartParams({ ...config, incognito: true } as WorkerConfig, {}).ephemeral, true);
  assert.equal(buildThreadStartParams({ ...config, sandbox: 'read-only' } as WorkerConfig, {}).sandbox, 'read-only');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerConfig } from '@arco/shared';
import { CodexProvider } from './codex.js';
import { buildThreadConfigOverrides } from './codex-appserver/worker.js';

for (const interactionMode of ['agent', 'chat'] as const) {
  for (const chatWebAccess of [false, true]) {
    for (const resume of [false, true]) {
      test(`Codex ${interactionMode} web=${chatWebAccess} resume=${resume} matches on both transports`, async () => {
        const config: WorkerConfig = { provider: 'codex', model: 'fixture', effort: 'low', interactionMode, chatWebAccess, ...(resume ? { resumeSessionId: 'fixture-session' } : {}) };
        const worker = CodexProvider.create('fixture', config) as unknown as { buildArgs(): string[] };
        const args = worker.buildArgs();
        const expected = interactionMode === 'agent' || chatWebAccess ? 'live' : 'disabled';
        assert.ok(args.includes(`web_search="${expected}"`), 'exec sets the effective search policy explicitly');
        assert.equal((await buildThreadConfigOverrides(config)).web_search, expected);
      });
    }
  }
}

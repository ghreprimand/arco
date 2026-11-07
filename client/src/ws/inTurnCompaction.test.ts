import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleServerMessage } from './handleServerMessage';
import { useAppStore } from '../stores/appStore';

const ctx = { wsRef: { current: null }, scheduleReconnect: () => {} };

test('an automatic compaction inside a turn shows no takeover or Continue banner and refreshes CTX', () => {
  const storage = useAppStore.persist.getOptions().storage;
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  try {
    useAppStore.setState({ jobs: {} });
    useAppStore.getState().createJob('fixture', { name: 'fixture', workingDirectory: '/fixture', skipPermissions: false, primaryProvider: 'claude', primaryModel: 'claude-opus-4-8', primaryEffort: 'low' });
    handleServerMessage({ type: 'native_compacting', workflowId: 'fixture', foldedTurns: 3, trigger: 'auto-in-turn', percent: 72, thresholdPercent: 70 }, ctx);
    assert.notEqual(useAppStore.getState().jobs.fixture.compacting, true, 'no takeover: the turn keeps running and steers stay possible');
    handleServerMessage({ type: 'native_compacted', workflowId: 'fixture', summary: 'S', foldedTurns: 3, inTurn: true, trigger: 'auto-in-turn', percent: 72, thresholdPercent: 70, promptTokensAfter: 120_000, contextWindow: 1_000_000 }, ctx);
    const job = useAppStore.getState().jobs.fixture;
    assert.ok(!job.compactedResume, 'no Continue banner');
    assert.equal(job.contextUsage?.percentOfWindow, 12);
    assert.equal(job.contextUsage?.estimatedTokens, 120_000);
    // A manual or between-turn compaction keeps its takeover and banner.
    handleServerMessage({ type: 'native_compacting', workflowId: 'fixture', foldedTurns: 3 }, ctx);
    assert.equal(useAppStore.getState().jobs.fixture.compacting, true);
    handleServerMessage({ type: 'native_compacted', workflowId: 'fixture', summary: 'S', foldedTurns: 3 }, ctx);
    assert.ok(useAppStore.getState().jobs.fixture.compactedResume);
  } finally {
    useAppStore.setState({ jobs: {} });
    useAppStore.persist.setOptions({ storage });
  }
});

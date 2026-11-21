import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleServerMessage } from './handleServerMessage';
import { useAppStore } from '../stores/appStore';
import { projectChatMessages } from '../utils/displayMessages';
import type { ServerMessage } from '@arco/shared';

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

test('replayed compaction notices and context dividers keep their saved place and time', () => {
  const storage = useAppStore.persist.getOptions().storage;
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const id = 'system-row-history';
  const base = Date.now() - 2 * 60 * 60 * 1000;
  try {
    useAppStore.getState().createJob(id, { name: 'fixture', workingDirectory: '/fixture', skipPermissions: false, primaryProvider: 'claude', primaryModel: 'claude-opus-4-8', primaryEffort: 'low', claudeTransport: 'native' });
    const records: Array<Record<string, unknown>> = [
      { type: 'user_message_echo', content: 'First request', clientMessageId: 'first' },
      { type: 'primary_turn_started' },
      { type: 'primary_text', phase: 'passthrough', text: 'Before compaction.' },
      { type: 'system_notice', content: 'Compacting automatically (context 40%)' },
      { type: 'native_compacting', trigger: 'auto-in-turn', foldedTurns: 3 },
      { type: 'native_compacted', inTurn: true, summary: 'Earlier context', foldedTurns: 3 },
      { type: 'system_notice', content: 'Compacted, continuing (context now 4%)' },
      { type: 'primary_text', phase: 'passthrough', text: 'Continuing the first request.' },
      { type: 'ctx_action', action: 'system_delta', trigger: 'operator', detail: 'Plan edit one' },
      { type: 'primary_complete', phase: 'passthrough' },
      { type: 'primary_turn_ended' },
      { type: 'user_message_echo', content: 'Second request', clientMessageId: 'second' },
      { type: 'primary_turn_started' },
      { type: 'primary_text', phase: 'passthrough', text: 'Second reply.' },
      { type: 'ctx_action', action: 'system_delta', trigger: 'operator', detail: 'Plan edit two' },
      { type: 'primary_complete', phase: 'passthrough' },
      { type: 'primary_turn_ended' },
    ];
    const events = records.map((record, index) => {
      const eventTs = base + index * 1000;
      return { ...record, workflowId: id, seq: index + 1, eventTs, timestamp: eventTs, startedAt: eventTs, endedAt: eventTs } as unknown as ServerMessage;
    });
    handleServerMessage({ type: 'replay_batch', workflowId: id, events }, ctx);
    const affected = (content: string) => content.startsWith('Compact') || content.startsWith('system prompt update appended');
    const rows = projectChatMessages(useAppStore.getState().jobs[id]).filter(m => m.role === 'user' || m.role === 'assistant' || affected(m.content));
    assert.deepEqual(rows.map(m => m.content), [
      'First request', 'Before compaction.', 'Compacting automatically (context 40%)',
      'Compacted, continuing (context now 4%)', 'Continuing the first request.',
      'system prompt update appended (operator) · Plan edit one',
      'Second request', 'Second reply.', 'system prompt update appended (operator) · Plan edit two',
    ]);
    assert.deepEqual(rows.filter(m => affected(m.content)).map(m => [m.eventSeq, m.timestamp]), [
      [4, base + 3000], [7, base + 6000], [9, base + 8000], [15, base + 14000],
    ]);
    const liveAt = Date.now();
    handleServerMessage({ type: 'system_notice', workflowId: id, content: 'Live notice', seq: 18, eventTs: liveAt } as unknown as ServerMessage, ctx);
    assert.equal(projectChatMessages(useAppStore.getState().jobs[id]).at(-1)?.content, 'Live notice');
    const beforeFallback = Date.now();
    handleServerMessage({ type: 'system_notice', workflowId: id, content: 'Legacy unsequenced notice' }, ctx);
    const fallback = useAppStore.getState().jobs[id].messages.at(-1)!;
    assert.ok(fallback.timestamp >= beforeFallback && fallback.timestamp <= Date.now());
    assert.equal(fallback.eventSeq, undefined);
  } finally {
    useAppStore.getState().removeJob(id);
    useAppStore.persist.setOptions({ storage });
  }
});


test('Gemini sub-agent updates create one conversation line per tool id on replay', () => {
  const storage = useAppStore.persist.getOptions().storage;
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const id = 'gemini-subagent-test';
  try {
    useAppStore.getState().createJob(id, { name: 'fixture', workingDirectory: '/fixture', skipPermissions: false, primaryProvider: 'antigravity-cli', primaryModel: 'gemini', primaryEffort: 'low' });
    for (const status of ['in_progress', 'completed']) handleServerMessage({ type: 'primary_tool_use', workflowId: id, tool: 'invoke_subagent', toolUseId: 'one', input: JSON.stringify({ Role: 'Researcher', Prompt: 'Read the brief' }), status } as unknown as ServerMessage, ctx);
    const rows = useAppStore.getState().jobs[id].messages.filter(m => m.toolUse?.tool === 'invoke_subagent');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].toolUse?.input, { Role: 'Researcher', Prompt: 'Read the brief' });
  } finally { useAppStore.getState().removeJob(id); useAppStore.persist.setOptions({ storage }); }
});

test('skill activity stays in the transcript after replay and clears when the turn ends', () => {
  const storage = useAppStore.persist.getOptions().storage;
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const id = 'skill-activity-replay';
  try {
    useAppStore.getState().createJob(id, { name: 'fixture', workingDirectory: '/fixture', skipPermissions: false, primaryProvider: 'claude', primaryModel: 'claude-opus-4-8', primaryEffort: 'low' });
    handleServerMessage({ type: 'primary_turn_started', workflowId: id, startedAt: 100 }, ctx);
    handleServerMessage({ type: 'skill_activity', workflowId: id, kind: 'loaded', name: 'Example', scope: 'builtin', turn: 100 }, ctx);
    assert.equal(useAppStore.getState().jobs[id].skillActivity?.[0]?.name, 'Example');
    useAppStore.setState(s => ({ jobs: { ...s.jobs, [id]: { ...s.jobs[id], skillActivity: [] } } }));
    handleServerMessage({ type: 'workflow_state_snapshot', workflowId: id, workers: {}, busy: true, turnStartedAt: 100, transcriptTail: [], skillActivity: [{ kind: 'loaded', name: 'Example', scope: 'builtin', turn: 100 }] }, ctx);
    assert.equal(useAppStore.getState().jobs[id].skillActivity?.[0]?.name, 'Example');
    handleServerMessage({ type: 'primary_turn_ended', workflowId: id, endedAt: 200 }, ctx);
    assert.deepEqual(useAppStore.getState().jobs[id].skillActivity, []);
    assert.ok(useAppStore.getState().jobs[id].messages.some(m => m.content === '[SKILL] Loaded: Example'));
    useAppStore.getState().removeJob(id);
    useAppStore.getState().createJob(id, { name: 'fixture', workingDirectory: '/fixture', skipPermissions: false, primaryProvider: 'claude', primaryModel: 'claude-opus-4-8', primaryEffort: 'low' });
    handleServerMessage({ type: 'replay_batch', workflowId: id, events: [
      { type: 'primary_turn_started', workflowId: id, startedAt: 100, seq: 1 },
      { type: 'skill_activity', workflowId: id, kind: 'loaded', name: 'Example', scope: 'builtin', turn: 100, seq: 2 },
      { type: 'primary_turn_ended', workflowId: id, endedAt: 200, seq: 3 },
    ] }, ctx);
    assert.deepEqual(useAppStore.getState().jobs[id].skillActivity, []);
    assert.ok(useAppStore.getState().jobs[id].messages.some(m => m.content === '[SKILL] Loaded: Example'));
  } finally {
    useAppStore.getState().removeJob(id);
    useAppStore.persist.setOptions({ storage });
  }
});

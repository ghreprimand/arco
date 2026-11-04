import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coalesceThinkingRuns,
  MAX_CLUSTER_THINKING_CHARS,
  type ClusterActivityItemLike,
} from './clusterActivity.helpers.js';

function thought(id: string, ts: number, summary: string, memberId = 'kimi'): ClusterActivityItemLike {
  return { id, ts, kind: 'thinking', summary, memberId };
}

test('coalesces word-sized Cursor thinking deltas without losing separators', () => {
  const rows = coalesceThinkingRuns([
    thought('first', 1, 'agency'),
    thought('space-1', 2, ' '),
    thought('second', 3, 'rule'),
    thought('space-2', 4, '\n('),
    thought('third', 5, 'Beta'),
    thought('fourth', 6, "'s"),
    thought('space-3', 7, ' '),
    thought('fifth', 8, 'own rule'),
  ]);

  assert.deepEqual(rows, [{
    id: 'first',
    ts: 8,
    kind: 'thinking',
    summary: "agency rule\n(Beta's own rule",
    memberId: 'kimi',
  }]);
});

test('tool and member boundaries keep thinking runs separate', () => {
  const tool: ClusterActivityItemLike = {
    id: 'tool',
    ts: 2,
    kind: 'tool-use',
    summary: 'src/index.ts',
    memberId: 'kimi',
  };
  const rows = coalesceThinkingRuns([
    thought('kimi-1', 1, 'before'),
    tool,
    thought('kimi-2', 3, 'after'),
    thought('other', 4, 'peer', 'claude'),
    thought('kimi-3', 5, 'again'),
  ]);

  assert.deepEqual(rows.map((row) => row.id), [
    'kimi-1',
    'tool',
    'kimi-2',
    'other',
    'kimi-3',
  ]);
});

test('drops a standalone whitespace-only thinking row', () => {
  assert.deepEqual(coalesceThinkingRuns([thought('blank', 1, ' \n ')]), []);
});

test('bounds the derived coalesced display row', () => {
  const rows = coalesceThinkingRuns([
    thought('first', 1, 'a'.repeat(MAX_CLUSTER_THINKING_CHARS)),
    thought('overflow', 2, 'more'),
  ]);

  assert.equal(rows[0]?.summary.length, MAX_CLUSTER_THINKING_CHARS);
  assert.match(rows[0]?.summary ?? '', /…$/);
});

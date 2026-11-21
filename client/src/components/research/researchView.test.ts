import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActivityEntry } from '../../stores/appStore.types';
import { searchCount } from './researchView';

test('a researcher card counts web searches from tool activity, once per call', () => {
  const activity: ActivityEntry[] = [
    { id: '1', kind: 'tool_use', tool: 'web_search', toolUseId: 't1', status: 'started', at: 1 },
    { id: '2', kind: 'tool_use', tool: 'web_search', toolUseId: 't1', status: 'completed', at: 2 },
    { id: '3', kind: 'tool_use', tool: 'web_search', toolUseId: 't2', at: 3 },
    { id: '4', kind: 'tool_use', tool: 'web_fetch', toolUseId: 't3', at: 4 },
    { id: '5', kind: 'thinking', text: 'web_search', at: 5 },
  ];
  assert.equal(searchCount({ activity }), 2);
  assert.equal(searchCount(undefined), 0);
});

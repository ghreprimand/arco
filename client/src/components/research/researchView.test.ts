import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActivityEntry } from '../../stores/appStore.types';
import { searchCount } from './researchView';
import { replaceResearchProvider, researchCreatePayload } from '../WorkflowCreator/ResearchStartForm';

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

test('a Claude CLI researcher keeps its transport without a Native-only search limit', () => {
  const director = { key: 'd', provider: 'claude' as const, model: 'sonnet', effort: 'medium', advanced: false };
  const researcher = { ...director, key: 'r', researchClaudeTransport: 'cli' as const, webSearchMaxUses: 5 };
  const payload = researchCreatePayload({ name: 'Fixture', brief: 'Compare.', blind: true, director, rows: [researcher] });
  assert.equal(payload.members[1].researchClaudeTransport, 'cli');
  assert.equal(payload.members[1].webSearchMaxUses, undefined);
  const codex = { ...director, key: 'c', provider: 'codex' as const, model: 'gpt-5.5' };
  const codexPayload = researchCreatePayload({ name: 'Fixture', brief: 'Compare.', blind: true, director, rows: [codex] });
  assert.equal(codexPayload.members[1].provider, 'codex');
  assert.equal(codexPayload.members[1].researchClaudeTransport, undefined);
  const switched = replaceResearchProvider(researcher, codex);
  assert.equal(switched.provider, 'codex');
  assert.equal(switched.researchClaudeTransport, undefined);
  assert.equal(switched.webSearchMaxUses, undefined);
  assert.equal(switched.key, researcher.key);
});

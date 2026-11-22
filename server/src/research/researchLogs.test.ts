import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { researcherLogs } from './researchClose.js';
import type { ResearchState } from './researchState.js';

test('the researcher log records a Cursor web search query', async () => {
  const membersCwd = await fs.mkdtemp(join(tmpdir(), 'arco-research-logs-'));
  const dir = join(membersCwd, '.arco', 'workflows', 'wf-c');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'events.jsonl'), JSON.stringify({ type: 'primary_tool_use', tool: 'WebSearch', toolUseId: 't1', input: JSON.stringify({ searchTerm: 'Eiffel Tower height today' }) }) + '\n');
  const state = { membersCwd, researchers: [{ workflowId: 'wf-c', letter: 'C', provider: 'cursor', model: 'auto' }] } as unknown as ResearchState;
  const log = await researcherLogs(state);
  assert.match(log, /- Web searches: 1\n {2}- Eiffel Tower height today/);
  await fs.rm(membersCwd, { recursive: true, force: true });
});

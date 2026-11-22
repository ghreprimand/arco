import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a research request refused after its folder was made leaves no empty folder', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'arco-research-refused-'));
  const { patchSettings } = await import('../settings.js');
  await patchSettings({ researchFolder: root });
  const h = await import('./clusterHandlers.js');
  const errors: string[] = [];
  const ws = { readyState: 1, OPEN: 1, send: (raw: string) => { const m = JSON.parse(raw); if (m.type === 'error') errors.push(m.message); } } as never;
  const session = { id: 's', workflowIds: new Set(), clusterIds: new Set(), clusterObserved: new Map() } as never;
  let created = 0;
  h.initClusterHandlers({ catalogModelKnown: async () => false, handleUserMessage: async () => {}, handleRemoveWorkflow: () => {}, assertAllMembersClaudeOrCodex: async () => null, createBlankNativeWorkflow: async () => { created++; return 'never'; } });
  try {
    // The unknown model is refused only after the dated folder exists.
    await h.handleClusterCreateFromScratch(ws, session, { type: 'cluster_create_from_scratch', cwd: '', research: { name: 'Refused', brief: 'Compare.' },
      members: [{ provider: 'claude', model: 'fixture-unknown' }, { provider: 'claude', model: 'fixture-unknown' }] } as never);
    assert.equal(created, 0);
    assert.match(errors.join('\n'), /rejected: member\[0\]/);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await patchSettings({ researchFolder: '' });
    await fs.rm(root, { recursive: true, force: true });
  }
});

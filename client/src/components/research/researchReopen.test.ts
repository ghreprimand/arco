import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reopenPayload } from './ResearchReopenDialog';

const preview = { projectId: '11111111-1111-4111-8111-111111111111', name: 'Heat pump',
  director: { resumable: true, provider: 'codex' as const, model: 'gpt-fixture', effort: 'high' } };
const row = { provider: 'ollama' as const, model: 'qwen3:32b', effort: '', webAccess: false };

test('REOPEN sends the saved Research Director when it resumes, and the chosen one otherwise', () => {
  const chosen = { provider: 'claude' as const, model: 'sonnet', effort: 'medium' };
  const resumed = reopenPayload(preview, true, chosen, [row]);
  assert.deepEqual(resumed.members, [{ provider: 'codex', model: 'gpt-fixture', effort: 'high' }, { provider: 'ollama', model: 'qwen3:32b', webAccess: false }]);
  assert.deepEqual(resumed.research.reopen, { projectId: preview.projectId, resumeDirector: true });
  const fresh = reopenPayload(preview, false, chosen, [row]);
  assert.deepEqual(fresh.members[0], chosen);
  assert.equal(fresh.research.reopen.resumeDirector, false);
  // A provider without effort levels sends no effort; an empty one is refused.
  assert.deepEqual(reopenPayload(preview, false, { provider: 'cursor', model: 'auto', effort: '' }, [row]).members[0], { provider: 'cursor', model: 'auto' });
});

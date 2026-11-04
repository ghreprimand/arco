import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkflowState } from '../workflows/types.js';
import { workflows } from '../server/state.js';
import { scanEventsOfTypes } from '../workflowStore.js';
import { readConditionReply, restoreConditionReply, retryConditionReply } from './conditionReply.js';
import { observedWorker, observeConditionMessage, forgetObservedWorker } from './conditionFacts.js';

async function fixture(events: object[], run: (cwd: string, id: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-condition-reply-')), id = randomUUID(), dir = join(cwd, '.arco', 'workflows', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'events.jsonl'), events.map((e, i) => JSON.stringify({ workflowId: id, seq: i + 1, ts: Date.now(), ...e })).join('\n') + '\n');
  try { await run(cwd, id); } finally { workflows.delete(id); forgetObservedWorker(id); await rm(cwd, { recursive: true, force: true }); }
}
const start = { type: 'user_message_echo', content: 'Report progress.' };
const text = (text: string) => ({ type: 'primary_text', phase: 'passthrough', text });

test('short human question survives large metadata after the reply without retaining the whole transcript', async () => fixture([
  start, text('Which option do you want me to use?'), { type: 'task_ledger_snapshot', padding: 'x'.repeat(600000) },
], async (cwd, id) => {
  assert.deepEqual(await readConditionReply(cwd, id), { text: 'Which option do you want me to use?', truncated: false });
  let visited = 0; assert.deepEqual(await scanEventsOfTypes(cwd, id, ['primary_text'], () => { visited++; }), []); assert.equal(visited, 1);
}));
test('old long replies and thinking do not contaminate the current complete short reply', async () => fixture([
  start, text('old'.repeat(20000)), start, { type: 'primary_thinking', text: 'Do I need to ask a question?' }, text('Still working; testing is in progress.'),
], async (cwd, id) => assert.deepEqual(await readConditionReply(cwd, id), { text: 'Still working; testing is in progress.', truncated: false })));
test('genuinely oversized or boundary-truncated replies stay unknown rather than being silently cleared', async () => {
  for (const events of [[start, text('x'.repeat(33000))], [text('Only the end of a reply.')], [start, text('Old reply.'), { type: 'context_folded' }]]) {
    await fixture(events, async (cwd, id) => { const result = await readConditionReply(cwd, id); assert(result.truncated); assert(result.text.length <= 32000); });
  }
});
test('reply restoration excludes private workers and cannot overwrite a newer live turn', async () => fixture([start, text('Old question?')], async (cwd, id) => {
  const wf = { config: { kind: 'workflow', workingDirectory: cwd, incognito: true }, primary: { provider: 'codex' }, busy: false } as WorkflowState;
  workflows.set(id, wf); await restoreConditionReply(id, wf); assert.equal(observedWorker(id).text, '');
  wf.config.incognito = false; const pending = restoreConditionReply(id, wf);
  observeConditionMessage(id, 'cluster', { type: 'user_message_echo', workflowId: id, content: 'New answer.', timestamp: Date.now() });
  observeConditionMessage(id, 'cluster', { type: 'primary_text', workflowId: id, phase: 'passthrough', text: 'New response.' });
  await pending; assert.equal(observedWorker(id).text, 'New response.');
}));
test('unknown restored history is retried only after an explicit resume and still needs semantic observation', async () => fixture([text('Incomplete reply.')], async (cwd, id) => {
  const wf = { config: { kind: 'workflow', workingDirectory: cwd }, primary: { provider: 'codex' }, busy: false } as WorkflowState;
  workflows.set(id, wf); await restoreConditionReply(id, wf); assert(observedWorker(id).truncated);
  await writeFile(join(cwd,'.arco','workflows',id,'events.jsonl'), [start,text('Which option?')].map((e,i)=>JSON.stringify({seq:i+1,workflowId:id,...e})).join('\n')+'\n');
  await restoreConditionReply(id, wf); assert(observedWorker(id).truncated, 'no event-driven automatic disk retries');
  retryConditionReply(id); await restoreConditionReply(id, wf);
  assert.equal(observedWorker(id).text,'Which option?'); assert.equal(observedWorker(id).truncated,false); assert.equal(observedWorker(id).input,null,'resume never grants permission to ignore a question');
}));

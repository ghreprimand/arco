import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catchUpActivityTimes, catchUpMarkerStart, collectCatchUpFacts, readCatchUpEvents, resolveCatchUpWindow } from './catchUp.js';
import { buildUtilityPrompt } from './utilityJob.js';
import { UTILITY_JOB_INPUT_MAX_CHARS } from '@arco/shared';

test('collects only transcript and board events in the requested interval', () => {
  const { facts, truncated } = collectCatchUpFacts([
    { id: 'a', label: 'Builder', events: [
      { ts: 10, type: 'user_message_echo', content: 'old' },
      { ts: 20, type: 'user_message_echo', content: 'Build it' },
      { ts: 21, type: 'primary_text', text: 'Done ' }, { ts: 22, type: 'primary_text', text: 'today.' },
      { ts: 23, type: 'task_ledger_event', op: 'update', task: { title: 'Review', status: 'review' } },
      { ts: 24, type: 'primary_tool_use', content: 'hidden tool' },
      { ts: 51, type: 'user_message_echo', content: 'later' },
    ] },
    { id: 'b', label: 'Tester', events: [{ ts: 19, type: 'peer_message_received', content: 'Tests pass' }] },
  ], 10, 50);
  assert.deepEqual(facts.map((f) => f.value), ['Tests pass', 'Build it', 'Done today.', 'update: Review (review)', '1 board change; 1 review']);
  assert.equal(truncated, false);
});
test('board movement names release labels and counts changes by status', () => {
  const { facts } = collectCatchUpFacts([{ id: 'a', label: 'Director', events: [
    { ts: 5, type: 'task_ledger_event', op: 'create', task: { title: 'Out of range', status: 'todo', release: '0.1.4' } },
    { ts: 20, type: 'task_ledger_event', op: 'update', task: { title: 'Fix A', status: 'done', release: '0.1.4' } },
    { ts: 21, type: 'task_ledger_event', op: 'update', task: { title: 'Fix B', status: 'review', release: '0.1.4' } },
    { ts: 22, type: 'task_ledger_event', op: 'update', task: { title: 'Plain', status: 'review' } },
  ] }], 10, 50);
  assert.ok(facts.some((f) => f.value === 'update: Fix A (done) [release 0.1.4]'));
  assert.ok(facts.some((f) => f.value === 'update: Plain (review)'), 'unlabeled tasks read as before');
  const movement = facts.find((f) => f.label === 'Board movement in this range');
  assert.equal(movement?.value, '3 board changes; 1 done, 2 review; by release: 0.1.4 2');
  assert.equal(collectCatchUpFacts([{ id: 'a', label: 'Director', events: [{ ts: 20, type: 'user_message_echo', content: 'hi' }] }], 10, 50).facts.some((f) => f.label.startsWith('Board movement')), false);
});
test('facts are bounded and truncation is explicit', () => {
  const events = Array.from({ length: 45 }, (_, i) => ({ ts: i + 1, type: 'user_message_echo', content: `${i}:` + 'x'.repeat(600) }));
  const { facts, truncated } = collectCatchUpFacts([{ id: 'a', label: 'Worker', events }], 0, 100);
  assert.equal(facts.length, 32); assert.equal(truncated, true); assert.ok(facts.every((f) => f.value.length <= 350));
  const prompt = buildUtilityPrompt([{ label: 'Coverage', value: 'Earlier activity omitted.' }, ...facts], undefined);
  assert.equal(prompt.truncated, false); assert.ok(prompt.prompt.length <= UTILITY_JOB_INPUT_MAX_CHARS);
});
test('reads a bounded durable event tail and reports omissions', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-catch-')); const dir = join(cwd, '.arco', 'workflows', 'fixture');
  try {
    await mkdir(dir, { recursive: true });
    const row = JSON.stringify({ ts: 20, type: 'user_message_echo', content: 'x'.repeat(500) }) + '\n';
    await writeFile(join(dir, 'events.jsonl'), row.repeat(2200));
    const result = await readCatchUpEvents(cwd, 'fixture');
    assert.equal(result.truncated, true); assert.ok(result.events.length > 0 && result.events.length < 2200);
    await assert.rejects(readCatchUpEvents(cwd, '../escape'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('refuses an activity file symlink', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-catch-link-')); const dir = join(cwd, '.arco', 'workflows', 'fixture');
  try {
    await mkdir(dir, { recursive: true }); await writeFile(join(cwd, 'outside'), '{}');
    try { await symlink(join(cwd, 'outside'), join(dir, 'events.jsonl')); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Symlink creation is unavailable.'); return; } throw error; }
    await assert.rejects(readCatchUpEvents(cwd, 'fixture'), /Unsafe workflow activity/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a member that is not loaded or is incognito is skipped and named as unavailable', () => {
  const { facts } = collectCatchUpFacts([
    { id: 'a', label: 'Builder', events: [{ ts: 20, type: 'user_message_echo', content: 'Build it' }] },
    { id: 'b', label: 'Tester', events: [], unavailable: true },
  ], 10, 50);
  assert.equal(facts.length, 2);
  assert.match(facts[0]!.label, /Builder Operator$/);
  assert.deepEqual(facts[1], { label: 'Tester', value: 'activity not available' });
});

test('resolveCatchUpWindow reports empty when there is no transcript activity', () => {
  assert.deepEqual(resolveCatchUpWindow([{ id: 'a', label: 'Worker', events: [] }], 1000), { empty: true });
  assert.deepEqual(resolveCatchUpWindow([{ id: 'a', label: 'Worker', events: [], unavailable: true }], 1000), { empty: true });
});

test('resolveCatchUpWindow starts at the first event for a young tab', () => {
  const end = 1_000_000;
  const earliest = end - 60_000;
  const window = resolveCatchUpWindow([
    { id: 'a', label: 'Worker', events: [{ ts: earliest, type: 'user_message_echo', content: 'Hello' }] },
  ], end);
  assert.deepEqual(window, { from: earliest - 1 });
});

test('resolveCatchUpWindow clamps older tabs to the last 24 hours', () => {
  const end = 10 * 24 * 60 * 60 * 1000;
  const earliest = end - 3 * 24 * 60 * 60 * 1000;
  const window = resolveCatchUpWindow([
    { id: 'a', label: 'Worker', events: [{ ts: earliest, type: 'user_message_echo', content: 'Hello' }] },
  ], end);
  assert.deepEqual(window, { from: end - 24 * 60 * 60 * 1000 });
});


test('default starts at the earlier of the last operator message and visit', () => {
  const times = catchUpActivityTimes([{ id: 'a', label: 'Worker', events: [
    { ts: 10, type: 'user_message_echo', content: 'begin' },
    { ts: 20, type: 'primary_text', text: 'answer' },
  ] }], 30);
  assert.deepEqual(times, { lastActivity: 20, lastOperator: 10 });
  assert.equal(catchUpMarkerStart(25, times.lastOperator), 9);
  assert.equal(catchUpMarkerStart(5, times.lastOperator), 4);
  assert.equal(catchUpMarkerStart(5, null), 4);
});

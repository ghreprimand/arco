import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JobState } from '../stores/appStore';
import { collectClusterFacts, collectWorkerFacts, formatDuration, lastOperatorMessageState, toolSubject } from './briefFacts';

const NOW = 1_000_000_000;
function job(patch: Partial<JobState>): JobState {
  return { id: 'w1', messages: [], activity: [], busy: false, ...patch } as unknown as JobState;
}
const base = { name: 'Builder', hasQuestion: false, pendingMail: 0, tasks: [], changedFiles: null, now: NOW };
const get = (f: { label: string; value: string }[], l: string) => f.find((x) => x.label === l)!.value;

test('durations are short and exact', () => {
  assert.equal(formatDuration(4_000), '4s');
  assert.equal(formatDuration(192_000), '3m 12s');
  assert.equal(formatDuration(3_900_000), '1h 5m');
});

test('tool subject takes the first line of the most telling argument', () => {
  assert.equal(toolSubject(JSON.stringify({ command: 'npm test\nsecond', description: 'x' })), 'npm test');
  assert.equal(toolSubject(JSON.stringify({ file_path: '/a/b.ts' })), '/a/b.ts');
  assert.equal(toolSubject('{not json'), '{not json');
  assert.equal(toolSubject(undefined), '');
});

test('a busy worker names its step, elapsed time and marks a long step', () => {
  const j = job({ busy: true, turnStartedAt: NOW - 192_000, activity: [{ id: 'a', kind: 'tool_use', tool: 'Bash', input: JSON.stringify({ command: 'npm run build' }), status: 'started', at: NOW - 150_000 }] });
  const f = collectWorkerFacts({ ...base, job: j });
  assert.equal(get(f, 'Turn state'), 'working for 3m 12s');
  assert.equal(get(f, 'Current step'), 'Bash: npm run build, 2m 30s (long-running)');
});

test('a thinking step uses the working indicator wording and time', () => {
  const j = job({ busy: true, turnStartedAt: NOW - 45_000, activity: [{ id: 'a', kind: 'thinking', text: '...', at: NOW - 30_000 }, { id: 'b', kind: 'thinking', text: '...', at: NOW - 5_000 }] });
  assert.equal(get(collectWorkerFacts({ ...base, job: j }), 'Current step'), 'Thinking, 5s');
});

test('an idle worker has no step and a busy one with no activity is not visible', () => {
  assert.equal(get(collectWorkerFacts({ ...base, job: job({ lastTurnEndedAt: NOW - 60_000 }) }), 'Turn state'), 'idle, last turn ended 1m 0s ago');
  assert.equal(get(collectWorkerFacts({ ...base, job: job({}) }), 'Current step'), 'none (idle)');
  assert.match(get(collectWorkerFacts({ ...base, job: job({ busy: true }) }), 'Current step'), /^not visible/);
});

test('operator message state: queued, delivered and answered', () => {
  const user = { role: 'user', content: 'please run the tests', timestamp: 1 };
  const reply = { role: 'assistant', content: 'done', timestamp: 2 };
  assert.equal(lastOperatorMessageState(job({ messages: [{ ...user, queued: true }] as never }))!.state, 'queued');
  assert.equal(lastOperatorMessageState(job({ messages: [user] as never }))!.state, 'delivered, no reply yet');
  assert.equal(lastOperatorMessageState(job({ messages: [user, reply] as never }))!.state, 'answered');
  // The per-turn message state decides while a turn holds messages; the queue alone does not.
  assert.equal(lastOperatorMessageState(job({ messages: [user] as never, queue: { steering: [], followUp: [{ content: 'please run the tests' }] } }))!.state, 'delivered, no reply yet');
  const held = (state: 'queued' | 'delivered') => job({ messages: [user, reply] as never, turnMessages: { c1: { content: 'earlier', kind: 'steer', state: 'delivered' }, c2: { content: 'run it again', kind: 'follow-up', state } } });
  assert.deepEqual(lastOperatorMessageState(held('queued')), { text: 'run it again', state: 'queued' });
  assert.deepEqual(lastOperatorMessageState(held('delivered')), { text: 'run it again', state: 'delivered, no reply yet' });
  assert.equal(lastOperatorMessageState(job({})), null);
});

test('recent events are bounded and unseen values read not visible', () => {
  const acts = Array.from({ length: 20 }, (_, n) => ({ id: String(n), kind: 'tool_use' as const, tool: `T${n}`, status: 'completed' as const, at: NOW - 1000 * (20 - n) }));
  const f = collectWorkerFacts({ ...base, job: job({ activity: acts }), tasks: [{ title: 'Port a thing', status: 'in_progress' }], pendingMail: 2, hasQuestion: true, changedFiles: 3 });
  assert.equal(get(f, 'Recent events').split(' | ').length, 6);
  assert.match(get(f, 'Recent events'), /T19/);
  assert.equal(get(f, 'Board task'), 'Port a thing [in_progress]');
  assert.equal(get(f, 'Unread peer mail'), '2');
  assert.equal(get(f, 'Pending question'), 'yes, waiting for the operator to answer');
  assert.equal(get(f, 'Uncommitted files'), '3');
  assert.equal(get(collectWorkerFacts({ ...base, job: job({}) }), 'Uncommitted files'), 'not visible');
  assert.equal(get(collectWorkerFacts({ ...base, job: undefined }), 'Turn state'), 'not visible (this worker is not loaded)');
});

test('cluster facts give one line per member and roll up who waits on the operator', () => {
  const a = collectWorkerFacts({ ...base, name: 'A', job: job({}), hasQuestion: true });
  const b = collectWorkerFacts({ ...base, name: 'B', job: job({}) });
  const c = collectWorkerFacts({ ...base, name: 'C', job: job({}) });
  const f = collectClusterFacts([{ name: 'A', facts: a, blocked: false }, { name: 'B', facts: b, blocked: false }, { name: 'C', facts: c, blocked: true }]);
  assert.equal(get(f, 'Members'), '3');
  assert.equal(f.filter((x) => x.label.startsWith('Member ')).length, 3);
  assert.equal(get(f, 'Waiting on the operator'), 'A, C');
  assert.equal(get(collectClusterFacts([{ name: 'B', facts: b, blocked: false }]), 'Waiting on the operator'), 'nobody');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitComposer } from './submitComposer';

type Options = Parameters<typeof submitComposer>[0];
function fixture(overrides: Partial<Options> = {}) {
  const events: unknown[][] = [];
  const options: Options = {
    compactAvailable: false, isCompacting: false, uploading: false, readDraft: () => ' hello ', attachments: [],
    provider: 'claude', isBusy: false,
    job: { id: 'test', config: {} } as Options['job'],
    addMessage: ((...args: unknown[]) => events.push(['message', ...args])) as Options['addMessage'],
    clearAttachments: (id) => { events.push(['clear', id]); },
    setValue: (value) => { events.push(['draft', value]); },
    planModeArmed: false, planModeToggleVisible: false,
    setPlanModeArmed: (value) => { events.push(['plan', value]); },
    onSend: (...args) => { events.push(['send', ...args]); },
    pickedSkills: [], setPickedSkills: (skills) => { events.push(['skills', skills]); },
    ...overrides,
  };
  return { options, events };
}

test('blocks while compacting or uploading and for empty drafts', () => {
  for (const overrides of [{ isCompacting: true }, { uploading: true }, { readDraft: () => '  ' }]) {
    const { options, events } = fixture(overrides);
    submitComposer(options);
    assert.deepEqual(events, []);
  }
});

test('routes cursor compression and terminal-only commands without sending', () => {
  let compacted = 0;
  const cursor = fixture({ provider: 'cursor', readDraft: () => '/compress', onCompact: () => { compacted++; } });
  submitComposer(cursor.options);
  assert.equal(compacted, 1);
  assert.deepEqual(cursor.events, [['draft', ''], ['clear', 'test']]);
  const login = fixture({ readDraft: () => '/login' });
  submitComposer(login.options);
  assert.equal(login.events[0][0], 'message');
  assert.match((login.events[0][2] as { content: string }).content, /^\[AUTH:claude\]/);
  assert.equal(login.events.some((event) => event[0] === 'send'), false);
});

test('goal commands update configuration without sending a turn', () => {
  const changes: unknown[] = [];
  const { options, events } = fixture({ readDraft: () => '/goal run 3', job: { id: 'test', config: { goal: 'ship' } } as Options['job'], onUpdatePrimary: (change) => { changes.push(change); } });
  submitComposer(options);
  assert.deepEqual(changes, [{ goalRun: { enabled: true, total: 3 } }]);
  assert.equal(events.some((event) => event[0] === 'send'), false);
  assert.equal(events[0][0], 'message');
});

test('sends attachments, skills and busy kind; retains draft on failure', () => {
  const { options, events } = fixture({ isBusy: true, kind: 'steer', attachments: [{ path: '/sample' }] as Options['attachments'], pickedSkills: [{ scope: 'global', slug: 'review', name: 'Review' }], planModeArmed: true, planModeToggleVisible: true, onArmPlanMode: () => { events.push(['arm']); }, onSend: (...args) => { events.push(['send', ...args]); return false; } });
  submitComposer(options);
  assert.deepEqual(events, [['arm'], ['plan', false], ['send', 'hello', ['/sample'], 'steer', undefined, [{ scope: 'global', slug: 'review' }]]]);
});

test('idle ignores queue kind and successful send clears the draft', () => {
  const { options, events } = fixture({ kind: 'follow-up' });
  submitComposer(options);
  assert.deepEqual(events, [['plan', false], ['send', 'hello', undefined, undefined, undefined, undefined], ['draft', ''], ['clear', 'test'], ['skills', []]]);
});

test('cursor compression waits out a busy turn and refuses when the view cannot compact', () => {
  const busy = fixture({ provider: 'cursor', isBusy: true, readDraft: () => '/compress', onCompact: () => { throw new Error('must not compact'); } });
  submitComposer(busy.options);
  assert.match((busy.events[0][2] as { content: string }).content, /Wait for the current turn/);
  assert.deepEqual(busy.events.slice(1), [['draft', ''], ['clear', 'test']]);
  const missing = fixture({ provider: 'cursor', readDraft: () => '/compress' });
  submitComposer(missing.options);
  assert.match((missing.events[0][2] as { content: string }).content, /not available in this view/);
  assert.equal(missing.events.some((event) => event[0] === 'send'), false);
});

test('terminal-only commands, goal edges and an attachment-only send keep their old routes', () => {
  const compact = fixture({ provider: 'claude', readDraft: () => '/compact' });
  submitComposer(compact.options);
  assert.match((compact.events[0][2] as { content: string }).content, /terminal-only/);
  assert.equal(compact.events.some((event) => event[0] === 'send'), false);

  const named = fixture({ readDraft: () => '/goalkeeper' });
  submitComposer(named.options);
  assert.equal(named.events.some((event) => event[0] === 'send'), true);

  const shown = fixture({ readDraft: () => '/goal', job: { id: 'test', config: { goal: 'ship' } } as Options['job'] });
  submitComposer(shown.options);
  assert.match((shown.events[0][2] as { content: string }).content, /ship/);
  assert.equal(shown.events.some((event) => event[0] === 'send'), false);

  const stopped: unknown[] = [];
  const stop = fixture({ readDraft: () => '/goal run stop', onUpdatePrimary: (change) => { stopped.push(change); } });
  submitComposer(stop.options);
  assert.deepEqual(stopped, [{ goalRun: { enabled: false } }]);

  const bare: unknown[] = [];
  const noStar = fixture({ readDraft: () => '/goal run 4', onUpdatePrimary: (change) => { bare.push(change); } });
  submitComposer(noStar.options);
  assert.deepEqual(bare, []);
  assert.match((noStar.events[0][2] as { content: string }).content, /Set a north star first/);

  const files = fixture({ readDraft: () => '   ', attachments: [{ path: '/sample.png' }] as Options['attachments'] });
  submitComposer(files.options);
  assert.deepEqual(files.events.filter((event) => event[0] === 'send'), [['send', '', ['/sample.png'], undefined, undefined, undefined]]);

  const hidden = fixture({ planModeArmed: true, planModeToggleVisible: false, onArmPlanMode: () => { hidden.events.push(['arm']); } });
  submitComposer(hidden.options);
  assert.equal(hidden.events.some((event) => event[0] === 'arm'), false);
  assert.equal(hidden.events.some((event) => event[0] === 'send'), true);
});

for (const provider of ['codex', 'claude']) test(`B181: ${provider} native compact uses the available compact handler`, () => {
  let calls = 0;
  const { options, events } = fixture({ compactAvailable: true, provider, readDraft: () => '/compact', onCompact: () => { calls++; } });
  submitComposer(options);
  assert.equal(calls, 1);
  assert.ok(!events.some(e => e[0] === 'send' || e[0] === 'message'));
});


test('B181: busy native compact retains its draft and other providers keep their own commands', () => {
  const busy = fixture({ compactAvailable: true, provider: 'codex', isBusy: true, readDraft: () => '/compact', onCompact: () => { throw new Error('busy'); } });
  submitComposer(busy.options);
  assert.equal(busy.events.filter(e => e[0] === 'message').length, 1);
  assert.ok(!busy.events.some(e => e[0] === 'draft' || e[0] === 'send'));
  const other = fixture({ provider: 'codex', readDraft: () => '/status' });
  submitComposer(other.options);
  assert.ok(other.events.some(e => e[0] === 'send'));
});

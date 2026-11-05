// Claude Native checks around a tool call, in order. The first part runs the
// worker's real dispatchTool on synthetic calls in a temporary folder (no API
// request) and pins what happens before the tool runs (PreToolUse hooks and
// their input rewrites, the hardline floor, config protection, fact-force) and
// after it (output filter, partial-read note, PostToolUse hooks).
//
// Run: node --conditions development --import tsx --test src/providers/claude-native/toolChecks.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeNativeWorker } from './worker.js';
import type { HookConfig } from './hooks.js';
import { PRE_TOOL_GUARDS, firstBlockingGuard, postToolSteps, runPostToolSteps, type GuardInput, type PreToolGuard } from './toolChecks.js';

type Result = { text: string; isError: boolean };
interface Internals {
  dispatchTool(block: { id: string; name: string; input: Record<string, unknown> }): Promise<Result>;
  workflowEventBroadcast: (msg: Record<string, unknown>) => void;
  hooks: HookConfig;
  filesEditedThisTurn: Set<string>;
  partialReadSet: Set<string>;
}

function setup(config: Record<string, unknown> = {}, hooks: HookConfig = { byEvent: {} }) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'arco-native-checks-')));
  const w = new ClaudeNativeWorker({ workflowId: 'wf-native-checks', config: { model: 'sonnet', effort: 'medium', cwd, ...config } }) as unknown as Internals;
  const events: Array<Record<string, unknown>> = [];
  w.workflowEventBroadcast = (m) => events.push(m);
  w.hooks = hooks;
  let n = 0;
  const call = (name: string, input: Record<string, unknown>) => w.dispatchTool({ id: `tool-${++n}`, name, input });
  const gates = () => events.filter((e) => e.type === 'tool_gate_triggered').map((e) => `${e.gate}:${e.decision}`);
  return { cwd, w, events, call, gates, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

const hook = (event: string, matcher: string, command: string): HookConfig => ({ byEvent: { [event]: [{ matcher, hooks: [{ type: 'command', command }] }] } } as HookConfig);

test('before the tool: hardline, then config protection, then fact-force; the first block stops the rest', async () => {
  const s = setup({ efficiencyFactForce: 'on' });
  try {
    const rm = await s.call('Bash', { command: `rm -rf ${s.cwd}` });
    assert.equal(rm.isError, true);
    assert.match(rm.text, /^\[blocked by hardline-command-floor\]/);
    assert.ok(existsSync(s.cwd));
    const cfg = await s.call('Write', { file_path: join(s.cwd, '.eslintrc.json'), content: '{}' });
    assert.match(cfg.text, /^\[blocked by config-protection\]/);
    assert.equal(s.w.filesEditedThisTurn.size, 0, 'fact-force is not reached after a block');
    const first = await s.call('Write', { file_path: join(s.cwd, 'a.txt'), content: 'a' });
    assert.match(first.text, /^\[blocked by fact-force-first-edit\]/);
    assert.equal(existsSync(join(s.cwd, 'a.txt')), false);
    const again = await s.call('Write', { file_path: join(s.cwd, 'a.txt'), content: 'a' });
    assert.equal(again.isError, false, again.text);
    assert.equal(existsSync(join(s.cwd, 'a.txt')), true);
    assert.deepEqual(s.gates(), ['hardline-command-floor:blocked', 'config-protection:blocked', 'fact-force-first-edit:blocked']);
    // Every call is counted, blocked ones too.
    assert.deepEqual(s.events.filter((e) => e.type === 'primary_tool_counter').map((e) => e.toolCallsSinceCompact), [1, 2, 3, 4]);
  } finally { s.done(); }
});

test('config protection can be turned off; fact-force is off by default', async () => {
  let s = setup({ efficiencyConfigProtection: 'off', efficiencyFactForce: 'on' });
  try {
    assert.match((await s.call('Write', { file_path: join(s.cwd, '.eslintrc.json'), content: '{}' })).text, /^\[blocked by fact-force-first-edit\]/);
  } finally { s.done(); }
  s = setup();
  try {
    assert.equal((await s.call('Write', { file_path: join(s.cwd, 'b.txt'), content: 'b' })).isError, false);
    assert.match((await s.call('Write', { file_path: join(s.cwd, '.eslintrc.json'), content: '{}' })).text, /^\[blocked by config-protection\]/);
    assert.deepEqual(s.gates(), ['config-protection:blocked']);
  } finally { s.done(); }
});

test('a blocking PreToolUse hook comes before every guard; a rewrite is what the guards see', async () => {
  let s = setup({}, hook('PreToolUse', 'Bash', 'echo nope >&2; exit 2'));
  try {
    const r = await s.call('Bash', { command: `rm -rf ${s.cwd}` });
    assert.equal(r.text, '[blocked by PreToolUse hook] nope');
    assert.deepEqual(s.gates(), []);
    assert.equal(s.events.filter((e) => e.type === 'primary_tool_counter').length, 0, 'a hook block is not counted');
  } finally { s.done(); }
  s = setup();
  s.w.hooks = hook('PreToolUse', 'Bash', `echo '${JSON.stringify({ hookSpecificOutput: { updatedInput: { command: `rm -rf ${s.cwd}` } } })}'`);
  try {
    const r = await s.call('Bash', { command: 'echo harmless' });
    assert.match(r.text, /^\[blocked by hardline-command-floor\]/);
    assert.deepEqual(s.events.filter((e) => e.type === 'hook_rewrote_input').map((e) => e.rewrittenInput), [JSON.stringify({ command: `rm -rf ${s.cwd}` })]);
  } finally { s.done(); }
});

test('after the tool: the partial-read note, then PostToolUse stderr and context, in that order', async () => {
  const s = setup();
  s.w.hooks = hook('PostToolUse', 'Write', `echo warn >&2; echo '${JSON.stringify({ hookSpecificOutput: { additionalContext: 'extra context' } })}'`);
  try {
    const file = join(s.cwd, 'big.txt');
    writeFileSync(file, 'old');
    s.w.partialReadSet.add(file);
    const r = await s.call('Write', { file_path: file, content: 'new' });
    assert.equal(r.isError, false);
    const parts = r.text.split('\n\n');
    assert.match(parts[1], /partial/i);
    assert.deepEqual(parts.slice(2), ['[PostToolUse hook stderr] warn', 'extra context']);
    assert.deepEqual(s.gates(), ['partial-read-full-write:allowed']);
    assert.equal(s.w.partialReadSet.has(file), false, 'warned once');
  } finally { s.done(); }
});

test('a failed tool gets no partial-read note; a PostToolUse block replaces the result', async () => {
  let s = setup();
  try {
    const dir = join(s.cwd, 'adir'); mkdirSync(dir);
    s.w.partialReadSet.add(dir);
    const r = await s.call('Write', { file_path: dir, content: 'x' });
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.text, /partial/i);
  } finally { s.done(); }
  s = setup({}, hook('PostToolUse', 'Write', `echo '${JSON.stringify({ decision: 'block', reason: 'try again' })}'`));
  try {
    const r = await s.call('Write', { file_path: join(s.cwd, 'c.txt'), content: 'c' });
    assert.deepEqual(r, { text: '[PostToolUse hook blocked] try again', isError: true });
  } finally { s.done(); }
});

test('the output filter runs before the notes and reports what it did', async () => {
  const s = setup({ efficiencyToolFilter: 'conservative' });
  try {
    for (let i = 0; i < 400; i++) writeFileSync(join(s.cwd, `f${i}.txt`), '');
    const r = await s.call('Bash', { command: 'ls -la' });
    const filtered = s.events.filter((e) => e.type === 'tool_filtered');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].toolName, 'Bash');
    assert.ok(Number(filtered[0].filteredBytes) <= Number(filtered[0].originalBytes));
    assert.equal(r.isError, false);
  } finally { s.done(); }
  const off = setup();
  try {
    await off.call('Bash', { command: 'ls' });
    assert.equal(off.events.filter((e) => e.type === 'tool_filtered').length, 0);
  } finally { off.done(); }
});

// --- The lists themselves, with stand-in checks ---------------------------------------


test('the guard list order is hardline, config protection, fact-force', () => {
  assert.deepEqual(PRE_TOOL_GUARDS.map((g) => g.gate), ['hardline-command-floor', 'config-protection', 'fact-force-first-edit']);
});

test('the first blocking guard wins and later guards do not run', () => {
  const ran: string[] = [];
  const fake = (gate: PreToolGuard['gate'], blocks: boolean): PreToolGuard => ({ gate, check: () => { ran.push(gate); return blocks ? { gate, reason: gate, syntheticResult: `no (${gate})` } : null; } });
  const x: GuardInput = { name: 'Edit', input: {}, cwd: '/fixture', configProtection: true, factForce: true, filesEditedThisTurn: new Set() };
  assert.equal(firstBlockingGuard(x, [fake('hardline-command-floor', false), fake('config-protection', true), fake('fact-force-first-edit', true)])?.gate, 'config-protection');
  assert.deepEqual(ran, ['hardline-command-floor', 'config-protection']);
  assert.equal(firstBlockingGuard(x, [fake('hardline-command-floor', false)]), null);
});

test('after the tool: filter, note, hooks; a hook block ends the list', async () => {
  const order: string[] = [];
  const steps = postToolSteps({
    filter: async (text) => { order.push('filter'); return text.toUpperCase(); },
    partialNote: 'note',
    postHooks: async (text) => { order.push(`hooks saw: ${text}`); return [{ exitCode: 0, stdout: '', stderr: 'w', timedOut: false }] as never; },
  });
  assert.deepEqual(await runPostToolSteps(steps, { text: 'ok', isError: false }), { text: 'OK\n\nnote\n\n[PostToolUse hook stderr] w', isError: false });
  assert.deepEqual(order, ['filter', 'hooks saw: OK\n\nnote']);
  const failed = await runPostToolSteps(postToolSteps({ filter: async (t) => t, partialNote: 'note', postHooks: async () => [] }), { text: '[error] x', isError: true });
  assert.deepEqual(failed, { text: '[error] x', isError: true });
  const blocked = await runPostToolSteps([
    ...postToolSteps({ filter: async (t) => t, partialNote: null, postHooks: async () => [{ exitCode: 0, stdout: '{"decision":"block"}', stderr: '', timedOut: false }] as never }),
    async () => { throw new Error('a step after a final result ran'); },
  ], { text: 'ok', isError: false });
  assert.deepEqual(blocked, { text: '[PostToolUse hook blocked] PostToolUse hook requested retry', isError: true, final: true });
});

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
import { evaluateHooks, type HookConfig, type HookFireResult } from './hooks.js';
import { _powerShellFallbackForTest, _setCommandShellForTest } from '../../commandShell.js';
import { getNativeToolDefinitions } from './tools.js';
import { PRE_TOOL_GUARDS, firstBlockingGuard, postToolSteps, runPostToolSteps, type GuardInput, type PreToolGuard } from './toolChecks.js';

type Result = { text: string; isError: boolean };
interface Internals {
  dispatchTool(block: { id: string; name: string; input: Record<string, unknown> }): Promise<Result>;
  workflowEventBroadcast: (msg: Record<string, unknown>) => void;
  hooks: HookConfig;
  filesEditedThisTurn: Set<string>;
  partialReadSet: Set<string>;
  on(event: 'system_notice', listener: (notice: string) => void): unknown;
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
    assert.equal(r.text, 'PreToolUse:Bash hook error: [echo nope >&2; exit 2]: nope');
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

test('after the tool: the partial-read note, then PostToolUse context; exit-0 stderr is not for the model', async () => {
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
    assert.deepEqual(parts.slice(2), ['PostToolUse:Write hook additional context: extra context']);
    assert.deepEqual(s.gates(), ['partial-read-full-write:allowed']);
    assert.equal(s.w.partialReadSet.has(file), false, 'warned once');
  } finally { s.done(); }
});

test('a failed tool gets no partial-read note; a PostToolUse block adds its reason next to the result', async () => {
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
    assert.deepEqual(r, { text: `wrote 1 bytes to c.txt\n\nPostToolUse:Write hook feedback: [echo '{"decision":"block","reason":"try again"}']: try again`, isError: false });
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

test('the Bash tool runs in the platform shell and ends the whole tree on timeout', async () => {
  const s = setup();
  try {
    const ok = await s.call('Bash', { command: 'echo "hello from $0" && exit 3' });
    assert.match(ok.text, /exit code: 3/);
    assert.match(ok.text, /hello from /);
    const started = Date.now();
    // A background job that would leave a file behind if it outlived the kill.
    const slow = await s.call('Bash', { command: '(sleep 2; echo alive > alive.txt) & sleep 30', timeout: 1000 });
    assert.match(slow.text, /^\[timed out after 1000ms\]/);
    assert.ok(Date.now() - started < 15_000, `ended after ${Date.now() - started} ms`);
    await new Promise((r) => setTimeout(r, 3_000));
    assert.equal(existsSync(join(s.cwd, 'alive.txt')), false, 'the background job was ended with the tree');
  } finally { s.done(); }
});

// Windows with no shell at all (forced): Claude Code counts only exit 0 or 2
// as a shell-form PreToolUse hook's verdict there, so one that cannot start
// blocks unless it sets onFailure; the Bash tool says what is missing.
test('without a shell: a PreToolUse hook that cannot start blocks unless onFailure says otherwise; the Bash tool says what is missing', async () => {
  const s = setup({}, hook('PreToolUse', 'Write', 'exit 0'));
  const notices: string[] = [];
  s.w.on('system_notice', (n) => notices.push(n));
  _setCommandShellForTest({ ok: false, problem: 'Git Bash was not found (fixture). Install Git for Windows.' });
  try {
    const refused = await s.call('Write', { file_path: join(s.cwd, 'a.txt'), content: 'x' });
    assert.equal(refused.isError, true);
    assert.equal(refused.text, "PreToolUse:Write hook error: [exit 0]: failed; blocking because Git Bash wasn't found, so only exit code 0 or 2 counts as this hook's verdict.\nGit Bash was not found (fixture). Install Git for Windows.");
    assert.equal(existsSync(join(s.cwd, 'a.txt')), false);
    s.w.hooks = { byEvent: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'exit 0', onFailure: 'continue' }] }] } } as HookConfig;
    for (const name of ['b.txt', 'c.txt']) {
      const r = await s.call('Write', { file_path: join(s.cwd, name), content: 'x' });
      assert.equal(r.isError, false, r.text);
    }
    assert.deepEqual(notices, ['[HOOKS] A PreToolUse hook did not run, so the action went ahead. Git Bash was not found (fixture). Install Git for Windows. Hook: exit 0']);
    const bash = await s.call('Bash', { command: 'echo hi' });
    assert.equal(bash.isError, true);
    assert.match(bash.text, /The Bash tool cannot run: Git Bash was not found \(fixture\)\. Install Git for Windows\./);
  } finally { _setCommandShellForTest(null); s.done(); }
});

// Windows without Git Bash, as Claude Code does: hooks and the Bash tool run in
// PowerShell. Real on the Windows runner (Git Bash hidden from the lookup) and
// wherever else pwsh is installed.
const fallback = _powerShellFallbackForTest();
test('without Git Bash: the shell tool is PowerShell, hooks run in PowerShell and match "PowerShell", one information notice', { skip: fallback ? false : 'PowerShell is not installed here' }, async () => {
  const guard = '$in = [Console]::In.ReadToEnd() | ConvertFrom-Json; if ($in.tool_input.file_path -like "*blocked*") { [Console]::Error.WriteLine("refused in PowerShell " + $PSVersionTable.PSEdition); exit 2 }';
  const s = setup({}, { byEvent: { PreToolUse: [
    { matcher: 'Write', hooks: [{ type: 'command', command: guard }] },
    // Claude Code's names: a "Bash" matcher does not fire for the PowerShell tool.
    { matcher: 'Bash', hooks: [{ type: 'command', command: '[Console]::Error.WriteLine("bash matcher fired"); exit 2' }] },
    { matcher: 'PowerShell', hooks: [{ type: 'command', command: '$in = [Console]::In.ReadToEnd() | ConvertFrom-Json; if ($in.tool_input.command -match "forbidden") { [Console]::Error.WriteLine("powershell matcher: " + $in.tool_name); exit 2 }' }] },
  ] } } as HookConfig);
  const notices: string[] = [];
  s.w.on('system_notice', (n) => notices.push(n));
  _setCommandShellForTest(fallback);
  try {
    const ok = await s.call('Write', { file_path: join(s.cwd, 'a.txt'), content: 'x' });
    assert.equal(ok.isError, false, ok.text);
    const refused = await s.call('Write', { file_path: join(s.cwd, 'blocked.txt'), content: 'x' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /refused in PowerShell (Core|Desktop)/);
    assert.equal(existsSync(join(s.cwd, 'blocked.txt')), false);
    assert.deepEqual(notices, [`[HOOKS] ${fallback?.ok ? fallback.notice : ''}`], 'information, once');

    const defs = getNativeToolDefinitions();
    assert.equal(defs.some((d) => d.name === 'Bash'), false, 'no Bash tool');
    const pwsh = defs.find((d) => d.name === 'PowerShell');
    assert.match(pwsh?.description ?? '', /^Run a PowerShell command in the workflow cwd\. Git Bash was not found on this Windows computer, so this tool replaces Bash: write PowerShell commands, not bash or sh syntax\./);
    const ps = await s.call('PowerShell', { command: 'Write-Output "edition $($PSVersionTable.PSEdition)"; exit 3' });
    assert.match(ps.text, /exit code: 3/);
    assert.match(ps.text, /edition (Core|Desktop)/);
    const hooked = await s.call('PowerShell', { command: 'Write-Output forbidden' });
    assert.equal(hooked.text, 'PreToolUse:PowerShell hook error: [$in = [Console]::In.ReadToEnd() | ConvertFrom-Json; if ($in.tool_input.command -match "forbidden") { [Console]::Error.WriteLine("powershell matcher: " + $in.tool_name); exit 2 }]: powershell matcher: PowerShell');
    // A "Bash" call is an unknown tool here, refused before any hook.
    const bash = await s.call('Bash', { command: 'echo hi' });
    assert.deepEqual(bash, { text: '[error] unknown tool "Bash". The shell tool here is PowerShell.', isError: true });
    // A failing program's exit code is the command's, as in sh.
    const native = await s.call('PowerShell', { command: '& node -e "process.exit(5)"' });
    assert.match(native.text, /exit code: 5/);
    const started = Date.now();
    const slow = await s.call('PowerShell', { command: 'Start-Sleep -Seconds 30', timeout: 1000 });
    assert.match(slow.text, /^\[timed out after 1000ms\]/);
    assert.ok(Date.now() - started < 15_000, `ended after ${Date.now() - started} ms`);
  } finally { _setCommandShellForTest(null); s.done(); }
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

test('after the tool: filter, note, hooks; hook text is added next to the result, as in Claude Code', async () => {
  const order: string[] = [];
  const run = (r: Partial<HookFireResult>) => async (_text: string, failed: boolean) =>
    evaluateHooks(failed ? 'PostToolUseFailure' : 'PostToolUse', 'Bash', [{ exitCode: 0, stdout: '', stderr: '', timedOut: false, command: 'h', ...r }]);
  const steps = postToolSteps({
    filter: async (text) => { order.push('filter'); return text.toUpperCase(); },
    partialNote: 'note',
    toolName: 'Bash',
    postHooks: async (text, failed) => { order.push(`hooks saw: ${text}`); return run({ stderr: 'exit-0 stderr is not for the model' })(text, failed); },
  });
  assert.deepEqual(await runPostToolSteps(steps, { text: 'ok', isError: false }), { text: 'OK\n\nnote', isError: false });
  assert.deepEqual(order, ['filter', 'hooks saw: OK\n\nnote']);
  // Exit 2: stderr goes to the model; the tool already ran, so the result stays.
  const exit2 = await runPostToolSteps(postToolSteps({ filter: async (t) => t, partialNote: null, toolName: 'Bash', postHooks: run({ exitCode: 2, stderr: 'lint failed' }) }), { text: 'ok', isError: false });
  assert.deepEqual(exit2, { text: 'ok\n\nPostToolUse:Bash hook error: [h]: lint failed', isError: false });
  // decision "block" adds its reason; nothing after the hooks is skipped.
  const blocked = await runPostToolSteps(postToolSteps({ filter: async (t) => t, partialNote: null, toolName: 'Bash', postHooks: run({ stdout: '{"decision":"block","reason":"fix the tests"}' }) }), { text: 'ok', isError: false });
  assert.deepEqual(blocked, { text: 'ok\n\nPostToolUse:Bash hook feedback: [h]: fix the tests', isError: false });
  // Exit 1 is a non-blocking error for the operator, not text for the model.
  const exit1 = await runPostToolSteps(postToolSteps({ filter: async (t) => t, partialNote: null, toolName: 'Bash', postHooks: run({ exitCode: 1, stderr: 'oops' }) }), { text: 'ok', isError: false });
  assert.deepEqual(exit1, { text: 'ok', isError: false });
  // updatedToolOutput replaces what the model sees; continue:false asks to stop.
  const replaced = await runPostToolSteps(postToolSteps({ filter: async (t) => t, partialNote: null, toolName: 'Bash', postHooks: run({ stdout: '{"continue":false,"stopReason":"enough","hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":{"stdout":"[redacted]","stderr":""},"additionalContext":"ctx"}}' }) }), { text: 'secret', isError: false });
  assert.deepEqual(replaced, { text: '[redacted]\n\nPostToolUse:Bash hook additional context: ctx', isError: false, stop: 'enough' });
  // A failed tool runs PostToolUseFailure and gets no partial-read note.
  const failed = await runPostToolSteps(postToolSteps({ filter: async (t) => t, partialNote: 'note', toolName: 'Bash', postHooks: run({ exitCode: 2, stderr: 'saw it' }) }), { text: '[error] x', isError: true });
  assert.deepEqual(failed, { text: '[error] x\n\nPostToolUseFailure:Bash hook error: [h]: saw it', isError: true });
});

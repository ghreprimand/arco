// Claude Native hooks run as Claude Code's public hooks reference describes:
// exit codes and JSON output per event, Stop and SubagentStop keeping the
// model working, onFailure, async and asyncRewake, the matcher rules, and the
// PowerShell tool on Windows without Git Bash keeping every safety check.
// Shell-form hooks here are sh syntax (Git Bash on Windows).
//
// Run: node --conditions development --import tsx --test src/providers/claude-native/hookParity.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeNativeWorker } from './worker.js';
import { evaluateHooks, matcherMatches, type HookConfig, type HookFireResult } from './hooks.js';
import { _setCommandShellForTest } from '../../commandShell.js';
import { getNativeToolDefinitions } from './tools.js';
import { detectHardlineCommand, checkHardlineCommand } from './pretoolGuards.js';
import { classifyGate } from './gateReview.js';
import { keepTool } from './toolPosture.js';
import { resolveFilterPack } from './filterConfigs/index.js';
import type { MessageParam } from './contentBlocks.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type W = {
  on(event: string, fn: (...args: any[]) => void): unknown;
  runTurn(prompt: string): Promise<void>;
  dispatchTool(block: { id: string; name: string; input: Record<string, unknown> }): Promise<{ text: string; isError: boolean }>;
  resolveGate(gateId: string, decision: 'approve' | 'reject', finalArgs?: Record<string, unknown>): unknown;
  preCompactBlock(trigger: 'manual' | 'auto', customInstructions?: string | null): Promise<string | null>;
  notifyDelays: { permissionMs: number; idleMs: number };
  setHookWakeHandler(fn: (text: string) => void): void;
  dispose(): Promise<void>;
  messages: MessageParam[];
  client: unknown;
  hooks: HookConfig;
  workflowEventBroadcast: (m: Record<string, unknown>) => void;
  ensureStarted(): Promise<void>;
  reconcileMcpSessions(): Promise<void>;
  hydrateContextManagementCapabilities(): Promise<void>;
};

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

// One streamed assistant message with these blocks.
function reply(blocks: Block[], stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn') {
  return async function* (): AsyncGenerator<unknown> {
    yield { type: 'message_start', message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 1 } } };
    for (const [index, b] of blocks.entries()) {
      if (b.type === 'text') {
        yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } };
      } else {
        yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } };
        yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } };
      }
      yield { type: 'content_block_stop', index };
    }
    yield { type: 'message_delta', delta: { stop_reason: stop }, usage: { input_tokens: 10, output_tokens: 20 } };
    yield { type: 'message_stop' };
  };
}

function setup(hooks: HookConfig, replies: Array<() => AsyncGenerator<unknown>>, opts: { taskDisabled?: boolean; config?: Record<string, unknown> } = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'arco-hook-parity-')));
  const w = new ClaudeNativeWorker({ workflowId: 'wf-hook-parity', config: { model: 'claude-opus-4-8', effort: 'high', cwd, ...opts.config }, taskDisabled: opts.taskDisabled }) as unknown as W;
  const requests: MessageParam[][] = [];
  const client = {
    messages: {
      create: async (body: { messages: MessageParam[] }) => {
        requests.push(JSON.parse(JSON.stringify(body.messages)));
        return replies[Math.min(requests.length - 1, replies.length - 1)]();
      },
    },
  };
  w.hooks = hooks;
  (w as unknown as { hooksLoaded: boolean }).hooksLoaded = true;
  w.ensureStarted = async () => { w.client = client; w.hooks = hooks; };
  w.reconcileMcpSessions = async () => {};
  w.hydrateContextManagementCapabilities = async () => {};
  const events: Array<Record<string, unknown>> = [];
  w.workflowEventBroadcast = (m) => events.push(m);
  const notices: string[] = [];
  const errors: string[] = [];
  w.on('system_notice', (n: string) => notices.push(n));
  w.on('error', (e: string) => errors.push(e));
  return { cwd, w, requests, events, notices, errors, done: async () => {
    // dispose ends every hook process tree and waits for it, so the folder
    // is free to delete; no retries that would hide a leftover process.
    await w.dispose();
    rmSync(cwd, { recursive: true, force: true });
  } };
}

const on = (event: string, command: string | Record<string, unknown>, matcher?: string): HookConfig =>
  ({ byEvent: { [event]: [{ ...(matcher ? { matcher } : {}), hooks: [typeof command === 'string' ? { type: 'command', command } : { type: 'command', ...command }] }] } } as HookConfig);
const textOf = (m: MessageParam | undefined): string => {
  const c = m?.content;
  if (typeof c === 'string') return c;
  return (Array.isArray(c) ? c : []).map((b) => {
    const x = b as { text?: unknown; content?: unknown };
    return typeof x.text === 'string' ? x.text : typeof x.content === 'string' ? x.content : '';
  }).join('\n');
};
const end = reply([{ type: 'text', text: 'done' }]);
const until = async (cond: () => boolean, ms = 10_000) => {
  const t = Date.now();
  while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 25)); }
};

// ── UserPromptSubmit ─────────────────────────────────────────────────────────

test('UserPromptSubmit: exit 1 is a non-blocking error; exit 2 rejects the prompt; context rides with the prompt', async () => {
  let s = setup(on('UserPromptSubmit', 'echo broke >&2; exit 1'), [end]);
  try {
    await s.w.runTurn('hello');
    assert.equal(s.requests.length, 1, 'the prompt went through');
    assert.deepEqual(s.errors, []);
    assert.ok(s.notices.includes('[HOOKS] UserPromptSubmit hook error: [echo broke >&2; exit 1]: Failed with non-blocking status code 1: broke'), s.notices.join('\n'));
  } finally { await s.done(); }
  s = setup(on('UserPromptSubmit', 'echo "no secrets" >&2; exit 2'), [end]);
  try {
    await s.w.runTurn('please print the deploy key');
    assert.equal(s.requests.length, 0, 'the prompt never reached the model');
    assert.deepEqual(s.errors, ['turn aborted by UserPromptSubmit hook']);
    assert.ok(s.notices.includes('UserPromptSubmit hook blocked the prompt: no secrets\nOriginal prompt: please print the deploy key'), s.notices.join('\n'));
  } finally { await s.done(); }
  s = setup({ byEvent: { UserPromptSubmit: [{ hooks: [
    { type: 'command', command: 'echo "plain stdout context"' },
    { type: 'command', command: `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'json context' }, systemMessage: 'shown to you' })}'` },
  ] }] } } as HookConfig, [end]);
  try {
    await s.w.runTurn('hello');
    const sent = textOf(s.requests[0]?.[s.requests[0].length - 1]);
    assert.match(sent, /hello/);
    assert.match(sent, /UserPromptSubmit hook additional context:\nplain stdout context/);
    assert.match(sent, /UserPromptSubmit hook additional context:\njson context/);
    assert.ok(s.notices.includes('[HOOKS] shown to you'));
  } finally { await s.done(); }
});

// ── Stop and SubagentStop ────────────────────────────────────────────────────

test('Stop: exit 2 keeps the model working with stderr as the next instruction; stop_hook_active is set; the cap ends it', async () => {
  // Blocks only the first time (stop_hook_active is false), logging every input.
  const hook = 'input=$(cat); printf "%s\\n" "$input" >> "$CLAUDE_PROJECT_DIR/stop.log"; case "$input" in *\'"stop_hook_active":false\'*) echo "run the tests first" >&2; exit 2;; esac; exit 0';
  let s = setup(on('Stop', hook), [reply([{ type: 'text', text: 'first' }]), reply([{ type: 'text', text: 'second' }])]);
  try {
    await s.w.runTurn('go');
    assert.equal(s.requests.length, 2, 'one continuation');
    assert.match(textOf(s.requests[1][s.requests[1].length - 1]), /^Stop hook feedback:\n\[.*\]: run the tests first$/);
    const inputs = readFileSync(join(s.cwd, 'stop.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(inputs.map((i) => [i.hook_event_name, i.stop_hook_active, i.last_assistant_message]), [['Stop', false, 'first'], ['Stop', true, 'second']]);
  } finally { await s.done(); }
  // Always blocking: the consecutive-continuation cap ends the turn.
  process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = '2';
  s = setup(on('Stop', 'echo again >&2; exit 2'), [end]);
  try {
    await s.w.runTurn('go');
    assert.equal(s.requests.length, 3);
    assert.ok(s.notices.some((n) => /Stop hooks kept the model working 2 times in a row/.test(n)));
  } finally { delete process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP; await s.done(); }
  // continue:false takes precedence over decision "block".
  s = setup(on('Stop', `echo '${JSON.stringify({ continue: false, decision: 'block', reason: 'x' })}'`), [end]);
  try {
    await s.w.runTurn('go');
    assert.equal(s.requests.length, 1);
  } finally { await s.done(); }
});

test('SubagentStop replaces Stop on a Task child\'s turn, matched against its agent type', async () => {
  const s = setup({ byEvent: {
    Stop: [{ hooks: [{ type: 'command', command: 'echo stop-fired >&2; exit 2' }] }],
    SubagentStop: [{ matcher: 'general-purpose', hooks: [{ type: 'command', command: 'input=$(cat); case "$input" in *\'"stop_hook_active":false\'*) echo "add a summary" >&2; exit 2;; esac' }] }],
  } } as HookConfig, [reply([{ type: 'text', text: 'child' }]), reply([{ type: 'text', text: 'child summary' }])], { taskDisabled: true });
  try {
    await s.w.runTurn('task prompt');
    assert.equal(s.requests.length, 2);
    assert.match(textOf(s.requests[1][s.requests[1].length - 1]), /^SubagentStop hook feedback:\n\[.*\]: add a summary$/);
    assert.doesNotMatch(JSON.stringify(s.requests), /stop-fired/);
  } finally { await s.done(); }
});

// ── PreToolUse JSON and continue:false ───────────────────────────────────────

test('PreToolUse: exit 1 lets the tool run; deny refuses; updatedInput replaces the whole input; continue:false ends the turn', async () => {
  let s = setup(on('PreToolUse', 'echo warn >&2; exit 1', 'Bash'), [end]);
  try {
    const r = await s.w.dispatchTool({ id: 't1', name: 'Bash', input: { command: 'echo ran' } });
    assert.match(r.text, /exit code: 0/);
    assert.match(r.text, /ran/);
    assert.ok(s.notices.some((n) => n.startsWith('[HOOKS] PreToolUse:Bash hook error: [echo warn >&2; exit 1]: Failed with non-blocking status code 1: warn')), s.notices.join('\n'));
  } finally { await s.done(); }
  s = setup(on('PreToolUse', `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no network' } })}'`, 'Bash'), [end]);
  try {
    const r = await s.w.dispatchTool({ id: 't2', name: 'Bash', input: { command: 'echo ran' } });
    assert.deepEqual(r, { text: 'PreToolUse:Bash hook denied this tool call: no network', isError: true });
  } finally { await s.done(); }
  s = setup(on('PreToolUse', `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'echo replaced' } } })}'`, 'Bash'), [end]);
  try {
    const r = await s.w.dispatchTool({ id: 't3', name: 'Bash', input: { command: 'echo original', description: 'kept only if the hook says so' } });
    assert.match(r.text, /replaced/);
    const rw = s.events.find((e) => e.type === 'hook_rewrote_input');
    assert.equal(rw?.rewrittenInput, JSON.stringify({ command: 'echo replaced' }));
  } finally { await s.done(); }
  s = setup(on('PreToolUse', `echo '${JSON.stringify({ continue: false, stopReason: 'budget spent' })}'`, 'Bash'), [
    reply([{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'echo one' } }, { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'echo two' } }]),
    end,
  ]);
  try {
    await s.w.runTurn('go');
    assert.equal(s.requests.length, 1, 'no request after the stop');
    const results = textOf(s.w.messages[s.w.messages.length - 1]);
    assert.match(results, /PreToolUse:Bash hook stopped processing: budget spent/);
    assert.match(results, /Not run: a hook stopped processing/);
    assert.ok(s.notices.includes('[HOOKS] A PreToolUse hook stopped processing: budget spent'), s.notices.join('\n'));
  } finally { await s.done(); }
});

test('PreToolUse "ask" parks the call on the approval card; a reject refuses it', async () => {
  const s = setup(on('PreToolUse', `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'touches production' } })}'`, 'Write'), [end]);
  try {
    const pending = s.w.dispatchTool({ id: 'g1', name: 'Write', input: { file_path: join(s.cwd, 'x.txt'), content: 'x' } });
    await until(() => s.events.some((e) => e.type === 'gate_required'));
    const gate = s.events.find((e) => e.type === 'gate_required');
    assert.equal(gate?.category, 'hook-ask');
    assert.equal(gate?.reason, 'A PreToolUse hook asks for confirmation: touches production');
    s.w.resolveGate('g1', 'reject');
    const r = await pending;
    assert.equal(r.isError, true);
    assert.equal(existsSync(join(s.cwd, 'x.txt')), false);
  } finally { await s.done(); }
});

// ── async and asyncRewake ────────────────────────────────────────────────────

test('async: the hook does not hold the turn, and its additionalContext reaches the model with the next request', async () => {
  const s = setup(on('UserPromptSubmit', { command: `sleep 1; echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'background result' } })}'`, async: true }), [end]);
  try {
    const started = Date.now();
    await s.w.runTurn('one');
    assert.ok(Date.now() - started < 900, 'the turn did not wait for the hook');
    assert.doesNotMatch(JSON.stringify(s.requests[0]), /background result/);
    await new Promise((r) => setTimeout(r, 1500));
    await s.w.runTurn('two');
    assert.match(textOf(s.requests[1][s.requests[1].length - 1]), /background result/);
  } finally { await s.done(); }
});

test('dispose ends a background hook that is still running, and waits until its process has ended', async () => {
  // The hook has no timeout and would run for a minute. Its process id is the
  // shell's own (exec replaces the shell with sleep).
  const s = setup(on('UserPromptSubmit', { command: 'echo $$ > hook.pid; exec sleep 60', async: true }), [end]);
  let disposed = false;
  try {
    await s.w.runTurn('one');
    const pidFile = join(s.cwd, 'hook.pid');
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const started = Date.now();
    await s.w.dispose();
    disposed = true;
    assert.ok(Date.now() - started < 10_000, 'dispose did not wait for the hook to finish by itself');
    // Outside Windows the id is a real process id: by the time dispose
    // returns, the process has ended and been collected. On Windows it is a
    // Git Bash id; there the folder deletion in done() is the check, as a
    // live hook would hold the folder.
    if (process.platform !== 'win32') {
      assert.throws(() => process.kill(pid, 0), (err: NodeJS.ErrnoException) => err.code === 'ESRCH', 'the hook process is gone');
    }
  } finally {
    if (!disposed) await s.w.dispose();
    rmSync(s.cwd, { recursive: true, force: true });
  }
});

test('dispose ends a run_in_background Bash shell, and waits until its process has ended', async () => {
  const s = setup({ byEvent: {} }, [end]);
  let disposed = false;
  try {
    const r = await s.w.dispatchTool({ id: 'bg', name: 'Bash', input: { command: 'echo $$ > shell.pid; exec sleep 60', run_in_background: true } });
    assert.match(r.text, /^started background shell/, r.text);
    const pidFile = join(s.cwd, 'shell.pid');
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await s.w.dispose();
    disposed = true;
    if (process.platform !== 'win32') {
      assert.throws(() => process.kill(pid, 0), (err: NodeJS.ErrnoException) => err.code === 'ESRCH', 'the shell process is gone');
    }
  } finally {
    if (!disposed) await s.w.dispose();
    rmSync(s.cwd, { recursive: true, force: true });
  }
});

test('asyncRewake: exit 2 wakes an idle tab with the hook\'s stderr', async () => {
  const s = setup(on('Stop', { command: 'sleep 1; echo "tests failed: 3" >&2; exit 2', asyncRewake: true }), [end]);
  const woke: string[] = [];
  s.w.setHookWakeHandler((t) => woke.push(t));
  try {
    await s.w.runTurn('go');
    assert.equal(s.requests.length, 1, 'a background Stop hook does not keep the model working');
    await until(() => woke.length > 0);
    assert.equal(woke[0], 'Stop hook [sleep 1; echo "tests failed: 3" >&2; exit 2] reported (asyncRewake):\ntests failed: 3');
  } finally { await s.done(); }
});

// ── Pure rules ───────────────────────────────────────────────────────────────

test('matchers follow Claude Code: exact names and lists, unanchored regular expressions otherwise', () => {
  assert.equal(matcherMatches('Bash', 'Bash'), true);
  assert.equal(matcherMatches('Edit|Write', 'Write'), true);
  assert.equal(matcherMatches('Edit, Write', 'Write'), true);
  assert.equal(matcherMatches('Edit', 'NotebookEdit'), false, 'exact name');
  assert.equal(matcherMatches('Edit.*', 'NotebookEdit'), true, 'unanchored regex');
  assert.equal(matcherMatches('^Edit$', 'NotebookEdit'), false);
  assert.equal(matcherMatches('mcp__memory', 'mcp__memory__create'), false, 'letters and _ only: exact');
  assert.equal(matcherMatches('mcp__memory__.*', 'mcp__memory__create'), true);
  for (const m of [undefined, '', '*']) assert.equal(matcherMatches(m, 'anything'), true);
});

test('stdout and exit codes: the reference table', () => {
  const r = (x: Partial<HookFireResult>): HookFireResult => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, command: 'h', ...x });
  const v = (x: Partial<HookFireResult>) => evaluateHooks('PreToolUse', 'Bash', [r(x)]);
  const deny = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'json says no' } });
  // A valid JSON object with exit 1: the fields decide.
  assert.equal(v({ exitCode: 1, stdout: deny }).permission, 'deny');
  // Exit 2 with JSON: blocked, and the JSON's reason is the message.
  assert.deepEqual(v({ exitCode: 2, stdout: deny, stderr: 'stderr reason' }).blocks.map((b) => b.reason), ['json says no']);
  // Unparseable JSON with exit 0: a non-blocking error naming the problem...
  assert.match(v({ stdout: '{not json}' }).notices[0], /the output is not valid JSON/);
  // ...which blocks with onFailure "block".
  assert.match(v({ stdout: '{not json}', hook: { type: 'command', command: 'h', onFailure: 'block' } }).blocks[0].reason, /^failed; blocking because onFailure is "block"\./);
  // Precedence across hooks: deny > ask > allow.
  const ask = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask' } });
  const allow = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } });
  assert.equal(evaluateHooks('PreToolUse', 'Bash', [r({ stdout: allow }), r({ stdout: ask })]).permission, 'ask');
  assert.equal(evaluateHooks('PreToolUse', 'Bash', [r({ stdout: ask }), r({ stdout: deny })]).permission, 'deny');
  // The deprecated top-level decision still maps: block -> deny, approve -> allow.
  assert.equal(v({ stdout: '{"decision":"block","reason":"old"}' }).permission, 'deny');
  assert.equal(v({ stdout: '{"decision":"approve"}' }).permission, 'allow');
  // "defer" works only in non-interactive mode.
  assert.match(v({ stdout: '{"hookSpecificOutput":{"permissionDecision":"defer"}}' }).notices[0], /"defer" works only in non-interactive mode/);
  // Exit 2 on an event that cannot block does nothing.
  assert.deepEqual(evaluateHooks('Notification', 'x', [r({ exitCode: 2, stderr: 'no' })]).blocks, []);
});

// ── The PowerShell tool keeps every safety check ─────────────────────────────

test('the PowerShell tool (Windows without Git Bash) gets every check Bash gets', async () => {
  _setCommandShellForTest({ ok: true, file: 'pwsh-not-run-by-this-test', kind: 'powershell', notice: 'Git Bash was not found (fixture).' });
  const s = setup({ byEvent: {} }, [end]);
  try {
    const names = getNativeToolDefinitions().map((d) => d.name);
    assert.ok(names.includes('PowerShell') && !names.includes('Bash'), names.join(','));
    assert.ok(!getNativeToolDefinitions({ isolated: true }).some((d) => d.name === 'PowerShell'), 'isolated members get no shell');
    // Tool postures drop and keep it exactly like Bash.
    for (const posture of ['full', 'coding', 'review', 'chat'] as const) assert.equal(keepTool('PowerShell', posture), keepTool('Bash', posture), posture);
    // The hardline floor, through the worker, before anything runs.
    for (const command of [`rm -rf ${s.cwd}`, 'Remove-Item -Recurse -Force C:\\', `Remove-Item -Path "${s.cwd}" -Recurse`, 'rd /s /q C:\\', 'Stop-Process -Name arco', 'schtasks /End /TN arco-workbench', 'Stop-ScheduledTask -TaskName arco-workbench']) {
      const r = await s.w.dispatchTool({ id: `h-${command.length}`, name: 'PowerShell', input: { command } });
      assert.match(r.text, /^\[blocked by hardline-command-floor\]/, command);
    }
    assert.equal(detectHardlineCommand('Remove-Item -Recurse .\\build', s.cwd), null, 'a subfolder is fine');
    assert.equal(checkHardlineCommand('PowerShell', { command: 'Get-ChildItem' }, s.cwd).blocked, false);
    // The review gate classes it as a shell command.
    const git = classifyGate('PowerShell', { command: 'git push --force' }, s.cwd);
    assert.equal(git.sensitive && git.category, 'git-destructive');
    assert.deepEqual(classifyGate('PowerShell', { command: 'dir' }, s.cwd), { sensitive: true, category: 'bash', reason: 'PowerShell command — runs an arbitrary shell command.' });
    // The output filter pack and the tool-call counter apply.
    assert.deepEqual(resolveFilterPack('PowerShell', { command: 'git status' }, 'conservative'), resolveFilterPack('Bash', { command: 'git status' }, 'conservative'));
    assert.ok(s.events.some((e) => e.type === 'primary_tool_counter'), 'counted');
    // "Bash" is an unknown tool here, refused before any hook or tool.
    assert.deepEqual(await s.w.dispatchTool({ id: 'b', name: 'Bash', input: { command: 'echo hi' } }), { text: '[error] unknown tool "Bash". The shell tool here is PowerShell.', isError: true });
  } finally { _setCommandShellForTest(null); await s.done(); }
  // With Git Bash (or on Linux and macOS) nothing changes: Bash, and "PowerShell" is unknown.
  const t = setup({ byEvent: {} }, [end]);
  try {
    const names = getNativeToolDefinitions().map((d) => d.name);
    assert.ok(names.includes('Bash') && !names.includes('PowerShell'));
    assert.deepEqual(await t.w.dispatchTool({ id: 'p', name: 'PowerShell', input: { command: 'echo hi' } }), { text: '[error] unknown tool "PowerShell". The shell tool here is Bash.', isError: true });
  } finally { await t.done(); }
});

// ── if, the common input fields, agent_type, PreCompact, Notification ───────

const lines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
// A hook that appends one line (its name) to log.txt in the project folder.
const mark = (name: string, extra: Record<string, unknown> = {}) => ({ type: 'command', command: `echo ${name} >> "$CLAUDE_PROJECT_DIR/log.txt"`, ...extra });

test('if: a handler runs only when the tool call matches its permission rule; on other events it never runs', async () => {
  const s = setup({ byEvent: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [mark('printf-rule', { if: 'Bash(printf *)' }), mark('git-log-rule', { if: 'Bash(git log *)' })] },
      { matcher: 'Write', hooks: [mark('ts-rule', { if: 'Edit(*.ts)' })] },
    ],
    Stop: [{ hooks: [mark('stop-with-if', { if: 'Bash(*)' }), mark('stop-plain')] }],
  } } as HookConfig, [end]);
  const log = join(s.cwd, 'log.txt');
  try {
    await s.w.dispatchTool({ id: 'i1', name: 'Bash', input: { command: 'echo hi' } });
    assert.deepEqual(lines(log), [], 'no rule matches echo hi');
    await s.w.dispatchTool({ id: 'i2', name: 'Bash', input: { command: 'X=1 printf ok' } });
    assert.deepEqual(lines(log), ['printf-rule'], 'leading assignments are stripped');
    await s.w.dispatchTool({ id: 'i3', name: 'Bash', input: { command: 'echo $(printf x) && true' } });
    assert.deepEqual(lines(log).slice(1).sort(), ['git-log-rule', 'printf-rule'], 'a command inside $() is checked; a longer pattern runs on $() anyway');
    await s.w.dispatchTool({ id: 'i4', name: 'Write', input: { file_path: 'src/a.md', content: 'x' } });
    await s.w.dispatchTool({ id: 'i5', name: 'Write', input: { file_path: 'src/a.ts', content: 'x' } });
    assert.equal(lines(log).filter((l) => l === 'ts-rule').length, 1, 'Edit(*.ts) covers a Write to a .ts file only');
    await s.w.runTurn('hello');
    assert.ok(lines(log).includes('stop-plain'));
    assert.ok(!lines(log).includes('stop-with-if'), 'a Stop handler with if never runs');
  } finally { await s.done(); }
});

test('hook input: transcript_path is the tab\'s event log; file paths are absolute', async () => {
  const s = setup(on('PreToolUse', 'cat > "$CLAUDE_PROJECT_DIR/payload.json"', 'Write'), [end]);
  try {
    await s.w.dispatchTool({ id: 'p1', name: 'Write', input: { file_path: 'rel.txt', content: 'x' } });
    const payload = JSON.parse(readFileSync(join(s.cwd, 'payload.json'), 'utf8'));
    assert.equal(payload.transcript_path, join(s.cwd, '.arco', 'workflows', 'wf-hook-parity', 'events.jsonl'));
    assert.equal(payload.tool_input.file_path, join(s.cwd, 'rel.txt'));
    assert.equal(payload.session_id, 'wf-hook-parity');
    assert.equal(payload.agent_type, undefined, 'only inside a subagent');
    assert.equal(readFileSync(join(s.cwd, 'rel.txt'), 'utf8'), 'x');
  } finally { await s.done(); }
});

test('a Task child\'s turn: agent_type is the type the parent asked for, SubagentStop matches it, both transcripts are named', async () => {
  const s = setup({ byEvent: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'cat > "$CLAUDE_PROJECT_DIR/pre.json"' }] }],
    SubagentStop: [
      { matcher: 'general-purpose', hooks: [mark('wrong-type')] },
      { matcher: 'Explore', hooks: [{ type: 'command', command: 'cat > "$CLAUDE_PROJECT_DIR/stop.json"' }] },
    ],
  } } as HookConfig, [reply([{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'echo child' } }]), end], {
    taskDisabled: true,
    config: { claudeNativeSubagent: { agentType: 'Explore', parentWorkflowId: 'wf-parent' } },
  });
  try {
    await s.w.runTurn('look around');
    const stop = JSON.parse(readFileSync(join(s.cwd, 'stop.json'), 'utf8'));
    assert.equal(stop.hook_event_name, 'SubagentStop');
    assert.equal(stop.agent_type, 'Explore');
    assert.equal(stop.agent_id, 'wf-hook-parity');
    assert.equal(stop.session_id, 'wf-parent');
    assert.equal(stop.transcript_path, join(s.cwd, '.arco', 'workflows', 'wf-parent', 'events.jsonl'));
    assert.equal(stop.agent_transcript_path, join(s.cwd, '.arco', 'workflows', 'wf-hook-parity', 'events.jsonl'));
    assert.equal(stop.last_assistant_message, 'done');
    const pre = JSON.parse(readFileSync(join(s.cwd, 'pre.json'), 'utf8'));
    assert.equal(pre.agent_type, 'Explore', 'tool events inside the subagent carry it too');
    assert.ok(!lines(join(s.cwd, 'log.txt')).includes('wrong-type'));
  } finally { await s.done(); }
});

test('PreCompact: matched against manual or auto; exit 2 or decision "block" blocks; systemMessage is discarded', async () => {
  let s = setup({ byEvent: { PreCompact: [
    { matcher: 'auto', hooks: [{ type: 'command', command: 'cat > "$CLAUDE_PROJECT_DIR/pc.json"; echo "not during the release" >&2; exit 2' }] },
  ] } } as HookConfig, [end]);
  try {
    assert.equal(await s.w.preCompactBlock('manual'), null, 'the auto matcher skips a manual compaction');
    assert.equal(existsSync(join(s.cwd, 'pc.json')), false);
    assert.equal(await s.w.preCompactBlock('auto'), '[cat > "$CLAUDE_PROJECT_DIR/pc.json"; echo "not during the release" >&2; exit 2]: not during the release');
    const payload = JSON.parse(readFileSync(join(s.cwd, 'pc.json'), 'utf8'));
    assert.equal(payload.hook_event_name, 'PreCompact');
    assert.equal(payload.trigger, 'auto');
    assert.equal(payload.custom_instructions, null);
  } finally { await s.done(); }
  s = setup(on('PreCompact', `echo '${JSON.stringify({ decision: 'block', reason: 'snapshot first', systemMessage: 'shown nowhere', continue: false })}'`), [end]);
  try {
    assert.match(await s.w.preCompactBlock('manual') ?? '', /: snapshot first$/);
    assert.ok(!s.notices.some((n) => /shown nowhere|stopped processing/.test(n)), s.notices.join('\n'));
  } finally { await s.done(); }
  s = setup(on('PreCompact', 'echo fine'), [end]);
  try { assert.equal(await s.w.preCompactBlock('manual'), null); } finally { await s.done(); }
});

test('Notification: permission_prompt once an approval card has waited; nothing when it is answered sooner; exit codes ignored', async () => {
  const ask = { type: 'command', command: `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'check' } })}'` };
  const hooks = { byEvent: {
    PreToolUse: [{ matcher: 'Write', hooks: [ask] }],
    Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'command', command: 'cat >> "$CLAUDE_PROJECT_DIR/n.jsonl"; echo >> "$CLAUDE_PROJECT_DIR/n.jsonl"; echo ignored >&2; exit 2' }] }],
  } } as HookConfig;
  let s = setup(hooks, [end]);
  try {
    s.w.notifyDelays.permissionMs = 150;
    const pending = s.w.dispatchTool({ id: 'n1', name: 'Write', input: { file_path: join(s.cwd, 'x.txt'), content: 'x' } });
    await until(() => lines(join(s.cwd, 'n.jsonl')).length > 0);
    const n = JSON.parse(lines(join(s.cwd, 'n.jsonl'))[0]);
    assert.deepEqual([n.hook_event_name, n.notification_type, n.message, n.title], ['Notification', 'permission_prompt', 'Claude needs your permission to use Write', 'Permission needed']);
    s.w.resolveGate('n1', 'reject');
    await pending;
    assert.ok(!s.notices.some((x) => x.includes('ignored')), s.notices.join('\n'));
  } finally { await s.done(); }
  s = setup(hooks, [end]);
  try {
    s.w.notifyDelays.permissionMs = 800;
    const pending = s.w.dispatchTool({ id: 'n2', name: 'Write', input: { file_path: join(s.cwd, 'y.txt'), content: 'y' } });
    await until(() => s.events.some((e) => e.type === 'gate_required'));
    s.w.resolveGate('n2', 'approve');
    await pending;
    await new Promise((r) => setTimeout(r, 1_200));
    assert.deepEqual(lines(join(s.cwd, 'n.jsonl')), [], 'answered before the wait: no notification');
  } finally { await s.done(); }
});

test('Notification: idle_prompt after a finished turn with nothing sent since; a new turn resets the wait', async () => {
  const s = setup({ byEvent: {
    Notification: [{ matcher: 'idle_prompt', hooks: [{ type: 'command', command: 'cat >> "$CLAUDE_PROJECT_DIR/idle.jsonl"; echo >> "$CLAUDE_PROJECT_DIR/idle.jsonl"' }] }],
  } } as HookConfig, [end]);
  const idle = join(s.cwd, 'idle.jsonl');
  try {
    s.w.notifyDelays.idleMs = 1_000;
    await s.w.runTurn('one');
    await s.w.runTurn('two');
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(lines(idle), [], 'not yet');
    await until(() => lines(idle).length > 0);
    await new Promise((r) => setTimeout(r, 1_000));
    assert.equal(lines(idle).length, 1, 'the first turn\'s wait was replaced by the second\'s');
    const n = JSON.parse(lines(idle)[0]);
    assert.deepEqual([n.notification_type, n.message], ['idle_prompt', 'Claude is waiting for your input']);
  } finally { await s.done(); }
});

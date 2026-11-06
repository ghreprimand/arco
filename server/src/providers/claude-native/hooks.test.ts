// §4.2 — regression guard for the hook-output contract the Native worker
// consumes. parseHookOutput is the pure extraction; worker.ts folds
// updatedInput into the dispatched tool input (PreToolUse) and appends
// additionalContext to the tool_result (PostToolUse). This test pins the
// parser so a refactor can't silently drop those fields — the wiring was
// already in-tree (EFFICIENCY_PLAN Phase B0) when Phase 6 §4.2 verified it.
//
// Run: node --conditions development --import tsx --test src/providers/claude-native/hooks.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateHooks, fireHooks, hookLaunch, parseHookOutput, powerShellPlaceholders, type HookCommand, type HookConfig, type HookFireResult } from './hooks.js';

const blocks = (r: HookFireResult[], event: 'PreToolUse' | 'Stop' = 'PreToolUse') => evaluateHooks(event, 'Bash', r).blocks;
import { _setCommandShellForTest, findPowerShell } from '../../commandShell.js';

test('non-JSON / empty stdout → empty object (never throws)', () => {
  assert.deepEqual(parseHookOutput(''), {});
  assert.deepEqual(parseHookOutput('   '), {});
  assert.deepEqual(parseHookOutput('not json at all'), {});
  assert.deepEqual(parseHookOutput('[1,2,3]'), {}, 'top-level array ignored');
});

test('PreToolUse updatedInput is extracted', () => {
  const out = parseHookOutput(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'ls -la' } },
  }));
  assert.deepEqual(out.hookSpecificOutput?.updatedInput, { command: 'ls -la' });
});

test('updatedInput must be a plain object — array/scalar dropped', () => {
  const arr = parseHookOutput(JSON.stringify({ hookSpecificOutput: { updatedInput: [1, 2] } }));
  assert.equal(arr.hookSpecificOutput, undefined, 'array updatedInput rejected');
  const scalar = parseHookOutput(JSON.stringify({ hookSpecificOutput: { updatedInput: 'x' } }));
  assert.equal(scalar.hookSpecificOutput, undefined, 'scalar updatedInput rejected');
});

test('PostToolUse additionalContext is extracted', () => {
  const out = parseHookOutput(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'remember: lint runs on commit' },
  }));
  assert.equal(out.hookSpecificOutput?.additionalContext, 'remember: lint runs on commit');
});

test('both fields coexist on one hookSpecificOutput', () => {
  const out = parseHookOutput(JSON.stringify({
    hookSpecificOutput: { updatedInput: { a: 1 }, additionalContext: 'ctx' },
  }));
  assert.deepEqual(out.hookSpecificOutput?.updatedInput, { a: 1 });
  assert.equal(out.hookSpecificOutput?.additionalContext, 'ctx');
});

test('decision:block + reason are surfaced (PostToolUse retry path)', () => {
  const out = parseHookOutput(JSON.stringify({ decision: 'block', reason: 'tests must pass first' }));
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, 'tests must pass first');
});

test('permissionDecision allow/deny/ask preserved; junk dropped', () => {
  assert.equal(parseHookOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } })).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(parseHookOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'maybe' } })).hookSpecificOutput, undefined);
});

test('empty hookSpecificOutput object → no field on result', () => {
  const out = parseHookOutput(JSON.stringify({ hookSpecificOutput: {} }));
  assert.equal(out.hookSpecificOutput, undefined);
});

// A hook that exits without reading its input closes the pipe while Arco is
// still writing the payload. The EPIPE that follows must not crash the
// server, and the hook's real exit code and output must be kept.
test('a hook that exits before reading a large payload keeps its exit code and output', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-hook-epipe-'));
  let n = 0;
  const shells = { byId: new Map<string, { kill: () => void; backgrounded: boolean }>(), mintId: () => `hook-${n++}` };
  const config: HookConfig = { byEvent: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo refused >&2; exit 2' }] }] } };
  // Far larger than a pipe buffer, so the write is still pending when the hook exits.
  const payload = { tool_name: 'Bash', tool_input: { command: 'x'.repeat(8 * 1024 * 1024) } };
  try {
    for (let i = 0; i < 5; i++) {
      const [result] = await fireHooks(config, 'PreToolUse', 'Bash', payload, { cwd, abortSignal: new AbortController().signal, shells });
      assert.equal(result.exitCode, 2);
      assert.equal(result.stderr.trim(), 'refused');
      assert.equal(result.timedOut, false);
    }
    assert.equal(shells.byId.size, 0, 'every hook left the shell registry');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

const runOpts = (cwd: string) => {
  let n = 0;
  const shells = { byId: new Map<string, { kill: () => void; backgrounded: boolean }>(), mintId: () => `hook-${n++}` };
  return { cwd, abortSignal: new AbortController().signal, shells };
};
const preHook = (command: string, timeout?: number): HookConfig => ({ byEvent: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, ...(timeout ? { timeout } : {}) }] }] } });

// Runs for real on every platform: /bin/sh on Linux and macOS, Git Bash on Windows.
test('a hook reads its JSON input and blocks with its own message', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-hook-run-'));
  try {
    const results = await fireHooks(preHook('read -r line; case "$line" in *rm*) echo "no rm" >&2; exit 2;; esac; echo ok'), 'PreToolUse', 'Bash', { tool_input: { command: 'rm -rf x' } }, runOpts(cwd));
    assert.equal(results[0].exitCode, 2);
    assert.equal(results[0].stderr.trim(), 'no rm');
    assert.deepEqual(blocks(results).map((b) => [b.via, b.reason]), [['exit2', 'no rm']]);
    const fine = await fireHooks(preHook('read -r line; echo ok'), 'PreToolUse', 'Bash', { tool_input: { command: 'ls' } }, runOpts(cwd));
    assert.deepEqual([fine[0].exitCode, fine[0].stdout.trim(), blocks(fine)], [0, 'ok', []]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// Claude Code: a timed-out PreToolUse hook does not block (unless onFailure
// is "block"); its output is discarded and the operator sees a notice.
test('a hook past its timeout is ended with its whole process tree and does not block', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-hook-timeout-'));
  try {
    const started = Date.now();
    const command = '(sleep 2; echo alive > alive.txt) & sleep 30; echo late';
    const [r] = await fireHooks(preHook(command, 1), 'PreToolUse', 'Bash', {}, runOpts(cwd));
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 15_000, `ended after ${Date.now() - started} ms`);
    assert.ok(!r.stdout.includes('late'));
    const v = evaluateHooks('PreToolUse', 'Bash', [r]);
    assert.deepEqual(v.blocks, []);
    assert.equal(v.notices[0], `PreToolUse:Bash hook error: [${command}]: timed out; its output was discarded.`);
    await new Promise((res) => setTimeout(res, 3_000));
    assert.equal(existsSync(join(cwd, 'alive.txt')), false, 'the background job was ended with the tree');
    const [blocking] = await fireHooks(withHook({ type: 'command', command: 'sleep 30', timeout: 1, onFailure: 'block' }), 'PreToolUse', 'Bash', {}, runOpts(cwd));
    assert.match(blocks([blocking])[0]?.reason ?? '', /^timed out; blocking because onFailure is "block"\./);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('a hook that cannot start does not block, except a shell-form PreToolUse hook on Windows without Git Bash', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-hook-notrun-'));
  try {
    // Windows without Git Bash or PowerShell (forced): Claude Code counts only
    // exit 0 or 2 as the verdict there, so a hook that cannot start blocks...
    _setCommandShellForTest({ ok: false, problem: 'Git Bash was not found (fixture).' });
    const [missing] = await fireHooks(preHook('exit 2'), 'PreToolUse', 'Bash', {}, runOpts(cwd));
    assert.equal(missing.notRun, 'Git Bash was not found (fixture).');
    assert.equal(missing.strictFailure, true);
    assert.deepEqual(blocks([missing]).map((b) => b.reason), ["failed; blocking because Git Bash wasn't found, so only exit code 0 or 2 counts as this hook's verdict.\nGit Bash was not found (fixture)."]);
    // ...unless the hook sets onFailure, and never on Stop.
    const [lenient] = await fireHooks(withHook({ type: 'command', command: 'exit 2', onFailure: 'continue' }), 'PreToolUse', 'Bash', {}, runOpts(cwd));
    assert.deepEqual(blocks([lenient]), []);
    assert.deepEqual(blocks([missing], 'Stop'), []);
    _setCommandShellForTest(null);
    // Elsewhere a hook that cannot start is a non-blocking error.
    const [noCwd] = await fireHooks(preHook('exit 2'), 'PreToolUse', 'Bash', {}, runOpts(join(cwd, 'gone')));
    assert.match(noCwd.notRun ?? '', /^The hook could not start: /);
    assert.deepEqual(blocks([noCwd]), []);
    const [strict] = await fireHooks(withHook({ type: 'command', command: 'exit 2', onFailure: 'block' }), 'PreToolUse', 'Bash', {}, runOpts(join(cwd, 'gone')));
    assert.match(blocks([strict])[0]?.reason ?? '', /^failed; blocking because onFailure is "block"\.\nThe hook could not start: /);
  } finally { _setCommandShellForTest(null); rmSync(cwd, { recursive: true, force: true }); }
});

const withHook = (h: HookCommand): HookConfig => ({ byEvent: { PreToolUse: [{ matcher: 'Bash', hooks: [h] }] } });

// Exec form runs for real on every platform: no shell, so nothing in the
// arguments is interpreted, and "shell" is ignored.
test('exec form: the program starts with its arguments as written, ${CLAUDE_PROJECT_DIR} filled in, no shell', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-hook-exec-'));
  const script = "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const i=JSON.parse(d);process.stdout.write(JSON.stringify(process.argv.slice(1)));if(i.tool_input.command.includes('rm')){process.stderr.write('exec refused');process.exit(2)}})";
  const odd = "it's $HOME `id` & | ; %PATH% \"q\"";
  try {
    const h: HookCommand = { type: 'command', command: 'node', args: ['-e', script, '${CLAUDE_PROJECT_DIR}/x', odd], shell: 'powershell' };
    const [blocked] = await fireHooks(withHook(h), 'PreToolUse', 'Bash', { tool_input: { command: 'rm -rf x' } }, runOpts(cwd));
    assert.equal(blocked.notRun, undefined, blocked.notRun);
    assert.deepEqual(JSON.parse(blocked.stdout), [`${cwd}/x`, odd]);
    assert.deepEqual([blocked.exitCode, blocked.stderr, blocks([blocked]).map((b) => b.reason)], [2, 'exec refused', ['exec refused']]);
    const [fine] = await fireHooks(withHook(h), 'PreToolUse', 'Bash', { tool_input: { command: 'ls' } }, runOpts(cwd));
    assert.deepEqual([fine.exitCode, blocks([fine])], [0, []]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('exec form: a program that cannot start does not block and says why', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-hook-exec-missing-'));
  try {
    const [spaced] = await fireHooks(withHook({ type: 'command', command: 'node script.js', args: [] }), 'PreToolUse', 'Bash', {}, runOpts(cwd));
    assert.match(spaced.notRun ?? '', /^The hook could not start: .*With "args" set, "command" is only the program; move its arguments into "args"\.$/);
    assert.deepEqual(blocks([spaced]), []);
    const [bad] = await fireHooks(withHook({ type: 'command', command: 'node', args: ['-e', 1] as unknown as string[] }), 'PreToolUse', 'Bash', {}, runOpts(cwd));
    assert.equal(bad.notRun, 'The hook\'s "args" must be a list of strings.');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('shell form in PowerShell: placeholders become ${env:NAME}, the command is encoded, and the fallback notice rides along', () => {
  assert.equal(powerShellPlaceholders('& "${CLAUDE_PROJECT_DIR}\\a.ps1" ${CLAUDE_PLUGIN_ROOT} ${CLAUDE_PLUGIN_DATA} $env:X ${OTHER}'), '& "${env:CLAUDE_PROJECT_DIR}\\a.ps1" ${env:CLAUDE_PLUGIN_ROOT} ${env:CLAUDE_PLUGIN_DATA} $env:X ${OTHER}');
  _setCommandShellForTest({ ok: true, file: 'pwsh', kind: 'powershell', notice: 'Using PowerShell (fixture).' });
  try {
    const launch = hookLaunch({ type: 'command', command: 'Get-Content "${CLAUDE_PROJECT_DIR}/a"' }, '/p');
    assert.ok(launch.ok);
    if (!launch.ok) return;
    assert.equal(launch.file, 'pwsh');
    assert.equal(launch.shellNotice, 'Using PowerShell (fixture).');
    assert.match(Buffer.from(launch.args.at(-1) ?? '', 'base64').toString('utf16le'), /\nGet-Content "\$\{env:CLAUDE_PROJECT_DIR\}\/a"\n/);
    // Exec form ignores the shell entirely.
    const exec = hookLaunch({ type: 'command', command: '${CLAUDE_PROJECT_DIR}/bin/check', args: ['${CLAUDE_PROJECT_DIR}'] }, '/p');
    assert.deepEqual(exec.ok && [exec.file, exec.args, exec.exec, exec.shellNotice], ['/p/bin/check', ['/p'], true, undefined]);
  } finally { _setCommandShellForTest(null); }
});

// Runs for real wherever PowerShell is installed (every hosted CI runner).
const powershell = findPowerShell();
test('"shell": "powershell" runs the hook in PowerShell, reading its JSON input in UTF-8', { skip: powershell ? false : 'PowerShell is not installed here' }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-hook-pwsh-'));
  const command = '$in = [Console]::In.ReadToEnd() | ConvertFrom-Json; if ($in.tool_input.command -match "rm") { [Console]::Error.WriteLine("no rm in " + "${CLAUDE_PROJECT_DIR}"); exit 2 }; Write-Output $in.tool_input.note';
  try {
    const h: HookCommand = { type: 'command', shell: 'powershell', command, timeout: 60 };
    const [blocked] = await fireHooks(withHook(h), 'PreToolUse', 'Bash', { tool_input: { command: 'rm -rf x' } }, runOpts(cwd));
    assert.equal(blocked.notRun, undefined, blocked.notRun);
    assert.deepEqual([blocked.exitCode, blocked.stderr.trim(), blocks([blocked]).map((b) => b.reason)], [2, `no rm in ${cwd}`, [`no rm in ${cwd}`]]);
    assert.equal(blocked.shellNotice, undefined, 'asked for by the hook, so no fallback notice');
    const [fine] = await fireHooks(withHook(h), 'PreToolUse', 'Bash', { tool_input: { command: 'ls', note: 'na\u00efve \u2713' } }, runOpts(cwd));
    assert.deepEqual([fine.exitCode, fine.stdout.trim(), blocks([fine])], [0, 'na\u00efve \u2713', []], fine.stderr);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

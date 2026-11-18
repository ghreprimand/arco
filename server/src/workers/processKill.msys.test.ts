// Shell children on Windows with Git Bash: the command line MSYS reads back,
// and the tagged tree that the tree kill lists through /proc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { commandShell } from '../commandShell.js';
import { MSYS_TREE_SWEEP, PROCESS_TREE_ENV, _shellTreeTagForTest, msysQuote, msysTreeSweep, shellSpawnPlan, spawnShellChild, windowsTreeKillArgsFor } from './processKill.js';

// How the MSYS runtime reads one double-quoted word from a Windows command
// line (parent not an MSYS program, globbing on): inside the quotes a
// backslash before a quote or a backslash is dropped and the next character
// kept; every other character is literal.
function msysReadQuoted(word: string): string {
  assert.equal(word[0], '"');
  let out = '';
  let i = 1;
  for (; i < word.length && word[i] !== '"'; i++) {
    if (word[i] === '\\' && (word[i + 1] === '"' || word[i + 1] === '\\')) i++;
    out += word[i];
  }
  assert.equal(i, word.length - 1, 'the closing quote ends the word');
  return out;
}

// Node's own Windows quoting (libuv quote_cmd_arg): backslashes are doubled
// only before a quote.
function nodeQuote(src: string): string {
  if (src === '') return '""';
  if (!/[ \t"]/.test(src)) return src;
  if (!/["\\]/.test(src)) return `"${src}"`;
  let out = '"';
  let quoteHit = true;
  for (let i = src.length - 1; i >= 0; i--) {
    const c = src[i];
    out += c;
    if (quoteHit && c === '\\') out += '\\';
    else if (c === '"') { quoteHit = true; out += '\\'; }
    else quoteHit = false;
  }
  return [...`${out}"`].reverse().join('');
}

test('Node\'s own quoting loses backslashes on the way into Git Bash; msysQuote does not', () => {
  const hook = `echo '${JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'rm -rf C:\\Users\\x' } } })}'`;
  assert.equal(nodeQuote('hello\\"world'), '"hello\\\\\\"world"', 'the model of Node\'s quoting');
  assert.notEqual(msysReadQuoted(nodeQuote(hook)), hook, 'C:\\\\Users arrives as C:\\Users, so the JSON no longer parses');
  assert.equal(msysReadQuoted(msysQuote(hook)), hook);
});

test('msysQuote: Git Bash reads back exactly the command that was meant', () => {
  const samples = [
    `echo '${JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'rm -rf C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x' } } })}'`,
    'a\\',
    'ends with two \\\\',
    'quote \\" inside and "plain" quotes',
    '""',
    '$HOME `date` $(pwd) \'single\'',
    '*?[]{}()~ @file',
    'line one\nline two\ttab',
    'unicode: \u00e9\u00e8 \u4e2d\u6587',
    '',
  ];
  for (const s of samples) assert.equal(msysReadQuoted(msysQuote(s)), s);
});

test('a Git Bash child on Windows: MSYS quoting, verbatim command line, quoted program name, tagged environment', () => {
  const run = { file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['-c', 'echo "C:\\\\x"'], msys: true };
  const plan = shellSpawnPlan(run, { cwd: 'C:\\p', env: { PATH: 'x', MSYS: 'winsymlinks:nativestrict noglob' } }, 'win32');
  assert.deepEqual(plan.args, ['"-c"', '"echo \\"C:\\\\\\\\x\\""']);
  assert.equal(msysReadQuoted(plan.args[1]), run.args[1]);
  assert.equal(plan.options.windowsVerbatimArguments, true);
  assert.equal(plan.options.argv0, '"C:\\Program Files\\Git\\bin\\bash.exe"');
  assert.equal(plan.options.detached, false);
  assert.equal(plan.options.windowsHide, true);
  assert.equal(plan.options.cwd, 'C:\\p');
  assert.match(plan.tag ?? '', /^[0-9a-f-]{36}$/);
  assert.equal((plan.options.env as NodeJS.ProcessEnv)[PROCESS_TREE_ENV], plan.tag);
  assert.equal((plan.options.env as NodeJS.ProcessEnv).MSYS, 'winsymlinks:nativestrict', 'noglob would turn the unquoting off');
  // PowerShell, exec form, and every other OS: arguments as given, no tag.
  for (const [r, platform] of [[{ ...run, msys: false }, 'win32'], [run, 'linux'], [run, 'darwin']] as const) {
    const p = shellSpawnPlan(r, { env: { PATH: 'x' } }, platform);
    assert.deepEqual(p.args, run.args);
    assert.equal(p.tag, undefined);
    assert.equal(p.options.windowsVerbatimArguments, undefined);
    assert.equal((p.options.env as NodeJS.ProcessEnv)[PROCESS_TREE_ENV], undefined);
    assert.equal(p.options.detached, platform !== 'win32');
  }
});

test('the Windows tree kill ends the child and every listed process with their descendants', () => {
  assert.deepEqual(windowsTreeKillArgsFor([10, 22, 10]), ['/F', '/T', '/PID', '10', '/PID', '22']);
});

function findBash(): string | null {
  if (process.platform === 'win32') {
    const shell = commandShell();
    return shell.ok && shell.kind === 'git-bash' ? shell.file : null;
  }
  for (const f of ['/bin/bash', '/usr/bin/bash']) if (existsSync(f)) return f;
  return null;
}
const bash = findBash();
const noProc = process.platform !== 'win32' && !existsSync('/proc/self/environ');

// Each fresh Bash prints its process IDs once it is running, then stays alive
// on the fixture's input pipe. Explicit input keeps Bash from giving the
// background job /dev/null. The read timeout bounds an abandoned fixture.
const fixtureReady = [
  'native=$$',
  'if [ -r "/proc/$$/winpid" ]; then read -r native < "/proc/$$/winpid"; fi',
  'printf "ready %s %s %s\\n" "$1" "$$" "$native"',
];
const fixtureJob = [...fixtureReady, 'read -r -t 30'].join('\n');
const fixtureCommand = [
  ...fixtureReady,
  'exec 3<&0',
  `"$BASH" -c '${fixtureJob}' fixture background <&3 &`,
  `"$BASH" -c '${fixtureJob}' fixture foreground <&3`,
  'wait',
].join('\n');

test('the sweep lists every process of a tagged tree, background jobs included', { skip: !bash ? 'bash (Git Bash on Windows) is not installed here' : noProc ? 'no /proc on this system' : false }, async () => {
  let child: ChildProcess;
  let tag: string;
  const stdio: StdioOptions = ['pipe', 'pipe', 'pipe'];
  if (process.platform === 'win32') {
    // The real path: spawnShellChild quotes for MSYS and tags the tree.
    child = spawnShellChild({ file: bash!, args: ['-c', fixtureCommand, 'fixture', 'parent'], msys: true }, { stdio });
    tag = _shellTreeTagForTest(child) ?? '';
  } else {
    // Elsewhere the same environment tag, set by hand.
    tag = `test-${process.pid}-${Date.now()}`;
    child = spawn(bash!, ['-c', fixtureCommand, 'fixture', 'parent'], { stdio, detached: true, env: { ...process.env, [PROCESS_TREE_ENV]: tag } });
  }
  let stdout = '';
  let stderr = '';
  let sweep: unknown;
  const ready = new Map<string, number>();
  const seen = () => JSON.stringify({ childPid: child.pid, stdout, stderr, sweep });
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  try {
    assert.ok(tag);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fixture readiness timed out: ${seen()}`)), 10_000);
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
        stdout = (stdout + chunk).slice(-4000);
        for (const match of stdout.matchAll(/^ready (parent|background|foreground) \d+ (\d+)\r?\n/gm)) {
          ready.set(match[1], Number(match[2]));
        }
        if (ready.size === 3) { clearTimeout(timer); resolve(); }
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new Error(`fixture spawn failed (${error.code}): ${seen()}`));
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`fixture exited (${code}, ${signal}): ${seen()}`));
      });
    });
    assert.equal(new Set(ready.values()).size, 3, seen());
    const observe = (result: unknown) => { sweep = result; };
    const found = await msysTreeSweep(bash!, tag, process.platform, observe);
    for (const [role, pid] of ready) assert.ok(found.includes(pid), `missing ${role} pid ${pid}: ${seen()}`);
    assert.ok(!found.includes(process.pid), `nothing outside the tree: ${seen()}`);
    if (process.platform === 'linux') assert.ok(found.includes(child.pid!), `the shell itself is listed: ${seen()}`);
    assert.ok(MSYS_TREE_SWEEP.includes(PROCESS_TREE_ENV));
    assert.deepEqual(await msysTreeSweep(bash!, `${tag}-other`, process.platform, observe), [], `another tag lists nothing: ${seen()}`);
  } finally {
    if (process.platform === 'win32' && child.pid) spawn('taskkill', windowsTreeKillArgsFor([child.pid, ...ready.values()]), { stdio: 'ignore' });
    else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
    child.stdin?.destroy();
  }
});

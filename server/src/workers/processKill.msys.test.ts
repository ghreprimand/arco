// Shell children on Windows with Git Bash: the command line MSYS reads back,
// and the tagged tree that the tree kill lists through /proc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

test('the sweep lists every process of a tagged tree, background jobs included', { skip: !bash ? 'bash (Git Bash on Windows) is not installed here' : noProc ? 'no /proc on this system' : false }, async () => {
  const command = '(sleep 30; true) & sleep 30';
  let child: ChildProcess;
  let tag: string;
  if (process.platform === 'win32') {
    // The real path: spawnShellChild quotes for MSYS and tags the tree.
    child = spawnShellChild({ file: bash!, args: ['-c', command], msys: true }, { stdio: 'ignore' });
    tag = _shellTreeTagForTest(child) ?? '';
  } else {
    // Elsewhere the same environment tag, set by hand.
    tag = `test-${process.pid}-${Date.now()}`;
    child = spawn(bash!, ['-c', command], { stdio: 'ignore', detached: true, env: { ...process.env, [PROCESS_TREE_ENV]: tag } });
  }
  try {
    assert.ok(tag);
    await new Promise((r) => setTimeout(r, 1_000));
    const found = await msysTreeSweep(bash!, tag);
    assert.ok(found.length >= 3, `found ${JSON.stringify(found)}`);
    assert.ok(!found.includes(process.pid), 'nothing outside the tree');
    if (process.platform === 'linux') {
      const names = found.map((pid) => { try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return '?'; } });
      assert.equal(names.filter((n) => n === 'sleep').length, 2, `names ${JSON.stringify(names)}`);
      assert.ok(found.includes(child.pid!), 'the shell itself is listed');
    }
    assert.ok(MSYS_TREE_SWEEP.includes(PROCESS_TREE_ENV));
    assert.deepEqual(await msysTreeSweep(bash!, `${tag}-other`), [], 'another tag lists nothing');
  } finally {
    if (process.platform === 'win32') spawn('taskkill', windowsTreeKillArgsFor([child.pid!]), { stdio: 'ignore' });
    else { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }
  }
});

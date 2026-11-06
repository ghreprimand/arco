// The `if` field: Claude Code's permission rule syntax, checked against one
// tool call. Cases follow the hooks reference and the permissions guide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainMatches, ifMatches, parseRule, shellRuleMatches, splitShell, type IfCall } from './hookIf.js';

const call = (toolName: string, toolInput: Record<string, unknown>, extra: Partial<IfCall> = {}): IfCall =>
  ({ toolName, toolInput, cwd: '/work/proj', anchorDir: '/work/proj', homeDir: '/home/u', platform: 'linux', ...extra });
const bash = (rule: string, command: string) => ifMatches(rule, call('Bash', { command }));

test('rule syntax: Tool or Tool(specifier); parentheses inside are literal', () => {
  assert.deepEqual(parseRule('Bash'), { tool: 'Bash' });
  assert.deepEqual(parseRule('Edit(./Finance (2024)/**)'), { tool: 'Edit', spec: './Finance (2024)/**' });
  assert.equal(parseRule(''), null);
  assert.equal(parseRule('(x)'), null);
});

test('Bash: the hooks reference table', () => {
  assert.equal(bash('Bash(git *)', 'FOO=bar git push'), true, 'leading assignments are stripped');
  assert.equal(bash('Bash(git *)', 'npm test && git push'), true, 'each subcommand is checked');
  assert.equal(bash('Bash(rm *)', 'echo $(rm -rf /)'), true, 'commands inside $() are checked');
  assert.equal(bash('Bash(rm *)', 'echo `rm -rf /`'), true, 'and inside backticks');
  assert.equal(bash('Bash(rm *)', 'echo $(date)'), false);
  assert.equal(bash('Bash(git push *)', 'echo $(date)'), true, 'a longer pattern runs on $() anyway');
  assert.equal(bash('Bash(git push *)', 'echo $HOME'), true, 'and on $VAR');
  assert.equal(bash('Bash(git push *)', 'npm test'), false);
});

test('Bash: the permissions guide wildcard table', () => {
  const rows: Array<[string, string, boolean]> = [
    ['npm run build', 'npm run build', true], ['npm run build', 'npm run build --watch', false],
    ['npm run *', 'npm run test --watch', true], ['npm run *', 'npm run', true], ['npm run *', 'npm install', false],
    ['git log * main', 'git log --oneline main', true], ['git log * main', 'git log main', false],
    ['git * main', 'git push origin main', true], ['git * main', 'git log', false],
    ['* --version', 'node --version', true], ['* --version', 'node -v', false],
    ['ls *', 'ls -la', true], ['ls *', 'ls', true], ['ls *', 'lsof', false],
    ['ls*', 'lsof', true], ['* --help *', 'npm --help x', true], ['* --help *', 'npm --help', false],
    ['ls:*', 'ls -la', true], ['ls:*', 'lsof', false],
  ];
  for (const [rule, command, want] of rows) assert.equal(shellRuleMatches(rule, command, false), want, `${rule} vs ${command}`);
});

test('Bash: separators, wrappers, groups and commands it cannot take apart', () => {
  assert.equal(bash('Bash(git *)', 'cd /tmp; git status'), true);
  assert.equal(bash('Bash(git *)', 'make | tee log'), false);
  assert.equal(bash('Bash(tee *)', 'make | tee log'), true);
  assert.equal(bash('Bash(git *)', 'make 2>&1 | grep x'), false, '2>&1 is not a separator');
  assert.equal(bash('Bash(npm test *)', 'timeout 30 npm test'), true);
  assert.equal(bash('Bash(npm test *)', 'nice -n 5 nohup npm test --ci'), true);
  assert.equal(bash('Bash(grep *)', 'xargs grep pattern'), true);
  assert.equal(bash('Bash(grep *)', 'xargs -n1 grep pattern'), false);
  assert.equal(bash('Bash(rm *)', '(cd build && rm -rf out)'), true, 'inside a subshell');
  assert.equal(bash('Bash(rm *)', 'for f in a b; do rm "$f"; done'), true, 'inside a loop body');
  assert.equal(bash('Bash(git commit *)', 'git commit -m "fix; stuff && more"'), true, 'separators inside quotes do not split');
  assert.equal(bash('Bash(rm *)', 'echo "rm -rf /"'), false, 'quoted text is not a command');
  assert.equal(bash('Bash(git push *)', 'FOO="a b" git push origin'), true);
  assert.equal(bash('Bash(git push *)', 'git \\\n  push origin'), true, 'a continued line is one command');
  // Cannot tell what runs: the hook runs.
  assert.equal(bash('Bash(rm *)', 'npm test &&'), true);
  assert.equal(bash('Bash(rm *)', 'echo "unclosed'), true);
  assert.equal(bash('Bash(rm *)', 'cat <<EOF\nhi\nEOF'), true);
  assert.deepEqual(splitShell('a && b || c; d | e & f\ng'), { subcommands: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], dynamic: false });
});

test('PowerShell: aliases become the cmdlet, case is ignored, each statement is checked', () => {
  const ps = (rule: string, command: string) => ifMatches(rule, call('PowerShell', { command }));
  assert.equal(ps('PowerShell(Remove-Item *)', 'rm -Recurse x'), true);
  assert.equal(ps('PowerShell(Remove-Item *)', 'Get-Date; remove-item x'), true);
  assert.equal(ps('PowerShell(Get-ChildItem *)', 'dir C:\\'), true);
  assert.equal(ps('PowerShell(Remove-Item *)', 'Get-ChildItem | Select-Object Name'), false);
  assert.equal(ps('PowerShell(Remove-Item *)', 'Write-Output "rm x"'), false);
  assert.equal(ps('Bash(rm *)', 'rm x'), false, 'a Bash rule matches only the Bash tool');
});

test('tool names: exact, Agent for Task, MCP server prefixes and globs; a bare name matches every call', () => {
  assert.equal(ifMatches('Bash', call('Bash', { command: 'anything' })), true);
  assert.equal(ifMatches('Bash(*)', call('Bash', { command: 'anything' })), true);
  assert.equal(ifMatches('Bash', call('PowerShell', { command: 'x' })), false);
  assert.equal(ifMatches('mcp__memory', call('mcp__memory__create', {})), true);
  assert.equal(ifMatches('mcp__memory__*', call('mcp__memory__create', {})), true);
  assert.equal(ifMatches('mcp__memory', call('mcp__memorybank__x', {})), false);
  assert.equal(ifMatches('Agent(Explore)', call('Task', { subagent_type: 'Explore' })), true);
  assert.equal(ifMatches('Task(Explore)', call('Task', {})), false, 'no type is general-purpose');
  assert.equal(ifMatches('Task(model:opus)', call('Task', { model: 'opus' })), true, 'a parameter rule');
  assert.equal(ifMatches('Task(model:*)', call('Task', {})), false, 'an omitted parameter never matches');
  assert.equal(ifMatches('Bash(run_in_background:true)', call('Bash', { command: 'x', run_in_background: true })), false, 'Bash specifiers are commands');
});

test('file rules: Edit covers every editing tool, Read every reading tool; gitignore paths and anchors', () => {
  const edit = (rule: string, file: string, tool = 'Edit', extra: Partial<IfCall> = {}) => ifMatches(rule, call(tool, { file_path: file }, extra));
  assert.equal(edit('Edit(*.ts)', '/work/proj/src/deep/a.ts'), true, 'a bare pattern matches at any depth');
  assert.equal(edit('Edit(*.ts)', '/work/proj/a.md'), false);
  assert.equal(edit('Edit(*.ts)', 'src/a.ts', 'Write'), true, 'Write is an editing tool; relative paths resolve against the project');
  assert.equal(edit('Write(*.ts)', '/work/proj/a.ts', 'Write'), false, 'a Write path rule never matches');
  assert.equal(edit('Edit(*.ts)', '/work/proj/a.ts', 'Read'), false);
  assert.equal(edit('Read(*.ts)', '/work/proj/a.ts', 'Read'), true);
  assert.equal(ifMatches('Read(src/**)', call('Grep', { path: 'src/x' })), true, 'Grep reads its path');
  assert.equal(ifMatches('Read(src/**)', call('Glob', {})), false, 'Glob without a path reads the project folder');
  assert.equal(edit('Edit(src/**)', '/work/proj/src/a.ts'), true);
  assert.equal(edit('Edit(src/**)', '/work/proj/vendor/pkg/src/lib.js'), false, 'one directory segment is anchored at the project');
  assert.equal(edit('Edit(**/src/**)', '/work/proj/vendor/pkg/src/lib.js'), true);
  assert.equal(edit('Edit(/docs/**)', '/work/proj/docs/x.md', 'Edit', { anchorDir: '/work/proj' }), true, '/ is the settings source');
  assert.equal(edit('Edit(/secrets/**)', '/work/proj/secrets/k', 'Edit', { anchorDir: '/home/u/.claude' }), false, 'user settings anchor at ~/.claude');
  assert.equal(edit('Edit(~/notes/*.md)', '/home/u/notes/a.md'), true);
  assert.equal(edit('Edit(//tmp/scratch.txt)', '/tmp/scratch.txt'), true);
  assert.equal(edit('Edit(.env)', '/work/proj/a/b/.env'), true);
  assert.equal(edit('Edit(.env)', '/work/.env'), false, 'nothing above the project folder');
  assert.equal(edit('Edit(./Finance (2024)/**)', '/work/proj/Finance (2024)/q1.xlsx'), true);
  // Windows paths compare in POSIX form, ignoring case.
  const win = { cwd: 'C:\\Proj', anchorDir: 'C:\\Proj', homeDir: 'C:\\Users\\u', platform: 'win32' as const };
  assert.equal(edit('Edit(src/**)', 'C:\\Proj\\SRC\\a.ts', 'Edit', win), true);
  assert.equal(edit('Edit(//c/**/.env)', 'C:\\Other\\.env', 'Edit', win), true);
  assert.equal(edit('Edit(*.ts)', 'D:\\x\\a.ts', 'Edit', win), false);
});

test('WebFetch domains', () => {
  assert.equal(domainMatches('example.com', 'example.com'), true);
  assert.equal(domainMatches('example.com', 'api.example.com'), false);
  assert.equal(domainMatches('*.example.com', 'a.b.example.com'), true);
  assert.equal(domainMatches('*.example.com', 'example.com'), false);
  assert.equal(domainMatches('example.*', 'example.org'), true);
  assert.equal(domainMatches('example.*', 'example.evil.com'), false);
  assert.equal(domainMatches('EXAMPLE.com.', 'example.COM'), true);
  assert.equal(ifMatches('WebFetch(domain:example.com)', call('WebFetch', { url: 'https://example.com/a' })), true);
  assert.equal(ifMatches('WebFetch(domain:example.com)', call('WebFetch', { url: 'https://other.com/a' })), false);
});

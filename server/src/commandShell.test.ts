// Shell resolution for agent shell commands and Claude Native hooks, with
// faked files and environment so every platform runs every case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { findCommandShell, findPowerShell, findRequestedShell, gitRootFromGitExe, isWindowsSystemBash, powerShellScript, shellInvocation, shellToolLabel } from './commandShell.js';

const files = (...list: string[]) => { const set = new Set(list.map((f) => f.toLowerCase())); return (f: string) => set.has(f.toLowerCase()); };
const win = (env: NodeJS.ProcessEnv, isFile: (f: string) => boolean) => findCommandShell({ platform: 'win32', env, isFile });

test('Linux and macOS use /bin/sh, whatever the environment says', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    assert.deepEqual(findCommandShell({ platform, env: { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\x\\bash.exe' }, isFile: () => false }), { ok: true, file: '/bin/sh', kind: 'sh' });
  }
});

test('Windows: CLAUDE_CODE_GIT_BASH_PATH wins when the file exists, quoted or not', () => {
  const bash = 'D:\\Tools\\PortableGit\\bin\\bash.exe';
  assert.deepEqual(win({ CLAUDE_CODE_GIT_BASH_PATH: bash, ProgramFiles: 'C:\\Program Files' }, files(bash, 'C:\\Program Files\\Git\\bin\\bash.exe')), { ok: true, file: bash, kind: 'git-bash' });
  assert.deepEqual(win({ claude_code_git_bash_path: `"${bash}"` }, files(bash)), { ok: true, file: bash, kind: 'git-bash' });
});

test('Windows: an override that points nowhere or at WSL bash is reported, not replaced', () => {
  const missing = win({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\nope\\bash.exe', ProgramFiles: 'C:\\Program Files' }, files('C:\\Program Files\\Git\\bin\\bash.exe'));
  assert.equal(missing.ok, false);
  assert.match(!missing.ok ? missing.problem : '', /^CLAUDE_CODE_GIT_BASH_PATH is set, but there is no file at D:\\nope\\bash\.exe, and PowerShell was not found either.* install Git for Windows/);
  const wsl = win({ CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Windows\\System32\\bash.exe' }, files('C:\\Windows\\System32\\bash.exe'));
  assert.equal(wsl.ok, false);
  assert.match(!wsl.ok ? wsl.problem : '', /WSL, not Git Bash/);
});

test('Windows: the Git install that git on PATH belongs to (cmd, bin and mingw64 layouts)', () => {
  for (const [dir, root] of [['E:\\Git\\cmd', 'E:\\Git'], ['E:\\Git\\bin', 'E:\\Git'], ['E:\\Git\\mingw64\\bin', 'E:\\Git']]) {
    const r = win({ Path: `C:\\Windows\\System32;"${dir}";C:\\Other` }, files(`${dir}\\git.exe`, `${root}\\bin\\bash.exe`, 'C:\\Windows\\System32\\bash.exe'));
    assert.deepEqual(r, { ok: true, file: `${root}\\bin\\bash.exe`, kind: 'git-bash' }, dir);
  }
  // Only usr\bin\bash.exe present.
  assert.deepEqual(win({ PATH: 'E:\\Git\\cmd' }, files('E:\\Git\\cmd\\git.exe', 'E:\\Git\\usr\\bin\\bash.exe')), { ok: true, file: 'E:\\Git\\usr\\bin\\bash.exe', kind: 'git-bash' });
});

test('Windows: then the standard install folders, in order', () => {
  const env = { PATH: 'C:\\Windows\\System32', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\Fixture\\AppData\\Local', USERPROFILE: 'C:\\Users\\Fixture' };
  assert.deepEqual(win(env, files('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Users\\Fixture\\AppData\\Local\\Programs\\Git\\bin\\bash.exe')), { ok: true, file: 'C:\\Program Files\\Git\\bin\\bash.exe', kind: 'git-bash' });
  assert.deepEqual(win(env, files('C:\\Users\\Fixture\\AppData\\Local\\Programs\\Git\\bin\\bash.exe')), { ok: true, file: 'C:\\Users\\Fixture\\AppData\\Local\\Programs\\Git\\bin\\bash.exe', kind: 'git-bash' });
  assert.deepEqual(win(env, files('C:\\Users\\Fixture\\scoop\\apps\\git\\current\\bin\\bash.exe')), { ok: true, file: 'C:\\Users\\Fixture\\scoop\\apps\\git\\current\\bin\\bash.exe', kind: 'git-bash' });
});

test('Windows: WSL bash in System32 or WindowsApps is never picked; without Git Bash the problem names the fix', () => {
  const r = win({ PATH: 'C:\\Windows\\System32;C:\\Users\\Fixture\\AppData\\Local\\Microsoft\\WindowsApps', SystemRoot: 'C:\\Windows' }, files('C:\\Windows\\System32\\bash.exe', 'C:\\Users\\Fixture\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe'));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : '', /^Git Bash was not found, and PowerShell was not found either, so shell commands and hooks cannot run\. On Windows, Arco runs them with Git Bash, or PowerShell when Git Bash is missing\. To fix it, install Git for Windows \(https:\/\/git-scm\.com\/downloads\/win\), or set CLAUDE_CODE_GIT_BASH_PATH/);
  assert.equal(isWindowsSystemBash('C:\\WINDOWS\\Sysnative\\bash.exe'), true);
  assert.equal(isWindowsSystemBash('D:\\Win\\Other\\bash.exe', { SystemRoot: 'D:\\Win' }), true);
  assert.equal(isWindowsSystemBash('C:\\Program Files\\Git\\bin\\bash.exe', { SystemRoot: 'C:\\Windows' }), false);
});

test('gitRootFromGitExe ignores unknown layouts', () => {
  assert.equal(gitRootFromGitExe('C:\\Tools\\git.exe'), null);
  assert.equal(gitRootFromGitExe('C:\\Git\\usr\\bin\\git.exe'), 'C:\\Git');
});

// Windows without Git Bash falls back to PowerShell, as Claude Code does.
test('Windows without Git Bash: PowerShell 7 (pwsh) first, then Windows PowerShell, with an information notice', () => {
  const env = { PATH: 'C:\\Windows\\System32;D:\\Tools', ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' };
  const winPs = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const onPath = win(env, files('D:\\Tools\\pwsh.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', winPs));
  assert.equal(onPath.ok && onPath.kind, 'powershell');
  assert.equal(onPath.ok && onPath.file, 'D:\\Tools\\pwsh.exe');
  assert.match(onPath.ok ? onPath.notice ?? '' : '', /^Git Bash was not found, so shell commands and hooks run in PowerShell, as in Claude Code\. To use Git Bash instead, install Git for Windows/);
  assert.equal(findPowerShell({ platform: 'win32', env, isFile: files('C:\\Program Files\\PowerShell\\7\\pwsh.exe', winPs) }), 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.equal(findPowerShell({ platform: 'win32', env, isFile: files(winPs) }), winPs);
  assert.equal(findPowerShell({ platform: 'win32', env: {}, isFile: files(winPs) }), winPs, 'SystemRoot defaults to C:\\Windows');
  // A broken override still falls back, and the notice says what is wrong with it.
  const bad = win({ ...env, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\nope\\bash.exe' }, files(winPs));
  assert.match(bad.ok ? bad.notice ?? '' : '', /^CLAUDE_CODE_GIT_BASH_PATH is set, but there is no file at D:\\nope\\bash\.exe, so shell commands and hooks run in PowerShell/);
  // Git Bash, when found, wins and carries no notice.
  assert.deepEqual(win({ ...env, ProgramFiles: 'C:\\Program Files' }, files('C:\\Program Files\\Git\\bin\\bash.exe', winPs)), { ok: true, file: 'C:\\Program Files\\Git\\bin\\bash.exe', kind: 'git-bash' });
});

test('Linux and macOS: pwsh on PATH, then the usual install folders', () => {
  assert.equal(findPowerShell({ platform: 'linux', env: { PATH: '/x/bin:/y/bin' }, isFile: files('/y/bin/pwsh', '/usr/bin/pwsh') }), '/y/bin/pwsh');
  assert.equal(findPowerShell({ platform: 'darwin', env: { PATH: '/x/bin' }, isFile: files('/opt/homebrew/bin/pwsh') }), '/opt/homebrew/bin/pwsh');
  assert.equal(findPowerShell({ platform: 'linux', env: {}, isFile: () => false }), null);
});

test('a hook\'s own "shell": powershell needs PowerShell; bash needs Git Bash on Windows and is sh elsewhere', () => {
  assert.deepEqual(findRequestedShell('powershell', { platform: 'linux', env: { PATH: '/p' }, isFile: files('/p/pwsh') }), { ok: true, file: '/p/pwsh', kind: 'powershell' });
  const none = findRequestedShell('powershell', { platform: 'win32', env: {}, isFile: () => false });
  assert.equal(none.ok ? '' : none.problem, 'The hook asks for PowerShell ("shell": "powershell"), but neither pwsh nor powershell.exe was found.');
  assert.deepEqual(findRequestedShell('bash', { platform: 'darwin', env: {}, isFile: () => false }), { ok: true, file: '/bin/sh', kind: 'sh' });
  const noBash = findRequestedShell('bash', { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, isFile: files('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe') });
  assert.match(noBash.ok ? '' : noBash.problem, /^The hook asks for bash \("shell": "bash"\), which needs Git Bash on Windows\. Git Bash was not found\. To fix it, install Git for Windows/);
});

test('PowerShell commands are passed encoded, or through a temporary script when long', () => {
  const sh = shellInvocation({ file: '/bin/sh', kind: 'sh' }, 'echo "$HOME" && exit 3');
  assert.deepEqual([sh.file, sh.args], ['/bin/sh', ['-c', 'echo "$HOME" && exit 3']]);
  const command = 'Write-Output "it\'s $env:HOME"; exit 3';
  const short = shellInvocation({ file: 'pwsh', kind: 'powershell' }, command);
  assert.deepEqual(short.args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  const decoded = Buffer.from(short.args.at(-1) ?? '', 'base64').toString('utf16le');
  assert.equal(decoded, powerShellScript(command));
  assert.ok(decoded.includes(`\n${command}\n`));
  const long = shellInvocation({ file: 'pwsh', kind: 'powershell' }, `Write-Output '${'x'.repeat(20_000)}'`);
  const script = long.args.at(-1) ?? '';
  assert.equal(long.args.at(-2), '-File');
  assert.ok(readFileSync(script, 'utf8').startsWith('\uFEFF'), 'byte order mark for Windows PowerShell 5.1');
  long.cleanup();
  assert.equal(existsSync(script), false, 'the temporary script is removed');
});

test('the Bash tool description names the shell it runs in', () => {
  assert.equal(shellToolLabel({ ok: true, file: '/bin/sh', kind: 'sh' }), 'sh -c');
  assert.match(shellToolLabel({ ok: true, file: 'C:\\Git\\bin\\bash.exe', kind: 'git-bash' }), /^Git Bash/);
  assert.match(shellToolLabel({ ok: true, file: 'pwsh.exe', kind: 'powershell', notice: 'n' }), /PowerShell, because Git Bash was not found.*Write PowerShell commands, not bash/);
});

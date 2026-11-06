// Shell resolution for agent shell commands and Claude Native hooks, with
// faked files and environment so every platform runs every case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCommandShell, gitRootFromGitExe, isWindowsSystemBash } from './commandShell.js';

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
  assert.match(!missing.ok ? missing.problem : '', /CLAUDE_CODE_GIT_BASH_PATH is set, but there is no file at D:\\nope\\bash\.exe\. Install Git for Windows/);
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
  assert.match(!r.ok ? r.problem : '', /^Git Bash was not found\. On Windows, Arco runs shell commands and hooks with Git Bash\. Install Git for Windows \(https:\/\/git-scm\.com\/downloads\/win\), or set CLAUDE_CODE_GIT_BASH_PATH/);
  assert.equal(isWindowsSystemBash('C:\\WINDOWS\\Sysnative\\bash.exe'), true);
  assert.equal(isWindowsSystemBash('D:\\Win\\Other\\bash.exe', { SystemRoot: 'D:\\Win' }), true);
  assert.equal(isWindowsSystemBash('C:\\Program Files\\Git\\bin\\bash.exe', { SystemRoot: 'C:\\Windows' }), false);
});

test('gitRootFromGitExe ignores unknown layouts', () => {
  assert.equal(gitRootFromGitExe('C:\\Tools\\git.exe'), null);
  assert.equal(gitRootFromGitExe('C:\\Git\\usr\\bin\\git.exe'), 'C:\\Git');
});

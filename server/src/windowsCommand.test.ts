import test from 'node:test';
import assert from 'node:assert/strict';
import { npmShimTarget, resolveCommand, resolveLoginCommand } from './windowsCommand.js';

// A fake Windows file system: npm's global folder holds codex.cmd (a shim for
// a script) and a native tool, both found through PATH and PATHEXT.
const NPM = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
const files: Record<string, string> = {
  [`${NPM}\\codex.cmd`]: '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
  [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '',
  [`${NPM}\\legacy.cmd`]: '@"%~dp0\\node_modules\\legacy\\cli.mjs" %*\r\n',
  [`${NPM}\\node_modules\\legacy\\cli.mjs`]: '',
  [`${NPM}\\opaque.cmd`]: '@echo off\r\nsomething-else.exe %*\r\n',
  'C:\\Tools\\rg.exe': '',
  'C:\\Late\\agy.exe': '',
  'C:\\Script\\agy.ps1': '',
};
const opts = {
  platform: 'win32' as const,
  env: { Path: `C:\\Tools;"${NPM}"`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
  nodePath: 'C:\\node\\node.exe',
  isFile: (p: string) => Object.hasOwn(files, p),
  readText: (p: string) => files[p],
};

test('an npm .cmd shim starts its JavaScript entry with Node, arguments intact', () => {
  const r = resolveCommand('codex', ['exec', '--json', 'a "quoted" & arg'], opts);
  assert.equal(r.command, 'C:\\node\\node.exe');
  assert.deepEqual(r.args, [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`, 'exec', '--json', 'a "quoted" & arg']);
});

test('older %~dp0 shims and .mjs entries resolve too', () => {
  assert.equal(npmShimTarget(`${NPM}\\legacy.cmd`, files[`${NPM}\\legacy.cmd`]), `${NPM}\\node_modules\\legacy\\cli.mjs`);
  assert.equal(resolveCommand('legacy', [], opts).args[0], `${NPM}\\node_modules\\legacy\\cli.mjs`);
});

test('a native executable on PATH is started by its full path', () => {
  assert.deepEqual(resolveCommand('rg', ['-n', 'x'], opts), { command: 'C:\\Tools\\rg.exe', args: ['-n', 'x'] });
});

test('unknown commands and shims without a script pass through unchanged', () => {
  assert.deepEqual(resolveCommand('missing', ['a'], opts), { command: 'missing', args: ['a'] });
  assert.deepEqual(resolveCommand('opaque', ['a'], opts), { command: 'opaque', args: ['a'] });
});

test('other platforms pass through without touching the file system', () => {
  const r = resolveCommand('codex', ['exec'], { ...opts, platform: 'linux', isFile: () => { throw new Error('no fs on linux'); } });
  assert.deepEqual(r, { command: 'codex', args: ['exec'] });
});

// A service started before agy was installed keeps its old PATH; a new terminal
// reads the current one. Antigravity sign-in and turns find it there, opt-in only.
test('with fresh set, a program missing from the running PATH is found on the new-terminal PATH for sign-in and turns', () => {
  const registryPath = () => 'C:\\Late;C:\\Script';
  const merged = `C:\\Late;C:\\Script;C:\\Tools;"${NPM}"`;
  assert.deepEqual(resolveLoginCommand('agy acp --login', { ...opts, fresh: true, registryPath }), { line: '"C:\\Late\\agy.exe" acp --login', path: merged });
  const turn = resolveCommand('agy', ['acp'], { ...opts, fresh: true, registryPath });
  assert.equal(turn.command, 'C:\\Late\\agy.exe');
  assert.deepEqual(turn.args, ['acp']);
  assert.deepEqual(turn.env, { PATHEXT: '.COM;.EXE;.BAT;.CMD', Path: merged });
});

test('without fresh, or with a caller-supplied environment, the host PATH is never consulted', () => {
  const registryPath = () => { throw new Error('registry must not be read'); };
  assert.deepEqual(resolveCommand('agy', ['acp'], { ...opts, registryPath }), { command: 'agy', args: ['acp'] });
  assert.deepEqual(resolveLoginCommand('agy acp --login', { ...opts, registryPath }), { missing: 'agy' });
  assert.deepEqual(resolveCommand('agy', ['acp'], { ...opts, fresh: true }), { command: 'agy', args: ['acp'] });
});

test('sign-in names the program when no PATH has it, and does not accept a .ps1 script', () => {
  assert.deepEqual(resolveLoginCommand('agy acp --login', { ...opts, fresh: true, registryPath: () => 'C:\\Script' }), { missing: 'agy' });
  assert.deepEqual(resolveLoginCommand('agy acp --login', { ...opts, platform: 'linux' }), { line: 'agy acp --login' });
});

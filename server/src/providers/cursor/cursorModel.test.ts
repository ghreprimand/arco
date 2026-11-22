// Cursor model selection, sign-in state and the start-failure breaker, run
// against a fake `cursor-agent` that answers from a capture of the real CLI
// (fixtures/acp-models.json; no prompt was sent when it was taken).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { once } from 'node:events';
import { buildTurnWaitInstructions, type WorkerConfig } from '@arco/shared';
import fx from './fixtures/acp-models.json' with { type: 'json' };
import { catalogIds, resolveCatalogModel, acpMatchesCatalog, describeAcpModel } from './modelMap.js';
import { mergeAcpModels } from './catalog.js';

const root = mkdtempSync(join(tmpdir(), 'arco-cursor-model-'));
const bin = join(root, 'bin');
const logFile = join(root, 'acp.log');
const authFile = join(root, 'auth.json');
const savedEnv = { ...process.env };
const FAKE_KEYS = ['FAKE_CURSOR_AUTH_FAIL', 'FAKE_CURSOR_LOAD_OK', 'FAKE_CURSOR_LOAD_CURRENT', 'FAKE_CURSOR_REJECT_SET', 'FAKE_CURSOR_IGNORE_SET', 'FAKE_CURSOR_NO_CONFIG_OPTION', 'FAKE_CURSOR_STATUS'];

let worker: typeof import('./worker.js');
let dispatcher: typeof import('./index.js');
let authState: typeof import('./authState.js');
let auth: typeof import('../../auth.js');
let login: typeof import('../../authLoginSession.js');

before(async () => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(bin, { recursive: true });
  const here = new URL('./fixtures/', import.meta.url);
  copyFileSync(new URL('fake-cursor-agent.mjs', here), join(bin, 'fake-cursor-agent.mjs'));
  copyFileSync(new URL('acp-models.json', here), join(bin, 'acp-models.json'));
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'cursor-agent.cmd'), `@ECHO off\r\nSET "dp0=%~dp0"\r\n"${process.execPath}" "%dp0%\\fake-cursor-agent.mjs" %*\r\n`);
  } else {
    writeFileSync(join(bin, 'cursor-agent'), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'fake-cursor-agent.mjs')}" "$@"\n`);
    chmodSync(join(bin, 'cursor-agent'), 0o755);
  }
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  process.env.FAKE_CURSOR_LOG = logFile;
  process.env.ARCO_CURSOR_AUTH = authFile;
  writeFileSync(authFile, JSON.stringify({ accessToken: 'token-one' }));
  worker = await import('./worker.js');
  dispatcher = await import('./index.js');
  authState = await import('./authState.js');
  auth = await import('../../auth.js');
  login = await import('../../authLoginSession.js');
});

after(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});

function setFake(vars: Record<string, string>): void {
  for (const k of FAKE_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  writeFileSync(logFile, '');
}
const requests = (): Array<{ method?: string; params?: Record<string, unknown>; argv?: string[] }> =>
  existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const config = (model: string, workflowId = `wf-model-${model}`): WorkerConfig => ({
  provider: 'cursor', model, effort: 'high', tools: [], cwd: root, workflowId,
} as unknown as WorkerConfig);

// One turn on a real CursorAcpWorker over the fake CLI.
async function runTurn(model: string, resume?: string): Promise<{ init: { model?: string }; notices: string[]; w: InstanceType<typeof worker.CursorAcpWorker> }> {
  const w = new worker.CursorAcpWorker(`wf-${Math.random().toString(16).slice(2)}`, config(model), resume);
  const notices: string[] = [];
  w.on('system_notice', (n: string) => notices.push(n));
  const init = once(w, 'init');
  const settled = once(w, 'turn_settled');
  await w.ensureStarted();
  await w.beginTurn('hello');
  const [data] = await init;
  await settled;
  return { init: data, notices, w };
}

const avail = fx.sessionNewResult.models.availableModels;
const cat = catalogIds(fx.catalogStdout);
const grokHighFast = 'grok-4.7[context=256k,reasoning_effort=high,fast=true]';

test('captured catalog: every advertised ACP variant listed in the catalog maps to exactly one catalog id', () => {
  const listed = avail.filter((m) => cat.some((id) => acpMatchesCatalog(m.modelId, id, cat)));
  assert.ok(listed.length >= 40, `only ${listed.length} matched`);
  for (const m of listed) assert.equal(cat.filter((id) => acpMatchesCatalog(m.modelId, id, cat)).length, 1, m.modelId);
  assert.equal(describeAcpModel(grokHighFast, cat), 'grok-4.7-high-fast');
  assert.equal(describeAcpModel('claude-sonnet-4-6[thinking=true,context=200k,effort=medium]', cat), 'claude-4.6-sonnet-medium-thinking');
  assert.equal(describeAcpModel('gpt-5.3-codex[reasoning=medium,fast=false]', cat), 'gpt-5.3-codex');
});

test('catalog ids resolve by effort, fast and thinking, never by name alone', () => {
  assert.deepEqual(resolveCatalogModel('auto', avail, cat), { kind: 'exact', acpId: 'default[]' });
  assert.deepEqual(resolveCatalogModel('grok-4.7-high-fast', avail, cat), { kind: 'exact', acpId: grokHighFast });
  assert.deepEqual(resolveCatalogModel('grok-4.7-medium', avail, cat), { kind: 'other-variant', acpId: grokHighFast, effective: 'grok-4.7-high-fast' });
  assert.deepEqual(resolveCatalogModel('gpt-5.3-codex-high', avail, cat).kind, 'other-variant');
  assert.deepEqual(resolveCatalogModel('claude-4.6-sonnet-medium-thinking', avail, cat).kind, 'exact');
  assert.deepEqual(resolveCatalogModel('claude-4.6-sonnet-medium', avail, cat).kind, 'other-variant');
  assert.deepEqual(resolveCatalogModel('no-such-model', avail, cat), { kind: 'unavailable' });
  // The text catalog prefixes Grok with the vendor; ACP does not.
  assert.deepEqual(resolveCatalogModel('cursor-grok-4.6-high-fast', [{ modelId: 'grok-4.6[effort=high,fast=true]' }], ['cursor-grok-4.6-high', 'cursor-grok-4.6-high-fast']),
    { kind: 'exact', acpId: 'grok-4.6[effort=high,fast=true]' });
});

// `cursor-agent models` left out models its sessions offer (GLM 5.3); the
// catalog adds each advertised model with no text variant, and choosing it
// selects the advertised id.
test('models a Cursor session advertises but the text list omits join the catalog and resolve', () => {
  const text = [{ id: 'glm-5.2-high', displayName: 'GLM 5.2', isDefault: false }, { id: 'cursor-grok-4.6-high', displayName: 'Grok 4.6', isDefault: false }];
  const acp = [{ modelId: 'default[]' }, { modelId: 'glm-5.2[reasoning=high]', name: 'glm-5.2' }, { modelId: 'grok-4.6[effort=high]', name: 'grok-4.6' },
    { modelId: 'glm-5p3[reasoning=high]', name: 'glm-5p3' }, { modelId: 'claude-haiku-4-5[thinking=true]', name: 'claude-haiku-4-5' }];
  const merged = mergeAcpModels(text, acp);
  assert.deepEqual(merged.slice(text.length), [
    { id: 'glm-5p3', displayName: 'GLM 5.3', isDefault: false },
    { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', isDefault: false },
  ]);
  assert.deepEqual(resolveCatalogModel('glm-5p3', acp, merged.map((m) => m.id)), { kind: 'exact', acpId: 'glm-5p3[reasoning=high]' });
});

test('a new session selects the configured model explicitly and confirms it', { timeout: 30_000 }, async () => {
  setFake({});
  const { init, notices, w } = await runTurn('grok-4.7-high-fast');
  try {
    const sets = requests().filter((r) => r.method === 'session/set_config_option');
    assert.deepEqual(sets.map((r) => r.params?.value), [grokHighFast], 'set explicitly after session/new');
    assert.equal(init.model, 'grok-4.7-high-fast');
    assert.deepEqual(notices, []);
    assert.ok(!requests().find((r) => r.argv)?.argv?.includes('--model'), 'no ignored --model at spawn');
  } finally { await w.dispose(); }
});

test('a variant Cursor does not offer is named with the model it runs on (no silent fallback)', { timeout: 30_000 }, async () => {
  setFake({});
  const { init, notices, w } = await runTurn('grok-4.7-medium');
  try {
    assert.equal(init.model, 'grok-4.7-high-fast', 'chip shows the effective model');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /"grok-4\.7-medium"/);
    assert.match(notices[0], /"grok-4\.7-high-fast"/);
  } finally { await w.dispose(); }
});

test('a loaded session is switched and confirmed too', { timeout: 30_000 }, async () => {
  setFake({ FAKE_CURSOR_LOAD_OK: '1', FAKE_CURSOR_LOAD_CURRENT: 'claude-sonnet-4-6[thinking=true,context=200k,effort=medium]' });
  const { init, notices, w } = await runTurn('grok-4.7-medium', 'saved-session');
  try {
    assert.ok(requests().some((r) => r.method === 'session/load'));
    assert.deepEqual(requests().filter((r) => r.method === 'session/set_config_option').map((r) => r.params?.value), [grokHighFast]);
    assert.equal(init.model, 'grok-4.7-high-fast');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /grok-4\.7-medium/);
  } finally { await w.dispose(); }
});

test('an unconfirmed, refused or unavailable model leaves a notice naming both models', { timeout: 60_000 }, async () => {
  setFake({ FAKE_CURSOR_IGNORE_SET: '1' });
  let r = await runTurn('grok-4.7-high-fast');
  try {
    assert.equal(r.init.model, 'auto');
    assert.match(r.notices[0] ?? '', /did not confirm the switch to "grok-4\.7-high-fast".*"auto"/);
  } finally { await r.w.dispose(); }
  setFake({ FAKE_CURSOR_REJECT_SET: '1' });
  r = await runTurn('grok-4.7-high-fast');
  try {
    assert.equal(r.init.model, 'auto');
    assert.match(r.notices[0] ?? '', /refused the switch to "grok-4\.7-high-fast".*Invalid model value.*"auto"/);
  } finally { await r.w.dispose(); }
  setFake({});
  r = await runTurn('no-such-model');
  try {
    assert.equal(r.init.model, 'auto');
    assert.match(r.notices[0] ?? '', /does not offer "no-such-model".*"auto"/);
    assert.equal(requests().filter((x) => x.method === 'session/set_config_option').length, 0);
  } finally { await r.w.dispose(); }
  setFake({ FAKE_CURSOR_NO_CONFIG_OPTION: '1' });
  r = await runTurn('grok-4.7-high-fast');
  try {
    assert.deepEqual(requests().filter((x) => x.method === 'session/set_model').map((x) => x.params?.modelId), [grokHighFast], 'older CLI: set_model');
    assert.equal(r.init.model, 'grok-4.7-high-fast');
  } finally { await r.w.dispose(); }
});

async function dispatchTurn(workflowId: string): Promise<{ notices: string[]; error?: string }> {
  const turn = dispatcher.CursorProvider.create(`t-${Math.random()}`, config('auto', workflowId));
  const notices: string[] = [];
  turn.on('system_notice', (n: string) => notices.push(n));
  const done = new Promise<{ error?: string }>((res) => { turn.once('error', (e: string) => res({ error: e })); turn.once('result', () => res({})); });
  turn.spawn('hello');
  return { notices, ...(await done) };
}

test('sign-in failures show a sign-in notice and never trip the start-failure breaker', { timeout: 60_000 }, async () => {
  const wf = 'wf-cursor-auth-breaker';
  setFake({ FAKE_CURSOR_AUTH_FAIL: '1' });
  for (let i = 0; i < 4; i++) {
    const r = await dispatchTurn(wf);
    assert.match(r.error ?? '', /Authentication required/);
    assert.ok(r.notices.some((n) => n.startsWith('[AUTH:cursor]') && /Sign in again/.test(n)), `attempt ${i + 1}: ${r.notices.join(' | ')}`);
    assert.ok(!r.notices.some((n) => /stops retrying/.test(n)), `attempt ${i + 1} was blocked`);
  }
  const status = await auth.getAuthStatus();
  assert.equal(status.cursor.loggedIn, false, 'a rejected sign-in reads as not signed in');
  assert.equal(status.cursor.signInRejected, true);
  // Signing in again (a new token) clears it, and the tab works at once.
  writeFileSync(authFile, JSON.stringify({ accessToken: 'token-two' }));
  setFake({});
  assert.equal((await auth.getAuthStatus()).cursor.loggedIn, true);
  const ok = await dispatchTurn(wf);
  assert.equal(ok.error, undefined, ok.notices.join(' | '));
  dispatcher.disposeCursorWorker(wf);
});

test('the Connections check asks cursor-agent status; polls never do', { timeout: 30_000 }, async () => {
  authState.noteCursorAuthOk();
  setFake({ FAKE_CURSOR_STATUS: 'Error: unable to fetch user details\n' });
  assert.equal((await auth.getAuthStatus()).cursor.loggedIn, true, 'a poll does not run the CLI');
  const checked = await auth.getConnectionStatus('cursor');
  assert.equal(checked.loggedIn, false);
  assert.equal(checked.signInRejected, true);
  assert.match(checked.error ?? '', /Sign in again/);
  setFake({ FAKE_CURSOR_STATUS: 'Logged in as user\n' });
  assert.equal((await auth.getConnectionStatus('cursor')).loggedIn, true);
  assert.equal(authState.parseCursorStatusOutput('Not logged in'), 'rejected');
  assert.equal(authState.parseCursorStatusOutput('something else'), 'unknown');
});

test('a sign-in the current CLI moved to the Linux keyring is read there, and a locked keyring is not a sign-out', async () => {
  const { readCursorAccessTokenFrom, parseSecretToolSearch, cursorAuthPaths } = await import('./authToken.js');
  // What cursor-agent leaves in auth.json once its tokens live in the secret service.
  const pointer = JSON.stringify({ storedIn: 'os-secret-store' });
  let reads = 0;
  const src = (file: string, store: () => ReturnType<typeof parseSecretToolSearch>) => ({
    platform: 'linux' as const, authPaths: ['/fixture/auth.json'], override: false,
    readFileText: async () => file, readKeychain: async () => null,
    readSecretStore: async () => { reads++; return store(); },
  });
  const stored = parseSecretToolSearch('[/org/freedesktop/secrets/collection/login/7]\nlabel = Cursor CLI credentials (cursor)\nsecret = {"accessToken":"tok-store","refreshToken":"r"}\n', '');
  assert.deepEqual(await readCursorAccessTokenFrom(src(pointer, () => stored)), { token: 'tok-store', source: 'secret-store' });
  const locked = await readCursorAccessTokenFrom(src(pointer, () => parseSecretToolSearch('[/org/freedesktop/secrets/collection/login/7]\nlabel = Cursor CLI credentials (cursor)\n', '')));
  assert.equal(locked.token, null);
  assert.equal(locked.token === null && locked.uncertain, true);
  assert.match(locked.token === null ? locked.detail ?? '' : '', /locked/);
  const signedOut = await readCursorAccessTokenFrom(src(JSON.stringify({ signedOut: true }), () => stored));
  assert.equal(signedOut.token === null && signedOut.reason, 'signed-out');
  assert.equal(reads, 2, 'a signed-out file never reads the keyring');
  for (const r of [locked, signedOut]) assert.doesNotMatch(r.token === null ? r.detail ?? '' : '', /fixture|auth\.json/, 'no file path in the message');
  // The CLI's own path first; the path Arco read before stays as a fallback.
  assert.deepEqual(cursorAuthPaths('linux', {}, '/h'), [join('/h', '.config', 'cursor', 'auth.json')]);
  assert.deepEqual(cursorAuthPaths('linux', { XDG_CONFIG_HOME: '/x' }, '/h'), [join('/x', 'cursor', 'auth.json'), join('/h', '.config', 'cursor', 'auth.json')]);
  assert.deepEqual(cursorAuthPaths('win32', { APPDATA: 'C:\\A' }, 'C:\\h'), [join('C:\\A', 'Cursor', 'auth.json'), join('C:\\h', '.config', 'cursor', 'auth.json')]);
  assert.deepEqual(cursorAuthPaths('darwin', {}, '/h'), [join('/h', '.cursor', 'auth.json'), join('/h', '.config', 'cursor', 'auth.json')]);
  const legacy = await readCursorAccessTokenFrom({ ...src(pointer, () => stored), platform: 'win32', authPaths: ['/own/auth.json', '/legacy/auth.json'],
    readFileText: async (path: string) => { if (path === '/own/auth.json') throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return JSON.stringify({ accessToken: 'tok-legacy' }); } });
  assert.deepEqual(legacy, { token: 'tok-legacy', source: 'file' });
});

test('print mode passes the chosen catalog id, Auto included', { timeout: 30_000 }, async () => {
  const { CursorPrintProvider } = await import('./print.js');
  for (const model of ['auto', 'grok-4.7-medium']) {
    setFake({});
    const p = CursorPrintProvider.create(`p-${model}`, config(model));
    const done = new Promise<void>((res, rej) => { p.once('result', () => res()); p.once('error', (e: string) => rej(new Error(e))); });
    p.spawn('hello');
    await done;
    const argv = requests().find((r) => r.argv)?.argv ?? [];
    assert.equal(argv[argv.indexOf('--model') + 1], model, argv.join(' '));
  }
});

test('ACP and print mode close the prompt prefix with the output-style addendum', { timeout: 30_000 }, async () => {
  const { outputStyleAddendum } = await import('../outputStyle.js');
  const { goalBlock } = await import('../goalBlock.js');
  const terse = outputStyleAddendum('terse')!;
  const { FILE_READ_GUIDANCE } = await import('../providerFileContent.js');
  setFake({});
  const w = new worker.CursorAcpWorker('wf-style', { ...config('auto', 'wf-style'), outputStyle: 'terse', goal: 'Ship the fix' } as WorkerConfig, undefined);
  try {
    const settled = once(w, 'turn_settled');
    await w.ensureStarted();
    await w.beginTurn('hello', 'APPENDED');
    await settled;
    const prompt = requests().find((r) => r.method === 'session/prompt')?.params?.prompt as Array<{ type: string; text?: string }>;
    const prefix = `${buildTurnWaitInstructions()}\n\n${goalBlock('Ship the fix')}\n\nAPPENDED\n\n${FILE_READ_GUIDANCE}\n\n${terse}\n\n---\n\n`;
    assert.equal(prompt[0].text, `${prefix}hello`);
    const nextSettled = once(w, 'turn_settled');
    await w.beginTurn('next turn', 'APPENDED');
    await nextSettled;
    const next = requests().filter((r) => r.method === 'session/prompt').at(-1)?.params?.prompt as Array<{ type: string; text?: string }>;
    assert.equal(next[0].text, `${prefix}next turn`, 'the prefix stays stable when the turn body changes');
  } finally { await w.dispose(); }

  const { CursorPrintProvider } = await import('./print.js');
  for (const [style, expected] of [['plain', `${buildTurnWaitInstructions()}\n\n${goalBlock('Ship the fix')}\n\nAPPENDED\n\n${FILE_READ_GUIDANCE}\n\n${outputStyleAddendum('plain')}\n\n---\n\nhello`], ['normal', `${buildTurnWaitInstructions()}\n\n${goalBlock('Ship the fix')}\n\nAPPENDED\n\n${FILE_READ_GUIDANCE}\n\n---\n\nhello`]] as const) {
    setFake({});
    const p = CursorPrintProvider.create(`p-style-${style}`, { ...config('auto'), outputStyle: style, goal: 'Ship the fix', appendSystemPrompt: 'APPENDED' } as WorkerConfig);
    const done = new Promise<void>((res, rej) => { p.once('result', () => res()); p.once('error', (e: string) => rej(new Error(e))); });
    p.spawn('hello');
    await done;
    assert.equal((requests().find((r) => r.argv) as { stdin?: string }).stdin, expected, style);
  }
});

test('Connections > Cursor runs the sign-in in Arco and shows its link', { timeout: 30_000 }, async () => {
  assert.ok(login.IN_APP_LOGIN.cursor, 'cursor has in-app login');
  const started = login.startLoginSession('cursor', 'env NO_OPEN_BROWSER=1 cursor-agent login');
  assert.equal(started.status, 'pending');
  assert.equal(started.needsCode, false);
  const deadline = Date.now() + 20_000;
  let s = login.getLoginSession('cursor');
  while (s?.status === 'pending' && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 100)); s = login.getLoginSession('cursor'); }
  assert.equal(s?.status, 'completed', s?.message);
  assert.equal(s?.url, 'https://cursor.example/login?challenge=abc', 'NO_OPEN_BROWSER reached the CLI, which printed its link');
});

// Hub guard decision: a server whose Arco home is inside the temporary folder
// does not join the hub, and sends no phone notices to an inherited
// ARCO_NTFY_URL, unless ARCO_ALLOW_TEMP_HOME=1 (or the older
// ARCO_HUB_ALLOW_TEMP_HOME=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _resetGuardNotesForTest, decideHubLink, environmentNtfyAllowed, hubUrlForServer, isSameOrInside, realpathLoose } from './hubGuard.js';

const HUB = 'ws://127.0.0.1:9/agent';

function fixture(): { root: string; temp: string; outside: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'arco-hub-guard-'));
  const temp = path.join(root, 'tmp'), outside = path.join(root, 'outside');
  mkdirSync(temp); mkdirSync(outside);
  return { root, temp, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('no hub URL: nothing to join and nothing held back', () => {
  const f = fixture();
  try {
    assert.deepEqual(decideHubLink({ home: path.join(f.temp, 'home'), tempDir: f.temp }), { heldBack: false });
    assert.deepEqual(decideHubLink({ hubUrl: '  ', home: path.join(f.temp, 'home'), tempDir: f.temp }), { heldBack: false });
  } finally { f.cleanup(); }
});

test('home inside the temporary folder: held back', () => {
  const f = fixture();
  try {
    const home = path.join(f.temp, 'run-1', 'home', '.arco'); // need not exist yet
    assert.deepEqual(decideHubLink({ hubUrl: HUB, home, tempDir: f.temp }), { heldBack: true });
  } finally { f.cleanup(); }
});

test('home inside the temporary folder with the override: joins', () => {
  const f = fixture();
  try {
    const home = path.join(f.temp, 'home');
    assert.deepEqual(decideHubLink({ hubUrl: HUB, home, tempDir: f.temp, override: '1' }), { hubUrl: HUB, heldBack: false });
    // Only "1" lifts the rule.
    assert.deepEqual(decideHubLink({ hubUrl: HUB, home, tempDir: f.temp, override: '0' }), { heldBack: true });
    assert.deepEqual(decideHubLink({ hubUrl: HUB, home, tempDir: f.temp, override: '' }), { heldBack: true });
  } finally { f.cleanup(); }
});

test('home outside the temporary folder: joins as before', () => {
  const f = fixture();
  try {
    assert.deepEqual(decideHubLink({ hubUrl: ` ${HUB} `, home: path.join(f.outside, '.arco'), tempDir: f.temp }), { hubUrl: HUB, heldBack: false });
  } finally { f.cleanup(); }
});

test('home equal to the temporary folder itself: held back', () => {
  const f = fixture();
  try {
    assert.deepEqual(decideHubLink({ hubUrl: HUB, home: f.temp, tempDir: f.temp }), { heldBack: true });
    assert.deepEqual(decideHubLink({ hubUrl: HUB, home: `${f.temp}${path.sep}`, tempDir: f.temp }), { heldBack: true });
  } finally { f.cleanup(); }
});

test('a sibling that only shares the prefix is not inside', () => {
  const f = fixture();
  try {
    const sibling = `${f.temp}foo`;
    mkdirSync(sibling);
    assert.deepEqual(decideHubLink({ hubUrl: HUB, home: path.join(sibling, '.arco'), tempDir: f.temp }), { hubUrl: HUB, heldBack: false });
    assert.equal(isSameOrInside('/tmpfoo', '/tmp', path.posix), false);
    assert.equal(isSameOrInside('/tmp/..foo', '/tmp', path.posix), true);
    assert.equal(isSameOrInside('/', '/tmp', path.posix), false);
  } finally { f.cleanup(); }
});

test('symlinked TMPDIR: a home reached through either name counts', (t) => {
  const f = fixture();
  try {
    const link = path.join(f.root, 'tmp-link');
    try { symlinkSync(f.temp, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { t.skip('symlinks unavailable'); return; }
    // TMPDIR is the link, the home is under the real folder.
    assert.deepEqual(decideHubLink({ hubUrl: HUB, home: path.join(f.temp, 'home'), tempDir: link }), { heldBack: true });
    // TMPDIR is the real folder, the home is under the link (and does not exist yet).
    assert.deepEqual(decideHubLink({ hubUrl: HUB, home: path.join(link, 'home', '.arco'), tempDir: f.temp }), { heldBack: true });
    // A link elsewhere that points outside stays outside.
    const outsideLink = path.join(f.temp, 'to-outside');
    symlinkSync(f.outside, outsideLink, process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(decideHubLink({ hubUrl: HUB, home: path.join(outsideLink, '.arco'), tempDir: f.temp }), { hubUrl: HUB, heldBack: false });
  } finally { f.cleanup(); }
});

test('macOS: /var/folders and /private/var/folders resolve the same way', () => {
  const realpath = (p: string) => {
    if (p === '/var' || p.startsWith('/var/')) return `/private${p}`;
    if (p === '/' || p === '/private' || p.startsWith('/private/var')) return p;
    throw new Error('ENOENT');
  };
  const base = { hubUrl: HUB, realpath, pathApi: path.posix };
  assert.deepEqual(decideHubLink({ ...base, home: '/private/var/folders/ab/T/run/.arco', tempDir: '/var/folders/ab/T' }), { heldBack: true });
  assert.deepEqual(decideHubLink({ ...base, home: '/var/folders/ab/T/run/.arco', tempDir: '/private/var/folders/ab/T' }), { heldBack: true });
  assert.deepEqual(decideHubLink({ ...base, home: '/opt/fixture/.arco', tempDir: '/var/folders/ab/T' }), { hubUrl: HUB, heldBack: false });
});

test('Windows paths: case-insensitive, other drives are outside', () => {
  const realpath = (p: string) => p;
  const base = { hubUrl: HUB, realpath, pathApi: path.win32 };
  assert.deepEqual(decideHubLink({ ...base, home: 'C:\\Users\\Fixture\\AppData\\Local\\Temp\\run\\.arco', tempDir: 'c:\\users\\fixture\\appdata\\local\\temp' }), { heldBack: true });
  assert.deepEqual(decideHubLink({ ...base, home: 'C:\\Users\\Fixture\\.arco', tempDir: 'C:\\Users\\Fixture\\AppData\\Local\\Temp' }), { hubUrl: HUB, heldBack: false });
  assert.deepEqual(decideHubLink({ ...base, home: 'D:\\Temp\\.arco', tempDir: 'C:\\Temp' }), { hubUrl: HUB, heldBack: false });
});

test('realpathLoose keeps the missing tail of a path that does not exist yet', () => {
  const f = fixture();
  try {
    const resolved = realpathLoose(path.join(f.temp, 'a', 'b'));
    assert.equal(path.basename(resolved), 'b');
    assert.equal(path.basename(path.dirname(resolved)), 'a');
  } finally { f.cleanup(); }
});

test('hubUrlForServer reads ARCO_HOME and the system temporary folder, and logs once', () => {
  const saved = process.env.ARCO_HOME;
  const f = fixture();
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logged.push(args.join(' ')); };
  try {
    _resetGuardNotesForTest();
    process.env.ARCO_HOME = path.join(tmpdir(), 'arco-hub-guard-home');
    assert.equal(hubUrlForServer({ ARCO_HUB_URL: HUB }), undefined);
    assert.equal(hubUrlForServer({ ARCO_HUB_URL: HUB }), undefined);
    assert.equal(hubUrlForServer({ ARCO_HUB_URL: HUB, ARCO_ALLOW_TEMP_HOME: '1' }), HUB);
    assert.equal(hubUrlForServer({ ARCO_HUB_URL: HUB, ARCO_HUB_ALLOW_TEMP_HOME: '1' }), HUB, 'the older override name still works');
    assert.equal(hubUrlForServer({}), undefined);
    const notes = logged.filter((line) => line.includes('[hub-link]') && line.includes('ARCO_ALLOW_TEMP_HOME=1'));
    assert.equal(notes.length, 1);
    assert.ok(!notes[0].includes(tmpdir()), 'the log line names no local path');
  } finally {
    console.log = original;
    if (saved === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = saved;
    f.cleanup();
  }
});

test('environmentNtfyAllowed holds back an inherited ARCO_NTFY_URL only for a temporary home, and logs once', () => {
  const f = fixture();
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logged.push(args.join(' ')); };
  try {
    _resetGuardNotesForTest();
    const NTFY = 'http://127.0.0.1:9/arco-topic';
    const tempHome = path.join(f.temp, 'home', '.arco');
    const normalHome = path.join(f.outside, '.arco');
    assert.equal(environmentNtfyAllowed({ ARCO_HOME: tempHome }, f.temp), true, 'nothing set, nothing held back');
    assert.equal(environmentNtfyAllowed({ ARCO_HOME: tempHome, ARCO_NTFY_URL: NTFY }, f.temp), false);
    assert.equal(environmentNtfyAllowed({ ARCO_HOME: tempHome, ARCO_NTFY_URL: NTFY }, f.temp), false);
    assert.equal(environmentNtfyAllowed({ ARCO_HOME: tempHome, ARCO_NTFY_URL: NTFY, ARCO_ALLOW_TEMP_HOME: '1' }, f.temp), true);
    assert.equal(environmentNtfyAllowed({ ARCO_HOME: tempHome, ARCO_NTFY_URL: NTFY, ARCO_HUB_ALLOW_TEMP_HOME: '1' }, f.temp), true);
    assert.equal(environmentNtfyAllowed({ ARCO_HOME: tempHome, ARCO_NTFY_URL: NTFY, ARCO_ALLOW_TEMP_HOME: '0' }, f.temp), false);
    assert.equal(environmentNtfyAllowed({ ARCO_HOME: normalHome, ARCO_NTFY_URL: NTFY }, f.temp), true, 'a normal home is unchanged');
    const linked = path.join(f.root, 'linked-tmp');
    let linkMade = true;
    try { symlinkSync(f.temp, linked, process.platform === 'win32' ? 'junction' : 'dir'); } catch { linkMade = false; }
    if (linkMade) assert.equal(environmentNtfyAllowed({ ARCO_HOME: path.join(linked, 'home'), ARCO_NTFY_URL: NTFY }, f.temp), false, 'a symlinked path to the temporary folder counts');
    const notes = logged.filter((line) => line.includes('[ntfy]'));
    assert.equal(notes.length, 1);
    assert.ok(notes[0].includes('ARCO_ALLOW_TEMP_HOME=1'));
    assert.ok(!notes[0].includes(f.root), 'the log line names no local path');
  } finally {
    console.log = original;
    f.cleanup();
  }
});

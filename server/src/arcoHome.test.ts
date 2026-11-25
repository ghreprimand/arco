import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { arcoHome } from './arcoHome.js';

test('tests refuse the default Arco home', () => {
  const previous = process.env.ARCO_HOME;
  delete process.env.ARCO_HOME;
  try { assert.throws(() => arcoHome(), /Refusing.*Arco home.*test/); } finally { if (previous !== undefined) process.env.ARCO_HOME = previous; }
});

test('ARCO_HOME relocates the Arco home and is resolved per call', () => {
  const previous = process.env.ARCO_HOME;
  try {
    process.env.ARCO_HOME = '  relative-home  ';
    assert.equal(arcoHome(), resolve('relative-home'));
    process.env.ARCO_HOME = '';
    assert.throws(() => arcoHome(), /Refusing.*Arco home.*test/);
  } finally { if (previous === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = previous; }
});

test('a missing moduleLoadList does not prevent ordinary home resolution', async () => {
  const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'arco-home-no-internals-')));
  try {
    const home = join(root, 'home');
    const state = join(root, 'state');
    const source = `import { arcoHome } from ${JSON.stringify(pathToFileURL(resolve('server/src/arcoHome.ts')).href)};
Object.defineProperty(process, 'moduleLoadList', { value: undefined });
console.log(arcoHome());`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ARCO_HOME: state,
        TMPDIR: root, TMP: root, TEMP: root },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), state);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A home behind a link (a symlinked home folder, the macOS /var alias, a
// Windows short name) made storage checks, which compare canonical paths,
// refuse Arco's own chat and Quick research folders with "conversation storage
// is unavailable".
test('an Arco home reached through a link resolves to its canonical folder', async () => {
  const { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'arco-home-link-')));
  const previous = process.env.ARCO_HOME;
  try {
    mkdirSync(join(root, 'real', 'state'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'link'), 'junction');
    process.env.ARCO_HOME = join(root, 'link', 'state');
    assert.equal(arcoHome(), join(root, 'real', 'state'));
    process.env.ARCO_HOME = join(root, 'link', 'not-created');
    assert.equal(arcoHome(), join(root, 'real', 'not-created'));
  } finally {
    if (previous === undefined) delete process.env.ARCO_HOME; else process.env.ARCO_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

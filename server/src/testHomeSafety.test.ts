import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Every child has a fake user home. No test probes the invoking user's files.
for (const runner of ['test', 'node', 'tsx'] as const) {
  for (const alias of [false, true]) {
    test(`catalog cannot overwrite the default home via ${runner}, symlink=${alias}`, () => {
      const root = mkdtempSync(join(tmpdir(), 'arco-home-guard-'));
      // tsx CLI opens a UNIX socket; nested runner TMPDIRs can exceed sun_path.
      const childTemp = runner === 'tsx'
        ? mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'arco-hg-')) : root;
      try {
        const home = join(root, 'home');
        const state = join(home, '.arco');
        mkdirSync(state, { recursive: true });
        const catalog = join(state, 'llamacpp.json');
        const sentinel = '{"models":[]}\n';
        writeFileSync(catalog, sentinel);
        const linked = join(root, 'linked-state');
        if (alias) symlinkSync(state, linked, process.platform === 'win32' ? 'junction' : 'dir');
        // Import the catalog BEFORE node:test to reproduce a cached module path.
        const source = `import { writeCatalog } from ${JSON.stringify(pathToFileURL(resolve('server/src/llamacppCatalog.ts')).href)};
import { test } from 'node:test';
import { createHash } from 'node:crypto';
test('copied catalog test', async () => { await writeCatalog({ models: [{ alias: 'synthetic', ggufPath: '/fixture/synthetic.gguf' }] }, createHash('sha256').update(${JSON.stringify(sentinel)}).digest('hex')); });`;
        const file = join(root, runner === 'test' ? 'copied.test.mjs' : 'copied.mjs');
        writeFileSync(file, source);
        const args = runner === 'tsx' ? [resolve('node_modules/tsx/dist/cli.mjs'), file]
          : ['--import', 'tsx', ...(runner === 'test' ? ['--test'] : []), file];
        const child = spawnSync(process.execPath, args, {
          env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ARCO_HOME: alias ? linked : state,
            TMPDIR: childTemp, TMP: childTemp, TEMP: childTemp, ARCO_UPDATE_CHECK: '0' },
          encoding: 'utf8', timeout: 30_000,
        });
        assert.equal(readFileSync(catalog, 'utf8'), sentinel, child.stdout + child.stderr);
        assert.notEqual(child.status, 0);
        assert.match(child.stdout + child.stderr, /Refusing.*Arco home.*test/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
        if (childTemp !== root) rmSync(childTemp, { recursive: true, force: true });
        assert.equal(existsSync(childTemp), false, 'the child temporary folder is removed');
      }
    });
  }
}

test('default resolution is refused in tests but NODE_ENV alone preserves production behavior', () => {
  const root = mkdtempSync(join(tmpdir(), 'arco-home-default-'));
  try {
    const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, TMPDIR: root,
      ARCO_UPDATE_CHECK: '0', NODE_ENV: 'test' };
    const url = JSON.stringify(pathToFileURL(resolve('server/src/arcoHome.ts')).href);
    const run = (source: string) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      env, encoding: 'utf8', timeout: 30_000,
    });
    const production = run(`import { arcoHome } from ${url}; console.log(arcoHome());`);
    assert.equal(production.status, 0, production.stderr);
    assert.equal(production.stdout.trim(), join(root, '.arco'));
    const testing = run(`import 'node:test'; import { arcoHome } from ${url}; arcoHome();`);
    assert.notEqual(testing.status, 0);
    assert.match(testing.stderr, /Refusing.*Arco home.*test/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('late test imports protect cached settings, projects, trust and profile writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'arco-home-cached-'));
  try {
    const home = join(root, 'home');
    const state = join(home, '.arco');
    mkdirSync(state, { recursive: true });
    const files = ['settings.json', 'projects.json', 'trust.json', 'strata-profiles.json'];
    for (const file of files) writeFileSync(join(state, file), 'unchanged');
    const atomic = JSON.stringify(pathToFileURL(resolve('server/src/atomicFile.ts')).href);
    const resolver = JSON.stringify(pathToFileURL(resolve('server/src/arcoHome.ts')).href);
    const file = join(root, 'copied.mjs');
    writeFileSync(file, `import { arcoHome } from ${resolver};
import { atomicWriteFile, atomicWriteFileSync } from ${atomic};
const cached = arcoHome();
process.env.HOME = ${JSON.stringify(join(root, 'later-home'))};
process.env.USERPROFILE = process.env.HOME;
process.env.ARCO_HOME = ${JSON.stringify(join(root, 'later-state'))};
await import('node:test');
const { default: assert } = await import('node:assert/strict');
for (const name of ${JSON.stringify(files)}) {
  await assert.rejects(atomicWriteFile(cached + '/' + name, 'overwritten'), /Refusing/);
  assert.throws(() => atomicWriteFileSync(cached + '/' + name, 'overwritten'), /Refusing/);
}`);
    const child = spawnSync(process.execPath, ['--import', 'tsx', file], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ARCO_HOME: state, TMPDIR: root },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    for (const name of files) assert.equal(readFileSync(join(state, name), 'utf8'), 'unchanged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

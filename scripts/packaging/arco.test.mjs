import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { supportedNodeVersion, repairedNativeDir, npmCliPath } from './native-repair.mjs';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const cli = fileURLToPath(new URL('./arco.mjs', import.meta.url));
test('npm lookup finds a runnable CLI in Node, global-prefix and command layouts', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-npm-lookup-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (path) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'console.log("npm fixture");'); return path; };
  const options = { argv0: '', argv: [], packageRoot: null };
  const check = (expected, env, node, extra = {}) => {
    const found = npmCliPath(env, node, { ...options, ...extra });
    assert.equal(found, expected);
    const result = spawnSync(process.execPath, [found], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'npm fixture');
  };
  if (process.platform !== 'win32') {
    const prefix = join(root, 'homebrew');
    const node = file(join(prefix, 'Cellar', 'node', '26.10.0_1', 'bin', 'node'));
    const npm = file(join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    mkdirSync(join(prefix, 'bin'));
    symlinkSync(node, join(prefix, 'bin', 'node'));
    symlinkSync(npm, join(prefix, 'bin', 'npm'));
    check(npm, { PATH: join(root, 'short-path') }, node);
    const pathNpm = file(join(root, 'path-target', 'npm-cli.js'));
    const bin = join(root, 'path-bin'); mkdirSync(bin);
    symlinkSync(pathNpm, join(bin, 'npm'));
    check(pathNpm, { PATH: bin }, join(root, 'other', 'node'));
  }
  const prefix = join(root, 'custom-prefix');
  const npm = file(join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  check(npm, {}, join(root, 'separate-node', 'node'), { packageRoot: join(prefix, 'lib', 'node_modules', 'arco-workbench') });
  const windowsNpm = file(join(root, 'windows', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  check(windowsNpm, {}, join(root, 'windows', 'node.exe'));
  const managedNpm = file(join(root, 'managed-node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  check(managedNpm, {}, join(root, 'managed-node', 'bin', 'node'));
  check(managedNpm, {}, join(root, 'elsewhere', 'node'), { argv0: join(root, 'managed-node', 'bin', 'node') });
  check(managedNpm, { npm_execpath: managedNpm }, join(root, 'elsewhere', 'node'));
  assert.throws(() => npmCliPath({ PATH: '' }, join(root, 'missing', 'node'), options), /Cannot locate npm-cli\.js.*Node\.js.*global package directory.*PATH/);
});

test('unknown update options are refused before any update starts', () => {
  const result = spawnSync(process.execPath, [cli, 'update', '--ref', 'v1.0.0'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /arco update takes no arguments/);
});

test('native package supports the tested Node majors and uses a Node-API repair path', () => {
  for (const version of ['24.0.0', '24.22.2', '26.0.0', '26.13.0']) assert.equal(supportedNodeVersion(version), true);
  for (const version of ['22.0.0', '25.0.0', '27.0.0', 'invalid']) assert.equal(supportedNodeVersion(version), false);
  assert.ok(repairedNativeDir({ ARCO_HOME: join('fixture', 'home') }).endsWith(join('native', `${process.platform}-${process.arch}`)));
});

test('failed native repair reports the decisive build step and preserves installed parts', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arco-native-failure-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const npm = join(home, 'npm-fixture.cjs');
  const env = { HOME: home, USERPROFILE: home, ARCO_HOME: join(home, 'state'), PATH: home, npm_execpath: npm };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  const installed = repairedNativeDir(env);
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'existing-part'), 'installed native fixture');
  for (const [step, diagnosis] of [
    ['link', 'ld: unknown architecture arm64e.x1-macos'],
    ['compile', 'binding.cc:7: fatal error: fixture-header.h: No such file or directory'],
  ]) {
    writeFileSync(npm, `console.log('Building native fixture'); console.error(${JSON.stringify('npm error ' + diagnosis)}); console.error('npm error clang: error: linker command failed with exit code 1'); console.error('npm error gyp ERR! build error'); process.exitCode = 1;`);
    const run = `import { repairNative } from ${JSON.stringify(new URL('./native-repair.mjs', import.meta.url).href)};
      try { await repairNative({ arcoNativeDependencies: { 'node-pty': '1.0.0', 'better-sqlite3': '1.0.0' } }); }
      catch (error) { console.error(error.message); process.exitCode = 1; }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', run], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Building native fixture/, result.stderr);
    assert.ok(result.stderr.includes(`Native ${step} failed: ${diagnosis}.`), result.stderr);
    assert.equal((result.stderr.match(/Native (?:link|compile) failed:/g) || []).length, 1);
    assert.match(result.stderr, /build tools may be missing, out of date or broken/);
    assert.match(result.stderr, /Installed native parts were left unchanged and keep working/);
    assert.match(result.stderr, /Repair is only needed when Arco reports that a native part will not load/);
    assert.doesNotMatch(result.stdout, /Native modules repaired/);
    assert.equal(readFileSync(join(installed, 'existing-part'), 'utf8'), 'installed native fixture');
    assert.deepEqual(readdirSync(dirname(installed)), [process.platform + '-' + process.arch]);
  }
});

test('setup and doctor explain an unsupported Node major', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arco-node-version-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, USERPROFILE: home, ARCO_HOME: join(home, '.arco'), ARCO_PORT: '0', PATH: home };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  for (const command of ['setup', 'doctor']) {
    const source = `Object.defineProperty(process.versions, 'node', { value: '22.0.0' }); process.argv = ['node', ${JSON.stringify(cli)}, ${JSON.stringify(command)}]; await import(${JSON.stringify(new URL('./arco.mjs', import.meta.url).href)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env, timeout: 10000 });
    if (command === 'setup') {
      const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
      assert.equal(result.stdout.split(/\r?\n/)[0], `Arco v${manifest.version}`);
    }
    assert.notEqual(result.status, 0);
    assert.match((result.stdout || '') + (result.stderr || ''), /(?:Unsupported Node\.js|unsupported).*Node\.js 24 or 26/i);
  }
});

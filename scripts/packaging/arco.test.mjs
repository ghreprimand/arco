import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { supportedNodeVersion, repairedNativeDir } from './native-repair.mjs';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const cli = fileURLToPath(new URL('./arco.mjs', import.meta.url));
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

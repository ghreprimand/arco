import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const audit = fileURLToPath(new URL('../public-audit.mjs', import.meta.url));
const root = dirname(dirname(audit));
test('package audit rejects test artifacts and secret patterns', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-package-audit-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = () => spawnSync(process.execPath, [audit, '--package', dir], { cwd: root, encoding: 'utf8' });
  writeFileSync(join(dir, 'package.json'), '{}'); assert.equal(run().status, 0);
  mkdirSync(join(dir, 'tests')); writeFileSync(join(dir, 'tests', 'sample.js'), 'fixture');
  assert.match(run().stderr, /package-test-or-devlog/);
  rmSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'data.txt'), 'api_key="' + 'A'.repeat(40) + '"');
  assert.match(run().stderr, /credential-assignment/);
});

test('package audit accepts only reviewed client minifier tokens across bundle changes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-package-bundle-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const assets = join(dir, 'client', 'dist', 'assets'); mkdirSync(assets, { recursive: true });
  const bundle = join(assets, 'index-fixture.js');
  const tokens = ['oo.yq', 'mooqr1g3d1g3dooqr1g3f1g3fo.yq'].map((suffix) => ['5', suffix].join('@'));
  const run = () => spawnSync(process.execPath, [audit, '--package', dir], { cwd: root, encoding: 'utf8' });
  for (const extra of ['first build', 'changed client content']) {
    writeFileSync(bundle, `${tokens.join(' ')} ${extra}`);
    assert.equal(run().status, 0, 'reviewed tokens remain valid when the bundle changes');
  }
  writeFileSync(bundle, `${tokens.join(' ')} ${'private'}@${'mail.com'}`);
  assert.match(run().stderr, /unapproved-email-address/, 'other addresses remain blocked in client bundles');
  rmSync(bundle); writeFileSync(join(dir, 'other.js'), tokens[0]);
  assert.match(run().stderr, /unapproved-email-address/, 'reviewed tokens remain blocked outside the client bundle');
  rmSync(join(dir, 'other.js'));
  const native = join(dir, 'native', 'win32-x64-abi137'); mkdirSync(native, { recursive: true });
  writeFileSync(join(native, 'better_sqlite3.node'), ['t4', '8kgu.hc'].join('@'));
  assert.match(run().stderr, /unapproved-email-address/, 'the SQLite token still requires the reviewed binary hash');
  const napi = join(dir, 'native', 'win32-x64'); mkdirSync(napi, { recursive: true });
  writeFileSync(join(napi, 'better_sqlite3.node'), ['t4', '8kgu.hc'].join('@'));
  assert.match(run().stderr, /unapproved-email-address/, 'the Node-API artifact also requires its exact reviewed hash');
});

test('package exceptions require the exact vendor path and token and keep other IPs visible', t => {
  const dir=mkdtempSync(join(tmpdir(),'arco-vendor-audit-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const run=()=>spawnSync(process.execPath,[audit,'--package',dir],{cwd:root,encoding:'utf8'});
  const xlsx=join(dir,'node_modules/xlsx');mkdirSync(xlsx,{recursive:true});
  const comment='// '+[10,4,6,2].join('.')+' <draw:object>';
  for(const file of ['xlsx.js','xlsx.mjs']) {
    const path=join(xlsx,file);writeFileSync(path,"case 'object': break; "+comment);assert.equal(run().status,0);
    writeFileSync(path,comment+'\nconst address="'+[10,20,30,40].join('.')+'";');assert.match(run().stderr,/private-network-example/);
    writeFileSync(path,comment.replace('object','other'));assert.match(run().stderr,/private-network-example/);
    rmSync(path);
  }
  writeFileSync(join(xlsx,'other.js'),comment);assert.match(run().stderr,/private-network-example/);rmSync(join(xlsx,'other.js'));
  const assets=join(dir,'client/dist/assets');mkdirSync(assets,{recursive:true});
  const patternFile=join(dir,'patterns');writeFileSync(patternFile,['13','070'].join(''));
  const env={...process.env,ARCO_PRIVATE_PATTERNS_FILE:patternFile};
  // Keep the private-pattern fixture outside the scanned package.
  const patterns=mkdtempSync(join(tmpdir(),'arco-audit-patterns-'));t.after(()=>rmSync(patterns,{recursive:true,force:true}));
  env.ARCO_PRIVATE_PATTERNS_FILE=join(patterns,'patterns');writeFileSync(env.ARCO_PRIVATE_PATTERNS_FILE,readFileSync(patternFile));rmSync(patternFile);
  const shader=join(assets,'ThemedBackgroundShaderImpl-Cw4_ZBZ9.js');
  const runShader=()=>spawnSync(process.execPath,[audit,'--package',dir],{cwd:root,env,encoding:'utf8'});
  writeFileSync(shader,'const value='+['13','070'].join('')+';');assert.equal(runShader().status,0);
  writeFileSync(shader,'const value='+['13','070','1'].join('')+';');assert.match(runShader().stderr,/local-private-pattern/);
  writeFileSync(shader,'const value='+['13','070'].join('')+'; const ip="'+[10,20,30,40].join('.')+'";');assert.match(runShader().stderr,/private-network-example/);
  rmSync(shader);writeFileSync(join(assets,'other.js'),['13','070'].join(''));assert.match(runShader().stderr,/local-private-pattern/);
});

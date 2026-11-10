import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeDependencySpec } from './runtime-dependencies.mjs';
test('packed runtime uses a bundled archive dependency without an install-time URL', () => {
  const source = 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz';
  const lock = { packages: { 'node_modules/xlsx': { version: '0.20.3', resolved: source }, 'node_modules/ws': { version: '8.21.0' } } };
  assert.equal(runtimeDependencySpec('xlsx', source, lock), '0.20.3');
  assert.equal(runtimeDependencySpec('ws', '^8.18.0', lock), '8.21.0');
  assert.throws(() => runtimeDependencySpec('missing', '*', lock), /Missing locked/);
});

import { archiveRuntimeDependencies } from './runtime-dependencies.mjs';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
test('archive dependencies install from the packed bundle with an empty offline cache', t => {
  const root=mkdtempSync(join(tmpdir(),'arco-bundle-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dir=dirname(process.execPath);
  const candidates=[process.env.npm_execpath,join(dir,'node_modules/npm/bin/npm-cli.js'),join(dir,'../lib/node_modules/npm/bin/npm-cli.js')];
  try{candidates.push(realpathSync(join(dir,'npm')));}catch{}
  const npm=candidates.find(p=>p&&existsSync(p));assert.ok(npm,'npm CLI is available for package tests');
  const source='https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz';
  const packageDir=join(root,'package');mkdirSync(join(packageDir,'node_modules/xlsx'),{recursive:true});
  writeFileSync(join(packageDir,'package.json'),JSON.stringify({name:'arco-bundle-fixture',version:'1.0.0',dependencies:{xlsx:runtimeDependencySpec('xlsx',source,{packages:{'node_modules/xlsx':{version:'0.20.3'}}})},bundleDependencies:archiveRuntimeDependencies({xlsx:source})}));
  writeFileSync(join(packageDir,'node_modules/xlsx/package.json'),JSON.stringify({name:'xlsx',version:'0.20.3',main:'index.js'}));writeFileSync(join(packageDir,'node_modules/xlsx/index.js'),'module.exports = "bundled fixture";');
  const env={...process.env,npm_config_userconfig:join(root,'npmrc'),npm_config_globalconfig:join(root,'global-npmrc'),npm_config_cache:join(root,'cache')};
  const run=args=>spawnSync(process.execPath,[npm,...args],{cwd:packageDir,env,encoding:'utf8',timeout:30000});
  const pack=run(['pack','--ignore-scripts','--json']);assert.equal(pack.status,0,pack.stderr);
  const archive=join(packageDir,JSON.parse(pack.stdout)[0].filename);
  const install=run(['install','--prefix',join(root,'installed'),'--offline','--ignore-scripts','--no-audit','--no-fund','--registry','https://registry.invalid',archive]);assert.equal(install.status,0,install.stderr);
  assert.match(readFileSync(join(root,'installed/node_modules/arco-bundle-fixture/node_modules/xlsx/index.js'),'utf8'),/bundled fixture/);
});

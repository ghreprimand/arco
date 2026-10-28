import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCodexQuota } from './codexUsageRpc.js';

// The fake CLI speaks the same NDJSON protocol without using any credentials.
test('quota RPC reads multiple windows and rejects unsupported authentication and methods', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-quota-test-'));
  const bin = join(root, 'bin'); await mkdir(bin);
  const cli = `#!/usr/bin/env node
const readline = require('node:readline');
const path = require('node:path');
const mode = process.env.ARCO_TEST_QUOTA_MODE;
if (mode === 'hang') require('node:fs').writeFileSync(process.env.ARCO_TEST_PID_FILE, String(process.pid));
readline.createInterface({input:process.stdin}).on('line', line => {
 const req=JSON.parse(line); if (!req.id) return;
 if (mode === 'hang') return;
 let result={};
 if(req.method==='account/read') result={account: mode==='signedout'?null:mode==='key'?{type:'apiKey'}:{type:'chatgpt',email:path.basename(process.env.CODEX_HOME)+'@example.invalid',planType:'plus'}};
 if(req.method==='account/rateLimits/read') {
  if(mode==='rpcerror') {process.stdout.write(JSON.stringify({id:req.id,error:{code:500,message:'fixture failure'}})+'\\n');return;}
  if(mode==='old') {process.stdout.write(JSON.stringify({id:req.id,error:{code:-32601,message:'unsupported'}})+'\\n');return;}
  const bucket=(id,used)=>({limitId:id,limitName:null,primary:{usedPercent:used,windowDurationMins:300,resetsAt:1730947200},secondary:{usedPercent:50,windowDurationMins:10080,resetsAt:null}});
  result={rateLimits:bucket('codex',12),rateLimitsByLimitId:mode==='single'?null:{codex:bucket('codex',12),other:bucket('other',22)}};
 }
 process.stdout.write(JSON.stringify({id:req.id,result})+'\\n');
 if(req.method==='account/rateLimits/read' && mode==='notify') setTimeout(() => process.stdout.write(JSON.stringify({method:'account/rateLimits/updated',params:{rateLimits:{limitId:'codex',limitName:null,primary:{usedPercent:80,windowDurationMins:300,resetsAt:null},secondary:null}}})+'\\n'), 5);
});`;
  await writeFile(join(bin, 'codex'), cli, { mode: 0o755 });
  const oldPath=process.env.PATH, oldMode=process.env.ARCO_TEST_QUOTA_MODE;
  process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${oldPath}`;
  try {
    const {usage}=await readCodexQuota(join(root,'home'));
    assert.equal(usage.source, 'appserver'); assert.equal(usage.rows?.length, 4);
    assert.match(usage.rows![0].value, /12% used.*2024-11-07/);
    assert.match(usage.rows![2].label, /other/);
    process.env.ARCO_TEST_QUOTA_MODE = 'single';
    const single = await readCodexQuota(join(root,'home')); assert.equal(single.usage.rows?.length, 2);
    process.env.ARCO_TEST_QUOTA_MODE = 'notify';
    const notified = await readCodexQuota(join(root,'home')); assert.match(notified.usage.rows![0].value, /80% used/);
    process.env.ARCO_TEST_QUOTA_MODE = '';
    const arcoHome = join(root, 'arco'); await mkdir(arcoHome);
    await mkdir(join(root, 'a')); await writeFile(join(root, 'a', 'auth.json'), '{}');
    await writeFile(join(arcoHome, 'settings.json'), JSON.stringify({providerAccounts:{codex:[{id:'a',label:'A',codexHome:join(root,'a')},{id:'b',label:'B',codexHome:join(root,'b')}]}}));
    process.env.ARCO_HOME = arcoHome;
    process.env.ARCO_CAMOUFOX_PYTHON = join(root, 'missing-python');
    const { getCodexUsage } = await import('./codexUsage.js');
    const first = await getCodexUsage(true, 'a');
    assert.equal(first.accountRef, 'a'); assert.equal(first.available, true);
    process.env.ARCO_TEST_QUOTA_MODE = 'rpcerror';
    const stale = await getCodexUsage(true, 'a');
    assert.equal(stale.stale, true); assert.equal(stale.accountRef, 'a');
    await writeFile(join(root, 'a', 'auth.json'), '{\"fixture\":true}');
    const changed = await getCodexUsage(true, 'a'); assert.equal(changed.available, false);
    const other = await getCodexUsage(true, 'b');
    assert.equal(other.available, false); assert.equal(other.accountRef, 'b'); assert.equal(other.rows, undefined);
    const missing = await getCodexUsage(true, 'missing'); assert.equal(missing.available, false);
    const browser = await getCodexUsage(true, undefined, 'camoufox'); assert.equal(browser.available, false); assert.match(browser.error!, /Camoufox Python or its browser/);
    process.env.ARCO_TEST_PID_FILE = join(root, 'pid');
    process.env.ARCO_TEST_QUOTA_MODE = '';
    for (const [mode, expected] of [['signedout',/signed out/],['key',/API key/],['old',/does not support/],['hang',/timed out/]] as const) {
      process.env.ARCO_TEST_QUOTA_MODE = mode;
      await assert.rejects(readCodexQuota(join(root,'home'), mode==='hang' ? 500 : 5000), expected);
    }
    const pid = Number(await readFile(join(root, 'pid'), 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0));
    const emptyBin = join(root, 'empty'); await mkdir(emptyBin); process.env.PATH = emptyBin;
    await assert.rejects(readCodexQuota(join(root,'home'), 500), /Install or update/);
  } finally {
    delete process.env.ARCO_TEST_PID_FILE; delete process.env.ARCO_CAMOUFOX_PYTHON; delete process.env.ARCO_HOME;
    process.env.PATH=oldPath; if(oldMode===undefined) delete process.env.ARCO_TEST_QUOTA_MODE; else process.env.ARCO_TEST_QUOTA_MODE=oldMode;
    await rm(root,{recursive:true,force:true});
  }
});

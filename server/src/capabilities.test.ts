import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeLatestVersions, probeVersion } from './capabilities.js';

test('version probes terminate a stalled CLI and report it as broken', async () => {
  const result = await probeVersion(process.execPath, ['-e', 'setTimeout(() => console.log("1.2.3"), 250)'], 40);
  assert.equal(result, 'broken');
});

test('version probes bound stdout from a noisy CLI', async () => {
  const result = await probeVersion(process.execPath, ['-e', 'process.stdout.write("1.2.3" + "x".repeat(3 * 1024 * 1024))']);
  assert.equal(result, 'broken');
});

test('version probes keep successful and missing CLI results distinct', async () => {
  assert.equal(await probeVersion(process.execPath, ['-e', 'console.log("tool 1.2.3")']), '1.2.3');
  assert.equal(await probeVersion('arco-missing-probe-test-binary'), 'unknown');
});

test('llama.cpp update metadata selects the newest published numeric build and stays unknown on failure', async (t) => {
  const releases = [
    { tag_name: 'v1.0.0' }, { tag_name: 'b10549' }, { tag_name: 'b9037' },
    { tag_name: 'b12110' }, { tag_name: 'b99999', draft: true },
    { tag_name: 'b12111', prerelease: true }, { tag_name: 'b123not-a-build' },
  ];
  let response: unknown = releases;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    return new Response(JSON.stringify(url.includes('/ggml-org/llama.cpp/') ? response : {}));
  });
  const codex = Promise.resolve({ kind: 'unknown' as const });
  assert.equal((await probeLatestVersions(codex))?.llamacpp, 'b12111');
  response = [{ tag_name: 'v1.0.0' }];
  assert.equal((await probeLatestVersions(codex))?.llamacpp, undefined);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.equal((await probeLatestVersions(codex))?.llamacpp, undefined);
});


test('Cursor latest metadata reads only a bounded installer version and stays unknown on failure', async t => {
  let script = 'DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.11.13-eacade1/${OS}/${ARCH}/agent-cli-package.tar.gz"';
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(url === 'https://cursor.com/install' ? script : '{}'));
  const decision = Promise.resolve({ kind: 'unknown' as const });
  assert.equal((await probeLatestVersions(decision))?.cursor, '2026.11.13-eacade1');
  for (const invalid of ['no release version', script + '\nhttps://downloads.cursor.com/lab/2026.11.14-abcdef0/linux/x64/package', script.replace('2026.11.13', '2026.99.99'), 'x'.repeat(64 * 1024) + script]) {
    script = invalid;
    assert.equal((await probeLatestVersions(decision))?.cursor, undefined);
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.equal((await probeLatestVersions(decision))?.cursor, undefined);
});

test('Antigravity version metadata and updater use agy', async t => {
 const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs'); const { tmpdir }=await import('node:os');const { join }=await import('node:path');
 const { runCliUpdate }=await import('./capabilities.js');const dir=mkdtempSync(join(tmpdir(),'arco-agy-update-'));const bin=join(dir,'agy');writeFileSync(bin,'#!/bin/sh\necho 1.5.14\n');chmodSync(bin,0o755);const prior=process.env.PATH;process.env.PATH=`${dir}:${prior}`;t.after(()=>{process.env.PATH=prior;rmSync(dir,{recursive:true,force:true});});
 t.mock.method(globalThis,'fetch',async (url:string)=>new Response(JSON.stringify(url.includes('/google-antigravity/antigravity-cli/releases/latest')?{tag_name:'1.5.14'}:{})));
 const latest=await probeLatestVersions(Promise.resolve({kind:'unknown' as const}));assert.equal(latest?.['antigravity-cli'],'1.5.14');let command:string[]=[];
 const result=await runCliUpdate({cliVersion:'unknown',models:[],efforts:[],antigravityVersion:'1.5.14',latestVersions:latest} as any,'antigravity-cli',async(cmd,args)=>{command=[cmd,...args];return {exitCode:0,output:'current'};});
 assert.deepEqual(command,['agy','update']);assert.equal(result.currentVersion,'1.5.14');assert.equal(result.outcome,'current');
});


test('old Antigravity warns once when a named sub-agent call starts', async () => {
  const { AntigravitySubagentNotice } = await import('./providers/antigravity/index.js');
  const old = new AntigravitySubagentNotice('1.5.14');
  assert.equal(old.observe({ sessionUpdate: 'tool_call', name: 'other' }), undefined);
  assert.match(old.observe({ sessionUpdate: 'tool_call', name: 'invoke_subagent' })!, /Versions menu/);
  assert.equal(old.observe({ sessionUpdate: 'tool_call', name: 'invoke_subagent' }), undefined);
  assert.equal(new AntigravitySubagentNotice('1.5.15').observe({ sessionUpdate: 'tool_call', name: 'invoke_subagent' }), undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lspManager } from './client.js';

test('delayed document diagnostics reach each interested workflow, without stale duplicate sinks', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-lsp-routing-'));
  const manager = lspManager as any;
  const original = manager.ensure;
  const entry = { key: `${cwd}\0typescript`, cwd, languageId: 'typescript', ready: Promise.resolve(), openDocs: new Map(), nextId: 1, child: {} };
  manager.ensure = async () => entry;
  const received: any[] = [];
  const deliver = (file: string) => manager.onMessage(entry, {method:'textDocument/publishDiagnostics',params:{uri:pathToFileURL(join(cwd,file)).href,diagnostics:[]}}, -1, () => {});
  try {
    for (const file of ['a.ts','b.ts']) writeFileSync(join(cwd,file),'export {};');
    await manager.notifyWritten(join(cwd,'a.ts'),cwd,'flow-a',(m: any)=>received.push(m));
    await manager.notifyWritten(join(cwd,'b.ts'),cwd,'flow-b',(m: any)=>received.push(m));
    deliver('b.ts'); deliver('a.ts');
    assert.deepEqual(received.map(m=>[m.workflowId,m.file]),[['flow-b','b.ts'],['flow-a','a.ts']]);
    received.length=0;
    await manager.notifyWritten(join(cwd,'a.ts'),cwd,'flow-b',(m: any)=>received.push(m));
    await manager.notifyWritten(join(cwd,'a.ts'),cwd,'flow-a',(m: any)=>received.push({...m,refreshed:true}));
    deliver('a.ts');
    assert.deepEqual(received.map(m=>m.workflowId).sort(),['flow-a','flow-b']);
    assert.equal(received.find(m=>m.workflowId==='flow-a').refreshed,true);
    received.length=0; deliver('unopened.ts'); assert.equal(received.length,0);
    manager.dropServer(entry.key); deliver('a.ts'); assert.equal(received.length,0);
  } finally { manager.ensure=original; manager.shutdown(); rmSync(cwd,{recursive:true,force:true}); }
});

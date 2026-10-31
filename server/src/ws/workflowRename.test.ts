import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkflowState } from '../workflows/types.js';
import type { WebSocket } from 'ws';
const root = mkdtempSync(join(tmpdir(), 'arco-rename-'));
installIsolatedTestHome(root);
const { trackRecallFixture } = await import('../testSupport/recallFixture.test-support.js');
const closeRecall = trackRecallFixture();
const { workflows } = await import('../server/state.js');
const { handleRenameWorkflow } = await import('./workflowHandlers.js');
const { writeMeta, readMeta, workflowDir, workflowConfigFromMeta, arcoInternalSessionInfoForMeta } = await import('../workflowMeta.js');
after(async () => { await closeRecall(); rmSync(root, {recursive:true,force:true,maxRetries:10,retryDelay:100}); });
test('workflow rename persists before acknowledgement and refuses missing metadata', async () => {
 const id=randomUUID(), cwd=join(root,'project'), sent:Array<Record<string,unknown>>=[];
 const ws={readyState:1,send:(s:string)=>sent.push(JSON.parse(s))} as unknown as WebSocket;
 const wf={config:{name:'Original',workingDirectory:cwd},primary:{provider:'claude'},busy:true,observers:new Set([ws])} as unknown as WorkflowState;
 workflows.set(id,wf);
 try {
  await handleRenameWorkflow(ws,id,'Missing');
  assert.equal(wf.config.name,'Original');
  assert.ok(!sent.some(m=>m.type==='workflow_renamed'));
  assert.ok(sent.some(m=>m.type==='error'));
  await writeMeta(cwd,{workflowId:id,name:'Original',cwd,kind:'chat',createdAt:1,lastActiveAt:1,primaryProvider:'claude',primaryModel:'fixture',primaryEffort:'low',cliSessions:[],operator:'operator',lastEventSeq:null,lastTranscriptSeq:null,compactedAt:null} as never);
  sent.length=0;
  await handleRenameWorkflow(ws,id,'  New name  ');
  const reloaded = await readMeta(cwd,id);
  assert.equal(reloaded?.name,'New name');
  assert.equal(workflowConfigFromMeta(reloaded!,cwd).name,'New name');
  assert.equal(arcoInternalSessionInfoForMeta(reloaded!)?.arcoName,'New name');
  assert.equal(wf.config.name,'New name');
  assert.ok(sent.some(m=>m.type==='workflow_renamed' && m.name==='New name'));
  assert.equal(wf.busy,true);
  sent.length=0;
  await handleRenameWorkflow(ws,id,'x'.repeat(65),'long');
  assert.equal(wf.config.name,'New name');
  assert.ok(sent.some(m=>m.type==='workflow_rename_result' && m.requestId==='long' && m.error));
  await handleRenameWorkflow(ws,id,'   ','clear');
  assert.equal((await readMeta(cwd,id))?.name,'');
  assert.ok(sent.some(m=>m.type==='workflow_renamed' && m.name===null));
  assert.ok(sent.some(m=>m.type==='workflow_rename_result' && m.requestId==='clear' && !m.error));
  writeFileSync(join(workflowDir(cwd,id),'meta.json'),'{invalid');
  await handleRenameWorkflow(ws,id,'Bad','broken');
  assert.equal(wf.config.name,'');
  assert.ok(sent.some(m=>m.type==='workflow_rename_result' && m.requestId==='broken' && m.error));
  await handleRenameWorkflow(ws,randomUUID(),'Lost','missing');
  assert.ok(sent.some(m=>m.type==='workflow_rename_result' && m.requestId==='missing' && m.error));
 } finally { workflows.delete(id); }
});

test('incognito workspace rename stays in memory and acknowledges without metadata', async () => {
 const id=randomUUID(), cwd=join(root,'private-project'), sent:Array<Record<string,unknown>>=[];
 const ws={readyState:1,send:(s:string)=>sent.push(JSON.parse(s))} as unknown as WebSocket;
 const wf={config:{name:'Private',workingDirectory:cwd,incognito:true},primary:{provider:'claude'},busy:true,observers:new Set([ws])} as unknown as WorkflowState;
 workflows.set(id,wf);
 try {
  await handleRenameWorkflow(ws,id,'  Private revised  ','private-request');
  assert.equal(wf.config.name,'Private revised');
  assert.equal(wf.busy,true);
  assert.ok(sent.some(m=>m.type==='workflow_renamed' && m.name==='Private revised'));
  assert.ok(sent.some(m=>m.type==='workflow_rename_result' && m.requestId==='private-request' && !m.error));
  assert.equal(existsSync(workflowDir(cwd,id)),false);
 } finally { workflows.delete(id); }
});

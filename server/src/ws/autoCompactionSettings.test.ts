import { reportCleanupFailure } from '../testSupport/cleanupDiagnostics.test-support.js';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkflowState, Session } from '../workflows/types.js';
import type { WebSocket } from 'ws';

const temp = mkdtempSync(join(tmpdir(),'arco-policy-settings-'));
installIsolatedTestHome(temp);
const { trackRecallFixture } = await import('../testSupport/recallFixture.test-support.js');
const closeRecall = trackRecallFixture();
const { workflows } = await import('../server/state.js');
const { writeMeta, readMeta } = await import('../workflowMeta.js');
const { handleUpdatePrimaryConfig } = await import('./updatePrimaryConfig.js');

test('worker policy persists on/off/inherit and rejects invalid values without changing other settings', async () => {
  const cwd=join(temp,'project'), id=randomUUID();
  const sent: Array<Record<string,unknown>>=[];
  const ws={readyState:1,send:(payload:string)=>sent.push(JSON.parse(payload))} as unknown as WebSocket;
  const wf={config:{name:'fixture',workingDirectory:cwd,autoCompaction:undefined},primary:{provider:'claude',model:'sonnet',effort:'low'},observers:new Set([ws]),bootMaterialized:true} as unknown as WorkflowState;
  workflows.set(id,wf);
  try {
    await writeMeta(cwd,{workflowId:id,name:'fixture',cwd,kind:'chat',createdAt:1,lastActiveAt:1,primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',cliSessions:[],operator:'operator',lastEventSeq:null,lastTranscriptSeq:null,compactedAt:null} as never);
    const update=async (policy: unknown) => handleUpdatePrimaryConfig(ws,{} as Session,{type:'update_primary_config',workflowId:id,autoCompaction:policy} as never);
    await update({enabled:true,thresholdPercent:85});
    assert.deepEqual((await readMeta(cwd,id))?.autoCompaction,{enabled:true,thresholdPercent:85});
    const savedBeforeDuplicate = await readMeta(cwd,id);
    const notices = sent.filter(m => m.type === 'system_notice').length;
    await Promise.all([update({enabled:true,thresholdPercent:85}), update({enabled:true,thresholdPercent:85})]);
    assert.equal(sent.filter(m => m.type === 'system_notice').length, notices);
    assert.deepEqual(await readMeta(cwd,id), savedBeforeDuplicate);
    await handleUpdatePrimaryConfig(ws,{} as Session,{type:'update_primary_config',workflowId:id,autoCompaction:{enabled:true,thresholdPercent:85},model:'opus'} as never);
    assert.equal((await readMeta(cwd,id))?.primaryModel,'opus');
    assert.equal(sent.filter(m => m.type === 'system_notice').length, notices);
    await update({enabled:true,thresholdPercent:99});
    assert.deepEqual(wf.config.autoCompaction,{enabled:true,thresholdPercent:85});
    assert.ok(sent.some(m=>m.type==='error'));
    await update({enabled:false,thresholdPercent:65});
    assert.deepEqual((await readMeta(cwd,id))?.autoCompaction,{enabled:false,thresholdPercent:65});
    await update(null);
    assert.equal((await readMeta(cwd,id))?.autoCompaction,undefined);
    assert.equal(wf.config.autoCompaction,undefined);
    assert.equal((await readMeta(cwd,id))?.primaryModel,'opus');
    wf.config.workingDirectory = join(temp,'missing-project');
    await update({enabled:true,thresholdPercent:80});
    assert.equal(wf.config.autoCompaction,undefined);
    assert.ok(sent.some(m=>m.type==='error' && String(m.message).includes('Could not save')));
    assert.equal((await readMeta(cwd,id))?.autoCompaction,undefined);
  } finally {workflows.delete(id); await closeRecall(); try { rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100}); } catch (error) { try { reportCleanupFailure(temp); } catch { console.error('fixture diagnostics failed'); } throw error; }}
});

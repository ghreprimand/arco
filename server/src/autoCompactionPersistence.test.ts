import { reportCleanupFailure } from './testSupport/cleanupDiagnostics.test-support.js';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveAutoCompactionPolicy } from '@arco/shared';

const temp = mkdtempSync(join(tmpdir(), 'arco-policy-persistence-'));
installIsolatedTestHome(temp);
const { trackRecallFixture } = await import('./testSupport/recallFixture.test-support.js');
const closeRecall = trackRecallFixture();
const store = await import('./clusterStore.js');
const meta = await import('./workflowMeta.js');
const snapshots = await import('./clusterSnapshots.js');

test('cluster inheritance survives member changes and snapshot restore with worker overrides', async () => {
  const cwd = join(temp,'project'); const ids = [randomUUID(),randomUUID(),randomUUID()];
  let clusterId = '';
  try {
    for (const [i,id] of ids.entries()) await meta.writeMeta(cwd,{ workflowId:id,name:`fixture ${i}`,cwd,kind:'chat',createdAt:1,lastActiveAt:1,primaryProvider:'claude',primaryModel:'sonnet',primaryEffort:'low',cliSessions:[],operator:'operator',lastEventSeq:null,lastTranscriptSeq:null,compactedAt:null,...(i===1?{autoCompaction:{enabled:false,thresholdPercent:30}}:{}) } as import('./workflowMeta.js').WorkflowMeta);
    const cluster = await store.createCluster({cwd,memberWorkflowIds:ids.slice(0,2)}); clusterId=cluster.clusterId;
    assert.equal(store.getAutoCompaction(clusterId), undefined);
    assert.ok(await store.setAutoCompaction(clusterId,{enabled:true,thresholdPercent:30}));
    assert.equal((await store.setAutoCompactionWithChange(clusterId,{enabled:true,thresholdPercent:30}))?.changed,false);
    for (const thresholdPercent of [29, 30.5, 96]) assert.equal(await store.setAutoCompaction(clusterId,{enabled:true,thresholdPercent}),null);
    assert.ok(await store.setAutoCompaction(clusterId,{enabled:true,thresholdPercent:95}));
    assert.ok(await store.setAutoCompaction(clusterId,{enabled:true,thresholdPercent:30}));
    await store.addMember(clusterId,ids[2]);
    assert.deepEqual(store.getAutoCompaction(clusterId),{enabled:true,thresholdPercent:30});
    await store.removeMember(clusterId,ids[2]);
    const persisted = JSON.parse(readFileSync(store.clusterMetaPath(clusterId),'utf8'));
    assert.deepEqual(persisted.autoCompaction,{enabled:true,thresholdPercent:30});
    const fresh = spawnSync(process.execPath,['--conditions','development','--import','tsx','--input-type=module','-e',`const s=await import('./server/src/clusterStore.ts'); const c=await s.readCluster(process.argv[1]); process.stdout.write(JSON.stringify(c?.autoCompaction))`,clusterId],{cwd:process.cwd(),env:process.env,encoding:'utf8'});
    assert.equal(fresh.status,0,fresh.stderr);
    assert.deepEqual(JSON.parse(fresh.stdout),{enabled:true,thresholdPercent:30});
    assert.deepEqual(meta.workflowConfigFromMeta((await meta.readMeta(cwd,ids[1]))!,cwd).autoCompaction,{enabled:false,thresholdPercent:30});
    assert.equal(meta.workflowConfigFromMeta((await meta.readMeta(cwd,ids[0]))!,cwd).autoCompaction,undefined);
    assert.deepEqual(resolveAutoCompactionPolicy(meta.workflowConfigFromMeta((await meta.readMeta(cwd,ids[0]))!,cwd).autoCompaction, JSON.parse(fresh.stdout)),{enabled:true,thresholdPercent:30});
    const snap = await snapshots.saveSnapshot({clusterId,name:'fixture snapshot'});
    const restored = await snapshots.restoreSnapshot(snap.id,cwd);
    assert.deepEqual(restored.cluster.autoCompaction,{enabled:true,thresholdPercent:30});
    assert.deepEqual(restored.members.find((m)=>m.oldWorkflowId===ids[1])?.meta.autoCompaction,{enabled:false,thresholdPercent:30});
    assert.equal(restored.members.find((m)=>m.oldWorkflowId===ids[0])?.meta.autoCompaction,undefined);
    await store.deleteCluster(restored.cluster.clusterId);
    await store.setAutoCompaction(clusterId,null);
    assert.equal(store.getAutoCompaction(clusterId),undefined);
  } finally { if (clusterId) await store.deleteCluster(clusterId); await closeRecall(); try { rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100}); } catch (error) { try { reportCleanupFailure(temp); } catch { console.error('fixture diagnostics failed'); } throw error; } }
});

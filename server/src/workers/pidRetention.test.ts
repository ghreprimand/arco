import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'arco-pid-retention-'));
installIsolatedTestHome(root);
const workers = await import('./pidRegistry.js');
const terminals = await import('../terminal/ptyPidRegistry.js');
const { reapOrphanTerminals } = await import('../terminal/ptyManager.js');

test('unverified worker and terminal identities remain in their separate registries', () => {
  try {
    const one = [{pid:123,startTime:'recorded'}], two = [{pid:456,startTime:null}];
    workers.retainRegisteredProcs(one); terminals.retainRegisteredTerminalProcs(two);
    assert.deepEqual(workers.readRegisteredProcs(), one);
    assert.deepEqual(terminals.readRegisteredTerminalProcs(), two);
    const state = join(root, 'home', '.arco');
    assert.deepEqual(JSON.parse(readFileSync(join(state,'worker-pids.json'),'utf8')).procs, one);
    assert.deepEqual(JSON.parse(readFileSync(join(state,'terminal-pids.json'),'utf8')).procs, two);
    workers.registerWorkerPid(123, () => 'new-worker');
    terminals.registerTerminalPid(456, () => 'new-terminal');
    assert.deepEqual(workers.readRegisteredProcs(), [{pid:123,startTime:'new-worker'}]);
    assert.deepEqual(terminals.readRegisteredTerminalProcs(), [{pid:456,startTime:'new-terminal'}]);
    workers.registerWorkerPid(123, () => null);
    terminals.registerTerminalPid(456, () => null);
    assert.equal(workers.readRegisteredProcs()[0].startTime, 'new-worker');
    assert.equal(terminals.readRegisteredTerminalProcs()[0].startTime, 'new-terminal');
    const own = [{pid:process.pid,startTime:null}];
    terminals.retainRegisteredTerminalProcs(own);
    reapOrphanTerminals();
    assert.deepEqual(terminals.readRegisteredTerminalProcs(), own);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
    workers.retainRegisteredProcs([]); terminals.retainRegisteredTerminalProcs([]);
    assert.deepEqual(workers.readRegisteredProcs(), []);
    assert.deepEqual(terminals.readRegisteredTerminalProcs(), []);
  } finally { rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
});

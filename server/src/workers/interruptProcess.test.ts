import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { interruptProcess } from './interruptProcess.js';

test('CLI interruption waits for exit beyond synthetic cancellation settlement', async () => {
  const child = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>setTimeout(()=>process.exit(),100));console.log('ready');setInterval(()=>{},1000)`]);
  try {
    await once(child.stdout!, 'data');
    let cancelled = false;
    await interruptProcess(child, () => { cancelled = true; child.kill('SIGTERM'); });
    assert(cancelled);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'the child has exited, normally or by signal');
  } finally { child.kill('SIGKILL'); }
});

test('an exited or absent CLI still cancels retry state', async () => {
  let cancelled = 0;
  await interruptProcess(null, () => { cancelled++; });
  assert.equal(cancelled, 1);
});

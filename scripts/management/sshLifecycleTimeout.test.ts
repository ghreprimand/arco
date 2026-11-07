import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSshExec } from './hub.js';

test('B195: a connected command has a deadline and bounded captured output', async () => {
  const started = Date.now();
  const result = await defaultSshExec({ cmd: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(100000)); setInterval(()=>{},1000); setTimeout(()=>process.exit(0),1500)"] }, 200);
  assert.equal(result.exitCode, -1);
  assert.equal(result.timedOut, true);
  assert.ok(result.stdout.length <= 8000);
  assert.ok(result.stderr.length <= 8000);
  assert.ok(Date.now() - started < 3000);
});

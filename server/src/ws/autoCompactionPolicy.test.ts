import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
const fakeHome = mkdtempSync(join(tmpdir(), 'arco-policy-check-'));
installIsolatedTestHome(fakeHome);
const { claimBusy, releaseBusy, revokeBusy, initTurnEngine, maybeAutoCompactPolicy, freshAutoCompactionPercent } = await import('./turnEngine.js');
after(() => rmSync(fakeHome, { recursive:true, force:true }));
import type { WorkflowState, Session } from '../workflows/types.js';
import type { WebSocket } from 'ws';

const fakeSocket = {} as WebSocket;
const fakeSession = {} as Session;
function workflow(): WorkflowState {
  return { busy: false, config: { kind: 'workflow', autoCompaction: { enabled: true, thresholdPercent: 80 } }, primary: { provider: 'codex' }, primarySessionId: 'thread-a' } as unknown as WorkflowState;
}
const reading = { percent: 81, provider: 'codex', sessionId: 'thread-a' };

test('fresh eligible policy attempts once until a confirmed drop or new session', async () => {
  let attempts = 0;
  initTurnEngine({ previewAutoDetect: {} as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => {}, handleCompactWorkflow: async (_ws, _session, _msg, guard) => { attempts++; assert.ok(await guard!(() => 99)); } });
  const wf = workflow(); const token = claimBusy(wf); releaseBusy(wf, token);
  const run = (r: typeof reading | undefined) => maybeAutoCompactPolicy('fixture', wf, '', wf.config.autoCompaction!, r, token, fakeSocket, fakeSession);
  assert.equal(await run(undefined), false);
  assert.equal(await run({ ...reading, percent: NaN }), false);
  assert.equal(await run({ ...reading, percent: 79 }), false);
  assert.equal(await run(reading), true);
  assert.equal(await run(reading), false);
  assert.equal(attempts, 1);
  assert.equal(await run({ ...reading, percent: 60 }), false);
  assert.equal(await run(reading), true);
  assert.equal(attempts, 2);
});

test('stale or revoked claims and changed sessions cannot start a compact', async () => {
  let attempts = 0;
  initTurnEngine({ previewAutoDetect: {} as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => {}, handleCompactWorkflow: async () => { attempts++; } });
  const wf = workflow(); const token = claimBusy(wf); releaseBusy(wf, token);
  revokeBusy(wf);
  assert.equal(await maybeAutoCompactPolicy('fixture', wf, '', wf.config.autoCompaction!, reading, token, fakeSocket, fakeSession), true);
  assert.equal(attempts, 0);
});

test('account/session change during preflight refuses mutation and consumes the attempt', async () => {
  let accepted = 0;
  const wf = workflow();
  initTurnEngine({ previewAutoDetect: {} as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => {}, handleCompactWorkflow: async (_ws, _session, _msg, guard) => {
    wf.primarySessionId = 'thread-b';
    if (await guard!(() => { accepted++; return 1; })) assert.fail('stale session was accepted');
  } });
  const token = claimBusy(wf); releaseBusy(wf, token);
  assert.equal(await maybeAutoCompactPolicy('fixture',wf,'',wf.config.autoCompaction!,reading,token,fakeSocket,fakeSession),true);
  assert.equal(accepted,0);
});

test('an explicit disabled policy or unknown session never calls the compact handler', async () => {
  let attempts = 0;
  initTurnEngine({ previewAutoDetect: {} as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => {}, handleCompactWorkflow: async () => { attempts++; } });
  const wf = workflow(); const token=claimBusy(wf); releaseBusy(wf,token);
  assert.equal(await maybeAutoCompactPolicy('fixture',wf,'',{enabled:false,thresholdPercent:80},reading,token,fakeSocket,fakeSession),false);
  wf.primarySessionId = undefined;
  assert.equal(await maybeAutoCompactPolicy('fixture',wf,'',{enabled:true,thresholdPercent:80},{...reading,sessionId:undefined},token,fakeSocket,fakeSession),false);
  assert.equal(attempts,0);
});

test('only fresh supported turn measurements can trigger threshold policy', () => {
  assert.equal(freshAutoCompactionPercent('codex','appserver',{lastPromptTokens:800,modelContextWindow:1000}),undefined);
  assert.equal(freshAutoCompactionPercent('codex','appserver',{lastPromptTokens:800,modelContextWindow:2000,freshContextWindow:1000}),80);
  assert.equal(freshAutoCompactionPercent('claude','native',{lastPromptTokens:800,modelContextWindow:1000}),80);
  for (const numerator of [0,-1,NaN,Infinity]) assert.equal(freshAutoCompactionPercent('claude','native',{lastPromptTokens:numerator,modelContextWindow:1000}),undefined);
  for (const window of [0,-1,NaN,Infinity]) assert.equal(freshAutoCompactionPercent('codex','appserver',{lastPromptTokens:800,freshContextWindow:window}),undefined);
  assert.equal(freshAutoCompactionPercent('codex','exec',{lastPromptTokens:800,freshContextWindow:1000}),undefined);
  assert.equal(freshAutoCompactionPercent('claude','native',{error:'cancelled',lastPromptTokens:800,modelContextWindow:1000}),undefined);
});

test('unknown fold readings cannot trigger a history mutation', async () => {
  const { maybeAutoFold } = await import('./turnEngine.js');
  const wf = {busy:false,config:{kind:'workflow',claudeTransport:'native',autoFold:{enabled:true,foldAt:60}},primary:{provider:'claude'},lastContextBudgetPct:NaN} as unknown as WorkflowState;
  let attempted=false;
  assert.equal(await maybeAutoFold('fixture',wf,undefined,()=>{attempted=true;}),false);
  assert.equal(attempted,false);
});

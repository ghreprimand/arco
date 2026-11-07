import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexContextMetadata } from './codexContextWindow.js';
import { codexModelUsesCodeMode } from './codexCodeMode.js';
import { runWithFallbackChain } from './fallbackChain.js';
import { classifyError } from './errorClassifier.js';
import { partitionFencedTools, parseFencedToolCalls } from './ollamaFencedTools.js';

test('ambient Codex context and harness metadata follow CODEX_HOME, explicit home wins', () => {
  const home = mkdtempSync(join(tmpdir(), 'arco-codex-ambient-'));
  const explicit = mkdtempSync(join(tmpdir(), 'arco-codex-explicit-'));
  const previous = process.env.CODEX_HOME;
  const previousHome = process.env.HOME;
  process.env.HOME = explicit;
  try {
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({models:[{slug:'fixture-model', max_context_window:123456, tool_mode:'code_mode_only'}]}));
    writeFileSync(join(explicit, 'models_cache.json'), JSON.stringify({models:[{slug:'fixture-model', max_context_window:654321}]}));
    process.env.CODEX_HOME = home;
    assert.equal(readCodexContextMetadata('fixture-model')?.maxContextWindow, 123456);
    assert.equal(codexModelUsesCodeMode('fixture-model'), true);
    assert.equal(readCodexContextMetadata('fixture-model', explicit)?.maxContextWindow, 654321);
    assert.equal(codexModelUsesCodeMode('fixture-model', explicit), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    rmSync(home,{recursive:true,force:true}); rmSync(explicit,{recursive:true,force:true});
  }
});

test('defined HTTP error envelopes retain status through string and Error transport', () => {
  for (const provider of ['lmstudio', 'llamacpp'] as const) {
    for (const wrap of [(text:string) => text, (text:string) => new Error(text)]) {
      assert.equal(classifyError(provider,wrap('HTTP 429: Try again later')).reason, 'rate_limit');
      assert.equal(classifyError(provider,wrap('HTTP 413: Too large')).reason, 'context_overflow');
      assert.equal(classifyError(provider,wrap('HTTP 502: Unavailable')).reason, 'server_error');
      assert.equal(classifyError(provider,wrap('Example HTTP 429: in ordinary prose')).reason, 'unknown');
    }
  }
});

test('fenced cluster protocol retains the checkbox mutation', () => {
  const tools = ['cluster_plan_tick','cluster_plan_read','peer_send'].map(name => ({type:'function' as const,function:{name,description:name,parameters:{type:'object' as const,properties:{}}}}));
  const split=partitionFencedTools(tools);
  assert.deepEqual(split.action.map(t=>t.function.name),['cluster_plan_tick','peer_send']);
  assert.deepEqual(split.contextInjected.map(t=>t.function.name),['cluster_plan_read']);
});

test('ordinary code and configuration fences remain answers, explicit tool errors survive', () => {
  const known = (name:string)=>name==='Read';
  for (const body of ['```typescript\nconst answer = 42;\n```','```sh\necho hello\n```','```json\n{"name":"application","port":1234}\n```']) {
    assert.deepEqual(parseFencedToolCalls(body,known),[]);
  }
  assert.equal(parseFencedToolCalls('```tool\nnot json\n```',known)[0].argError !== undefined,true);
  assert.equal(parseFencedToolCalls('```json\n{"name":"Read","arguments":{"file_path":"fixture.txt"}}\n```',known)[0].name,'Read');
});

test('bounded chains advance on provider HTTP throttles but keep context and transient failures on the original leg', async () => {
  for (const label of ['LM Studio', 'llama-server', 'Strata', 'DeepSeek (Xolotl)']) {
    for (const status of [429, 413, 502]) {
      const calls: number[] = [];
      const result = await runWithFallbackChain({
        legs: [{provider:'lmstudio',model:'fixture-a'}, {provider:'llamacpp',model:'fixture-b'}],
        provider: leg => leg.provider,
        isError: (value: string | undefined) => value,
        spawnLeg: async (_leg, index) => { calls.push(index); return index === 0 ? `${label} HTTP ${status}: Try again later` : undefined; },
        onFellBack: () => {},
      });
      assert.deepEqual(calls,status === 429 ? [0,1] : [0]);
      assert.equal(result.fellBack,status === 429);
    }
  }
});

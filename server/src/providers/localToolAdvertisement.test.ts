import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const home = mkdtempSync(join(tmpdir(), 'arco-advertise-home-'));
installIsolatedTestHome(home);
test.after(() => rmSync(home, { recursive: true, force: true }));
const { LlamacppProvider } = await import('./llamacpp.js');
const { OpenAIHttpWorkerProcess } = await import('./lmstudio.js');

const response = () => new Response('data: '+JSON.stringify({choices:[{delta:{content:'ok'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}});

test('llama.cpp and LM Studio send only mailbox peer tools for BLIND members', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-advertise-'));
  const originalFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_url, init) => { body = JSON.parse(String(init?.body)); return response(); }) as typeof fetch;
  try {
    for (const mode of ['standard', 'blind'] as const) for (const provider of ['llamacpp', 'lmstudio'] as const) {
      const config: any = {cwd, model:'fixture', effort:'medium', interactionMode:'agent', clusterId:'cluster', workflowId:'workflow', clusterAccessMode:mode};
      const connection: any = {name:'lmstudio', label:'LM Studio', base:async()=> 'http://127.0.0.1:9', probe:async()=>({models:['fixture'],capabilities:{}})};
      const worker: any = provider === 'llamacpp' ? LlamacppProvider.create('fixture',config) : new OpenAIHttpWorkerProcess('fixture',config,connection);
      worker.on('error', () => {}); worker.abortController = new AbortController(); body = undefined;
      if (provider === 'llamacpp') await worker.runLoaded('hello',{alias:'fixture',capabilities:{tools:true}},{host:'127.0.0.1',port:9},Date.now());
      else await worker.run('hello');
      const names = body.tools.map((tool: any) => tool.function.name);
      assert.ok(names.includes('peer_send'), provider); assert.ok(names.includes('peer_read'), provider);
      for (const name of ['peer_list','cluster_plan_read','cluster_plan_write','cluster_plan_tick']) assert.equal(names.includes(name),mode === 'standard',`${provider} ${mode} ${name}`);
    }
  } finally { globalThis.fetch = originalFetch; rmSync(cwd,{recursive:true,force:true}); }
});

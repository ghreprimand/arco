import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const home = mkdtempSync(join(tmpdir(), 'arco-registry-home-'));
installIsolatedTestHome(home);
test.after(() => rmSync(home, { recursive: true, force: true }));
const { StrataProvider } = await import('./strata.js');
const { DeepSeekProvider } = await import('./deepseek.js');

test('Strata and DeepSeek advertise configured registry tools in agent requests', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-registry-advertise-'));
  const originalFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response('data: '+JSON.stringify({choices:[{delta:{content:'ok'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}); }) as typeof fetch;
  try {
    for (const [name, provider] of [['strata',StrataProvider],['deepseek',DeepSeekProvider]] as const) {
      const config: any = {cwd, model:'fixture', effort:'medium', interactionMode:'agent', workflowId:'workflow', mcpRegistryServers:[{key:'reg-fixture',command:process.execPath,args:[fileURLToPath(new URL('./fixtures/file-mcp.mjs',import.meta.url))],disabledTools:['disabled_picture']}]};
      const worker: any = provider.create('fixture',config);
      worker.connection = {name,label:name,chatWeb:true,base:async()=> 'http://127.0.0.1:9',probe:async()=>({models:['fixture'],capabilities:{}})};
      worker.on('error',()=>{}); worker.abortController = new AbortController(); body = undefined;
      try { await worker.run('hello'); } finally { worker.registry.close(); }
      const names = body.tools.map((tool: any) => tool.function.name);
      assert.ok(names.includes('mcp__reg-fixture__read_picture'), name);
      assert.ok(!names.includes('mcp__reg-fixture__disabled_picture'), name);
      assert.ok(names.includes('Read'), name);
    }
  } finally { globalThis.fetch = originalFetch; rmSync(cwd,{recursive:true,force:true}); }
});

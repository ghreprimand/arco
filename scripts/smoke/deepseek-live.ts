// Opt-in real GPU acceptance against an isolated Arco. Never stops a miner.
// First coordinate GPU use; require explicit opt-in AND an explicit WS target.
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, assert } from './lib.js';

async function main() {
  if (process.env.ARCO_DEEPSEEK_LIVE !== '1' || !process.env.ARCO_SMOKE_WS_URL) {
    throw Error('Coordinate GPU use first. Set ARCO_DEEPSEEK_LIVE=1 and ARCO_SMOKE_WS_URL for an isolated Arco; see docs/DEEPSEEK.md.');
  }
  const api = new URL(process.env.ARCO_SMOKE_WS_URL);
  api.protocol = api.protocol === 'wss:' ? 'https:' : 'http:'; api.pathname = '';
  const control = async (body: unknown) => {
    const res = await fetch(`${api.origin}/api/deepseek`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json() as any;
    if (!res.ok) throw Error(data.error || `DeepSeek HTTP ${res.status}`);
    return data;
  };
  const artifacts = process.env.DEEPSEEK_SMOKE_ARTIFACTS || mkdtempSync(join(tmpdir(), 'arco-deepseek-live-'));
  mkdirSync(artifacts, { recursive: true });
  const events: unknown[] = [], ids: string[] = [];
  let ownsServices = false;
  const secret = 'ARCO-READ-72941'; writeFileSync(join(artifacts, 'fact.txt'), `${secret}\n`);
  const c = await connect();
  const create = async (profile: string) => {
    c.send({ type: 'create_workflow', config: { kind: 'workflow', name: `DeepSeek ${profile} acceptance`,
      primaryProvider: 'deepseek', primaryModel: `deepseek-v4.1-flash-1017-${profile}`, primaryEffort: 'none',
      workingDirectory: artifacts, skipPermissions: true } });
    const id = String((await c.waitFor((m) => m.type === 'workflow_created', 10000)).workflowId); ids.push(id); return id;
  };
  const turn = async (workflowId: string, content: string, cancel = false, attachments?: string[]) => {
    c.send({ type: 'user_message', workflowId, content, attachments });
    let text = '', thinking = '', read = false, cancelled = false, completion: any;
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      if (cancel && !cancelled) {
        const status = await (await fetch('http://127.0.0.1:8150/v1/status', { signal: AbortSignal.timeout(3000) })).json() as any;
        if (status.activity?.in_flight) {
          c.send({ type: 'cancel', workflowId }); cancelled = true;
        }
      }
      let m;
      try { m = await c.waitFor((m) => m.workflowId === workflowId, cancel && !cancelled ? 250 : 60000, 'DeepSeek live turn'); }
      catch (err) { if (cancel && !cancelled) continue; console.log('Waiting for DeepSeek prefill/generation…'); if (Date.now() < deadline) continue; throw err; }
      events.push(m);
      if (m.type === 'primary_text') text += String(m.text ?? '');
      if (m.type === 'primary_thinking') thinking += String(m.text ?? '');
      if (m.type === 'primary_tool_use' && (m.name ?? m.tool) === 'Read' && m.status === 'completed') read = true;
      if (m.type === 'primary_complete') completion = m;
      if (!cancel && (m.type === 'primary_error' || m.type === 'error')) throw Error(JSON.stringify(m));
      if (m.type === 'primary_turn_ended') {
        if (cancel) assert(cancelled, 'cancelled a confirmed in-flight runtime request');
        else {
          assert(text.length > 0, 'assistant text streamed');
          assert(completion?.modelContextWindow === 262144, 'native configured context reached completion');
          assert(completion?.lastPromptTokens > 0, 'actual prompt tokens reached Arco');
        }
        return { text, thinking, read, completion };
      }
    }
    throw Error('Live turn exceeded ten minutes.');
  };
  try {
    const before = await (await fetch(`${api.origin}/api/deepseek`)).json() as any;
    assert(before.profiles.length === 2 && before.profiles.every((p: any) => !p.loaded && p.serviceState === 'inactive'), 'start only with both DeepSeek profiles stopped');
    ownsServices = true;
    for (const profile of ['exact', 'light']) {
      console.log(`Loading ${profile} through Arco; mining/resource guards remain active.`);
      await control({ action: 'load', profile });
      const id = await create(profile);
      const tools = await turn(id, 'Use the Read tool to read fact.txt in the working directory. Reply with the file contents and nothing else. Do not modify files or use other tools.');
      assert(tools.read && tools.text.includes(secret), `${profile}: real Read round trip`);
      if (process.env.ARCO_DEEPSEEK_VISION_IMAGE) {
        const image = await turn(id, 'Read the numeric code in the attached image. Reply with just that code. Do not use tools.', false, [process.env.ARCO_DEEPSEEK_VISION_IMAGE]);
        assert(image.text.includes('48263'), `${profile}: actual screenshot text reached the model through Arco`);
      }
      c.send({ type: 'update_primary_config', workflowId: id, effort: 'medium' });
      await c.waitFor((m) => m.workflowId === id && m.type === 'workflow_config_synced', 10000);
      const reasoning = await turn(id, 'What is 17 times 23? Think it through briefly and answer with the number.');
      assert(reasoning.thinking.length > 0 && reasoning.text.includes('391'), `${profile}: streamed reasoning and correct answer`);
      c.send({ type: 'update_primary_config', workflowId: id, effort: 'none' });
      await c.waitFor((m) => m.workflowId === id && m.type === 'workflow_config_synced', 10000);
      await turn(id, 'Count upward from 1 to 10000, writing every number on its own line. Continue until you reach 10000.', true);
      for (let i = 0; i < 100; i++) {
        const s = await (await fetch('http://127.0.0.1:8150/v1/status')).json() as any;
        if (!s.activity?.in_flight) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const idle = await (await fetch('http://127.0.0.1:8150/v1/status')).json() as any;
      assert(idle.activity?.in_flight === 0, `${profile}: cancellation released engine request`);
      console.log(`PASS ${profile}: Read, native context, reasoning, streaming, cancellation${process.env.ARCO_DEEPSEEK_VISION_IMAGE ? ", screenshot OCR" : ""}.`);
    }
    await control({ action: 'unload' });
    const after = await (await fetch(`${api.origin}/api/deepseek`)).json() as any;
    assert(after.live === null && after.profiles.every((p: any) => p.serviceState === 'inactive' && !p.loaded), 'both profiles stopped after unload');
    console.log('PASS: Exact → Light switch through Arco; both services stopped and endpoint gone. Inspect nvidia-smi/cgroup counters for resource evidence.');
  } finally {
    for (const workflowId of ids) c.send({ type: 'cancel', workflowId });
    // A failure can leave a recently cancelled request settling. Retry cleanup;
    // never bypass Arco's busy refusal or kill unrelated GPU processes.
    let unloaded = !ownsServices;
    for (let i = 0; ownsServices && i < 20; i++) {
      try { await control({ action: 'unload' }); unloaded = true; break; }
      catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    writeFileSync(join(artifacts, 'deepseek-live-events.json'), JSON.stringify(events, null, 2));
    for (const workflowId of ids) c.send({ type: 'remove_workflow', workflowId });
    await c.close(); console.log('Artifacts:', artifacts);
    if (!unloaded) throw Error('DeepSeek cleanup could not be confirmed; inspect managed services before resuming mining.');
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });

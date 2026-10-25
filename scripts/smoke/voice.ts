// Isolated source-server HTTP/WS acceptance; never connects to prod.
// Codex is a deterministic fixture. Optional real local ASR/TTS uses sample
// audio only; no microphone and no provider inference.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { connect, step, summary, type SmokeClient } from './lib.js';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'arco-voice-smoke-'));
  const bin = join(dir, 'bin'), home = join(dir, 'home'); mkdirSync(bin); mkdirSync(join(home, '.arco'), { recursive: true });
  const executable = join(bin, 'codex'); copyFileSync('scripts/smoke/fixtures/voice-codex.mjs', executable);
  writeFileSync(executable, '#!/usr/bin/env node\n' + readFileSync(executable, 'utf8')); chmodSync(executable, 0o755);
  const preload = join(dir, 'isolate.mjs');
  writeFileSync(preload, `import os from 'node:os';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';os.homedir=()=>${JSON.stringify(home)};const original=cp.spawn;cp.spawn=(command,args,options)=>original(command==='codex'?${JSON.stringify(executable)}:command,args,options);syncBuiltinESMExports();globalThis.fetch=async()=>new Response('{}',{status:503});\n`);
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = (reserve.address() as { port: number }).port; await new Promise<void>((r) => reserve.close(() => r()));
  const voiceHome = process.env.ARCO_VOICE_HOME || join(homedir(), '.arco', 'voice');
  const log = openSync(join(dir, 'server.log'), 'w');
  const child = spawn(process.execPath, ['--conditions', 'development', '--import', 'tsx', '--import', preload, 'server/src/index.ts'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ARCO_PORT: String(port), ARCO_WS_AUTH: 'off', ARCO_SERVE_CLIENT: '0', ARCO_VOICE_HOME: voiceHome }, stdio: ['ignore', log, log],
  });
  let c: SmokeClient | undefined;
  let session = '';
  const base = `http://127.0.0.1:${port}`;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`Server exited; see ${dir}/server.log`);
      try { if ((await fetch(base + '/api/voice/status')).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    c = await connect(`ws://127.0.0.1:${port}/ws`);
    let workflowId = '';
    await step('create a Native workflow without starting a provider turn', async () => {
      c!.send({ type: 'create_workflow', config: { name: 'Voice smoke fixture', workingDirectory: dir, primaryProvider: 'claude', primaryModel: 'claude-opus-4-7', claudeTransport: 'native', primaryEffort: 'normal', skipPermissions: true } });
      workflowId = String((await c!.waitFor((m) => m.type === 'workflow_created', 10000)).workflowId);
    });
    await step('voice needs explicit enable; session/audio requests are bounded', async () => {
      assert.equal((await post('/api/voice/session', { enabled: false })).status, 400);
      assert.equal((await post('/api/voice/interpret?session=missing', {})).status, 400);
      const status = await (await fetch(base + '/api/voice/status')).json() as any;
      assert.equal(status.model, 'gpt-6-luna'); assert.equal(status.effort, 'low');
      assert.equal(status.localSpeech, true, 'Run npm run voice:setup before this smoke.');
      session = (await post('/api/voice/session', { enabled: true })).body.sessionId; assert(session);
      const warmup = (await post(`/api/voice/warmup?session=${session}`, {})).body;
      assert.equal(warmup.ready, true); assert.equal(warmup.fastWake, true, 'Run voice:setup to install the streaming wake model.');
      const wake = await fetch(base + `/api/voice/wake?session=${session}&utterance=1`, { method: 'POST', body: Buffer.alloc(5120) });
      assert.equal(wake.status, 200); assert.equal((await wake.json() as any).detected, false);
      assert.equal((await fetch(base + `/api/voice/wake?session=${session}&utterance=0`, { method: 'POST', body: Buffer.alloc(100) })).status, 400);
      assert.equal((await fetch(base + `/api/voice/wake?session=${session}&utterance=2`, { method: 'POST', body: Buffer.alloc(16_002) })).status, 400);
      const invalid = await fetch(base + `/api/voice/audio?session=${session}`, { method: 'POST', body: Buffer.from([1]) }); assert.equal(invalid.status, 400);
    });
    await step('Codex interpreter is ephemeral, isolated, low effort; usage is returned live', async () => {
      const r = await post(`/api/voice/interpret?session=${session}`, { text: 'Bring up my reviewer', context: { currentId: workflowId, clusterId: null, targets: [{ id: workflowId, name: 'Reviewer', kind: 'workflow' }] } });
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.command.target, 'Reviewer');
      assert.deepEqual(r.body.usage, { inputTokens: 200, cachedInputTokens: 100, outputTokens: 20 });
    });
    await step('Computer voice-operator tool calls relay to the subscribed window and nowhere else', async () => {
      // VOICE_AGENT_PLAN.md — the arco-voice MCP child POSTs to /api/voice/tool
      // (loopback, cookie-exempt); the server forwards voice_tool_call to the
      // chat's observers and returns the window's voice_tool_result.
      const refused = await post('/api/voice/tool', { workflowId, tool: 'arco_status', args: {} });
      assert.equal(refused.status, 404, 'an ordinary workflow is not a voice operator');
      c!.send({ type: 'create_workflow', config: { kind: 'chat', name: 'Computer', workingDirectory: '', primaryProvider: 'codex', primaryModel: 'gpt-6-luna', primaryEffort: 'low', codexTransport: 'appserver', chatWebAccess: false, voiceOperator: true, skipPermissions: false } });
      const chatId = String((await c!.waitFor((m) => m.type === 'workflow_created' && m.workflowId !== workflowId, 10000)).workflowId);
      const inFlight = post('/api/voice/tool', { workflowId: chatId, tool: 'arco_select', args: { target: 'reviewer' } });
      const call = await c!.waitFor((m) => m.type === 'voice_tool_call', 5000);
      assert.equal(call.workflowId, chatId); assert.equal(call.tool, 'arco_select'); assert.deepEqual(call.args, { target: 'reviewer' });
      c!.send({ type: 'voice_tool_result', workflowId: chatId, requestId: call.requestId, ok: true, result: 'Reviewer selected.' });
      const answered = await inFlight;
      assert.equal(answered.status, 200); assert.deepEqual(answered.body, { ok: true, result: 'Reviewer selected.' });
      const bad = await post('/api/voice/tool', { workflowId: chatId, tool: 'arco_shell', args: {} });
      assert.deepEqual(bad.body, { ok: false, error: 'Unknown voice tool.' });
    });
    await step('local sample audio is recognized in memory and local speech output is a WAV', async () => {
      // The bundled sample is mono PCM16 at 16 kHz. Find its actual data
      // chunk rather than assuming every WAV has a 44-byte header.
      const wav = readFileSync(join(voiceHome, 'sherpa-onnx-moonshine-tiny-en-int8/test_wavs/0.wav'));
      let offset = 12, pcm: Buffer | undefined;
      while (offset + 8 <= wav.length) { const n = wav.readUInt32LE(offset + 4); if (wav.toString('ascii', offset, offset + 4) === 'data') { pcm = wav.subarray(offset + 8, offset + 8 + n); break; } offset += 8 + n + (n % 2); }
      assert(pcm);
      const response = await fetch(base + `/api/voice/audio?session=${session}`, { method: 'POST', body: pcm });
      assert.equal(response.status, 200);
      const recognized = await response.json() as any;
      assert.match(String(recognized.text), /yellow lamps/i); assert.equal(typeof recognized.phrases, 'string');
      const speech = await fetch(base + `/api/voice/speak?session=${session}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hands free is ready.' }) });
      assert.equal(speech.status, 200);
      // Edge neural voice (MP3) when reachable, Kokoro WAV otherwise (VOICE_AGENT_PLAN.md).
      const engine = speech.headers.get('x-voice-engine'); const audio = Buffer.from(await speech.arrayBuffer());
      assert(['edge', 'kokoro'].includes(String(engine)), `engine ${engine}`);
      if (engine === 'kokoro') assert.equal(audio.toString('ascii', 0, 4), 'RIFF'); else assert.equal(speech.headers.get('content-type'), 'audio/mpeg');
      assert(audio.length > 2000);
    });
    await step('disable closes the session; control text and audio are absent from workflow history', async () => {
      await fetch(base + `/api/voice/session?session=${session}`, { method: 'DELETE' });
      assert.equal((await post(`/api/voice/heartbeat?session=${session}`, {})).status, 400);
      assert.equal((await fetch(base + `/api/voice/wake?session=${session}&utterance=3`, { method: 'POST', body: Buffer.alloc(100) })).status, 400);
      const events = readFileSync(join(dir, '.arco/workflows', workflowId, 'events.jsonl'), 'utf8');
      assert(!events.includes('Bring up my reviewer')); assert(!events.includes('yellow lamps')); assert(!events.includes('Hands free is ready'));
      assert(!readFileSync(join(dir, 'server.log'), 'utf8').includes('Bring up my reviewer'));
      assert(!readdirSync(join(home, '.arco')).includes('voice-history'));
    });
  } finally {
    if (session) await fetch(base + `/api/voice/session?session=${session}`, { method: 'DELETE' }).catch(() => {});
    if (c) await c.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await stopped; clearTimeout(timer);
    }
    closeSync(log); console.log('Isolated artifacts:', dir);
  }
  summary('voice');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

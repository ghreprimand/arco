// Isolated source-server HTTP/WS acceptance; never connects to prod.
// Codex and speech use deterministic fixtures. No microphone or inference.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect, step, summary, voiceSmokeEnvironment, waitForVoiceSmokeServer, stopVoiceSmokeServer, type SmokeClient } from './lib.js';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'arco-voice-smoke-'));
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = (reserve.address() as { port: number }).port; await new Promise<void>((r) => reserve.close(() => r()));
  const env = voiceSmokeEnvironment(dir, port);
  const binaries = join(dir, 'bin');
  mkdirSync(binaries);
  env.PATH = binaries;
  const voiceHome = env.ARCO_VOICE_HOME;
  const python = join(voiceHome, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const model = 'sherpa-onnx-moonshine-tiny-en-int8';
  const wake = 'vosk-model-small-en-us-0.15';
  const markers = [
    ...['preprocess.onnx', 'encode.int8.onnx', 'uncached_decode.int8.onnx', 'cached_decode.int8.onnx', 'tokens.txt'].map(name => join(voiceHome, model, name)),
    ...['am/final.mdl', 'graph/HCLr.fst', 'graph/Gr.fst', 'conf/model.conf'].map(name => join(voiceHome, wake, name)),
    python,
  ];
  for (const file of markers) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  const speech = join(dir, 'speech.mjs');
  writeFileSync(speech, `import { createInterface } from 'node:readline';
const mode = process.argv[2];
console.log(JSON.stringify({ ready: true }));
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  if (mode === 'wake' && input.pcm) console.log(JSON.stringify({ detected: false }));
  else if (mode === 'asr' && input.pcm) console.log(JSON.stringify({ text: 'Sample audio', phrases: '' }));
  else if (mode === 'tts' && input.text) {
    const wav = Buffer.alloc(3244);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    console.log(JSON.stringify({ audio: wav.toString('base64') }));
  } else console.log(JSON.stringify({ error: 'No fixture for this request' }));
}
`);
  const codex = join(process.cwd(), 'scripts/smoke/fixtures/voice-codex.mjs');
  const preload = join(dir, 'isolate.mjs');
  writeFileSync(preload, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.spawn;
cp.spawn = (command, args, options) => {
  if (command === 'codex') return original(process.execPath, [${JSON.stringify(codex)}, ...args], options);
  if (command === ${JSON.stringify(python)}) return original(process.execPath, [${JSON.stringify(speech)}, args[3]], options);
  return original(command, args, options);
};
syncBuiltinESMExports();
globalThis.fetch = async () => new Response('{}', { status: 503 });
`);
  const logPath = join(dir, 'server.log');
  const log = openSync(logPath, 'w');
  const child = spawn(process.execPath, ['--conditions', 'development', '--import', 'tsx', '--import', preload, 'server/src/index.ts'], {
    env, stdio: ['ignore', log, log],
  });
  let c: SmokeClient | undefined;
  let session = '';
  const base = `http://127.0.0.1:${port}`;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    await waitForVoiceSmokeServer(child, base, logPath);
    c = await connect(`ws://127.0.0.1:${port}/ws`);
    let workflowId = '';
    await step('create a Native workflow without starting a provider turn', async () => {
      c!.send({ type: 'create_workflow', config: { name: 'Voice smoke fixture', workingDirectory: dir, primaryProvider: 'claude', primaryModel: 'claude-opus-4-7', claudeTransport: 'native', skipPermissions: true } });
      const created = await c!.waitFor(m => m.type === 'workflow_created' || m.type === 'error', 10000);
      assert.equal(created.type, 'workflow_created', String(created.message ?? ''));
      workflowId = String(created.workflowId);
    });
    await step('voice needs explicit enable; session/audio requests are bounded', async () => {
      assert.equal((await post('/api/voice/session', { enabled: false })).status, 400);
      assert.equal((await post('/api/voice/interpret?session=missing', {})).status, 400);
      const status = await (await fetch(base + '/api/voice/status')).json() as any;
      assert.equal(status.model, 'gpt-6-luna'); assert.equal(status.effort, 'low');
      assert.equal(status.localSpeech, true);
      assert.equal((await (await fetch(base + '/api/voice/setup')).json()).voiceHome, voiceHome);
      session = (await post('/api/voice/session', { enabled: true })).body.sessionId; assert(session);
      const warmup = (await post(`/api/voice/warmup?session=${session}`, {})).body;
      assert.equal(warmup.ready, true); assert.equal(warmup.fastWake, true);
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
      // docs/VOICE.md - the arco-voice MCP child POSTs to /api/voice/tool
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
    await step('synthetic PCM is transcribed and speech output is a WAV', async () => {
      const pcm = Buffer.alloc(3200);
      const response = await fetch(base + `/api/voice/audio?session=${session}`, { method: 'POST', body: pcm });
      assert.equal(response.status, 200);
      const recognized = await response.json() as any;
      assert.equal(recognized.text, 'Sample audio'); assert.equal(typeof recognized.phrases, 'string');
      const speech = await fetch(base + `/api/voice/speak?session=${session}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hands free is ready.' }) });
      assert.equal(speech.status, 200);
      const audio = Buffer.from(await speech.arrayBuffer());
      assert.equal(speech.headers.get('x-voice-engine'), 'kokoro');
      assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
      assert(audio.length > 2000);
    });
    await step('disable closes the session; control text and audio are absent from workflow history', async () => {
      await fetch(base + `/api/voice/session?session=${session}`, { method: 'DELETE' });
      assert.equal((await post(`/api/voice/heartbeat?session=${session}`, {})).status, 400);
      assert.equal((await fetch(base + `/api/voice/wake?session=${session}&utterance=3`, { method: 'POST', body: Buffer.alloc(100) })).status, 400);
      await c?.close(); c = undefined;
      await stopVoiceSmokeServer(child);
      const events = readFileSync(join(dir, '.arco/workflows', workflowId, 'events.jsonl'), 'utf8');
      assert(!events.includes('Bring up my reviewer')); assert(!events.includes('Sample audio')); assert(!events.includes('Hands free is ready'));
      assert(!readFileSync(join(dir, 'server.log'), 'utf8').includes('Bring up my reviewer'));
      assert(!readdirSync(env.ARCO_HOME).includes('voice-history'));
    });
  } finally {
    if (session) await fetch(base + `/api/voice/session?session=${session}`, { method: 'DELETE' }).catch(() => {});
    if (c) await c.close();
    await stopVoiceSmokeServer(child);
    closeSync(log); console.log('Isolated artifacts:', dir);
  }
  summary('voice');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

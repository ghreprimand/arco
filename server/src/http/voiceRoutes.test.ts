import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { VOICE_OUTPUT_SAMPLE } from '@archon/shared';
import { tryHandleVoiceRoutes } from './voiceRoutes.js';
import { LocalRecognizer } from '../voice/localRecognizer.js';
import { endVoiceSession, getVoiceSession, startVoiceSession } from '../voice/sessions.js';

test('the capture acknowledgement is a bundled quiet 230 ms double pulse without a voice lease', async () => {
  const server = createServer((req, res) => { void tryHandleVoiceRoutes(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/voice/ready-sound`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'audio/wav');
    const wav = Buffer.from(await response.arrayBuffer());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 48000);
    const samples = Array.from({ length: (wav.length - 44) / 2 }, (_, i) => wav.readInt16LE(44 + i * 2) / 32768);
    assert.equal(samples.length / 48000, .23);
    const peak = Math.max(...samples.map(Math.abs)); assert(peak > .064 && peak < .066);
    assert(samples.slice(4080, 5040).every((s) => s === 0), 'two pulses have a 20 ms silent gap');
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});

test('voice previews need no enabled lease, use a fixed sample, and are bounded', async (t) => {
  const calls: string[] = [];
  let wait: (() => void) | undefined;
  const stopped: LocalRecognizer[] = [];
  t.mock.method(LocalRecognizer.prototype, 'stop', function (this: LocalRecognizer) { stopped.push(this); });
  t.mock.method(LocalRecognizer.prototype, 'speakDetailed', async function (this: LocalRecognizer, text: string, signal: AbortSignal) {
    calls.push(text);
    if (calls.length === 1) await new Promise<void>((resolve) => { wait = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
    return { audio: Buffer.from('audition'), mime: 'audio/mpeg' };
  });
  const server = createServer((req, res) => { void tryHandleVoiceRoutes(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const preview = (voice: unknown) => fetch(base + '/api/voice/preview', {
    method: 'POST', body: JSON.stringify({ voice, text: 'Never accept arbitrary sample text' }),
  });
  try {
    assert.equal((await preview('invalid')).status, 400); assert.equal(calls.length, 0);
    const first = preview('en-US-JennyNeural');
    while (!wait) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await preview('en-CA-ClaraNeural')).status, 409);
    // No lease was consumed by previews: both microphone slots remain free.
    const a = startVoiceSession(), b = startVoiceSession(); endVoiceSession(a.id); endVoiceSession(b.id);
    wait(); const response = await first;
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await response.text(), 'audition'); assert.deepEqual(calls, [VOICE_OUTPUT_SAMPLE]);
    assert(stopped.length >= 3);
    assert.equal((await preview('en-CA-ClaraNeural')).status, 200);
  } finally { wait?.(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});

test('an old cancelled synthesis cannot kill a new voice in the same live session', async (t) => {
  let rejectOld: ((error: Error) => void) | undefined;
  let releaseNew: (() => void) | undefined;
  const stopped: LocalRecognizer[] = [];
  t.mock.method(LocalRecognizer.prototype, 'stop', function (this: LocalRecognizer) { stopped.push(this); });
  t.mock.method(LocalRecognizer.prototype, 'speakDetailed', async function (text: string) {
    if (text === 'Old reply') await new Promise<void>((_, reject) => { rejectOld = reject; });
    else await new Promise<void>((resolve) => { releaseNew = resolve; });
    return { audio: Buffer.from('reply'), mime: 'audio/mpeg' };
  });
  const session = startVoiceSession('en-US-JennyNeural');
  const server = createServer((req, res) => { void tryHandleVoiceRoutes(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/voice/speak?session=${session.id}`;
  const speak = (text: string, voice: string, signal?: AbortSignal) => fetch(url, { method: 'POST', body: JSON.stringify({ text, voice }), signal });
  try {
    const abort = new AbortController();
    const old = speak('Old reply', 'en-US-JennyNeural', abort.signal).catch(() => null);
    while (!rejectOld) await new Promise((r) => setTimeout(r, 5));
    abort.abort(); await old;
    const next = speak('New reply', 'en-CA-ClaraNeural');
    while (!releaseNew) await new Promise((r) => setTimeout(r, 5));
    const currentSpeaker = session.edgeSpeaker;
    rejectOld(new Error('Cancelled old synthesis')); await new Promise((r) => setTimeout(r, 5));
    assert.equal(session.edgeSpeaker, currentSpeaker); assert(currentSpeaker);
    assert.equal(stopped.includes(currentSpeaker), false); assert.equal(getVoiceSession(session.id), session);
    releaseNew(); assert.equal((await next).status, 200);
  } finally { releaseNew?.(); rejectOld?.(new Error('cleanup')); endVoiceSession(session.id); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});


test('private microphone recognition and diagnostics do not write transcript text to logs', async (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { logged.push(args); });
  t.mock.method(LocalRecognizer.prototype, 'recognize', async () => ({text:'PRIVATE_AUDIO_SENTINEL_7481',phrases:''}));
  t.mock.method(LocalRecognizer.prototype, 'stop', () => {});
  const session = startVoiceSession();
  const server = createServer((req, res) => { void tryHandleVoiceRoutes(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    const audio = await fetch(`${base}/api/voice/audio?session=${session.id}`, {method:'POST',headers:{'X-Archon-Voice-Private':'1'},body:Buffer.alloc(32)});
    assert.equal((await audio.json()).text,'PRIVATE_AUDIO_SENTINEL_7481');
    const diag = await fetch(`${base}/api/voice/diag?session=${session.id}`, {method:'POST',headers:{'X-Archon-Voice-Private':'1'},body:JSON.stringify({events:[{ev:'heard',text:'PRIVATE_DIAG_SENTINEL_7481'}]})});
    assert.equal(diag.status,200); assert.equal(logged.length,0);
  } finally { endVoiceSession(session.id); server.closeAllConnections(); await new Promise<void>((r)=>server.close(()=>r())); }
});

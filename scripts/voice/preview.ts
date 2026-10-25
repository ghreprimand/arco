// Standalone recognition lab: no workflow server, providers, or saved text.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalRecognizer, localVoiceAvailable, localWakeAvailable, voicePaths } from '../../server/src/voice/localRecognizer.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdir, unlink, writeFile } from 'node:fs/promises';

import { fileURLToPath } from 'node:url';

// GPU audition engines live in their own venvs (installed by hand, see
// docs/VOICE.md § Voice audition). The TNG computer voice is a personal,
// local reference clip the operator supplies; it is never bundled.
const AUDITION_TEXT = 'Ready. I can switch workflows, prepare a message, or ask your project director for a status update. What would you like to do?';
const AUDITIONS: Record<string, { venv: string; engine: string; ref?: string; extra?: string[]; label: string }> = {
  'chatterbox': { venv: 'venv-chatterbox', engine: 'chatterbox', label: 'Chatterbox · built-in voice' },
  'chatterbox-tng': { venv: 'venv-chatterbox', engine: 'chatterbox', ref: 'tng-computer.wav', label: 'Chatterbox · TNG computer clone' },
  // Chatterbox cloning Qwen's rendering of the TNG voice: Qwen's delivery at
  // Chatterbox speed. The reference is the cached qwen-tng sample.
  'chatterbox-tng-via-qwen': { venv: 'venv-chatterbox', engine: 'chatterbox', ref: '../audition-logs/qwen-tng.wav', extra: ['--exaggeration', '0.3', '--cfg', '0.4'], label: 'Chatterbox · TNG clone from the Qwen sample' },
  'chatterbox-tng-flat': { venv: 'venv-chatterbox', engine: 'chatterbox', ref: 'tng-computer.wav', extra: ['--exaggeration', '0.3', '--cfg', '0.3'], label: 'Chatterbox · TNG clone, flatter delivery' },
  'chatterbox-tng-via-qwen-long': { venv: 'venv-chatterbox', engine: 'chatterbox', ref: 'tng-computer-qwen-long.wav', extra: ['--exaggeration', '0.3', '--cfg', '0.4'], label: 'Chatterbox · TNG clone from a long Qwen reference' },
  'chatterbox-turbo-tng': { venv: 'venv-chatterbox', engine: 'chatterbox-turbo', ref: 'tng-computer.wav', label: 'Chatterbox Turbo · TNG clone' },
  'chatterbox-turbo-via-qwen-long': { venv: 'venv-chatterbox', engine: 'chatterbox-turbo', ref: 'tng-computer-qwen-long.wav', label: 'Chatterbox Turbo · TNG clone from a long Qwen reference' },
  // The two Qwen prompt modes that stop correctly on short text (the show-clip
  // in-context mode runs away); see docs/VOICE.md § Voice audition.
  'qwen-tng-long': { venv: 'venv-qwen', engine: 'qwen-clone', ref: 'tng-computer-qwen-long.wav', label: 'Qwen3-TTS · TNG clone, long Qwen reference (fast mode)' },
  'qwen-tng-xvec': { venv: 'venv-qwen', engine: 'qwen-clone', ref: 'tng-computer.wav', extra: ['--xvec'], label: 'Qwen3-TTS · TNG clone, speaker embedding only (fast mode)' },
  'qwen-british': { venv: 'venv-qwen', engine: 'qwen-design', label: 'Qwen3-TTS · designed British female' },
  'qwen-tng': { venv: 'venv-qwen', engine: 'qwen-clone', ref: 'tng-computer.wav', label: 'Qwen3-TTS · TNG computer clone' },
};
function auditionStatus(): Record<string, { available: boolean; reason?: string }> {
  const root = voicePaths().root;
  return Object.fromEntries(Object.entries(AUDITIONS).map(([id, a]) => {
    const python = join(root, a.venv, 'bin/python');
    if (!existsSync(python)) return [id, { available: false, reason: `install ${a.venv} first` }];
    if (a.ref && !existsSync(join(root, 'reference', a.ref))) return [id, { available: false, reason: `needs ~/.arco/voice/reference/${a.ref}` }];
    return [id, { available: true }];
  }));
}
async function audition(id: string, signal: AbortSignal): Promise<{ wav: Buffer; timing: string }> {
  const a = AUDITIONS[id]; const root = voicePaths().root;
  const out = join(tmpdir(), `arco-audition-${randomUUID()}.wav`);
  const script = fileURLToPath(new URL('./audition.py', import.meta.url));
  const argv = [script, '--engine', a.engine, '--text', AUDITION_TEXT, '--out', out, ...(a.ref ? ['--ref', join(root, 'reference', a.ref)] : []), ...(a.extra ?? [])];
  const child = spawn(join(root, a.venv, 'bin/python'), ['-u', ...argv], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', HF_HUB_DISABLE_TELEMETRY: '1' } });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const onAbort = () => child.kill('SIGTERM');
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)));
    if (code !== 0) throw new Error(`Audition failed (${code}): ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 600)}`);
    const timing = stderr.trim().split('\n').findLast((line) => line.startsWith('{')) ?? '{}';
    return { wav: await readFile(out), timing };
  } finally { signal.removeEventListener('abort', onAbort); await unlink(out).catch(() => {}); }
}
import { parseDirectVoiceCommand, voiceCommandBody } from '../../client/src/voice/commands.js';
import { VoiceCommandBuffer } from '../../client/src/voice/commandBuffer.js';
import { reservedVoiceText } from '../../client/src/voice/reservedPhrases.js';

if (!localVoiceAvailable()) throw new Error('Run npm run voice:setup first.');
const token = randomUUID();
const sessions = new Map<string, { recognizer: LocalRecognizer; waker: LocalRecognizer; wakeBusy: boolean; wakeUtterance: number; commands: VoiceCommandBuffer; controller: AbortController; expires: number; busy: boolean }>();
const samples = new Set<LocalRecognizer>();
let auditionBusy = false;

function end(id: string) {
  const s = sessions.get(id);
  if (s) { sessions.delete(id); s.commands.clear(); s.controller.abort(); s.recognizer.stop(); s.waker.stop(); }
}
const sweep = setInterval(() => {
  for (const [id, s] of sessions) if (s.expires < Date.now()) end(id);
}, 5000);
sweep.unref();
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const json = (status: number, body: unknown) => {
    if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
  };
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = (await readFile(new URL('./preview.html', import.meta.url), 'utf8')).replace('__VOICE_TOKEN__', token);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    if (req.method === 'GET' && url.pathname === '/voice-capture.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(await readFile(new URL('../../client/public/voice-capture.js', import.meta.url))); return;
    }
    if (req.headers['x-voice-preview'] !== token) { json(403, { error: 'Open the test page to begin.' }); return; }
    if (url.pathname === '/ready-sound' && req.method === 'GET') {
      const wav = await readFile(new URL('../../server/src/voice/capture-ready.wav', import.meta.url));
      res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(wav); return;
    }
    if (url.pathname === '/auditions' && req.method === 'GET') { json(200, auditionStatus()); return; }
    if (url.pathname === '/sample' && req.method === 'POST') {
      if (samples.size || auditionBusy) throw new Error('A voice sample is already being generated.');
      const voice = url.searchParams.get('voice') ?? '';
      if (AUDITIONS[voice]) {
        const status = auditionStatus()[voice];
        if (!status.available) throw new Error(status.reason ?? 'Unavailable.');
        // GPU generation takes tens of seconds under the miner, so the last
        // sample per voice is kept on disk (audition-logs/) for replay;
        // ?fresh=1 regenerates. Samples are the fixed audition sentence only.
        const cached = join(voicePaths().root, 'audition-logs', `${voice}.wav`);
        if (url.searchParams.get('fresh') !== '1' && existsSync(cached)) {
          const timing = await readFile(cached.replace(/\.wav$/, '.json'), 'utf8').catch(() => '{}');
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Voice-Timing': JSON.stringify({ ...JSON.parse(timing), cached: true }) }); res.end(await readFile(cached)); return;
        }
        auditionBusy = true;
        const abort = new AbortController(); res.once('close', () => abort.abort());
        try {
          const { wav, timing } = await audition(voice, abort.signal);
          await mkdir(join(voicePaths().root, 'audition-logs'), { recursive: true });
          await writeFile(cached, wav); await writeFile(cached.replace(/\.wav$/, '.json'), timing);
          if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Voice-Timing': timing }); res.end(wav); }
        } finally { auditionBusy = false; }
        return;
      }
      if (!voicePaths().tts.endsWith('kokoro-multi-lang-v1_0')) throw new Error('Install the British voices with npm run voice:setup.');
      if (voice !== 'emma' && voice !== 'isabella') throw new Error('Choose a listed voice.');
      const speaker = new LocalRecognizer(true, voice); samples.add(speaker);
      const abort = new AbortController(); res.once('close', () => abort.abort());
      try {
        const started = performance.now();
        const wav = await speaker.speak(AUDITION_TEXT, abort.signal);
        if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Voice-Timing': JSON.stringify({ engine: `kokoro-${voice}`, device: 'cpu', generateMs: Math.round(performance.now() - started) }) }); res.end(wav); }
      } finally { samples.delete(speaker); speaker.stop(); }
      return;
    }
    if (url.pathname === '/enable' && req.method === 'POST') {
      if (sessions.size >= 2) throw new Error('Close another test session first.');
      const id = randomUUID();
      sessions.set(id, { recognizer: new LocalRecognizer(), waker: new LocalRecognizer(false, 'emma', true), wakeBusy: false, wakeUtterance: -1, commands: new VoiceCommandBuffer(), controller: new AbortController(), expires: Date.now() + 45000, busy: false });
      let fastWake = localWakeAvailable();
      const session = sessions.get(id)!;
      try { await Promise.all([session.recognizer.warmup(session.controller.signal), ...(fastWake ? [session.waker.warmup(session.controller.signal).catch(() => {
        session.waker.stop(); fastWake = false;
      })] : [])]); session.controller.signal.throwIfAborted(); }
      catch (error) { end(id); throw error; }
      json(200, { id, fastWake }); return;
    }
    const id = url.searchParams.get('session') ?? '';
    if (url.pathname === '/stop' && req.method === 'DELETE') { end(id); json(200, {}); return; }
    const s = sessions.get(id);
    if (!s || s.expires < Date.now()) { end(id); throw new Error('Test session expired. Enable the microphone again.'); }
    if (url.pathname === '/heartbeat' && req.method === 'POST') {
      s.expires = Date.now() + 45000;
      json(200, { expired: s.commands.expire(), pendingText: s.commands.text, captureExpiresAt: s.commands.expiresAt }); return;
    }
    if (url.pathname === '/wake' && req.method === 'POST') {
      const utterance = Number(url.searchParams.get('utterance'));
      const firstSpeechAt = Number(url.searchParams.get('firstSpeechAt') ?? '0.25');
      if (!Number.isSafeInteger(utterance) || utterance < 1 || utterance < s.wakeUtterance) throw new Error('Invalid wake utterance.');
      if (!Number.isFinite(firstSpeechAt) || firstSpeechAt < 0 || firstSpeechAt > 0.5) throw new Error('Invalid speech offset.');
      if (s.wakeBusy) throw new Error('Wake detection is busy.');
      s.wakeBusy = true;
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16_000) throw new Error('Wake chunk is too long.'); chunks.push(Buffer.from(chunk)); }
        if (!bytes || bytes % 2) throw new Error('Expected PCM16 wake audio.');
        const reset = utterance !== s.wakeUtterance; s.wakeUtterance = utterance;
        const disconnected = new AbortController(); res.once('close', () => disconnected.abort());
        json(200, { detected: await s.waker.detectWake(Buffer.concat(chunks), reset, AbortSignal.any([s.controller.signal, disconnected.signal]), firstSpeechAt) });
      } catch (error) { end(id); throw error; }
      finally { s.wakeBusy = false; }
      return;
    }
    // Same buffer path for recognized text and the manual END/CANCEL buttons;
    // the page queues a button behind in-flight recognition like the app does.
    const accept = (text: string, rawText: string, elapsedMs: number) => {
      const body = voiceCommandBody(text);
      const result = s.commands.accept(text);
      const command = result.kind === 'execute' ? parseDirectVoiceCommand(result.text)
        : result.kind === 'disable' || result.kind === 'quiet' ? { action: result.kind, target: '', value: '' } : null;
      return { text, rawText, prefixed: body !== null, command, mode: result.kind, started: result.kind === 'pending' && result.started, pendingText: s.commands.text, captureExpiresAt: s.commands.expiresAt, elapsedMs };
    };
    if (url.pathname === '/control' && req.method === 'POST') {
      const text = url.searchParams.get('text');
      if (text !== 'End capture' && text !== 'Cancel capture') throw new Error('Unknown capture control.');
      if (s.busy) throw new Error('Recognition is busy.');
      if (s.commands.text === null) { json(200, { text, rawText: text, prefixed: false, command: null, mode: 'ignore', started: false, pendingText: null, captureExpiresAt: null, elapsedMs: 0 }); return; }
      json(200, accept(text, text, 0)); return;
    }
    if (url.pathname === '/audio' && req.method === 'POST') {
      if (s.busy) throw new Error('Recognition is busy.');
      s.busy = true;
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 16000 * 2 * 30) throw new Error('Audio segment too long.');
          chunks.push(Buffer.from(chunk));
        }
        if (!bytes || bytes % 2) throw new Error('Expected PCM16 audio.');
        const disconnected = new AbortController(); res.once('close', () => disconnected.abort());
        const started = performance.now();
        const recognized = await s.recognizer.recognize(Buffer.concat(chunks), AbortSignal.any([s.controller.signal, disconnected.signal]));
        const text = reservedVoiceText(recognized.text, recognized.phrases, s.commands.text !== null);
        json(200, accept(text, recognized.text, Math.round(performance.now() - started)));
      } catch (e) { end(id); throw e; }
      finally { s.busy = false; }
      return;
    }

    json(404, { error: 'Unknown test operation.' });
  } catch (e) { json(400, { error: e instanceof Error ? e.message : 'Recognition failed.' }); }
});
server.listen(Number(process.env.ARCO_VOICE_PREVIEW_PORT ?? 5194), '127.0.0.1', () => {
  const addr = server.address() as { port: number };
  console.log(`Voice recognition test: http://127.0.0.1:${addr.port}/ — microphone off until enabled; no workers or Luna.`);
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  for (const id of sessions.keys()) end(id);
  for (const speaker of samples) speaker.stop();
  server.close(); process.exit(0);
});

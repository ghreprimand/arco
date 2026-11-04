import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { killProcessTree } from '../workers/processKill.js';
import { arcoHome } from '../arcoHome.js';

export function voicePaths() {
  const root = process.env.ARCO_VOICE_HOME || join(arcoHome(), 'voice');
  const kokoro = join(root, 'kokoro-multi-lang-v1_0');
  const parakeet = join(root, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8');
  return { root, python: join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    // The current ONNX Parakeet decoder can return empty finals on Windows.
    model: process.platform !== 'win32' && existsSync(join(parakeet, 'encoder.int8.onnx')) ? parakeet : join(root, 'sherpa-onnx-moonshine-tiny-en-int8'),
    wakeModel: join(root, 'vosk-model-small-en-us-0.15'),
    tts: existsSync(join(kokoro, 'model.onnx')) ? kokoro : join(root, 'vits-piper-en_US-lessac-medium'),
    script: fileURLToPath(new URL('./recognizer.py', import.meta.url)) };
}
export function localWakeAvailable(): boolean {
  const p = voicePaths();
  return localVoiceAvailable() && ['am/final.mdl', 'graph/HCLr.fst', 'graph/Gr.fst',
    'conf/model.conf'].every((f) => existsSync(join(p.wakeModel, f)));
}

interface LocalSpeechResult { text?: string; phrases?: string; audio?: string; format?: string; detected?: boolean }
export function localVoiceAvailable(): boolean {
  const p = voicePaths();
  return existsSync(p.python) && existsSync(p.script)
    && (p.model.includes('parakeet') ? ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']
      : ['preprocess.onnx', 'encode.int8.onnx', 'uncached_decode.int8.onnx', 'cached_decode.int8.onnx', 'tokens.txt']).every((f) => existsSync(join(p.model, f)));
}

export class LocalRecognizer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: { resolve: (v: LocalSpeechResult) => void; reject: (e: Error) => void } | null = null;
  private stopped = false;
  private ready: Promise<void> | null = null;
  // `voice` is a Kokoro speaker (emma / isabella) or an Edge neural voice id
  // such as en-GB-SoniaNeural (docs/VOICE.md); Edge ids contain dashes.
  constructor(private speaking = false, private voice: string = 'emma', private waking = false) {}
  get edge(): boolean { return this.speaking && this.voice.includes('-'); }

  async warmup(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const abort = () => this.stop();
    signal.addEventListener('abort', abort, { once: true });
    try { await this.start(); signal.throwIfAborted(); }
    finally { signal.removeEventListener('abort', abort); }
  }

  private start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Voice session ended.'));
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      if (!localVoiceAvailable()) { reject(new Error('Install local speech with npm run voice:setup.')); return; }
      if (this.waking && !localWakeAvailable()) { reject(new Error('Install fast wake detection with npm run voice:setup.')); return; }
      const p = voicePaths();
      const child = spawn(p.python, ['-u', p.script, this.waking ? p.wakeModel : this.speaking ? p.tts : p.model, this.waking ? 'wake' : this.edge ? 'edge' : this.speaking ? 'tts' : 'asr', this.voice], { detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '2' } });
      this.child = child;
      const timer = setTimeout(() => { reject(new Error('Local speech startup timed out.')); this.stop(); }, 20_000);
      child.on('error', () => { clearTimeout(timer); reject(new Error('Could not start local speech.')); this.stop(); });
      child.stdin.on('error', () => this.stop());
      child.stderr.on('data', () => {});
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        if (line.length > (this.speaking ? 8_000_000 : 32_000)) { this.stop(); return; }
        try {
          const m = JSON.parse(line);
          if (m.ready === true) { clearTimeout(timer); resolve(); return; }
          const pending = this.pending; this.pending = null;
          if (m.error) pending?.reject(new Error('Local speech recognition failed.'));
          else pending?.resolve(m);
        } catch { this.stop(); }
      });
      child.on('close', () => { clearTimeout(timer); reject(new Error('Local speech closed.')); this.stop(); });
    });
    return this.ready;
  }

  async transcribe(pcm: Buffer, signal: AbortSignal): Promise<string> {
    return (await this.recognize(pcm, signal)).text;
  }

  async recognize(pcm: Buffer, signal: AbortSignal): Promise<{ text: string; phrases: string }> {
    const result = await this.request({ pcm: pcm.toString('base64') }, signal);
    return { text: typeof result.text === 'string' ? result.text.slice(0, 8000) : '',
      phrases: typeof result.phrases === 'string' ? result.phrases.slice(0, 8000) : '' };
  }

  async speak(text: string, signal: AbortSignal): Promise<Buffer> {
    return (await this.speakDetailed(text, signal)).audio;
  }
  async speakDetailed(text: string, signal: AbortSignal): Promise<{ audio: Buffer; mime: string }> {
    const result = await this.request({ text }, signal);
    if (typeof result.audio !== 'string') throw new Error('Local speech output failed.');
    return { audio: Buffer.from(result.audio, 'base64'), mime: result.format === 'mp3' ? 'audio/mpeg' : 'audio/wav' };
  }

  async detectWake(pcm: Buffer, reset: boolean, signal: AbortSignal, firstSpeechAt = 0.25): Promise<boolean> {
    const result = await this.request({ pcm: pcm.toString('base64'), reset, firstSpeechAt }, signal);
    return result.detected === true;
  }

  private async request(body: unknown, signal: AbortSignal): Promise<LocalSpeechResult> {
    signal.throwIfAborted();
    await this.start();
    signal.throwIfAborted();
    if (this.stopped || !this.child) throw new Error('Voice session ended.');
    if (this.pending) throw new Error('Local speech is busy.');
    return new Promise((resolve, reject) => {
      const abort = () => this.stop();
      const timer = setTimeout(() => this.stop(), 20_000);
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      this.pending = { resolve: (text) => { done(); resolve(text); }, reject: (e) => { done(); reject(e); } };
      signal.addEventListener('abort', abort, { once: true });
      this.child!.stdin.write(JSON.stringify(body) + '\n');
    });
  }

  stop(): void {
    this.stopped = true;
    this.pending?.reject(new Error('Voice session ended.')); this.pending = null;
    if (this.child?.pid) killProcessTree(this.child.pid);
    this.child = null;
  }
}

import { computerPrivate, computerCaptureKey } from '../stores/computerStore';
import { type VoiceCommand, type VoiceContext } from '@archon/shared';
import { voiceCommandBody, immediateVoiceControl } from './commands';
import { useVoiceStore } from './store';
import { VoiceCommandBuffer } from './commandBuffer';
import { voiceModeSwitch } from './modes';
import { voiceSpeechChunks } from './speech';
import { reservedVoiceText } from './reservedPhrases';

export interface VoiceRuntimeActions {
  context(): VoiceContext;
  // Direct execution is only reachable through Computer's tools now; kept for
  // the dictation flow and tests.
  execute?(command: VoiceCommand): Promise<string>;
  dictate(text: string): string;
  canInterpret(text: string): boolean;
  converse?(text: string, signal: AbortSignal, context?: string): Promise<string>;
  contextLine?(): string;
  returnToControl?(): string;
}

interface VoiceCaptureSnapshot { private?: boolean; computerKey?: string; draftAtCapture: string | null; speaking: boolean; context: VoiceContext; acknowledged?: boolean }
interface EarlyWake { snapshot: VoiceCaptureSnapshot; cancelled: boolean; endRequested: boolean }
type CaptureFrame = { type: 'wake' | 'segment'; utterance: number; pcm: ArrayBuffer; firstSpeechAt?: number; endpointMs?: number; flushed?: boolean }
  | { type: 'discard'; utterance: number } | { type: 'flushed' } | { type: 'level'; rms: number; peak?: number; noise?: number; onset?: number; active?: boolean };
export type VoiceCaptureControl = 'End capture' | 'Cancel capture';

// Owns every microphone/connection handle. Nothing runs until start() is
// called from an explicit operator gesture. Epoch checks reject late work.
export class VoiceRuntime {
  private epoch = 0;
  private stream: MediaStream | null = null;
  private audio: AudioContext | null = null;
  private capture: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private session: string | null = null;
  private abort = new AbortController();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  // Pipeline diagnostics (2026-10-17: "it's not recognizing me say computer
  // again" with nothing to read afterwards). Each decision the browser makes
  // about a frame — segment emitted, wake queued/ignored, what was heard and
  // what the buffer did with it — is batched to the server, which writes it
  // to the journal next to the recognizer's own lines. Local only.
  private processingPrivate = false;
  private diagEvents: Record<string, unknown>[] = [];
  private diagTimer: ReturnType<typeof setTimeout> | null = null;
  private levelWindow: { peak: number; noise: number; onset: number; active: boolean; at: number } | null = null;
  private diag(event: Record<string, unknown>): void {
    if (!this.session || computerPrivate() || this.processingPrivate) return;
    this.diagEvents.push({ t: Date.now(), ...event });
    if (this.diagEvents.length > 200) this.diagEvents.splice(0, this.diagEvents.length - 200);
    if (this.diagTimer) return;
    this.diagTimer = setTimeout(() => {
      this.diagTimer = null;
      const events = this.diagEvents.splice(0); const session = this.session;
      if (!events.length || !session || computerPrivate()) return;
      void fetch(`/api/voice/diag?session=${session}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(computerPrivate() ? { 'X-Archon-Voice-Private': '1' } : {}) }, body: JSON.stringify({ events }), keepalive: true }).catch(() => {});
    }, 1500);
  }
  private queue: Array<{ pcm: ArrayBuffer; utterance?: number; snapshot: VoiceCaptureSnapshot; endpointMs?: number } | { control: VoiceCaptureControl }> = [];
  private flushWaiters: VoiceCaptureControl[] = [];
  private wakeQueue: Array<{ pcm: ArrayBuffer; utterance: number; firstSpeechAt: number; snapshot: VoiceCaptureSnapshot }> = [];
  private wakeContexts = new Map<number, VoiceCaptureSnapshot>();
  private earlyWakes = new Map<number, EarlyWake>();
  private previewWakeId: number | null = null;
  private handledUtterance = 0;
  private wakeProcessing = false;
  private fastWake = false;
  private unsubscribeWake: (() => void) | null = null;
  private speechAbort: AbortController | null = null;
  private playback: AudioBufferSourceNode | null = null;
  private speechEpoch = 0;
  // Barge-in (the operator, 2026-10-17: "Computer" while it talks must stop it and
  // wait for the next words). A fast wake is only the phrase grammar's guess
  // — it has heard Computer in "Thank you" — so playback is HELD on the
  // wake, not killed: the verified word ends it (quiet) and opens a capture,
  // an unverified one releases the held sentence, which replays from its
  // start. `index` is the sentence being spoken, used to ignore a wake while
  // Computer itself is saying "Computer" (manual sections do).
  private speech: { chunks: string[]; index: number; held: boolean; release: (() => void) | null } | null = null;
  private processing = false;
  private releaseLock: (() => void) | null = null;
  private commands = new VoiceCommandBuffer();
  private commandContext: VoiceContext | null = null;
  private commandTimer: ReturnType<typeof setTimeout> | null = null;
  private announcements: string[] = [];
  private pendingReply: { text: string; mode: 'archon' | 'conversation' } | null = null;
  private readySound: AudioBuffer | null = null;
  constructor(private actions: VoiceRuntimeActions) {}

  clearPendingCapture(): void {
    this.handledUtterance = Math.max(this.handledUtterance, ...this.wakeContexts.keys(), ...this.queue.map((item) => 'utterance' in item ? item.utterance ?? 0 : 0));
    this.announcements = [];
    this.commands.clear(); this.commandContext = null; this.clearCommandTimer();
    this.queue = []; this.wakeQueue = []; this.wakeContexts.clear(); this.earlyWakes.clear();
    this.previewWakeId = null; this.diagEvents = [];
    this.capture?.port.postMessage('resume');
    this.releaseSpeech();
    useVoiceStore.setState({ commandText: null, lastHeard: '', status: 'Computer context cleared.' });
  }

  async start(): Promise<void> {
    if (useVoiceStore.getState().enabled) return;
    const epoch = ++this.epoch;
    this.abort = new AbortController();
    useVoiceStore.setState({ enabled: true, phase: 'starting', status: 'Requesting microphone…', error: null, inputLevel: 0, lastHeard: '' });
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires localhost or HTTPS.');
      const audio = new AudioContext({ latencyHint: 'interactive' });
      this.audio = audio;
      const resumed = audio.resume().catch(() => {});
      if (navigator.locks) {
        const acquired = await new Promise<boolean>((resolve) => {
          void navigator.locks.request('archon-hands-free-microphone', { ifAvailable: true }, (lock) => {
            if (!lock || !this.current(epoch)) { resolve(false); return; }
            return new Promise<void>((release) => { this.releaseLock = release; resolve(true); });
          }).catch(() => resolve(false));
        });
        if (!this.current(epoch)) return;
        if (!acquired) throw new Error('Hands-free mode is already enabled in another Arco window.');
      }
      // Keep the operator's system mic gain fixed; browser AGC can lower it.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false });
      if (!this.current(epoch)) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream = stream;
      stream.getAudioTracks().forEach((track) => track.addEventListener('ended', () => { if (this.current(epoch)) this.fail('Microphone disconnected. Enable hands-free again when ready.'); }));
      const voice = useVoiceStore.getState().outputVoice;
      const result = await this.json<{ sessionId: string }>('/api/voice/session', { enabled: true, ...(voice ? { voice } : {}) });
      if (!this.current(epoch)) {
        void fetch(`/api/voice/session?session=${encodeURIComponent(result.sessionId)}`, { method: 'DELETE', keepalive: true }); return;
      }
      this.session = result.sessionId;
      await resumed;
      useVoiceStore.setState({ status: 'Preparing local recognition…' });
      const loadSound = async () => {
        const response = await fetch('/api/voice/ready-sound', { signal: this.abort.signal });
        if (!response.ok) return null;
        return audio.decodeAudioData(await response.arrayBuffer());
      };
      const [readySound, warmup] = await Promise.all([loadSound(), this.json<{ fastWake?: boolean; recognizer?: string }>(`/api/voice/warmup?session=${this.session}`, {}), audio.audioWorklet.addModule('/voice-capture.js')]);
      if (!this.current(epoch) || !this.audio) return;
      this.readySound = readySound;
      if (!readySound) useVoiceStore.setState({ error: 'Acknowledgement sound is unavailable. Capture is shown on screen.' });
      this.capture = new AudioWorkletNode(this.audio, 'archon-voice-capture');
      this.fastWake = warmup.fastWake === true;
      useVoiceStore.setState({ recognizer: warmup.recognizer ?? 'Local CPU', recognitionMs: null, interpretationMs: null, speechMs: null, endpointMs: null });
      const syncWake = () => {
        const state = useVoiceStore.getState();
        // Armed during playback too (the operator, 2026-10-17: "Computer" while it
        // talks must stop it). Echo cancellation keeps its own voice out;
        // `receiveWake` holds playback and the transcript verifies the word.
        this.capture?.port.postMessage({ threshold: state.speechThreshold, wakeEnabled: this.fastWake && state.enabled && state.commandText === null });
      };
      this.unsubscribeWake = useVoiceStore.subscribe((next, prev) => {
        if (next.commandText !== prev.commandText || next.phase !== prev.phase || next.enabled !== prev.enabled || next.speechThreshold !== prev.speechThreshold) syncWake();
      });
      syncWake();
      this.source = this.audio.createMediaStreamSource(stream);
      this.capture.port.onmessage = (e: MessageEvent<ArrayBuffer | CaptureFrame>) => this.ingest(e.data, epoch);
      this.source.connect(this.capture);
      // Keep the processor pulled while its output remains silent.
      const mute = this.audio.createGain(); mute.gain.value = 0;
      this.capture.connect(mute); mute.connect(this.audio.destination);
      this.heartbeat = setInterval(() => {
        void this.json(`/api/voice/heartbeat?session=${this.session}`, {}).catch(() => { if (this.current(epoch)) this.fail('Voice connection lost. Microphone stopped; draft kept.'); });
      }, 15_000);
      // A spoken startup tutorial put the listener in playback-only mode and
      // discarded Computer when the operator immediately tried the wake word.
      useVoiceStore.setState({ open: false, phase: 'listening', status: 'Ready. Say “Computer”, wait for the soft double pulse, then speak. Pause, then say “over” to submit.' });
    } catch (e) { if (this.current(epoch)) this.fail(e instanceof Error ? e.message : 'Could not enable voice.'); }
  }

  // Entry point for every worklet port message; also the fixture seam.
  ingest(frame: ArrayBuffer | CaptureFrame, epoch = this.epoch): void {
    if (!this.current(epoch)) return;
    if (!(frame instanceof ArrayBuffer) && frame.type === 'level') {
      const clamp = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
      useVoiceStore.setState({ inputLevel: clamp(frame.peak) ?? clamp(frame.rms) ?? 0, noiseFloor: clamp(frame.noise), speechOnset: clamp(frame.onset) });
      const w = this.levelWindow ?? { peak: 0, noise: 0, onset: 0, active: false, at: Date.now() };
      w.peak = Math.max(w.peak, frame.peak ?? 0); w.noise = frame.noise ?? 0; w.onset = frame.onset ?? 0; w.active = w.active || frame.active === true;
      this.levelWindow = w;
      if (Date.now() - w.at >= 5000) {
        this.diag({ ev: 'level', peak: +w.peak.toFixed(4), noise: +w.noise.toFixed(4), onset: +w.onset.toFixed(4), active: w.active, phase: useVoiceStore.getState().phase, capture: useVoiceStore.getState().commandText !== null, fastWake: this.fastWake });
        this.levelWindow = null;
      }
      return;
    }
    if (!(frame instanceof ArrayBuffer) && frame.type === 'flushed') {
      // Ordered port delivery guarantees the flushed segment, if any, was
      // ingested before this confirmation, so the control queues behind it.
      const control = this.flushWaiters.shift();
      if (control) this.queueControl(control, epoch);
      return;
    }
    if (!(frame instanceof ArrayBuffer) && frame.type === 'discard') {
      this.diag({ ev: 'discard', u: frame.utterance });
      this.handledUtterance = Math.max(this.handledUtterance, frame.utterance);
      this.wakeContexts.delete(frame.utterance); this.earlyWakes.delete(frame.utterance);
      if (this.previewWakeId === frame.utterance) {
        this.previewWakeId = null; this.clearCommandTimer();
        useVoiceStore.setState({ commandText: null, status: 'Waiting for Computer.' });
        this.releaseSpeech();
      }
      return;
    }
    const snapshot: VoiceCaptureSnapshot = (!(frame instanceof ArrayBuffer) ? this.wakeContexts.get(frame.utterance) : undefined)
      ?? { private: computerPrivate(), computerKey: computerCaptureKey(), draftAtCapture: useVoiceStore.getState().dictatingId, speaking: useVoiceStore.getState().phase === 'speaking', context: this.actions.context() };
    if (!(frame instanceof ArrayBuffer) && frame.type === 'wake') {
      if (!this.fastWake) return;
      if (!this.wakeContexts.has(frame.utterance)) { this.wakeContexts.set(frame.utterance, snapshot); this.diag({ ev: 'wake-frames', u: frame.utterance, firstSpeechAt: frame.firstSpeechAt, speaking: snapshot.speaking }); }
      if (this.wakeQueue.length >= 80) { this.disableFastWake('Fast wake detection fell behind. Full speech recognition remains available.'); return; }
      this.wakeQueue.push({ pcm: frame.pcm, utterance: frame.utterance, firstSpeechAt: frame.firstSpeechAt ?? 0.25, snapshot: this.wakeContexts.get(frame.utterance)! });
      void this.drainWake(epoch); return;
    }
    if (this.queue.filter((item) => 'pcm' in item).length >= 4) { this.fail('Speech buffer is full. Your existing draft was kept.'); return; }
    // Bind the recipient when audio is captured, before transcription.
    const utterance = frame instanceof ArrayBuffer ? undefined : frame.utterance;
    this.diag({ ev: 'segment', u: utterance, bytes: frame instanceof ArrayBuffer ? frame.byteLength : frame.pcm.byteLength, endpointMs: frame instanceof ArrayBuffer ? undefined : frame.endpointMs, queued: this.queue.length, processing: this.processing });
    this.queue.push({ pcm: frame instanceof ArrayBuffer ? frame : frame.pcm, utterance, endpointMs: frame instanceof ArrayBuffer ? undefined : frame.endpointMs, snapshot: utterance ? this.wakeContexts.get(utterance) ?? snapshot : snapshot });
    void this.drain(epoch);
  }

  // The END/CANCEL CAPTURE buttons. A click can land while the final phrase
  // is still accumulating in the worklet or in flight to the recognizer;
  // submitting immediately executed a directive without its last words. The
  // worklet flushes what it holds, then the control queues behind every
  // pending segment. Spoken End/Cancel capture needs none of this: the
  // closing phrase is itself the last recognized segment.
  endCapture(control: VoiceCaptureControl): void {
    if (!useVoiceStore.getState().enabled) return;
    if (!this.capture) { this.queueControl(control, this.epoch); return; }
    this.flushWaiters.push(control);
    useVoiceStore.setState({ status: control === 'End capture' ? 'Finishing the last phrase, then ending capture…' : 'Cancelling capture…' });
    this.capture.port.postMessage('flush');
  }

  private queueControl(control: VoiceCaptureControl, epoch: number): void {
    this.queue.push({ control });
    void this.drain(epoch);
  }

  stop(): void {
    ++this.epoch; this.abort.abort();
    this.flushWaiters = [];
    this.commands.clear(); this.commandContext = null;
    this.clearCommandTimer();
    this.unsubscribeWake?.(); this.unsubscribeWake = null;
    this.fastWake = false; this.wakeQueue = []; this.wakeContexts.clear(); this.earlyWakes.clear();
    this.previewWakeId = null; this.handledUtterance = 0; this.wakeProcessing = false;
    this.releaseLock?.(); this.releaseLock = null;
    this.queue = []; this.processing = false; this.quiet();
    this.capture?.port.close(); this.capture?.disconnect(); this.capture = null;
    this.source?.disconnect(); this.source = null;
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null;
    this.readySound = null;
    void this.audio?.close(); this.audio = null;
    globalThis.speechSynthesis?.cancel();
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null;
    const id = this.session; this.session = null;
    if (id) void fetch(`/api/voice/session?session=${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    useVoiceStore.setState({ enabled: false, mode: 'archon', phase: 'off', status: 'Microphone off.', inputLevel: 0, lastHeard: '', dictatingId: null, choices: [], pendingCommand: null, commandText: null });
  }

  private current(epoch: number): boolean { return epoch === this.epoch && useVoiceStore.getState().enabled; }
  private fail(message: string): void { this.stop(); useVoiceStore.setState({ error: message }); }
  private async json<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(computerPrivate() ? { 'X-Archon-Voice-Private': '1' } : {}) }, body: JSON.stringify(body), signal: this.abort.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Voice request failed.');
    return result;
  }

  private async drain(epoch: number): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    let attemptedUtterance = 0;
    try {
      while (this.queue.length && this.current(epoch)) {
        const item = this.queue.shift()!;
        if ('control' in item) {
          // Nothing armed: a repeated click must not dictate the phrase.
          if (this.commands.text === null && this.previewWakeId === null) { useVoiceStore.setState({ status: 'No capture to end.' }); continue; }
          await this.receive(item.control, epoch);
          continue;
        }
        const { pcm, utterance, snapshot, endpointMs } = item;
        this.processingPrivate = snapshot.private === true;
        attemptedUtterance = utterance ?? 0;
        const { draftAtCapture, speaking } = snapshot;
        if (!speaking) useVoiceStore.setState({ phase: 'recognizing' });
        const started = performance.now();
        const response = await fetch(`/api/voice/audio?session=${this.session}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...((snapshot.private || computerPrivate()) ? { 'X-Archon-Voice-Private': '1' } : {}) }, body: pcm, signal: this.abort.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Speech recognition failed.');
        if (!this.current(epoch)) return;
        useVoiceStore.setState({ recognitionMs: Math.round(performance.now() - started), endpointMs: endpointMs ?? null });
        this.diag({ ev: 'heard', u: utterance, ms: Math.round(performance.now() - started), text: String(result.text ?? '').slice(0, 300), phrases: String(result.phrases ?? '').slice(0, 200), speaking });
        if (draftAtCapture && draftAtCapture !== useVoiceStore.getState().dictatingId) throw new Error('Dictation target changed. Please repeat that segment.');
        if (snapshot.computerKey && snapshot.computerKey !== computerCaptureKey()) {
          this.commands.clear(); this.commandContext = null; this.clearCommandTimer();
          useVoiceStore.setState({ commandText: null, lastHeard: '', status: 'Computer changed while that speech was captured. Please start again.' });
          continue;
        }
        await this.receiveSegment(result.text ?? '', utterance, snapshot, epoch, result.phrases ?? '');
      }
    } catch (e) {
      this.diag({ ev: 'recognition-error', u: attemptedUtterance, error: e instanceof Error ? e.message : String(e) });
      if (this.current(epoch)) {
        this.handledUtterance = Math.max(this.handledUtterance, attemptedUtterance, ...this.queue.map((item) => ('utterance' in item ? item.utterance : undefined) ?? 0));
        this.queue = []; this.wakeContexts.clear(); this.earlyWakes.clear();
        this.commands.clear(); this.commandContext = null; this.clearCommandTimer();
        useVoiceStore.setState({ commandText: null, status: 'Recognition failed. Capture cancelled; please repeat the complete command.' });
        if (this.previewWakeId !== null) {
          this.previewWakeId = null; this.clearCommandTimer(); useVoiceStore.setState({ commandText: null });
        }
        useVoiceStore.setState({ error: e instanceof Error ? e.message : 'Voice command failed.' });
      }
    } finally {
      this.processingPrivate = false;
      if (this.current(epoch)) { this.processing = false; if (useVoiceStore.getState().phase !== 'speaking') useVoiceStore.setState({ phase: 'listening' }); this.flushReply(); }
    }
  }

  private disableFastWake(error: string): void {
    this.diag({ ev: 'fast-wake-disabled', error });
    this.fastWake = false; this.wakeQueue = [];
    this.capture?.port.postMessage({ wakeEnabled: false });
    useVoiceStore.setState({ error });
  }

  private async drainWake(epoch: number): Promise<void> {
    if (this.wakeProcessing) return;
    this.wakeProcessing = true;
    try {
      while (this.wakeQueue.length && this.current(epoch) && this.fastWake) {
        const frame = this.wakeQueue.shift()!;
        if (frame.utterance <= this.handledUtterance || useVoiceStore.getState().commandText !== null) continue;
        const response = await fetch(`/api/voice/wake?session=${this.session}&utterance=${frame.utterance}&firstSpeechAt=${frame.firstSpeechAt}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...((frame.snapshot.private || computerPrivate()) ? { 'X-Archon-Voice-Private': '1' } : {}) }, body: frame.pcm, signal: this.abort.signal,
        });
        const result = await response.json();
        if (!response.ok) { this.diag({ ev: 'wake-http', u: frame.utterance, status: response.status, error: result.error }); throw new Error('Fast wake detection is unavailable. Full recognition remains available.'); }
        if (result.detected === true) this.diag({ ev: 'wake-detected', u: frame.utterance });
        if (this.current(epoch) && this.fastWake && result.detected === true) this.receiveWake(frame.utterance, frame.snapshot, epoch);
      }
    } catch (error) {
      if (this.current(epoch)) this.disableFastWake(error instanceof Error ? error.message : 'Fast wake detection failed.');
    } finally { if (this.current(epoch)) this.wakeProcessing = false; }
  }

  receiveWake(utterance: number, snapshot: VoiceCaptureSnapshot, epoch = this.epoch): void {
    if (snapshot.computerKey && snapshot.computerKey !== computerCaptureKey()) return;
    if (!this.current(epoch) || utterance <= this.handledUtterance || this.commands.text !== null || useVoiceStore.getState().commandText !== null) {
      this.diag({ ev: 'wake-ignored', u: utterance, speaking: snapshot.speaking, phase: useVoiceStore.getState().phase, handled: this.handledUtterance, buffered: this.commands.text !== null, capture: useVoiceStore.getState().commandText !== null });
      return;
    }
    if (snapshot.speaking || useVoiceStore.getState().phase === 'speaking') {
      if (this.speakingItsOwnName()) { this.diag({ ev: 'wake-ignored', u: utterance, reason: 'own-name', chunk: this.speech?.index }); return; }
      this.holdSpeech();
    }
    this.diag({ ev: 'wake-accepted', u: utterance, speaking: snapshot.speaking });
    this.earlyWakes.set(utterance, { snapshot, cancelled: false, endRequested: false });
    this.previewWakeId = utterance;
    // No chime here. The fast wake is the forced phrase grammar's guess and
    // it guessed "computer" for "Thank you" even after the 0.6 s hold
    // (journal, 2026-10-17; the operator: the sound must play ONLY when the operator said
    // Computer). The chime now waits for the full transcript to verify the
    // word (`receive`, started), about half a second later. The early
    // capture still shows on screen so immediate follow-on speech is kept.
    // PCM already contains everything from before the word. Acknowledging it
    // now cannot discard immediate follow-on speech or authorize an action.
    useVoiceStore.setState({ commandText: '', status: 'Heard something. Verifying Computer…', error: null });
    this.clearCommandTimer();
    this.commandTimer = setTimeout(() => {
      if (!this.current(epoch) || this.previewWakeId !== utterance) return;
      const early = this.earlyWakes.get(utterance); if (early) early.cancelled = true;
      this.previewWakeId = null;
      useVoiceStore.setState({ commandText: null, status: 'Capture expired before wake verification. Nothing executed.' });
      if (this.speech?.held) this.quiet();
    }, 120_000);
    this.commandTimer.unref?.();
  }

  async receiveSegment(raw: string, utterance: number | undefined, snapshot: VoiceCaptureSnapshot, epoch = this.epoch, phrases = ''): Promise<void> {
    if (!this.current(epoch)) return;
    const early = utterance !== undefined ? this.earlyWakes.get(utterance) : undefined;
    // A fast-wake hit is the phrase grammar hearing Computer first; it
    // vouches for the wake word when the general recognizer garbled it.
    const text = reservedVoiceText(raw, phrases, this.commands.text !== null, early !== undefined);
    if (utterance !== undefined) { this.handledUtterance = Math.max(this.handledUtterance, utterance); this.wakeContexts.delete(utterance); }
    if (utterance !== undefined) this.earlyWakes.delete(utterance);
    if (utterance === this.previewWakeId) this.previewWakeId = null;
    if (early?.cancelled) return;
    if (early && voiceCommandBody(text) === null) {
      this.clearCommandTimer();
      this.diag({ ev: 'wake-unverified', u: utterance, text: text.slice(0, 300), phrases: phrases.slice(0, 200) });
      useVoiceStore.setState({ commandText: null, lastHeard: `${text} (phrase grammar: ${phrases.trim() || 'nothing'})`.slice(0, 8000), status: 'Computer was not verified as the first word. Nothing executed; waiting for Computer.' });
      this.releaseSpeech();
      if (early.snapshot.draftAtCapture && early.snapshot.draftAtCapture === useVoiceStore.getState().dictatingId && text.trim()) {
        useVoiceStore.setState({ status: this.actions.dictate(text), error: null });
      }
      return;
    }
    // A segment that endpointed but transcribed to nothing used to vanish
    // silently; the operator could not tell a dropped phrase from a pause.
    // The capture stays open and untouched — only End/Cancel capture closes it.
    if (!text.trim() && this.commands.text !== null) {
      useVoiceStore.setState({ lastHeard: '(nothing recognized)', status: 'That phrase was not recognized. Please say it again, or say “over” to submit or “cancel” to discard.' });
      return;
    }

    await this.receive(text, epoch, early ? { ...early.snapshot, acknowledged: true } : snapshot);
    if (this.current(epoch) && text !== raw) useVoiceStore.setState({ lastHeard: `${raw} → ${text}`.slice(0, 8000) });
    if (early?.endRequested && this.current(epoch) && this.commands.text !== null) await this.receive('End capture', epoch, snapshot);
  }

  async receive(text: string, epoch = this.epoch, capture?: VoiceCaptureSnapshot): Promise<void> {
    if (!this.current(epoch) || !text.trim()) return;
    const early = this.previewWakeId !== null ? this.earlyWakes.get(this.previewWakeId) : undefined;
    if (early && !capture) {
      if (/^cancel[\s,:;.!?]+capture[\s,:;.!?]*$/i.test(text.trim())) {
        early.cancelled = true; this.previewWakeId = null;
        this.clearCommandTimer(); if (this.speech?.held) this.quiet();
        useVoiceStore.setState({ commandText: null, status: 'Capture cancelled. Nothing executed.' }); return;
      }
      if (/^end[\s,:;.!?]+capture[\s,:;.!?]*$/i.test(text.trim())) {
        early.endRequested = true;
        useVoiceStore.setState({ status: 'Ending capture after the initial wake word is verified. Nothing executed yet.' }); return;
      }
    }
    useVoiceStore.setState({ lastHeard: text.slice(0, 8000) });
    // Heard while Computer was talking. Without its name, only an instant
    // control counts ("stop", "quiet": the operator interrupting, no name
    // needed); playback residue cannot arm, append or execute anything. With
    // its name, playback stops and the words are an ordinary directive:
    // "Computer" alone opens a capture that waits, "Computer, stop" is
    // silence, "Computer, switch to ORBIT, over" interrupts and acts. The one
    // exception is a sentence in which Computer says its own name.
    if (capture?.speaking) {
      const body = voiceCommandBody(text);
      if (body === null) {
        const action = immediateVoiceControl(text);
        if (action === 'disable') this.stop();
        if (action === 'quiet') { this.quiet(); useVoiceStore.setState({ status: 'Stopped.' }); }
        return;
      }
      if (this.speakingItsOwnName()) { this.diag({ ev: 'own-name', text: text.slice(0, 300), chunk: this.speech?.index }); this.releaseSpeech(); return; }
      this.quiet();
    }
    const input = this.commands.accept(text);
    this.diag({ ev: 'buffer', kind: input.kind, started: 'started' in input ? input.started : undefined, text: text.slice(0, 300), acknowledged: capture?.acknowledged === true });
    if (input.kind === 'disable') { this.stop(); return; }
    if (input.kind === 'quiet') { this.quiet(); return; }
    if (['cancel', 'empty', 'expired', 'overflow'].includes(input.kind)) {
      this.commandContext = null;
      this.clearCommandTimer();
      useVoiceStore.setState({ commandText: null, status: input.kind === 'cancel' ? 'Capture cancelled. Nothing executed.' : input.kind === 'empty' ? 'Capture ended with no directive. Nothing executed.' : input.kind === 'expired' ? 'Capture expired after two minutes of silence. Nothing executed. Say Computer to start again.' : 'Command limit reached. Nothing executed; start again with Computer.' });
      this.flushReply(); return;
    }
    if (input.kind === 'ignore') {
      if (!capture?.speaking && useVoiceStore.getState().dictatingId && (!capture || capture.draftAtCapture === useVoiceStore.getState().dictatingId)) {
        const status = this.actions.dictate(text);
        useVoiceStore.setState({ status, error: null });
      }
      return;
    }
    if (input.kind !== 'pending' && input.kind !== 'execute') return;
    if (input.started) this.commandContext = capture?.context ?? this.actions.context();
    if (input.kind === 'pending') {
      if (input.started) this.captureChime();
      this.armCommandTimer(epoch);
      useVoiceStore.setState({ commandText: input.text, status: 'Capturing directive. Take your time; up to two minutes between phrases. Pause, then say “over” to submit or “cancel” to discard.', error: null });
      return;
    }
    let before = this.commandContext ?? capture?.context ?? this.actions.context();
    this.pendingReply = null;
    this.commandContext = null;
    this.clearCommandTimer();
    useVoiceStore.setState({ commandText: null });
    const selected = this.actions.context();
    if (before.currentId !== selected.currentId || before.clusterId !== selected.clusterId) {
      this.feedback('The selection changed while you were composing that command. Please start it again.'); return;
    }
    let body = input.text;
    const modeSwitch = voiceModeSwitch(body);
    if (modeSwitch?.mode === 'archon') {
      this.pendingReply = null;
      const message = this.actions.returnToControl?.();
      if (!message) { this.feedback('Computer conversation is unavailable in this window.'); return; }
      body = modeSwitch.body;
      before = this.actions.context();
      if (!body) { this.feedback(message); return; }
    } else if (modeSwitch?.mode === 'conversation' || useVoiceStore.getState().mode === 'conversation') {
      if (!this.actions.converse) { this.feedback('Computer conversation is unavailable in this window.'); return; }
      const message = await this.actions.converse(modeSwitch?.body ?? body, this.abort.signal);
      if (this.current(epoch)) this.feedback(message);
      return;
    }
    // VOICE_AGENT_PLAN.md (the operator, 2026-10-17): "there should be no exact
    // matching going on with anything" — every directive goes to Computer,
    // which reads the roster and decides what to do. The only instant words
    // are the microphone controls; closings are handled by the buffer.
    const immediate = immediateVoiceControl(body);
    if (immediate === 'disable') { this.stop(); return; }
    if (immediate === 'quiet') { this.quiet(); return; }
    useVoiceStore.setState({ interpretationMs: 0 });
    if (!useVoiceStore.getState().lunaEnabled || !this.actions.converse || !this.actions.canInterpret(body)) {
      this.feedback('Computer is off for this window, so hands-free cannot act. Turn Computer on in the voice settings.'); return;
    }
    useVoiceStore.setState((s) => ({ phase: 'interpreting', status: 'Computer is working on it…', calls: s.calls + 1 }));
    const started = performance.now();
    const message = await this.actions.converse(body, this.abort.signal, this.actions.contextLine?.() ?? '');
    if (!this.current(epoch)) return;
    useVoiceStore.setState({ interpretationMs: Math.round(performance.now() - started), phase: 'listening' });
    if (message) this.feedback(message);
  }

  private feedback(message: string): void {
    useVoiceStore.setState({ status: message }); this.speak(message);
  }

  reply(message: string, mode: 'archon' | 'conversation' = 'conversation'): void {
    if (!useVoiceStore.getState().enabled || useVoiceStore.getState().mode !== mode) return;
    this.pendingReply = { text: message, mode };
    this.flushReply();
  }

  announce(message: string): void {
    if (!useVoiceStore.getState().enabled || !useVoiceStore.getState().spokenFeedback) return;
    this.announcements.push(message); this.announcements = this.announcements.slice(-20); this.flushReply();
  }

  private flushReply(): void {
    if (!this.processing && !this.speech && useVoiceStore.getState().commandText === null && !this.pendingReply && this.announcements.length) {
      const text = this.announcements.shift()!;
      if (useVoiceStore.getState().enabled) this.feedback(text);
      return;
    }
    if (!this.pendingReply || this.processing || useVoiceStore.getState().commandText !== null) return;
    const { text, mode } = this.pendingReply; this.pendingReply = null;
    if (useVoiceStore.getState().enabled && useVoiceStore.getState().mode === mode) this.feedback(text);
  }

  private clearCommandTimer(): void {
    if (this.commandTimer !== null) clearTimeout(this.commandTimer);
    this.commandTimer = null;
  }

  private armCommandTimer(epoch: number): void {
    this.clearCommandTimer();
    this.commandTimer = setTimeout(() => {
      this.commandTimer = null;
      if (!this.current(epoch)) return;
      if (!this.commands.expire()) {
        if (this.commands.expiresAt !== null) this.armCommandTimer(epoch);
        return;
      }
      this.commandContext = null;
      useVoiceStore.setState({ commandText: null, status: 'Capture expired after two minutes of silence. Nothing executed. Say Computer to start again.' });
      this.flushReply();
    }, Math.max(0, this.commands.expiresAt! - Date.now()));
    // Node-based fixtures should not stay alive for a browser's idle timer.
    this.commandTimer.unref?.();
  }

  private captureChime(): void {
    if (!this.audio || !this.readySound) return;
    const source = this.audio.createBufferSource(); source.buffer = this.readySound;
    // The bundled cue is mastered at the chosen preview level. Never normalize
    // it toward the old TNG alert volume or put it behind speech synthesis.
    source.connect(this.audio.destination);
    source.onended = () => source.disconnect();
    source.start();
  }

  quiet(preserveAnnouncements = false): void {
    this.pendingReply = null;
    if (!preserveAnnouncements) this.announcements = [];
    ++this.speechEpoch;
    const speech = this.speech; this.speech = null;
    speech?.release?.();
    this.speechAbort?.abort(); this.speechAbort = null;
    try { this.playback?.stop(); } catch { /* already ended */ }
    this.playback = null;
    globalThis.speechSynthesis?.cancel();
    if (useVoiceStore.getState().enabled) useVoiceStore.setState({ phase: 'listening' });
  }

  // Hold playback on a fast wake; the sentence stops mid-word and replays
  // from its start if the wake is not verified. Nothing else changes: the
  // phase stays 'speaking' so the segment that follows is judged as heard
  // during playback.
  holdSpeech(): boolean {
    const speech = this.speech;
    if (!speech || speech.held) return false;
    speech.held = true;
    this.diag({ ev: 'speech-held', chunk: speech.index });
    try { this.playback?.stop(); } catch { /* already ended */ }
    return true;
  }

  releaseSpeech(): void {
    const speech = this.speech;
    if (!speech || !speech.held) return;
    speech.held = false;
    this.diag({ ev: 'speech-released', chunk: speech.index });
    speech.release?.(); speech.release = null;
  }

  // The sentence being spoken contains "Computer" (the manual's voice
  // section does). Echo cancellation is good, not perfect: a wake heard
  // during that sentence is more likely its own voice than the operator.
  // "Computer, stop" during such a sentence is also dropped; a bare "stop"
  // still works.
  private speakingItsOwnName(): boolean {
    const chunk = this.speech?.chunks[this.speech.index];
    return chunk !== undefined && /\bcomputer\b/i.test(chunk);
  }

  // Fixture seam: tests attach a fake AudioContext to exercise playback.
  attachAudio(audio: AudioContext, readySound?: AudioBuffer): void { this.audio = audio; if (readySound) this.readySound = readySound; }

  speak(message: string, preview = false): void {
    if (!message || !useVoiceStore.getState().enabled || (!preview && !useVoiceStore.getState().spokenFeedback)) return;
    // Freeze one voice per reply, including the prefetched sentence. A picker
    // change applies to the next reply without cutting this one or its capture.
    const voice = useVoiceStore.getState().outputVoice;
    this.quiet(true);
    const epoch = this.epoch, speechEpoch = this.speechEpoch;
    const abort = new AbortController(); this.speechAbort = abort;
    useVoiceStore.setState({ phase: 'speaking' });
    // Local speech output works even when Linux/Chromium has no installed
    // browser voices. Chunks are memory-only and permit spoken interruption.
    const chunks = voiceSpeechChunks(message);
    const speech = { chunks, index: 0, held: false, release: null as (() => void) | null };
    this.speech = speech;
    const speechStarted = performance.now();
    const live = () => this.current(epoch) && speechEpoch === this.speechEpoch && this.audio !== null;
    void (async () => {
      try {
        const load = async (text: string): Promise<AudioBuffer> => {
          if (!live()) throw new Error('Speech cancelled.');
          const response = await fetch(`/api/voice/speak?session=${this.session}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...(computerPrivate() ? { 'X-Archon-Voice-Private': '1' } : {}) }, body: JSON.stringify({ text, ...(voice ? { voice } : {}) }), signal: abort.signal,
          });
          if (!response.ok) throw new Error('Spoken feedback unavailable. Your command result remains on screen.');
          const data = await response.arrayBuffer();
          if (!live()) throw new Error('Speech cancelled.');
          return this.audio!.decodeAudioData(data);
        };
        // One synthesis per sentence, kept so a held sentence replays without
        // a second request; the next sentence is prepared during playback.
        const loaded: Array<Promise<AudioBuffer> | undefined> = [];
        const buffer = (i: number) => (loaded[i] ??= load(chunks[i]));
        let first = true;
        for (let i = 0; i < chunks.length; i++) {
          speech.index = i;
          if (speech.held) await new Promise<void>((resolve) => { speech.release = resolve; });
          if (!live()) return;
          const audio = await buffer(i);
          if (!live()) return;
          if (speech.held) { i--; continue; }
          if (first) { first = false; useVoiceStore.setState({ speechMs: Math.round(performance.now() - speechStarted) }); }
          if (i + 1 < chunks.length) void buffer(i + 1).catch(() => {});
          const pause = /[.!?][”"')\]]*$/.test(chunks[i]) ? 0.22 : /[,;:]$/.test(chunks[i]) ? 0.12 : 0.06;
          const padded = this.audio!.createBuffer(audio.numberOfChannels, audio.length + Math.round(audio.sampleRate * pause), audio.sampleRate);
          for (let channel = 0; channel < audio.numberOfChannels; channel++) padded.copyToChannel(audio.getChannelData(channel), channel);
          const source = this.audio!.createBufferSource(); source.buffer = padded; source.connect(this.audio!.destination);
          this.playback = source;
          await new Promise<void>((resolve) => { source.onended = () => resolve(); source.start(); });
          source.disconnect();
          // Stopped by a hold: wait, then replay this sentence from its start.
          if (speech.held) i--;
        }
      } catch (e) {
        if (live() && !abort.signal.aborted) useVoiceStore.setState({ error: e instanceof Error ? e.message : 'Spoken feedback failed.' });
      } finally {
        if (this.current(epoch) && speechEpoch === this.speechEpoch) { this.playback = null; this.speechAbort = null; this.speech = null; useVoiceStore.setState({ phase: 'listening' }); this.flushReply(); }
      }
    })();
  }
}

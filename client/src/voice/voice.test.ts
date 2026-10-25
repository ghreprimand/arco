import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { VoiceCommand, VoiceContext } from '@archon/shared';
import { resolveVoiceTarget, voiceCommandBody } from './commands.js';
import { VoiceExecutor } from './executor.js';
import { VoiceRuntime } from './runtime.js';
import { VoiceCommandBuffer, VOICE_CAPTURE_IDLE_MS } from './commandBuffer.js';
import { voiceModeSwitch } from './modes.js';
import { ComputerConversation } from './conversation.js';
import { voiceSpeechChunks } from './speech.js';
import { reservedVoiceText } from './reservedPhrases.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { useVoiceStore } from './store.js';
import { useAppStore } from '../stores/appStore.js';
import { useComputerStore } from '../stores/computerStore.js';
import { controlComputer, registerComputerSwitch } from './computerControl.js';
import { readDraft, useDraftStore } from '../stores/draftStore.js';
import { useChatFollowStore } from '../stores/chatFollowStore.js';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });

const context: VoiceContext = { currentId: 'worker-a', clusterId: 'cluster-a', targets: [
  { id: 'cluster-a', name: 'Atlas', kind: 'cluster' },
  { id: 'worker-a', name: 'Builder #1', kind: 'member', clusterId: 'cluster-a', aliases: ['member 1'] },
  { id: 'worker-b', name: 'Builder #2', kind: 'member', clusterId: 'cluster-a', aliases: ['member 2'], role: 'reviewer' },
  { id: 'worker-c', name: 'Other reviewer', kind: 'member', clusterId: 'cluster-b', role: 'reviewer' },
] };
const cmd = (action: VoiceCommand['action'], target = '', value = ''): VoiceCommand => ({ action, target, value });
const reset = () => useVoiceStore.setState({ enabled: true, mode: 'archon', phase: 'listening', spokenFeedback: false, lunaEnabled: true, draftId: null, dictatingId: null, choices: [], pendingCommand: null, commandText: null });
afterEach(() => {
  useChatFollowStore.setState({ request: null });
  useComputerStore.getState().setOpen(false);
  useVoiceStore.setState({ enabled: false, spokenFeedback: true, draftId: null, dictatingId: null, outputVoice: null });
  for (const id of ['worker-a', 'worker-b', 'worker-c', 'computer-chat']) { useAppStore.getState().removeJob(id); useDraftStore.getState().clearDraft(id); }
  useAppStore.getState().clearCluster('cluster-a');
});

test('speech preserves sentence punctuation and only splits long sentences at phrase or word boundaries', () => {
  assert.deepEqual(voiceSpeechChunks('Hello, there. Ready? Yes!'), ['Hello, there.', 'Ready?', 'Yes!']);
  assert.deepEqual(voiceSpeechChunks('The value is 3.14. Dr. Smith is here.'), ['The value is 3.14.', 'Dr. Smith is here.']);
  const text = 'word '.repeat(150).trim() + '.';
  const chunks = voiceSpeechChunks(text);
  assert(chunks.length > 1); assert(chunks.every((c) => c.length <= 480));
  assert.equal(chunks.join(' '), text);
  assert.deepEqual(voiceSpeechChunks('**Ready.** [Open it](https://example.com).'), ['Ready.', 'Open it.']);
});

test('steady room noise cannot hold Computer open until the old 22-second segment cap', () => {
  const frames: unknown[] = []; let Processor: new () => { process(inputs: Float32Array[][]): boolean };
  runInNewContext(readFileSync(new URL('../../public/voice-capture.js', import.meta.url), 'utf8'), {
    sampleRate: 16000, AudioWorkletProcessor: class { port = { postMessage: (v: unknown) => frames.push(v) }; },
    registerProcessor: (_name: string, value: typeof Processor) => { Processor = value; },
  });
  const processor = new Processor!();
  const feed = (seconds: number, level: number) => { for (let i = 0; i < seconds * 16000 / 128; i++) processor.process([[new Float32Array(128).fill(level)]]); };
  feed(1, 0.0048); feed(0.45, 0.035); feed(1, 0.0048);
  const audio = frames.filter((f) => (f as { type?: string }).type === 'segment');
  assert.equal(audio.length, 1, 'a standalone word must be emitted within one second of returning to room noise');
  assert(frames.some((f) => (f as { type?: string }).type === 'level'));
});

test('quiet speech reaches recognition within 400 ms of silence without submitting the command', () => {
  const frames: Array<{ type: string; endpointMs?: number }> = [];
  let Processor: new () => { process(inputs: Float32Array[][]): boolean };
  runInNewContext(readFileSync(new URL('../../public/voice-capture.js', import.meta.url), 'utf8'), {
    sampleRate: 16000, AudioWorkletProcessor: class { port = { postMessage: (v: typeof frames[number]) => frames.push(v) }; },
    registerProcessor: (_name: string, value: typeof Processor) => { Processor = value; },
  });
  const processor = new Processor!();
  const feed = (seconds: number, level: number) => { for (let i = 0; i < seconds * 16000 / 128; i++) processor.process([[new Float32Array(128).fill(level)]]); };
  feed(0.3, 0.0004); feed(0.4, 0.0045); feed(0.4, 0.0004);
  const segment = frames.find((f) => f.type === 'segment'); assert(segment);
  assert(segment.endpointMs! >= 350 && segment.endpointMs! <= 400);
  assert(!frames.some((f) => f.type === 'execute'));
});

test('wake PCM arrives before endpoint silence while the full segment retains immediate follow-on speech', () => {
  const frames: Array<{ type: string; pcm?: ArrayBuffer }> = [];
  let Processor: new () => { process(inputs: Float32Array[][]): boolean; port: { onmessage: (e: { data: unknown }) => void } };
  runInNewContext(readFileSync(new URL('../../public/voice-capture.js', import.meta.url), 'utf8'), {
    sampleRate: 16000, AudioWorkletProcessor: class { port = { postMessage: (v: typeof frames[number]) => frames.push(v) }; },
    registerProcessor: (_name: string, value: typeof Processor) => { Processor = value; },
  });
  const processor = new Processor!(); processor.port.onmessage({ data: { wakeEnabled: true } });
  const feed = (seconds: number, level: number) => { for (let i = 0; i < seconds * 16000 / 128; i++) processor.process([[new Float32Array(128).fill(level)]]); };
  feed(0.3, 0); feed(0.6, 0.3); feed(0.2, 0);
  assert(frames.some((f) => f.type === 'wake')); assert(!frames.some((f) => f.type === 'segment'));
  processor.port.onmessage({ data: { wakeEnabled: false } });
  feed(0.5, 0.2); feed(1, 0);
  const segment = frames.find((f) => f.type === 'segment'); assert(segment?.pcm);
  const pcm = new Int16Array(segment.pcm);
  assert(pcm.filter((v) => v > 9000).length >= 16000 * 0.59, 'initial word audio survives');
  assert(pcm.filter((v) => v > 6000 && v < 8000).length >= 16000 * 0.49, 'immediate speech after wake acknowledgement survives');
});

const loadProcessor = (frames: unknown[]) => {
  let Processor: new () => { process(inputs: Float32Array[][]): boolean; port: { onmessage: (e: { data: unknown }) => void } };
  runInNewContext(readFileSync(new URL('../../public/voice-capture.js', import.meta.url), 'utf8'), {
    sampleRate: 16000, AudioWorkletProcessor: class { port = { postMessage: (v: unknown) => frames.push(v) }; },
    registerProcessor: (_name: string, value: typeof Processor) => { Processor = value; },
  });
  const processor = new Processor!();
  const feed = (seconds: number, level: number) => { for (let i = 0; i < seconds * 16000 / 128; i++) processor.process([[new Float32Array(128).fill(level)]]); };
  return { processor, feed };
};
type Frame = { type: string; endpointMs?: number; flushed?: boolean; onset?: number; active?: boolean; pcm?: ArrayBuffer };

test('breath or lip noise just under the onset cannot raise it above ordinary quiet speech', () => {
  const frames: Frame[] = []; const { feed } = loadProcessor(frames);
  feed(0.3, 0.0004); feed(0.5, 0.003); feed(0.4, 0.0045); feed(0.4, 0.0004);
  const segment = frames.find((f) => f.type === 'segment'); assert(segment, 'quiet word after sub-threshold noise still reaches recognition');
  const onset = frames.filter((f) => f.type === 'level').map((f) => f.onset!);
  assert(Math.max(...onset) < 0.0045, 'the floor must not learn near-threshold noise within half a second');
});

test('steady noise arriving after calibration is absorbed within a few seconds instead of holding a segment open to the cap', () => {
  const frames: Frame[] = []; const { feed } = loadProcessor(frames);
  feed(0.5, 0.0004); feed(5, 0.005);
  const segments = frames.filter((f) => f.type === 'segment');
  assert(segments.length <= 1, 'at most one noise segment');
  assert(segments.every((s) => s.pcm!.byteLength < 16000 * 2 * 8), 'nothing close to the 22-second cap');
  const last = frames.filter((f) => f.type === 'level').at(-1)!;
  assert.equal(last.active, false); assert(last.onset! > 0.005, 'steady noise is now below onset');
  feed(0.45, 0.035); feed(1, 0.005);
  assert.equal(frames.filter((f) => f.type === 'segment').length, segments.length + 1, 'a real word above the new floor still endpoints normally');
});

test('flush delivers the phrase still waiting for endpoint silence, then confirms; idle flush only confirms', () => {
  const frames: Frame[] = []; const { processor, feed } = loadProcessor(frames);
  feed(0.3, 0.0004); processor.port.onmessage({ data: 'flush' });
  assert.deepEqual(frames.filter((f) => f.type !== 'level').map((f) => f.type), ['flushed']);
  feed(0.4, 0.02); feed(0.1, 0.0004);
  assert(!frames.some((f) => f.type === 'segment'), 'endpoint silence has not elapsed');
  processor.port.onmessage({ data: 'flush' });
  const tail = frames.filter((f) => f.type !== 'level').slice(1);
  assert.deepEqual(tail.map((f) => f.type), ['segment', 'flushed']);
  assert.equal(tail[0].flushed, true); assert(tail[0].pcm!.byteLength >= 16000 * 2 * 0.4);
  feed(0.4, 0.02); feed(0.4, 0.0004);
  assert.equal(frames.filter((f) => f.type === 'segment').length, 2, 'capture continues normally after a flush');
});

const captureSnapshot = { draftAtCapture: null, speaking: false, context };
test('reserved phrase repair needs independent acoustic agreement and preserves ordinary dictation and captured Computer', () => {
  assert.equal(reservedVoiceText('And capture.', 'end capture', false), 'And capture.');
  assert.equal(reservedVoiceText('And capture.', '', true), 'And capture.');
  assert.equal(reservedVoiceText('And capture.', '[unk]', true), 'And capture.');
  assert.equal(reservedVoiceText('And capture.', 'end capture [unk]', true), 'And capture.');
  assert.equal(reservedVoiceText('And capture.', 'end capture', true), 'End capture.');
  assert.equal(reservedVoiceText("Let's leave it there for now and capture.", '[unk] end capture', true), "Let's leave it there for now End capture.");
  assert.equal(reservedVoiceText('Computer open plan and capture.', 'computer [unk] end capture', false), 'Computer open plan End capture.');
  assert.equal(reservedVoiceText('A computer.', 'computer', false), 'Computer.');
  assert.equal(reservedVoiceText('The computer.', 'computer', false), 'Computer.');
  assert.equal(reservedVoiceText('The computer.', 'the computer', false), 'The computer.');
  assert.equal(reservedVoiceText('', 'computer', false), 'Computer');
  assert.equal(reservedVoiceText('', 'end capture', false), '');
  assert.equal(reservedVoiceText('', 'end capture', true), 'end capture');
  assert.equal(reservedVoiceText('', 'cancel capture', true), 'cancel capture');
  assert.equal(reservedVoiceText('A computer.', 'a computer', false), 'A computer.');
  assert.equal(reservedVoiceText('Hey computer.', 'hey computer', false), 'Hey computer.');
  assert.equal(reservedVoiceText('A computer.', 'computer', true), 'A computer.');
  assert.equal(reservedVoiceText('Computer open plan.', 'computer', false), 'Computer open plan.');
});

test('a garbled wake word still wakes: near misses alone, looser slips with phrase-grammar agreement, never inside a capture', () => {
  // Close enough on its own (one edit from "computer", s ignored).
  for (const heard of ['Computers switch to REA, over.', "Computer's switch to REA, over.", 'Commuter switch to REA, over.', 'Computed switch to REA, over.', 'Computor switch to REA, over.']) {
    assert.equal(reservedVoiceText(heard, '', false), 'Computer switch to REA, over.', heard);
  }
  assert.equal(reservedVoiceText('Compute, switch to REA, over.', '', false), 'Computer, switch to REA, over.');
  assert.equal(reservedVoiceText('Computers.', '', false), 'Computer.');
  // Too far on its own; accepted when the grammar (or fast wake) heard Computer first.
  assert.equal(reservedVoiceText('Come here, switch to REA, over.', '', false), 'Come here, switch to REA, over.');
  assert.equal(reservedVoiceText('Come here, switch to REA, over.', 'computer [unk] over', false), 'Computer, switch to REA, over.');
  // A split word wakes on its first half; the stray half is noise Computer reads past.
  assert.equal(reservedVoiceText('Compute her switch to REA, over.', '', false, true), 'Computer her switch to REA, over.');
  assert.equal(reservedVoiceText('Come pewter switch to REA, over.', '', false, true), 'Computer switch to REA, over.');
  // An unrecognizable first word still fails, and a preamble before a clear
  // Computer is never rewritten, even when the fast wake vouched.
  assert.equal(reservedVoiceText('Can you tell switch to REA, over.', '', false, true), 'Can you tell switch to REA, over.');
  assert.equal(reservedVoiceText('Hey Computer send now, over.', 'computer [unk]', false, true), 'Hey Computer send now, over.');
  // Ordinary speech while idle stays unrecognized without grammar agreement.
  for (const heard of ['Compiler errors again.', 'Come here.', 'Can you tell me the time?', 'The computer is slow.']) {
    assert.equal(reservedVoiceText(heard, '[unk]', false), heard, heard);
    assert.equal(voiceCommandBody(reservedVoiceText(heard, '[unk]', false)), null, heard);
  }
  // Inside a capture the same words are directive text.
  assert.equal(reservedVoiceText('Computers are slow today.', 'computer', true), 'Computers are slow today.');
  assert.equal(reservedVoiceText('Commuter traffic.', '', true, true), 'Commuter traffic.');
});

test('known mishearings of the closing phrase close the capture; an unrelated final word does not', () => {
  for (const heard of ["I'm capture.", 'Am capture', 'Good capture.', 'and capture', 'In capture!', 'then capture', 'Ended capture', 'end captcha']) {
    const buffer = new VoiceCommandBuffer();
    assert.deepEqual(buffer.accept(`Computer open plan ${heard}`), { kind: 'execute', text: 'open plan', started: true }, heard);
  }
  for (const heard of ['council capture', 'Cancel capture', 'cancer capture.']) {
    const buffer = new VoiceCommandBuffer();
    assert.deepEqual(buffer.accept(`Computer open plan ${heard}`), { kind: 'cancel' }, heard);
  }
  const buffer = new VoiceCommandBuffer();
  assert.equal(buffer.accept('Computer message this worker about screen capture').kind, 'pending');
  assert.equal(buffer.accept('and capture the logs too').kind, 'pending');
  assert.deepEqual(buffer.accept('am capture'), { kind: 'execute', text: 'message this worker about screen capture and capture the logs too', started: false });
  // Grammar-confirmed closing with a dropped or unknown first word.
  assert.equal(reservedVoiceText("Let's leave it there for now capture.", '[unk] end capture', true), "Let's leave it there for now End capture.");
  assert.equal(reservedVoiceText('Open plan, uh capture.', '[unk] end capture', true), 'Open plan, uh End capture.');
  assert.equal(reservedVoiceText('Open plan, the capture.', '[unk] cancel capture', true), 'Open plan, Cancel capture.');
  assert.equal(reservedVoiceText('Open plan, the capture.', '[unk]', true), 'Open plan, the capture.');
});

test('a lone "over" (or execute / engage / make it so) submits; inside a directive the same words stay literal', () => {
  const buffer = new VoiceCommandBuffer();
  assert.equal(buffer.accept('Computer put it over there').kind, 'pending');
  assert.equal(buffer.accept('execute the tests').kind, 'pending');
  assert.deepEqual(buffer.accept('Over.'), { kind: 'execute', text: 'put it over there execute the tests', started: false });
  // Said in the same breath: a phrase ending in the submit word also closes.
  assert.deepEqual(new VoiceCommandBuffer().accept('Computer open the plan, over.'), { kind: 'execute', text: 'open the plan', started: true });
  const b2 = new VoiceCommandBuffer(); b2.accept('Computer ask the reviewer');
  assert.deepEqual(b2.accept('how the auth work is going over'), { kind: 'execute', text: 'ask the reviewer how the auth work is going', started: false });
  assert.deepEqual(new VoiceCommandBuffer().accept('Computer, over'), { kind: 'empty' });
  const b3 = new VoiceCommandBuffer(); b3.accept('Computer tell it to cancel');
  assert.equal(b3.text, 'tell it to cancel', 'a trailing cancel word stays literal');
  b3.accept('and then execute'); assert.equal(b3.text, 'tell it to cancel and then execute', 'only over closes in trailing position');
  for (const word of ['Execute', 'engage.', 'Make it so!', '“Over”']) {
    const b = new VoiceCommandBuffer(); b.accept('Computer open plan');
    assert.deepEqual(b.accept(word), { kind: 'execute', text: 'open plan', started: false }, word);
  }
  const b = new VoiceCommandBuffer();
  assert.deepEqual(b.accept('Computer, over'), { kind: 'empty' });
  assert.equal(b.text, null);
  b.accept('Computer cancel the turn for builder one'); assert.equal(b.text, 'cancel the turn for builder one');
  assert.deepEqual(b.accept('Cancel.'), { kind: 'cancel' }); assert.equal(b.text, null);
  b.accept('Computer open plan'); assert.deepEqual(b.accept('belay that'), { kind: 'cancel' });
  assert.equal(new VoiceCommandBuffer().accept('over').kind, 'ignore', 'nothing armed: a lone word is ambient speech');
  assert.equal(reservedVoiceText('Oval.', 'over', true), 'over');
  assert.equal(reservedVoiceText('', 'engage', true), 'engage');
  assert.equal(reservedVoiceText('put it over.', 'over', true), 'put it over.');
  assert.equal(reservedVoiceText('Oval.', 'over', false), 'Oval.');
});

test('acoustically verified End capture submits the accumulated directive once despite And capture transcription', async () => {


  reset(); const executed: string[] = [];
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => true, converse: async (text) => { executed.push(text); return ''; } });
  await runtime.receive('Computer open plan');
  await runtime.receiveSegment('And capture.', 1, captureSnapshot, undefined, 'end capture');
  assert.deepEqual(executed, ['open plan']);
  assert.equal(useVoiceStore.getState().commandText, null);
  assert.equal(useVoiceStore.getState().lastHeard, 'And capture. → End capture.');
  await runtime.receiveSegment('And capture.', 2, captureSnapshot, undefined, 'end capture');
  assert.equal(executed.length, 1); runtime.stop();
});

test('a verified standalone Computer survives a general recognizer A computer hallucination without losing immediate words', async () => {
  reset(); const executed: string[] = [];
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => true, converse: async (text) => { executed.push(text); return ''; } });
  runtime.receiveWake(1, captureSnapshot);
  await runtime.receiveSegment('A computer open plan.', 1, captureSnapshot, undefined, 'computer [unk]');
  assert.equal(useVoiceStore.getState().commandText, 'open plan.');
  await runtime.receive('End capture');
  assert.deepEqual(executed, ['open plan']); runtime.stop();
});

test('fast wake immediately shows capture but never acts until the full first word and closing phrase are verified', async () => {
  reset(); const executed: string[] = [];
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => true, converse: async (text) => { executed.push(text); return ''; } });
  runtime.receiveWake(1, captureSnapshot);
  assert.equal(useVoiceStore.getState().commandText, ''); assert.deepEqual(executed, []);
  await runtime.receiveSegment('Computer open plan', 1, captureSnapshot);
  assert.equal(useVoiceStore.getState().commandText, 'open plan'); assert.deepEqual(executed, []);
  runtime.receiveWake(2, captureSnapshot); // A later Computer must not reset the directive.
  assert.equal(useVoiceStore.getState().commandText, 'open plan');
  await runtime.receive('End capture'); assert.deepEqual(executed, ['open plan']);
  runtime.receiveWake(1, captureSnapshot); assert.equal(useVoiceStore.getState().commandText, null);
  runtime.stop();
});

test('a speculative wake from a later Computer cannot authorize any model call or action', async () => {
  reset(); let acted = false;
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => { acted = true; return ''; }, canInterpret: () => { acted = true; return true; }, converse: async () => { acted = true; return ''; } });
  runtime.receiveWake(1, captureSnapshot);
  await runtime.receiveSegment('Hey Computer send now End capture', 1, captureSnapshot);
  assert.equal(acted, false); assert.equal(useVoiceStore.getState().commandText, null);
  assert.match(useVoiceStore.getState().status, /not verified/); runtime.stop();
});

test('early capture accepts manual end/cancel without losing verification or rearming on a late transcript', async () => {
  reset(); const executed: string[] = [];
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => true, converse: async (text) => { executed.push(text); return ''; } });
  runtime.receiveWake(1, captureSnapshot); await runtime.receive('End capture');
  assert.deepEqual(executed, []);
  await runtime.receiveSegment('Computer open plan', 1, captureSnapshot);
  assert.deepEqual(executed, ['open plan']);
  runtime.receiveWake(2, captureSnapshot); await runtime.receive('Cancel capture');
  await runtime.receiveSegment('Computer send now End capture', 2, captureSnapshot);
  assert.equal(executed.length, 1); assert.equal(useVoiceStore.getState().commandText, null);
  runtime.receiveWake(3, captureSnapshot); runtime.stop(); reset();
  await runtime.receiveSegment('Computer send now End capture', 3, captureSnapshot, 0);
  assert.equal(executed.length, 1); runtime.stop();
});

test('the END CAPTURE button waits behind in-flight recognition so the last phrase is part of the directive', async () => {
  reset(); const executed: string[] = []; let dictated = 0;
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => { dictated++; return ''; }, canInterpret: () => true, converse: async (text) => { executed.push(text); return ''; } });
  await runtime.receive('Computer open');
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (!String(url).includes('/api/voice/audio')) throw new Error(`unexpected request ${String(url)}`);
    await gate; return new Response(JSON.stringify({ text: 'the plan', phrases: '' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    runtime.ingest({ type: 'segment', utterance: 1, pcm: new ArrayBuffer(640), endpointMs: 350 });
    runtime.endCapture('End capture');
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(executed, []); assert.equal(useVoiceStore.getState().commandText, 'open');
    release(); await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(executed, ['open the plan']); assert.equal(useVoiceStore.getState().commandText, null);
    // A repeated click with nothing armed neither executes nor dictates.
    useVoiceStore.setState({ dictatingId: 'worker-a' });
    runtime.endCapture('End capture'); await new Promise((r) => setTimeout(r, 10));
    assert.equal(executed.length, 1); assert.equal(dictated, 0); assert.equal(useVoiceStore.getState().status, 'No capture to end.');
    // Cancel through the same ordered path discards the in-flight phrase too.
    await runtime.receive('Computer open');
    runtime.ingest({ type: 'segment', utterance: 2, pcm: new ArrayBuffer(640), endpointMs: 350 });
    runtime.endCapture('Cancel capture'); await new Promise((r) => setTimeout(r, 30));
    assert.equal(executed.length, 1); assert.equal(useVoiceStore.getState().commandText, null);
    assert.equal(useVoiceStore.getState().status, 'Capture cancelled. Nothing executed.');
  } finally { globalThis.fetch = originalFetch; runtime.stop(); }
});

test('a blank transcript during capture is reported and keeps the directive open; only the closing phrase submits', async () => {
  reset(); const executed: string[] = [];
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => true, converse: async (text) => { executed.push(text); return ''; } });
  await runtime.receive('Computer open plan');
  await runtime.receiveSegment('', 2, captureSnapshot);
  assert.equal(useVoiceStore.getState().commandText, 'open plan');
  assert.equal(useVoiceStore.getState().lastHeard, '(nothing recognized)');
  assert.match(useVoiceStore.getState().status, /not recognized/);
  assert.deepEqual(executed, []);
  await runtime.receiveSegment('', 3, captureSnapshot, undefined, 'end capture');
  assert.deepEqual(executed, ['open plan']);
  runtime.ingest({ type: 'level', rms: 0.002, peak: 0.004, noise: 0.0006, onset: 0.0035 });
  assert.equal(useVoiceStore.getState().inputLevel, 0.004); assert.equal(useVoiceStore.getState().speechOnset, 0.0035);
  runtime.stop();
});

test('early wake keeps the context from the start of audio rather than rebinding after transcription', async () => {

  reset(); let selected = context; let acted = false;
  const runtime = new VoiceRuntime({ context: () => selected, dictate: () => '', canInterpret: () => true, converse: async () => { acted = true; return ''; } });
  runtime.receiveWake(1, captureSnapshot); selected = { ...context, currentId: 'worker-b' };
  await runtime.receiveSegment('Computer send now End capture', 1, { ...captureSnapshot, context: selected });
  assert.equal(acted, false); assert.match(useVoiceStore.getState().status, /selection changed/); runtime.stop();
});

test('global spoken mode switches preserve a first request and ignore quoted mentions', () => {
  assert.deepEqual(voiceModeSwitch("let's talk about my question"), { mode: 'conversation', body: 'my question' });
  assert.deepEqual(voiceModeSwitch('Let’s talk. What should I do?'), { mode: 'conversation', body: 'What should I do?' });
  assert.deepEqual(voiceModeSwitch('back to Arco, switch to PS5'), { mode: 'archon', body: 'switch to PS5' });
  assert.equal(voiceModeSwitch('what does back to Arco mean?'), null);
});

test('mode changes and ordinary Computer conversation need no interpreter call or extra execute', async () => {
  reset(); const talks: string[] = []; const executed: VoiceCommand[] = [];
  const runtime = new VoiceRuntime({ context: () => context, execute: async (c) => { executed.push(c); return ''; },
    dictate: () => { throw new Error('Unexpected worker dictation'); }, canInterpret: () => true,
    converse: async (text) => { talks.push(text); return ''; },
    returnToControl: () => { useVoiceStore.setState({ mode: 'archon' }); return 'Arco control.'; } });
  await runtime.receive("Computer let's talk about the weather. End capture");
  assert.deepEqual(talks, ['the weather']);
  await runtime.receive('Computer open plan. End capture');
  assert.deepEqual(talks, ['the weather', 'open plan']); assert.deepEqual(executed, [], 'nothing is executed outside Computer');
  await runtime.receive('Computer back to Arco, switch to PS5. End capture');
  assert.equal(useVoiceStore.getState().mode, 'archon'); assert.deepEqual(talks, ['the weather', 'open plan', 'switch to PS5']);
  await runtime.receive('Computer stop listening');
  assert.equal(talks.length, 3); assert.equal(useVoiceStore.getState().enabled, false);
});

test('Computer is a projectless voice-operator chat; voice keeps the operator selection and drafts', async () => {
  fixture(); let created = 0; const sent: string[][] = [];
  useDraftStore.getState().setDraft('worker-a', 'Keep this worker draft.');
  useVoiceStore.setState({ dictatingId: 'worker-a' });
  const controller = new AbortController();
  const computer = new ComputerConversation({ createWorkflow: (config) => {
    created++; assert.equal(config.kind, 'chat'); assert.equal(config.workingDirectory, '');
    assert.equal(config.primaryModel, 'gpt-6-luna'); assert.equal(config.primaryEffort, 'low'); assert.equal(config.chatWebAccess, false);
    assert.equal(config.voiceOperator, true, 'the Computer chat carries the archon-voice tools');
    useAppStore.getState().createJob('computer-chat', config);
  }, sendMessage: (id, text) => { sent.push([id, text]); return true; } }, () => {});
  try {
    assert.equal(await computer.talk('How does this work?', controller.signal, '[Archon context] selected: Builder #1.'), '');
    assert.deepEqual(sent, [['computer-chat', '[Archon context] selected: Builder #1.\n\nHow does this work?']]);
    assert.equal(computer.chatId, 'computer-chat');
    assert.equal(useVoiceStore.getState().dictatingId, null);
    // Voice never leaves the operator on the Computer tab: tools act on the selection.
    assert.equal(useAppStore.getState().activeClusterId, 'cluster-a');
    assert.equal(useAppStore.getState().clusterFocusedMember['cluster-a'], 'worker-a');
    assert.equal(readDraft('worker-a'), 'Keep this worker draft.');
    await computer.talk('A second question.', controller.signal);
    assert.equal(created, 1); assert.equal(sent.length, 2); assert.equal(sent[1][1], 'A second question.');
  } finally { controller.abort(); }
});

test('Computer stays outside workbench selection, including a fresh workspace and a saved active Computer tab', () => {
  fixture();
  const config = { kind: 'chat' as const, name: 'Computer', workingDirectory: '', skipPermissions: false,
    primaryProvider: 'codex' as const, primaryModel: 'gpt-6-luna', primaryEffort: 'low' as const, voiceOperator: true };
  const s = useAppStore.getState();
  s.createJob('computer-chat', config);
  assert.equal(useAppStore.getState().activeClusterId, 'cluster-a');
  assert.equal(useAppStore.getState().activeJobId, null);
  assert.equal(useComputerStore.getState().open, false, 'voice creation does not open the transcript');
  s.setActiveJob('computer-chat');
  assert.equal(useComputerStore.getState().open, true, 'a history link opens the dedicated surface');
  assert.equal(useAppStore.getState().activeClusterId, 'cluster-a', 'viewing history keeps the tool target');
  useComputerStore.getState().setOpen(false);
  assert.equal(useVoiceStore.getState().enabled, true, 'closing history does not disable voice');

  const restored = { ...useAppStore.getState(), activeJobId: 'computer-chat', activeClusterId: null, showCreator: false };
  const finish = useAppStore.persist.getOptions().onRehydrateStorage?.(restored);
  if (typeof finish === 'function') finish(restored, undefined);
  assert.equal(restored.activeJobId, null, 'cluster members do not become standalone tabs during migration');
  assert.equal(restored.activeClusterId, 'cluster-a');
  assert.equal(restored.showCreator, false);
  assert.equal(restored.jobs['computer-chat'].config.voiceOperator, true, 'the saved thread survives migration');
  s.createJob('worker-c', { ...config, voiceOperator: false });
  const clustered = { ...useAppStore.getState(), activeJobId: 'computer-chat', activeClusterId: 'cluster-a', showCreator: false };
  const restoreCluster = useAppStore.persist.getOptions().onRehydrateStorage?.(clustered);
  if (typeof restoreCluster === 'function') restoreCluster(clustered, undefined);
  assert.equal(clustered.activeJobId, null, 'a saved cluster selection takes precedence over a fallback tab');
  assert.equal(clustered.activeClusterId, 'cluster-a');
  s.removeJob('worker-c');

  s.clearCluster('cluster-a');
  s.removeJob('worker-a'); s.removeJob('worker-b');
  useAppStore.setState({ activeJobId: null, activeClusterId: null, showCreator: true });
  s.createJob('computer-chat', config);
  assert.equal(useAppStore.getState().showCreator, true, 'Computer never takes over an empty workspace');
  s.createJob('worker-a', { ...config, voiceOperator: false });
  assert.equal(useAppStore.getState().activeJobId, 'worker-a', 'an ordinary chat named Computer is still a normal tab');
  s.removeJob('worker-a');
  assert.equal(useAppStore.getState().activeJobId, null, 'closing the last project cannot select Computer');
  assert.equal(useAppStore.getState().showCreator, true);
});

test('Computer opening cancelled by disabling voice cannot send a late question', async () => {
  fixture(); const controller = new AbortController(); let created!: Parameters<NonNullable<import('./executor.js').VoiceSenders['createWorkflow']>>[0]; let sent = false;
  const computer = new ComputerConversation({ createWorkflow: (config) => { created = config; }, sendMessage: () => { sent = true; return true; } }, () => {});
  const pending = computer.talk('Must not send.', controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  useAppStore.getState().createJob('computer-chat', created);
  assert.equal(sent, false); assert.equal(useVoiceStore.getState().mode, 'archon');
});

test('Computer reads only its new settled answer and returning to Arco cancels readback', async () => {
  fixture(); const controller = new AbortController(); const replies: string[] = [];
  const computer = new ComputerConversation({ createWorkflow: (config) => useAppStore.getState().createJob('computer-chat', config), sendMessage: () => true }, (text) => replies.push(text));
  const add = (id: string, text: string, streaming = false) => useAppStore.getState().addMessage('computer-chat', { id, role: 'assistant', content: text, isStreaming: streaming, timestamp: Date.now() });
  try {
    await computer.talk('', controller.signal); add('old', 'Previous answer.');
    await computer.talk('New question.', controller.signal);
    add('next', 'New answer.', true); assert.deepEqual(replies, []);
    useAppStore.getState().updateMessage('computer-chat', 'next', { isStreaming: false });
    assert.deepEqual(replies, ['New answer.']);
    await computer.talk('Another question.', controller.signal); computer.back();
    add('late', 'Late answer.'); assert.deepEqual(replies, ['New answer.']);
  } finally { controller.abort(); }
});

test('a bare Done. from Computer is not spoken; the operator reads the result in Arco', async () => {
  fixture(); const controller = new AbortController(); const replies: string[] = [];
  const computer = new ComputerConversation({ createWorkflow: (config) => useAppStore.getState().createJob('computer-chat', config), sendMessage: () => true }, (text) => replies.push(text));
  const add = (id: string, text: string) => useAppStore.getState().addMessage('computer-chat', { id, role: 'assistant', content: text, isStreaming: false, timestamp: Date.now() });
  try {
    await computer.talk('', controller.signal);
    await computer.talk('Switch to PS5 and ask the director where things stand.', controller.signal);
    useVoiceStore.setState({ status: 'Computer is working on it…' });
    add('done', 'Done.'); assert.deepEqual(replies, []); assert.equal(useVoiceStore.getState().status, 'Done.');
    await computer.talk('Which builder?', controller.signal);
    useVoiceStore.setState({ status: 'Computer is working on it…' });
    add('ask', 'Opus Builder or SOL Builder?'); assert.deepEqual(replies, ['Opus Builder or SOL Builder?']);
    assert.equal(useVoiceStore.getState().status, 'Computer replied. Open COMPUTER to read its response.');
  } finally { controller.abort(); }
});

test('Computer must be the first whole word; punctuation and letter case are accepted', () => {
  for (const text of ['Computer send now', 'Computer: send now', 'computer,send now', '  COMPUTER. send now  ']) {
    assert.equal(voiceCommandBody(text), 'send now');
  }
  assert.equal(voiceCommandBody('Computer'), ''); assert.equal(voiceCommandBody('Computer:'), '');
  for (const text of ['send now', 'Arco send now', 'Arcon send now', 'hey Computer send now', 'tell Computer send now', 'computerized send now', 'Computer-aided design']) {
    assert.equal(voiceCommandBody(text), null, text);
  }
});
test('unprefixed speech cannot reach Computer; a Computer directive reaches it once, on the closing', async () => {
  reset(); const originalFetch = globalThis.fetch; let calls = 0;
  const executed: string[] = [];
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected model request'); };
  try {
    const runtime = new VoiceRuntime({ context: () => context, dictate: () => { throw new Error('Unexpected dictation'); }, canInterpret: () => true, converse: async (text) => { executed.push(text); return ''; } });
    for (const text of ['send now', 'Arco send now', 'hey Computer send now', 'I told Computer to bring up the reviewer', 'Could you please bring up the reviewer?']) await runtime.receive(text);
    assert.equal(executed.length, 0); assert.equal(calls, 0);
    await runtime.receive('Computer: send now');
    assert.equal(executed.length, 0); assert.equal(calls, 0);
    await runtime.receive('End capture');
    assert.deepEqual(executed, ['send now']); assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('commands survive pauses and multiple segments, and execute exactly once on the explicit directive', async () => {
  reset(); const executed: string[] = [];
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => { throw new Error('Not dictating'); }, canInterpret: () => true, converse: async (text) => { executed.push(text); return ''; } });
  await runtime.receive('Computer'); await runtime.receive('open');
  await runtime.receive(''); await runtime.receive('Atlas');
  assert.equal(useVoiceStore.getState().commandText, 'open Atlas'); assert.equal(executed.length, 0);
  await runtime.receive('End capture');
  assert.deepEqual(executed, ['open Atlas']); assert.equal(useVoiceStore.getState().commandText, null);
  await runtime.receive('End capture'); assert.equal(executed.length, 1);
});
test('cancel and disable discard pending commands, while inline execution remains explicit', async () => {
  reset(); const executed: string[] = [];
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => true, converse: async (text) => { executed.push(text); return ''; } });
  await runtime.receive('Computer open plan'); await runtime.receive('Cancel capture'); await runtime.receive('End capture');
  assert.equal(executed.length, 0); assert.equal(useVoiceStore.getState().commandText, null);
  await runtime.receive('Computer open plan. End capture'); assert.deepEqual(executed, ['open plan']);
  await runtime.receive('Computer send now'); runtime.stop(); reset(); await runtime.receive('End capture');
  assert.equal(executed.length, 1);
});
test('capture cancellation discards empty and partially dictated requests without contacting Computer', async () => {
  for (const start of ['Computer', 'Computer nudge the SignalQueue Builder']) {
    for (const cancel of ['cancel', 'Cancel capture', 'Actually, cancel capture.', 'belay that', 'never mind']) {
      reset(); let calls = 0;
      const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => true,
        converse: async () => { calls++; return ''; } });
      await runtime.receive(start); await runtime.receive(cancel);
      assert.equal(useVoiceStore.getState().commandText, null, `${start} / ${cancel}`);
      await runtime.receive('End capture'); assert.equal(calls, 0, 'discarded capture must not become a script/worker command');
      runtime.stop();
    }
  }
  reset(); let calls = 0;
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => true,
    converse: async () => { calls++; return ''; } });
  await runtime.receive('Computer, tell the builder to change the tests, actually, cancel capture.');
  assert.equal(useVoiceStore.getState().commandText, null);
  await runtime.receive('End capture'); assert.equal(calls, 0, 'an inline Cancel capture discards all preceding words');
  await runtime.receive('Computer tell the worker to cancel the test');
  assert.match(useVoiceStore.getState().commandText!, /cancel the test/, 'bare cancel inside dictated text remains literal');
  await runtime.receive('Actually, cancel capture.'); assert.equal(calls, 0);
  runtime.stop();
});
test('pending command context cannot be redirected by navigation, and spends no quota before execute', async () => {
  reset(); const originalFetch = globalThis.fetch; let current = context, calls = 0, executed = false;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected model request'); };
  try {
    const runtime = new VoiceRuntime({ context: () => current, dictate: () => '', canInterpret: () => true, converse: async () => { executed = true; return ''; } });
    await runtime.receive('Computer I would like to message'); await runtime.receive('the reviewer when ready');
    assert.equal(calls, 0); assert.equal(executed, false);
    current = { ...context, currentId: 'worker-b' };
    await runtime.receive('End capture');
    assert.equal(calls, 0); assert.equal(executed, false); assert.match(useVoiceStore.getState().status, /selection changed/);
  } finally { globalThis.fetch = originalFetch; }
});
test('execute inside a phrase stays literal; command buffers are bounded and a new wake word cannot replace capture', () => {
  const buffer = new VoiceCommandBuffer();
  assert.equal(buffer.accept('open plan End capture').kind, 'ignore');
  assert.equal(buffer.accept('Computer open plan').kind, 'pending');
  assert.equal(buffer.accept('execute the tests').kind, 'pending');
  assert.equal(buffer.text, 'open plan execute the tests');
  assert.deepEqual(buffer.accept('Computer open files End capture'), { kind: 'execute', text: 'open plan execute the tests Computer open files', started: false });
  assert.equal(buffer.accept('Computer ' + 'x'.repeat(8001)).kind, 'overflow'); assert.equal(buffer.text, null);
});
test('a standalone Computer arms capture before a ten-second pause; silence timeout only discards', () => {
  const buffer = new VoiceCommandBuffer();
  assert.deepEqual(buffer.accept('Computer:', 0), { kind: 'pending', text: '', started: true });
  assert.equal(buffer.expiresAt, VOICE_CAPTURE_IDLE_MS);
  assert.equal(buffer.expire(10_000), false); assert.equal(buffer.text, '');
  assert.deepEqual(buffer.accept('open the plan', 10_001), { kind: 'pending', text: 'open the plan', started: false });
  assert.equal(buffer.expire(110_000), false);
  assert.deepEqual(buffer.accept('End capture', 110_001), { kind: 'execute', text: 'open the plan', started: false });
  buffer.accept('Computer', 200_000);
  assert.equal(buffer.expire(200_000 + VOICE_CAPTURE_IDLE_MS), true);
  assert.equal(buffer.text, null);
  assert.equal(buffer.accept('End capture', 400_000).kind, 'ignore');
});
test('only the full closing phrase at the end terminates, including across recognition segments', () => {
  const buffer = new VoiceCommandBuffer();
  for (const word of ['end', 'cancel', 'capture', 'execute']) {
    buffer.accept('Computer explain ' + word);
    assert.equal(buffer.accept('in the workflow').kind, 'pending');
    assert.equal(buffer.accept('Cancel capture').kind, 'cancel');
  }
  buffer.accept('Computer open the plan');
  assert.equal(buffer.accept('End').kind, 'pending');
  assert.deepEqual(buffer.accept('capture.'), { kind: 'execute', text: 'open the plan', started: false });
  buffer.accept('Computer send now');
  assert.equal(buffer.accept('Cancel').kind, 'cancel', 'a lone Cancel is itself a closing'); assert.equal(buffer.text, null);
  buffer.accept('Computer send now'); buffer.accept('Cancel the');
  assert.equal(buffer.accept('capture').kind, 'pending', 'split closing phrase with extra words stays literal');
  assert.equal(buffer.accept('Cancel capture').kind, 'cancel');
});

test('Computer inside an armed capture is literal text, including a standalone repeated word and a new ASR segment', () => {
  const buffer = new VoiceCommandBuffer();
  assert.deepEqual(buffer.accept('Computer', 0), { kind: 'pending', text: '', started: true });
  assert.deepEqual(buffer.accept('Computer', 1000), { kind: 'pending', text: 'Computer', started: false });
  assert.deepEqual(buffer.accept('is the name I want to use.', 2000), { kind: 'pending', text: 'Computer is the name I want to use.', started: false });
  assert.deepEqual(buffer.accept('Computer should wait while I think.', 3000), { kind: 'pending', text: 'Computer is the name I want to use. Computer should wait while I think.', started: false });
  assert.deepEqual(buffer.accept('End capture', 4000), { kind: 'execute', text: 'Computer is the name I want to use. Computer should wait while I think', started: false });
  assert.deepEqual(buffer.accept('Computer open plan', 5000), { kind: 'pending', text: 'open plan', started: true });
});

test('conversation receives all captured words once; later Computer cannot reset the text or rebind its starting context', async () => {
  reset(); useVoiceStore.setState({ mode: 'conversation' });
  let selected = context; const sent: string[] = [];
  const runtime = new VoiceRuntime({ context: () => selected, execute: async () => { throw new Error('Unexpected control action'); },
    dictate: () => { throw new Error('Unexpected dictation'); }, canInterpret: () => { throw new Error('Unexpected interpreter'); },
    converse: async (text) => { sent.push(text); return ''; } });
  await runtime.receive('Computer');
  await runtime.receive('Explain how the'); await runtime.receive('Computer should handle pauses.');
  assert.deepEqual(sent, []);
  assert.equal(useVoiceStore.getState().commandText, 'Explain how the Computer should handle pauses.');
  await runtime.receive('End capture');
  assert.deepEqual(sent, ['Explain how the Computer should handle pauses']);
  await runtime.receive('Computer explain');
  selected = { ...context, currentId: 'worker-b' };
  await runtime.receive('Computer should not redirect this.'); await runtime.receive('End capture');
  assert.equal(sent.length, 1); assert.match(useVoiceStore.getState().status, /selection changed/);
});
test('Computer receives the complete accumulated instruction with context only after the closing phrase', async () => {
  reset(); useVoiceStore.setState({ calls: 0 }); const requests: string[][] = [], executed: VoiceCommand[] = [];
  const runtime = new VoiceRuntime({ context: () => context, execute: async (c) => { executed.push(c); return ''; }, dictate: () => '', canInterpret: () => true,
    converse: async (text, _signal, ctx) => { requests.push([text, ctx ?? '']); return 'Brought up the reviewer.'; }, contextLine: () => '[Archon context] selected: Builder #1.' });
  await runtime.receive('Computer could you bring up'); await runtime.receive('my reviewer please');
  assert.equal(requests.length, 0); assert.equal(executed.length, 0);
  await runtime.receive('End capture');
  assert.deepEqual(requests, [['could you bring up my reviewer please', '[Archon context] selected: Builder #1.']]);
  assert.deepEqual(executed, [], 'the model acts through tools, not through the direct executor');
  assert.equal(useVoiceStore.getState().status, 'Brought up the reviewer.');
  assert.equal(useVoiceStore.getState().calls, 1);
});

test('every directive goes to Computer with the context line; spaced spoken project names resolve without guessing', async () => {
  // 2026-10-17 — no deterministic command matching: "switch to PS5 and tell
  // me where we're at" is Computer's to interpret against the roster.
  const spoken: VoiceContext = { ...context, clusterId: null, targets: [{ id: 'ps', name: 'PS5', kind: 'workflow' }, { id: 'live', name: 'Firelight', kind: 'workflow' }] };
  assert.equal(resolveVoiceTarget('P S five', spoken)[0]?.id, 'ps');
  assert.equal(resolveVoiceTarget('fire light', spoken)[0]?.id, 'live');
  reset(); const executed: VoiceCommand[] = []; const conversed: string[][] = [];
  useVoiceStore.setState({ lunaEnabled: true });
  const runtime = new VoiceRuntime({ context: () => spoken, execute: async (c) => { executed.push(c); return ''; }, dictate: () => '', canInterpret: () => true,
    converse: async (text, _s, ctx) => { conversed.push([text, ctx ?? '']); return 'ok'; }, contextLine: () => '[Archon context] selected: PS5 [workflow].' });
  for (const said of ["Computer switch to PS5 and tell me where we're at. End capture", 'Computer open the plan. End capture', 'Computer status. End capture']) await runtime.receive(said);
  assert.deepEqual(executed, []);
  assert.deepEqual(conversed.map((c) => c[0]), ["switch to PS5 and tell me where we're at", 'open the plan', 'status']);
  assert.equal(conversed[0][1], '[Archon context] selected: PS5 [workflow].');
  useVoiceStore.setState({ lunaEnabled: false });
  await runtime.receive('Computer open the plan. End capture');
  assert.equal(conversed.length, 3); assert.match(useVoiceStore.getState().status, /Computer is off/); runtime.stop();
});

test('the context line names every open target even when member roles are long prose', () => {
  const { executor } = fixture(); const state = useAppStore.getState();
  const prose = 'Director role. Delegate via peer_send, never Task; do not write code; verify claims; plan = rules + tasks; you land. '.repeat(3);
  state.setClusterState('cluster-a', { ...state.clusters['cluster-a'], members: [
    { workflowId: 'worker-a', displayName: 'Director', status: 'idle', role: prose },
    { workflowId: 'worker-b', displayName: 'Builder 1', status: 'busy', role: 'Implementer role. Focus on your assigned scope. Use peer_send to report progress + blockers, not to direct peers.' },
  ] });
  for (const name of ['atlantis-maint', 'REA', 'SignalQueue', 'GroundTruth', 'firelight', 'kestrel', 'atlas', 'ACME-email-migration'])
    state.createJob(name.toLowerCase(), { name, workingDirectory: '/tmp/voice-fixture', skipPermissions: false, primaryProvider: 'codex', primaryModel: 'gpt-6-luna', primaryEffort: 'low' });
  const line = executor.contextLine();
  for (const name of ['atlantis-maint', 'REA', 'SignalQueue', 'GroundTruth', 'firelight', 'kestrel', 'atlas', 'ACME-email-migration']) state.removeJob(name.toLowerCase());
  assert.match(line, /^\[Archon context\] selected: Director \(Director\) in cluster Atlas\. Open: cluster Atlas: Director \(Director\), Builder 1 \(BUILDER\); workflows: /);
  for (const name of ['atlantis-maint', 'REA', 'SignalQueue', 'GroundTruth', 'ACME-email-migration']) assert(line.includes(name), name);
  assert(!line.includes('peer_send'), 'role prose is not in the line'); assert(line.length < 600, String(line.length));
});

test('Computer can read what a project is doing through archon_read_recent and archon_status', async () => {
  const { executor } = fixture(); const state = useAppStore.getState();
  const now = Date.now();
  state.addMessage('worker-b', { id: 'u1', role: 'user', content: 'Refactor the parser and add tests.', isStreaming: false, timestamp: now - 600000 });
  state.addMessage('worker-b', { id: 'a1', role: 'assistant', content: 'Parser refactored.\n```ts\nconst x = 1;\n```\nRunning tests next.', isStreaming: false, timestamp: now - 300000 });
  state.addMessage('worker-b', { id: 'a2', role: 'assistant', content: 'Three tests fail in tokenizer.test.ts, fixing.', isStreaming: true, timestamp: now - 60000 });
  useAppStore.setState((s) => ({ jobs: { ...s.jobs, 'worker-b': { ...s.jobs['worker-b'], turnStartedAt: now - 290000, lastPrimaryEventAt: now - 5000,
    activity: [{ id: 't1', kind: 'tool_use', tool: 'Bash', status: 'in_progress', at: now - 5000 }], plan: { id: 'p', title: 'Parser rewrite', updatedAt: now } } } }));
  const digest = await executor.runTool({ type: 'voice_tool_call', workflowId: 'c', requestId: 'r', tool: 'archon_read_recent', args: { target: 'builder two', messages: '2' } });
  assert.match(digest, /^Builder #2, agent workflow on codex gpt-6-luna\./);
  assert.match(digest, /State: working, turn started 5 minutes ago, last activity 1 minute ago/);
  assert.match(digest, /Current or latest tool: Bash \(in_progress\)/);
  assert.match(digest, /Plan: Parser rewrite\./);
  assert.match(digest, /2 unread peer messages/);
  assert.match(digest, /Last 2 messages, oldest first:/);
  assert.doesNotMatch(digest, /Refactor the parser/);
  assert.match(digest, /Builder #2: Parser refactored\. \(code omitted\) Running tests next\./);
  assert.match(digest, /Builder #2 \(still writing\): Three tests fail/);
  assert.match(await executor.runTool({ type: 'voice_tool_call', workflowId: 'c', requestId: 'r', tool: 'archon_read_recent', args: { target: 'this' } }), /^Builder #1, .*\nState: idle\./);
  assert.equal(await executor.runTool({ type: 'voice_tool_call', workflowId: 'c', requestId: 'r', tool: 'archon_status', args: { target: 'builder two' } }), 'Builder #2 is active.');
  assert.match(await executor.runTool({ type: 'voice_tool_call', workflowId: 'c', requestId: 'r', tool: 'archon_status', args: {} }), /Builder #1: idle, 1 pending mail/);
});
test('target resolution understands number words, stable IDs, scoped roles and qualified names', () => {
  assert.equal(resolveVoiceTarget('builder two', context)[0]?.id, 'worker-b');
  assert.equal(resolveVoiceTarget('member two', context)[0]?.id, 'worker-b');
  assert.equal(resolveVoiceTarget('worker-b', context)[0]?.id, 'worker-b');
  assert.deepEqual(resolveVoiceTarget('reviewer', context).map((t) => t.id), ['worker-b']);
  assert.equal(resolveVoiceTarget('reviewer in Atlas', context)[0]?.id, 'worker-b');
  assert.equal(resolveVoiceTarget('missing worker', context).length, 0);
  // 2026-10-17 — phonetic spellings and spoken punctuation from the recognizer.
  const tabs: VoiceContext = { currentId: 'o', clusterId: null, targets: [
    { id: 'o', name: 'ATLAS', kind: 'workflow' }, { id: 'om', name: 'ATLANTIS-MAINT', kind: 'cluster' },
    { id: 'rea', name: 'REA', kind: 'workflow' }, { id: 'sq', name: 'SignalQueue', kind: 'workflow' }, { id: 'ps', name: 'PS5', kind: 'workflow' }] };
  assert.deepEqual(resolveVoiceTarget('atlantus hyphen maint', tabs).map((t) => t.id), ['om']);
  assert.deepEqual(resolveVoiceTarget('atlantis maint', tabs).map((t) => t.id), ['om']);
  assert.deepEqual(resolveVoiceTarget('atlas', tabs).map((t) => t.id), ['o']);
  assert.deepEqual(resolveVoiceTarget('ray', tabs).map((t) => t.id), []);
  assert.deepEqual(resolveVoiceTarget('zorblax', tabs).map((t) => t.id), []);
  // Computer's targets for the selection, as Luna actually phrases them.
  for (const spoken of ['this project', 'the project', 'it', 'the current tab', 'this one', 'this workflow', 'the current workflow', 'this'])
    assert.deepEqual(resolveVoiceTarget(spoken, context).map((t) => t.id), [context.currentId], spoken);
});

test('voice compaction requires an exact idle supported worker and acknowledges the actual busy claim',async()=>{
  const {executor}=fixture();const s=useAppStore.getState();
  const original=s.wsSendRaw;
  useAppStore.setState((next)=>({jobs:{...next.jobs,'worker-a':{...next.jobs['worker-a'],config:{...next.jobs['worker-a'].config,codexTransport:'appserver'}}}}));
  const sent:unknown[]=[];
  useAppStore.setState({wsSendRaw:(m)=>{sent.push(m);useAppStore.setState((next)=>({jobs:{...next.jobs,'worker-a':{...next.jobs['worker-a'],busy:true}}}));}});
  try{
    const reply=await executor.runTool({type:'voice_tool_call',workflowId:'computer-chat',requestId:'compact',tool:'archon_compact',args:{target:'worker-a'}});
    assert.match(reply,/requested/);assert.deepEqual(sent,[{type:'compact_workflow',workflowId:'worker-a'}]);
    await assert.rejects(executor.runTool({type:'voice_tool_call',workflowId:'computer-chat',requestId:'again',tool:'archon_compact',args:{target:'worker-a'}}),/busy/);
  }finally{useAppStore.setState({wsSendRaw:original});}
});

function fixture() {
  reset();
  const s = useAppStore.getState();
  for (const id of ['worker-a', 'worker-b']) s.createJob(id, { name: id, workingDirectory: '/tmp/voice-fixture', skipPermissions: false, primaryProvider: 'codex', primaryModel: 'gpt-6-luna', primaryEffort: 'low' });
  s.setClusterState('cluster-a', { clusterId: 'cluster-a', cwd: '/tmp/voice-fixture', name: 'Atlas', createdAt: '', taskBoardMode: 'none', taskBoardAttached: false,
    mailboxDepth: { 'worker-a': 1, 'worker-b': 2 }, members: [
      { workflowId: 'worker-a', displayName: 'Builder #1', status: 'idle' },
      { workflowId: 'worker-b', displayName: 'Builder #2', status: 'busy' },
    ] });
  s.setActiveCluster('cluster-a'); s.setClusterFocusedMember('cluster-a', 'worker-a');
  useAppStore.setState((state) => ({ connected: true, jobs: { ...state.jobs, 'worker-b': { ...state.jobs['worker-b'], busy: true } } }));
  const sent: unknown[][] = [], cancelled: string[] = [];
  const executor = new VoiceExecutor({ sendMessage: (...args) => { sent.push(args); return true; }, cancel: (id) => cancelled.push(id) });
  return { executor, sent, cancelled };
}

test('voice navigation and successful sends follow the selected transcript without moving unrelated history', async () => {
  const { executor } = fixture();
  await executor.execute(cmd('member', 'member one'));
  assert.equal(useChatFollowStore.getState().request?.workflowId, 'worker-a');
  const seq = useChatFollowStore.getState().request!.seq;
  await executor.execute(cmd('nudge', 'member one'));
  assert(useChatFollowStore.getState().request!.seq > seq);
  const current = useChatFollowStore.getState().request;
  await executor.execute(cmd('nudge', 'member two'));
  assert.equal(useChatFollowStore.getState().request, current, 'a background recipient cannot scroll the selected worker');
  const disconnected = new VoiceExecutor({ sendMessage: () => false, cancel: () => {} });
  await assert.rejects(disconnected.runTool({ type: 'voice_tool_call', workflowId: 'c', requestId: 'r', tool: 'archon_send_message', args: { target: 'worker-a', text: 'Not delivered.' } }), /Disconnected/);
  assert.equal(useChatFollowStore.getState().request, current, 'a failed send cannot re-pin history');
  await executor.execute(cmd('member', 'member two'));
  assert.equal(useChatFollowStore.getState().request?.workflowId, 'worker-b');
  await executor.execute(cmd('back'));
  assert.equal(useChatFollowStore.getState().request?.workflowId, 'worker-a');
});

test('project updates ask only the unique director and read only the new settled answer', async () => {
  fixture(); const state = useAppStore.getState(), replies: string[] = [], sent: unknown[][] = [];
  state.setClusterState('cluster-a', { ...state.clusters['cluster-a'], members: [
    { workflowId: 'worker-a', displayName: 'Director', status: 'idle' },
    { workflowId: 'worker-b', displayName: 'Builder', status: 'busy' },
  ] });
  state.addMessage('worker-a', { id: 'old', role: 'assistant', content: 'Old answer', isStreaming: false, timestamp: 1 });
  const executor = new VoiceExecutor({ sendMessage: (...args) => { sent.push(args); return true; }, cancel: () => {} }, (text) => replies.push(text));
  assert.match(await executor.execute(cmd('project-status', 'Atlas')), /Asking Director/);
  assert.equal(sent[0][0], 'worker-a'); assert.equal(sent[0][3], 'follow-up');
  assert.match(String(sent[0][1]), /Do not start new work/); assert.deepEqual(replies, []);
  state.addMessage('worker-a', { id: 'new', role: 'assistant', content: 'Progress, blocker, next step.', isStreaming: true, timestamp: 2 });
  assert.deepEqual(replies, []);
  state.updateMessage('worker-a', 'new', { isStreaming: false });
  assert.deepEqual(replies, ['Progress, blocker, next step.']);
  await executor.execute(cmd('project-status', 'Atlas')); useVoiceStore.setState({ enabled: false });
  state.addMessage('worker-a', { id: 'late', role: 'assistant', content: 'Late answer.', isStreaming: false, timestamp: 3 });
  assert.equal(replies.length, 1);
});

test('project status preserves drafts, refuses director guesses and never reads the prior busy turn', async () => {
  const { executor, sent } = fixture();
  assert.match(await executor.execute(cmd('project-status', 'Atlas')), /Which member/); assert.equal(sent.length, 0);
  useDraftStore.getState().setDraft('worker-a', 'Keep my draft');
  assert.match(await executor.execute(cmd('project-status', 'member one')), /unsent draft/); assert.equal(sent.length, 0);
  assert.equal(readDraft('worker-a'), 'Keep my draft');
  const replies: string[] = [];
  const busyExecutor = new VoiceExecutor({ sendMessage: (...args) => { sent.push(args); return true; }, cancel: () => {} }, (text) => replies.push(text));
  assert.match(await busyExecutor.execute(cmd('project-status', 'member two')), /queued after/);
  useAppStore.getState().addMessage('worker-b', { id: 'old-turn', role: 'assistant', content: 'Previous turn finished.', isStreaming: false, timestamp: 4 });
  assert.deepEqual(replies, []);
});

test('help and clarification responses stay brief instead of speaking the command manual', async () => {
  const { executor } = fixture();
  assert((await executor.execute(cmd('help'))).length < 150);
  assert.equal(await executor.execute(cmd('help', '', 'Which workflow should I open?')), 'Which workflow should I open?');
});

test('dictation stays addressed to its original worker across navigation and silence never sends', async () => {
  const { executor, sent } = fixture();
  await executor.execute(cmd('dictate', 'member one'));
  executor.dictate('Check the failing tests.');
  await executor.execute(cmd('member', 'member two'));
  executor.dictate('Keep the current API.');
  assert.equal(readDraft('worker-a'), 'Check the failing tests. Keep the current API.');
  assert.equal(readDraft('worker-b'), ''); assert.equal(sent.length, 0);
  await executor.execute(cmd('finish'));
  await executor.execute(cmd('follow-up'));
  assert.deepEqual(sent, [['worker-a', 'Check the failing tests. Keep the current API.', undefined, 'follow-up']]);
  assert.equal(readDraft('worker-a'), '');
});
test('disconnect, target mismatch and removed recipients preserve the draft without sending', async () => {
  const { executor, sent } = fixture();
  await executor.execute(cmd('dictate', 'member one')); executor.dictate('Keep this draft.');
  useAppStore.setState({ connected: false });
  await executor.execute(cmd('send')); assert.equal(sent.length, 0); assert.equal(readDraft('worker-a'), 'Keep this draft.');
  useAppStore.setState({ connected: true });
  await executor.execute(cmd('send', 'member two')); assert.equal(sent.length, 0);
  useAppStore.getState().setClusterState('cluster-a', { ...useAppStore.getState().clusters['cluster-a'], members: [] });
  useAppStore.getState().removeJob('worker-a');
  await executor.execute(cmd('send')); assert.equal(sent.length, 0);
});
test('active nudges use gentle steer wording; idle nudges use wake-up wording', async () => {
  const { executor, sent } = fixture();
  await executor.execute(cmd('nudge', 'member two'));
  assert.match(String(sent[0][1]), /convenient point in your current work/); assert.equal(sent[0][3], 'steer');
  await executor.execute(cmd('nudge', 'member one'));
  assert.match(String(sent[1][1]), /peer mail waiting/);
});
test('an ambiguous name comes back to Computer as a question and nothing is sent', async () => {
  const { executor, sent } = fixture();
  await assert.rejects(executor.runTool({ type: 'voice_tool_call', workflowId: 'c', requestId: 'r', tool: 'archon_send_message', args: { target: 'builder', text: 'stop' } }), /Which one: Builder #1, Builder #2\?/);
  assert.equal(sent.length, 0);
  assert.equal(await executor.runTool({ type: 'voice_tool_call', workflowId: 'c', requestId: 'r', tool: 'archon_select', args: { target: 'Zorblax' } }), 'No open target is named Zorblax.');
});
test('Incognito targets stay outside interpreter context', async () => {
  const { executor } = fixture();
  useAppStore.setState((s) => ({ jobs: { ...s.jobs, 'worker-a': { ...s.jobs['worker-a'], config: { ...s.jobs['worker-a'].config, incognito: true } } } }));
  assert.equal(executor.canInterpret(), false);
  assert(!executor.interpreterContext().targets.some((t) => t.id === 'worker-a'));
  useAppStore.getState().setClusterFocusedMember('cluster-a', 'worker-b');
  assert.equal(executor.canInterpret('bring up Builder #1 please'), false);
  assert.equal(executor.canInterpret('show my settings please'), true);
});

test('off state ignores speech completely and does not invoke any input service', async () => {
  useVoiceStore.setState({ enabled: false });
  const executed: string[] = [];
  const r = new VoiceRuntime({ context: () => context, dictate: () => { throw new Error('Unexpected dictation'); }, canInterpret: () => true, converse: async (t) => { executed.push(t); return ''; } });
  await r.receive('Computer send now'); await r.receive('End capture'); assert.equal(executed.length, 0);
});
test('ambient speech is ignored; dictated text does not call Computer', async () => {
  reset(); let count = 0, text = '';
  const r = new VoiceRuntime({ context: () => context, dictate: (t) => { text += t; return ''; }, canInterpret: () => true, converse: async () => { count++; return ''; } });
  await r.receive('send message'); assert.equal(count, 0); assert.equal(text, '');
  useVoiceStore.setState({ dictatingId: 'worker-a' });
  await r.receive('Do not send a message yet.'); assert.equal(text, 'Do not send a message yet.'); assert.equal(count, 0);
  await r.receive('Computer finish message'); assert.equal(count, 0);
  await r.receive('End capture'); assert.equal(count, 1);
});
test('a Computer request in flight is abandoned on disable and its late reply is not spoken', async () => {
  reset(); let resolve!: (r: string) => void; let signal: AbortSignal | undefined; const executed: VoiceCommand[] = [];
  const runtime = new VoiceRuntime({ context: () => context, execute: async (c) => { executed.push(c); return ''; }, dictate: () => '', canInterpret: () => true,
    converse: (_text, s) => { signal = s; return new Promise<string>((r) => { resolve = r; }); } });
  const pending = runtime.receive('Computer could you bring up my reviewer? End capture');
  await Promise.resolve(); runtime.stop();
  assert(signal?.aborted);
  resolve('Late reply.');
  await pending; assert.equal(executed.length, 0); assert.notEqual(useVoiceStore.getState().status, 'Late reply.');
});
// Playback fixture: a fake AudioContext whose sources report when they are
// started and stopped, and a speak endpoint that returns silence.
function fakeAudio() {
  const sources: Array<{ buffer: unknown; started: boolean; stopped: boolean; onended: null | (() => void) }> = [];
  const pcm = { numberOfChannels: 1, length: 1600, sampleRate: 16000, getChannelData: () => new Float32Array(1600) };
  const audio = {
    destination: {}, close: async () => {},
    decodeAudioData: async () => pcm,
    createBuffer: (channels: number, length: number, rate: number) => ({ numberOfChannels: channels, length, sampleRate: rate, copyToChannel() {} }),
    createBufferSource: () => {
      const s = { buffer: null, onended: null as null | (() => void), started: false, stopped: false, connect() {}, disconnect() {}, start() { s.started = true; }, stop() { s.stopped = true; s.onended?.(); } };
      sources.push(s); return s;
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })) as unknown as typeof fetch;
  const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
  return { audio: audio as unknown as AudioContext, sources, tick, finish: async () => { sources.at(-1)?.onended?.(); await tick(); }, restore: () => { globalThis.fetch = realFetch; } };
}
const speakingSnapshot = { draftAtCapture: null, speaking: true, context };

test('the quiet capture cue plays once after verified wake, at its authored level, without delaying following words', async () => {
  reset();
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => false });
  const fx = fakeAudio();
  const wav = readFileSync(new URL('../../../server/src/voice/capture-ready.wav', import.meta.url));
  const pcm = Float32Array.from({ length: (wav.length - 44) / 2 }, (_, i) => wav.readInt16LE(44 + i * 2) / 32768);
  const cue: AudioBuffer = { numberOfChannels: 1, length: pcm.length, sampleRate: 48000, duration: .23,
    getChannelData: () => pcm, copyFromChannel() {}, copyToChannel() {} };
  runtime.attachAudio(fx.audio, cue);
  try {
    runtime.receiveWake(1, captureSnapshot); assert.equal(fx.sources.length, 0, 'a grammar guess is silent');
    await runtime.receiveSegment('Thank you.', 1, captureSnapshot, undefined, '[unk]');
    assert.equal(fx.sources.length, 0);
    runtime.receiveWake(2, captureSnapshot);
    await runtime.receiveSegment('Computer.', 2, captureSnapshot, undefined, 'computer');
    assert.equal(fx.sources.length, 1); assert.equal(fx.sources[0].buffer, cue);
    assert(Math.max(...pcm.map(Math.abs)) < .066, 'the subtle cue is not normalized toward alert volume');
    // The cue has not ended, yet capture accepts the immediate next phrase.
    await runtime.receive('open the plan', 0, captureSnapshot);
    assert.equal(useVoiceStore.getState().commandText, 'open the plan');
    await runtime.receive('computer', 0, captureSnapshot);
    assert.equal(fx.sources.length, 1, 'the name inside a capture cannot replay the cue');
  } finally { runtime.stop(); fx.restore(); }
});

test('a voice change preserves an ongoing reply and its prefetch, then applies to the next reply', async () => {
  reset(); useVoiceStore.setState({ spokenFeedback: true, outputVoice: 'en-US-JennyNeural' });
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => false });
  const fx = fakeAudio(); runtime.attachAudio(fx.audio);
  const requests: Array<{ voice?: string; text: string }> = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(init!.body as string));
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  }) as typeof fetch;
  try {
    runtime.speak('First sentence. Second sentence. Third sentence.'); await fx.tick();
    useVoiceStore.getState().setOutputVoice('en-US-AvaNeural');
    assert.equal(fx.sources[0].stopped, false); assert.equal(useVoiceStore.getState().enabled, true);
    await fx.finish(); await fx.finish(); await fx.finish();
    assert.equal(requests.length, 3); assert(requests.every((r) => r.voice === 'en-US-JennyNeural'));
    runtime.speak('A new reply.'); await fx.tick();
    assert.equal(requests.at(-1)?.voice, 'en-US-AvaNeural');
  } finally { runtime.stop(); fx.restore(); }
});

test('a live voice sample uses normal interruptible playback even with spoken feedback off', async () => {
  reset();
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => false,
    converse: async () => { throw Error('Audition must not call Luna'); } });
  const fx = fakeAudio(); runtime.attachAudio(fx.audio);
  try {
    runtime.speak('Of course. Take your time.', true); await fx.tick();
    assert.equal(fx.sources.length, 1);
    await runtime.receive('quiet', 0, speakingSnapshot);
    assert.equal(fx.sources[0].stopped, true);
    assert.equal(useVoiceStore.getState().spokenFeedback, false);
    assert.equal(useVoiceStore.getState().enabled, true);
  } finally { runtime.stop(); fx.restore(); }
});

test('a bare "stop" or "quiet" cuts playback without the name; other playback audio cannot arm or execute', async () => {
  reset(); useVoiceStore.setState({ spokenFeedback: true }); let executed = false; const fx = fakeAudio();
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => { executed = true; return ''; }, canInterpret: () => true, converse: async () => { executed = true; return ''; } });
  runtime.attachAudio(fx.audio);
  try {
    runtime.speak('Strata routes each request.'); await fx.tick();
    assert.equal(useVoiceStore.getState().phase, 'speaking'); assert.equal(fx.sources.length, 1);
    await runtime.receive('send now', 0, speakingSnapshot); assert.equal(executed, false); assert.equal(useVoiceStore.getState().commandText, null);
    assert.equal(useVoiceStore.getState().phase, 'speaking', 'ordinary words during playback change nothing');
    await runtime.receive('Stop.', 0, speakingSnapshot);
    assert.equal(fx.sources[0].stopped, true); assert.equal(useVoiceStore.getState().phase, 'listening'); assert.equal(useVoiceStore.getState().status, 'Stopped.');
    await runtime.receive('Computer stop listening', 0, speakingSnapshot); assert.equal(useVoiceStore.getState().enabled, false);
  } finally { fx.restore(); runtime.stop(); }
});

test('"Computer" while it talks holds playback, then ends it and waits; an unverified wake resumes the sentence', async () => {
  reset(); useVoiceStore.setState({ spokenFeedback: true }); const fx = fakeAudio();
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => true, converse: async () => '' });
  runtime.attachAudio(fx.audio);
  try {
    runtime.speak('Strata routes each request. It picks the expert.'); await fx.tick();
    assert.equal(fx.sources.length, 1);
    // The phrase grammar guessed Computer: playback is held, not killed.
    runtime.receiveWake(1, speakingSnapshot); await fx.tick();
    assert.equal(fx.sources[0].stopped, true); assert.equal(fx.sources.length, 1, 'held: nothing replays yet');
    assert.equal(useVoiceStore.getState().phase, 'speaking'); assert.equal(useVoiceStore.getState().commandText, '');
    // The transcript says it was not Computer: the held sentence replays.
    await runtime.receiveSegment('Thank you.', 1, speakingSnapshot, undefined, '[unk]'); await fx.tick();
    assert.equal(fx.sources.length, 2, 'released: the sentence restarts'); assert.equal(fx.sources[1].started, true);
    assert.equal(useVoiceStore.getState().commandText, null); assert.equal(useVoiceStore.getState().phase, 'speaking');
    // A verified Computer ends playback and opens a capture that waits.
    runtime.receiveWake(2, speakingSnapshot); await fx.tick(); assert.equal(fx.sources[1].stopped, true);
    await runtime.receiveSegment('Computer.', 2, speakingSnapshot, undefined, 'computer'); await fx.tick();
    assert.equal(fx.sources.length, 2, 'no replay after a verified wake'); assert.equal(useVoiceStore.getState().phase, 'listening');
    assert.equal(useVoiceStore.getState().commandText, '', 'capture open, waiting for the next words');
    // "stop" as the first word closes the empty capture with nothing.
    await runtime.receive('Stop.'); assert.equal(useVoiceStore.getState().commandText, null);
    assert.match(useVoiceStore.getState().status, /cancelled/i);
  } finally { fx.restore(); runtime.stop(); }
});

test('"Computer, switch to the reviewer, over" interrupts and acts in one breath', async () => {
  reset(); useVoiceStore.setState({ spokenFeedback: true }); const fx = fakeAudio(); const asked: string[] = [];
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => true, converse: async (text) => { asked.push(text); return ''; } });
  runtime.attachAudio(fx.audio);
  try {
    runtime.speak('Strata routes each request.'); await fx.tick();
    await runtime.receive('Computer switch to the reviewer over', 0, speakingSnapshot); await fx.tick();
    assert.equal(fx.sources[0].stopped, true); assert.deepEqual(asked, ['switch to the reviewer']);
  } finally { fx.restore(); runtime.stop(); }
});

test('a wake heard while Computer is saying its own name is ignored and playback continues', async () => {
  reset(); useVoiceStore.setState({ spokenFeedback: true }); const fx = fakeAudio(); let asked = 0;
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => true, converse: async () => { asked++; return ''; } });
  runtime.attachAudio(fx.audio);
  try {
    runtime.speak('Say Computer, then speak.'); await fx.tick();
    runtime.receiveWake(1, speakingSnapshot); await fx.tick();
    assert.equal(fx.sources[0].stopped, false, 'not held'); assert.equal(useVoiceStore.getState().commandText, null);
    await runtime.receive('Computer open plan over', 0, speakingSnapshot); await fx.tick();
    assert.equal(asked, 0); assert.equal(fx.sources[0].stopped, false); assert.equal(useVoiceStore.getState().phase, 'speaking');
    // The name-free interrupt still works during that sentence.
    await runtime.receive('quiet', 0, speakingSnapshot); assert.equal(fx.sources[0].stopped, true);
  } finally { fx.restore(); runtime.stop(); }
});

test('"stop" closes only an empty capture; inside a directive it is literal, and "Computer stop" is instant', () => {
  const buffer = new VoiceCommandBuffer();
  assert.deepEqual(buffer.accept('Computer.'), { kind: 'pending', text: '', started: true });
  assert.deepEqual(buffer.accept('Stop.'), { kind: 'cancel' });
  assert.deepEqual(buffer.accept('Computer tell the director to'), { kind: 'pending', text: 'tell the director to', started: true });
  assert.deepEqual(buffer.accept('stop'), { kind: 'pending', text: 'tell the director to stop', started: false });
  assert.deepEqual(buffer.accept('the tests, over'), { kind: 'execute', text: 'tell the director to stop the tests', started: false });
  assert.deepEqual(buffer.accept('Computer, stop'), { kind: 'quiet' });
  assert.deepEqual(buffer.accept('Computer'), { kind: 'pending', text: '', started: true });
  assert.deepEqual(buffer.accept('quiet'), { kind: 'cancel' });
});

test('archon_open_dialog opens a picker, never the action; unavailable dialogs are reported, not claimed', async () => {
  const { executor, sent } = fixture();
  const call = (name: string) => executor.runTool({ type: 'voice_tool_call', workflowId: 'c', requestId: 'r', tool: 'archon_open_dialog', args: { name } });
  assert.match(await call('settings'), /There is no settings dialog/);
  // No component owns the dialogs here (node): requests stay unhandled and say so.
  assert.match(await call('nudge dialog'), /nudge dialog is not available for the current selection/);
  assert.match(await call('review'), /review dialog is not available for the current selection/);
  useAppStore.getState().setActiveCluster(null as never); useAppStore.setState({ activeClusterId: null, activeJobId: null } as never);
  assert.match(await call('nudge'), /only available while a cluster is selected/);
  assert.deepEqual(sent, [], 'opening a dialog never sends anything');
});

test('a message addressed to a cluster goes to its single Director; otherwise the members are listed', async () => {
  const { executor, sent } = fixture();
  const call = () => executor.runTool({ type: 'voice_tool_call', workflowId: 'c', requestId: 'r', tool: 'archon_send_message', args: { target: 'Atlas', text: 'What is going on?' } });
  await assert.rejects(call, /Atlas is a cluster with no Director; name one of its members: Builder #1, Builder #2\./);
  const state = useAppStore.getState();
  state.setClusterState('cluster-a', { ...state.clusters['cluster-a'], members: [
    { workflowId: 'worker-a', displayName: 'Director', status: 'idle', role: 'Director role. Delegate via peer_send.' },
    { workflowId: 'worker-b', displayName: 'Builder', status: 'busy' },
  ] });
  assert.equal(await call(), 'Message sent to Director.');
  assert.deepEqual(sent.map((x) => [x[0], x[1]]), [['worker-a', 'What is going on?']]);
});


test('a full Computer clear discards pending capture without disabling the microphone', async () => {
  reset();
  const sent: string[] = [];
  const runtime = new VoiceRuntime({context:()=>context,dictate:()=>'',canInterpret:()=>true,converse:async (text)=>{sent.push(text);return '';}});
  await runtime.receive('Computer remember these private words');
  assert.notEqual(useVoiceStore.getState().commandText,null);
  runtime.clearPendingCapture();
  assert.equal(useVoiceStore.getState().commandText,null);
  assert.equal(useVoiceStore.getState().enabled,true);
  await runtime.receive('over');
  assert.deepEqual(sent,[]);
  await runtime.receive('Computer a new thought'); await runtime.receive('over');
  assert.deepEqual(sent,['a new thought']);
});


test('Computer profiles are not worker targets or private-name blockers, including its own no-history mode', async () => {
  reset();
  useAppStore.getState().createJob('computer-chat',{kind:'chat',name:'Computer',voiceOperator:true,incognito:true,primaryProvider:'codex',primaryModel:'gpt-6-luna',primaryEffort:'low',workingDirectory:'',skipPermissions:false});
  useAppStore.setState({activeJobId:null,activeClusterId:null});
  const executor = new VoiceExecutor({sendMessage:()=>true,cancel:()=>{}});
  assert.equal(executor.canInterpret('clear Computer context'),true);
  const targets = JSON.parse(await executor.runTool({type:'voice_tool_call',workflowId:'computer-chat',requestId:'targets',tool:'archon_targets',args:{}}));
  assert(!targets.targets.some((t:{id:string})=>t.id==='computer-chat'));
});


test('clearing context releases a tentative speech hold instead of leaving playback stuck', async () => {
  reset(); useVoiceStore.setState({spokenFeedback:true}); const fx = fakeAudio();
  const runtime = new VoiceRuntime({context:()=>context,dictate:()=>'',canInterpret:()=>true,converse:async()=>''});
  runtime.attachAudio(fx.audio);
  try {
    runtime.speak('Your selected model handles the conversation.'); await fx.tick();
    runtime.receiveWake(1,speakingSnapshot); await fx.tick();
    assert.equal(fx.sources.length,1); assert.equal(fx.sources[0].stopped,true);
    runtime.clearPendingCapture(); await fx.tick();
    assert.equal(fx.sources.length,2); assert.equal(fx.sources[1].started,true);
    assert.equal(useVoiceStore.getState().commandText,null);
  } finally { fx.restore(); runtime.stop(); }
});

test('changing Computer privacy preserves the chosen model and effort', () => {
  reset(); useAppStore.setState({connected:true});
  const previous = useComputerStore.getState().selection;
  const selection = {provider:'codex' as const,model:'gpt-6-luna',effort:'high' as const,history:'saved' as const};
  const changed: unknown[] = [];
  registerComputerSwitch((next)=>changed.push(next));
  useComputerStore.setState({selection});
  try {
    controlComputer({action:'privacy',history:'none'});
    assert.deepEqual(changed,[{...selection,history:'none'}]);
  } finally { useComputerStore.setState({selection:previous}); }
});

test('Computer speaks a failed request instead of silently reading its partial answer', async()=>{
  reset();useAppStore.setState({jobs:{},connected:true});
  useComputerStore.setState({selection:{provider:'codex',model:'gpt-6-luna',effort:'low',history:'saved'},activeId:null,pending:null});
  const state=useAppStore.getState();
  state.createJob('computer-chat',{kind:'chat',name:'Computer',voiceOperator:true,primaryProvider:'codex',primaryModel:'gpt-6-luna',primaryEffort:'low',workingDirectory:'',skipPermissions:false});
  const spoken:string[]=[];
  const conversation=new ComputerConversation({sendMessage:()=>true},(text)=>spoken.push(text));
  await conversation.talk('close the dialog',new AbortController().signal);
  useAppStore.setState((s)=>({jobs:{...s.jobs,'computer-chat':{...s.jobs['computer-chat'],busy:true}}}));
  state.addMessage('computer-chat',{id:'partial',role:'assistant',content:'Checking the screen.',timestamp:1,isStreaming:false});
  state.addMessage('computer-chat',{id:'timeout',role:'system',content:'[ERROR] [COMPUTER TIMEOUT] Computer stopped responding. Nothing was retried.',timestamp:2,isStreaming:false});
  assert.deepEqual(spoken,[]);
  useAppStore.setState((s)=>({jobs:{...s.jobs,'computer-chat':{...s.jobs['computer-chat'],busy:false}}}));
  assert.deepEqual(spoken,['Computer stopped responding. Nothing was retried.']);
});

test('completion announcements wait through capture and speech without replacing an answer', async () => {
  reset(); useVoiceStore.setState({ spokenFeedback: true }); const fx = fakeAudio();
  const runtime = new VoiceRuntime({ context: () => context, dictate: () => '', canInterpret: () => true, converse: async () => 'Done.' });
  runtime.attachAudio(fx.audio);
  try {
    runtime.speak('Your current answer.'); await fx.tick();
    runtime.announce('Builder one finished.'); runtime.announce('Builder two finished.'); await fx.tick();
    assert.equal(fx.sources.length, 1); assert.equal(fx.sources[0].stopped, false);
    await fx.finish(); assert.equal(fx.sources.length, 2);
    await fx.finish(); assert.equal(fx.sources.length, 3);
    await fx.finish();
    await runtime.receive('Computer'); runtime.announce('Another worker finished.'); await fx.tick();
    assert.equal(fx.sources.length, 3);
    await runtime.receive('Cancel capture'); await fx.tick();
    assert(fx.sources.length >= 4);
  } finally { runtime.stop(); fx.restore(); }
});

test('a background acknowledgement cannot consume the readback for an operator follow-up',async()=>{
  fixture();const controller=new AbortController(),spoken:string[]=[];
  const conversation=new ComputerConversation({createWorkflow:(config)=>useAppStore.getState().createJob('computer-chat',config),sendMessage:()=>true},(text)=>spoken.push(text));
  const state=useAppStore.getState();
  const boundary=(computerTurnActive:boolean)=>useAppStore.setState((s)=>({jobs:{...s.jobs,'computer-chat':{...s.jobs['computer-chat'],busy:false,computerTurnActive}}}));
  try{
    await conversation.talk('What happened?',controller.signal);boundary(true);
    state.addMessage('computer-chat',{id:'background-done',role:'assistant',content:'Done.',timestamp:1,isStreaming:false});
    assert.deepEqual(spoken,[]);
    state.addMessage('computer-chat',{id:'operator-answer',role:'assistant',content:'Builder one finished.',timestamp:2,isStreaming:false});
    assert.deepEqual(spoken,[]);boundary(false);assert.deepEqual(spoken,['Builder one finished.']);
  }finally{controller.abort();}
});

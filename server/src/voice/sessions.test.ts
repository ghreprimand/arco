import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { isVoiceCommand, type VoiceInterpretResult } from '@arco/shared';
import { endVoiceSession, getVoiceSession, interpretVoice, parseVoiceContext, selectSessionOutputVoice, startVoiceSession, VOICE_EDGE_VOICE } from './sessions.js';
import { lunaArgs } from './luna.js';

const ids: string[] = [];
afterEach(() => { ids.splice(0).forEach(endVoiceSession); });
const start = () => { const s = startVoiceSession(); ids.push(s.id); return s; };
const context = { currentId: 'worker', clusterId: null, targets: [{ id: 'worker', name: 'Worker', kind: 'workflow' as const }] };
const result: VoiceInterpretResult = { command: { action: 'navigate', target: 'worker', value: '' }, model: 'gpt-6-luna', effort: 'low', usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 0 } };

test('voice starts without a model call; ending a lease aborts pending work and cannot be renewed', () => {
  const s = start();
  assert.equal(s.calls.length, 0); assert.equal(s.interpreting, false); assert.equal(s.transcribing, false);
  endVoiceSession(s.id); assert(s.controller.signal.aborted);
  assert.throws(() => getVoiceSession(s.id), /expired/);
});
test('expired leases are unusable and the number of enabled windows is bounded', () => {
  const a = start(), b = start();
  assert.throws(startVoiceSession, /two windows/);
  a.expires = Date.now() - 1; assert.throws(() => getVoiceSession(a.id), /expired/); assert(a.controller.signal.aborted);
  assert.equal(getVoiceSession(b.id), b);
});
test('changing output voice preserves the recognition lease, capture resources and model history', () => {
  const s = start();
  const { recognizer, waker, speaker, controller, id } = s;
  const original = s.edgeSpeaker;
  selectSessionOutputVoice(s, 'en-US-JennyNeural');
  assert.equal(s.edgeVoice, 'en-US-JennyNeural'); assert.notEqual(s.edgeSpeaker, original);
  assert.equal(getVoiceSession(id), s); assert.equal(s.recognizer, recognizer);
  assert.equal(s.waker, waker); assert.equal(s.speaker, speaker); assert.equal(s.controller, controller);
  assert.equal(s.controller.signal.aborted, false); assert.deepEqual(s.calls, []);
  const selected = s.edgeSpeaker;
  assert.throws(() => selectSessionOutputVoice(s, 'not-a-voice'), /listed output voice/);
  assert.equal(s.edgeSpeaker, selected);
  selectSessionOutputVoice(s, undefined); assert.equal(s.edgeVoice, VOICE_EDGE_VOICE);
});
test('a failed Edge voice stays on fallback until a different voice is explicitly chosen', () => {
  const s = start();
  selectSessionOutputVoice(s, 'en-US-JennyNeural');
  s.edgeSpeaker!.stop(); s.edgeSpeaker = null;
  selectSessionOutputVoice(s, 'en-US-JennyNeural'); assert.equal(s.edgeSpeaker, null);
  selectSessionOutputVoice(s, 'en-CA-ClaraNeural'); assert(s.edgeSpeaker);
  assert.equal(s.edgeVoice, 'en-CA-ClaraNeural');
});
test('an invalid output voice cannot allocate a hands-free session', () => {
  assert.throws(() => startVoiceSession('not-a-voice'), /listed output voice/);
  start(); start(); // both leases remain available
});
test('interpreter receives only the bounded current context, with no implicit retries or growing history', async () => {
  const s = start(); let calls = 0;
  const interpret = async (text: string, c: unknown, signal: AbortSignal) => { calls++; assert.equal(text, 'Open my worker'); assert.deepEqual(c, context); assert.equal(signal, s.controller.signal); return result; };
  assert.deepEqual(await interpretVoice(s, 'Open my worker', context, s.controller.signal, interpret), result);
  assert.equal(calls, 1); assert.equal(s.interpreting, false);
  await assert.rejects(interpretVoice(s, 'Open my worker', context, s.controller.signal, async () => { calls++; throw new Error('quota'); }), /quota/);
  assert.equal(calls, 2); assert.equal(s.interpreting, false);
});
test('parallel and excessive model requests are refused before invoking the model', async () => {
  const s = start(); let calls = 0;
  const interpret = async () => { calls++; return result; };
  s.interpreting = true;
  await assert.rejects(interpretVoice(s, 'open', context, s.controller.signal, interpret), /already/);
  s.interpreting = false; s.calls = Array.from({ length: 12 }, () => Date.now());
  await assert.rejects(interpretVoice(s, 'open', context, s.controller.signal, interpret), /limit/);
  assert.equal(calls, 0);
});
test('malformed/oversized command contexts and executable model output are rejected', () => {
  assert.deepEqual(parseVoiceContext(context).targets[0].id, 'worker');
  assert.throws(() => parseVoiceContext({ ...context, targets: Array(81).fill(context.targets[0]) }), /Too many/);
  assert.throws(() => parseVoiceContext({ ...context, targets: [{ ...context.targets[0], name: 'x'.repeat(161) }] }), /Invalid/);
  assert.equal(isVoiceCommand({ action: 'shell', target: '', value: 'rm -rf /' }), false);
  assert.equal(isVoiceCommand({ action: 'navigate', target: '', value: '', shell: 'pwd' }), false);
  assert.equal(isVoiceCommand(result.command), true);
});
test('Luna uses subscription auth, ephemeral isolated turns, low effort and no inherited project tools', () => {
  const args = lunaArgs('/private/scratch');
  for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--output-schema']) assert(args.includes(flag));
  assert(args.includes('gpt-6-luna')); assert(args.includes('model_reasoning_effort="low"'));
  assert(args.includes('project_doc_max_bytes=0')); assert(args.includes('features.multi_agent=false'));
  assert(args.includes('web_search="disabled"')); assert(args.includes('features.shell_tool=false'));
});

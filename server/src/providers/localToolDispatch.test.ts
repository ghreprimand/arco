import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WorkerConfig } from '@arco/shared';
import { LlamacppProvider } from './llamacpp.js';
import { LmstudioProvider } from './lmstudio.js';
import { OllamaProvider } from './ollama.js';
import { StrataProvider } from './strata.js';
import { ToolLoopDetector } from './ollamaTools.js';
import { decideLocalToolCall, dispatchLocalToolCalls, parseToolArguments, truncateLocalToolResult, type LocalToolRules, type LocalToolRuntime } from './localToolDispatch.js';

// Pins what the local-model providers do with a tool call the model makes:
// the order of the checks, the exact result text, the events shown to the
// operator and the result truncation. Runs the real provider dispatchers with
// synthetic calls in a temporary folder; no model or server is involved.

type Kind = 'ollama' | 'lmstudio' | 'llamacpp' | 'strata';
interface Worker {
  abortController: AbortController | null;
  advertisedTools?: Set<string>;
  dispatchToolCalls(calls: unknown[], autoMode: boolean, loop: ToolLoopDetector): Promise<Array<{ role: string; content: string; tool_call_id?: string }>>;
  on(event: string, fn: (payload: unknown) => void): unknown;
}

const PROVIDERS = { ollama: OllamaProvider, lmstudio: LmstudioProvider, llamacpp: LlamacppProvider, strata: StrataProvider };

function make(kind: Kind, extra: Partial<WorkerConfig>, advertised?: string[]) {
  const w = PROVIDERS[kind].create('fixture', { workflowId: 'fixture', ...extra } as WorkerConfig) as unknown as Worker;
  const events: Array<[string, unknown]> = [];
  for (const e of ['tool_use', 'system_notice']) w.on(e, (p) => events.push([e, p]));
  w.on('error', () => {});
  if (advertised && 'advertisedTools' in w) w.advertisedTools = new Set(advertised);
  return { w, events };
}

// Ollama receives parsed arguments; the OpenAI-shaped providers receive JSON text.
function call(kind: Kind, name: string, args: Record<string, unknown> | string, id = 'c1') {
  if (kind === 'ollama') return typeof args === 'string' ? { function: { name, arguments: {} }, argError: 'bad json' } : { function: { name, arguments: args } };
  return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}

// Normalize call ids only after checking the bridge id matches the receipt id.
function plain(events: Array<[string, unknown]>) {
  return events.map(([e, p]) => {
    if (e !== 'tool_use' || typeof p !== 'object' || !p) return [e, p];
    const payload = p as Record<string, unknown>;
    assert.equal(typeof payload.id, 'string');
    assert.ok(payload.id);
    assert.equal(payload.id, payload.toolUseId, 'the worker bridge and media receipt use the same call id');
    return [e, { ...payload, id: 'id', toolUseId: 'id' }];
  });
}

async function run(kind: Kind, extra: Partial<WorkerConfig>, calls: unknown[], opts: { auto?: boolean; advertised?: string[]; loop?: ToolLoopDetector } = {}) {
  const { w, events } = make(kind, extra, opts.advertised);
  const out = await w.dispatchToolCalls(calls, opts.auto ?? true, opts.loop ?? new ToolLoopDetector());
  return { out, events: plain(events) };
}

const ALL: Kind[] = ['ollama', 'lmstudio', 'llamacpp', 'strata'];
const SAFE = (name: string) => `[Arco SAFE mode] tool "${name}" was not executed. The local provider runs tools server-side only when AUTO mode is enabled on this workflow. Tell the operator what you were going to do, or answer from what they have shown you.`;
const OFFERED = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Frobnicate'];

let dir = '';
test.before(() => { dir = mkdtempSync(join(tmpdir(), 'arco-local-tools-')); });
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('malformed arguments are refused before anything else', async () => {
  for (const kind of ALL) {
    const { out } = await run(kind, { cwd: dir, interactionMode: 'chat' }, [call(kind, 'Bash', '{not json')], { advertised: [] });
    const expected = kind === 'ollama' ? '[error] tool "Bash" arguments rejected: bad json'
      : '[error] tool "Bash" arguments rejected: arguments not JSON-parseable (' ;
    assert.ok(out[0].content.startsWith(expected), `${kind}: ${out[0].content}`);
  }
  const { out } = await run('llamacpp', { cwd: dir }, [call('llamacpp', 'Bash', '42')]);
  assert.equal(out[0].content, '[error] tool "Bash" arguments rejected: arguments JSON parsed to a non-object (number)');
});

test('Chat turns refuse tools, each provider with its own wording and order', async () => {
  const chat = { cwd: dir, interactionMode: 'chat' as const, chatWebAccess: false };
  assert.equal((await run('ollama', chat, [call('ollama', 'Bash', { command: 'touch x' })])).out[0].content,
    '[error] tool "Bash" is unavailable in Arco Chat. Only armed WebSearch/WebFetch calls are allowed.');
  for (const kind of ['lmstudio', 'llamacpp', 'strata'] as Kind[]) {
    assert.equal((await run(kind, chat, [call(kind, 'Bash', { command: 'touch x' })], { advertised: OFFERED })).out[0].content, '[error] tool "Bash" is not enabled for this turn.', kind);
  }
  assert.equal(existsSync(join(dir, 'x')), false);
  // The Chat check comes before SAFE mode.
  assert.match((await run('ollama', chat, [call('ollama', 'Bash', {})], { auto: false })).out[0].content, /unavailable in Arco Chat/);
  // A Computer (voice) chat: Ollama sends every call to Computer first; LM Studio refuses unoffered names first.
  const voice = { ...chat, voiceOperator: true };
  const ollamaVoice = await run('ollama', voice, [call('ollama', 'Bash', {})]);
  assert.equal(ollamaVoice.out[0].content, '[error] Tool is not available in Computer.');
  assert.deepEqual(ollamaVoice.events, [['tool_use', { name: 'Bash', input: '{}', id: 'id', toolUseId: 'id' }], ['tool_use', { name: 'Bash', input: '{}', id: 'id', toolUseId: 'id', status: 'failed', output: '[error] Tool is not available in Computer.' }]]);
  assert.equal((await run('lmstudio', voice, [call('lmstudio', 'Bash', {})], { advertised: [] })).out[0].content, '[error] tool "Bash" is not enabled for this turn.');
  assert.equal((await run('lmstudio', voice, [call('lmstudio', 'Bash', {})], { advertised: ['Bash'] })).out[0].content, '[error] tool "Bash" is not enabled for this turn.');
});

test('LM Studio and Strata refuse a tool that was not offered this turn, even with AUTO', async () => {
  for (const kind of ['lmstudio', 'strata'] as Kind[]) {
    assert.equal((await run(kind, { cwd: dir, interactionMode: 'agent' }, [call(kind, 'Bash', { command: 'true' })], { advertised: ['Read'] })).out[0].content, '[error] tool "Bash" is not enabled for this turn.', kind);
  }
});

test('SAFE mode, a missing folder and an unknown tool, in that order', async () => {
  for (const kind of ALL) {
    const agent = { cwd: dir, interactionMode: 'agent' as const };
    assert.equal((await run(kind, agent, [call(kind, 'Frobnicate', {})], { auto: false, advertised: OFFERED })).out[0].content, SAFE('Frobnicate'), kind);
    assert.equal((await run(kind, { interactionMode: 'agent' }, [call(kind, 'Frobnicate', {})], { advertised: OFFERED })).out[0].content, '[error] tool "Frobnicate" requires a workflow cwd; this spawn has none.', kind);
    const unknown = (await run(kind, agent, [call(kind, 'Frobnicate', {})], { advertised: OFFERED })).out[0].content;
    assert.equal(unknown, {
      ollama: '[error] unknown tool "Frobnicate". The Ollama tool runtime is on a strict allowlist; see docs/PROVIDERS.md §Ollama for the v1 set.',
      llamacpp: '[error] unknown tool "Frobnicate". The local-tool runtime is on a strict allowlist; see docs/PROVIDERS.md.',
      lmstudio: '[error] unknown tool "Frobnicate". The local-tool runtime is on a strict allowlist; see docs/PROVIDERS.md.',
      strata: '[error] unknown tool "Frobnicate". The local-tool runtime is on a strict allowlist; see docs/PROVIDERS.md.',
    }[kind], kind);
  }
});

test('a repeated identical call is coached; Ollama never ends the turn, the others do', async () => {
  for (const kind of ALL) {
    const loop = new ToolLoopDetector();
    const seen: string[] = [];
    const notices: unknown[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await run(kind, { cwd: dir, interactionMode: 'agent' }, [call(kind, 'Glob', { pattern: 'nothing-*.none' })], { advertised: OFFERED, loop });
      seen.push(r.out[0].content.slice(0, 40));
      notices.push(...r.events.filter(([e]) => e === 'system_notice').map(([, p]) => String(p).split(':')[0]));
    }
    assert.equal(seen[0], seen[1], `${kind}: first two run the tool`);
    assert.notEqual(seen[2], seen[0], `${kind}: the third is coached`);
    if (kind === 'ollama') assert.ok(notices.every((n) => n === 'tool-loop coach'), `${kind}: ${notices}`);
    else assert.ok(notices.includes('tool-loop terminating'), `${kind}: ${notices}`);
  }
});

test('AUTO runs the tool; events and stored results per provider', async () => {
  const big = 'head -c 9000 /dev/zero | tr "\\0" a';
  const results: Record<string, { out: unknown; events: unknown }> = {};
  for (const kind of ALL) results[kind] = await run(kind, { cwd: dir, interactionMode: 'agent' }, [call(kind, 'Bash', { command: big })], { advertised: OFFERED });
  // Ollama keeps the whole result and has no tool_call_id.
  const o = results.ollama.out as Array<{ role: string; content: string; tool_call_id?: string }>;
  assert.equal(o[0].role, 'tool'); assert.equal(o[0].tool_call_id, undefined); assert.ok(o[0].content.includes('a'.repeat(9000)));
  assert.deepEqual(results.ollama.events, [['tool_use', { name: 'Bash', input: JSON.stringify({ command: big }), id: 'id', toolUseId: 'id' }]]);
  // llama.cpp and LM Studio trim with their own label; Strata keeps the runtime result and reports both phases.
  for (const [kind, label] of [['llamacpp', 'llama.cpp'], ['lmstudio', 'LM Studio']] as const) {
    const out = results[kind].out as Array<{ content: string; tool_call_id: string }>;
    assert.equal(out[0].tool_call_id, 'c1');
    assert.match(out[0].content, new RegExp(`bytes of tool output elided by Arco to keep ${label.replace('.', '\\.')} context lean`), kind);
    assert.deepEqual(results[kind].events, [['tool_use', { name: 'Bash', input: JSON.stringify({ command: big }), id: 'id', toolUseId: 'id' }]], kind);
  }
  const s = results.strata.out as Array<{ content: string }>;
  assert.ok(s[0].content.includes('a'.repeat(9000)));
  assert.deepEqual(results.strata.events, [['tool_use', { name: 'Bash', input: JSON.stringify({ command: big }), id: 'id', toolUseId: 'id', status: 'started', provider: 'strata' }], ['tool_use', { name: 'Bash', input: JSON.stringify({ command: big }), id: 'id', toolUseId: 'id', status: 'completed', provider: 'strata', output: s[0].content }]]);
});

test('a cancelled batch stops before the next call', async () => {
  for (const kind of ALL) {
    const { w } = make(kind, { cwd: dir, interactionMode: 'agent' }, OFFERED);
    w.abortController = new AbortController();
    w.abortController.abort();
    assert.deepEqual(await w.dispatchToolCalls([call(kind, 'Bash', { command: 'touch y' })], true, new ToolLoopDetector()), [], kind);
  }
  assert.equal(existsSync(join(dir, 'y')), false);
});

// --- The shared seam, with stand-ins for the tool runtimes ---------------------------


function seam(over: Partial<LocalToolRuntime> = {}) {
  const ran: string[] = [];
  const notices: string[] = [];
  const rt: LocalToolRuntime = {
    cwd: '/fixture', autoMode: true, computerChat: false, loop: new ToolLoopDetector(),
    runComputer: async (name) => { ran.push(`computer:${name}`); return 'computer ok'; },
    runTool: async (name) => { ran.push(`tool:${name}`); return 'tool ok'; },
    notice: (t) => notices.push(t), ...over,
  };
  return { rt, ran, notices };
}
const rules = (over: Partial<LocalToolRules> = {}): LocalToolRules => ({ computer: 'none', boundary: () => null, unknownTool: (n) => `unknown ${n}`, endTurnOnRepeat: true, ...over });

test('seam: each check in order, and only the tool runs a tool', async () => {
  const refuse = rules({ boundary: (n) => `refused ${n}` });
  let s = seam({ computerChat: true });
  assert.equal(await decideLocalToolCall('Bash', { args: {}, argError: 'bad' }, rules({ computer: 'first' }), s.rt), '[error] tool "Bash" arguments rejected: bad');
  assert.equal(await decideLocalToolCall('Bash', { args: {} }, { ...refuse, computer: 'first' }, s.rt), 'computer ok');
  assert.equal(await decideLocalToolCall('Bash', { args: {} }, { ...refuse, computer: 'after-boundary' }, s.rt), 'refused Bash');
  assert.equal(await decideLocalToolCall('Bash', { args: {} }, rules({ computer: 'after-boundary' }), s.rt), 'computer ok');
  assert.equal(await decideLocalToolCall('Bash', { args: {} }, rules({ computer: 'none' }), s.rt), 'tool ok', 'no Computer: a Computer chat runs the tool rules');
  assert.deepEqual(s.ran, ['computer:Bash', 'computer:Bash', 'tool:Bash']);
  s = seam({ autoMode: false, cwd: undefined });
  assert.match(await decideLocalToolCall('Nope', { args: {} }, rules(), s.rt), /^\[Arco SAFE mode\] tool "Nope" was not executed\./);
  s = seam({ cwd: undefined });
  assert.equal(await decideLocalToolCall('Nope', { args: {} }, rules(), s.rt), '[error] tool "Nope" requires a workflow cwd; this spawn has none.');
  s = seam();
  assert.equal(await decideLocalToolCall('Nope', { args: {} }, rules(), s.rt), 'unknown Nope');
  assert.deepEqual(s.ran, []);
});

test('seam: the loop coach, and ending the turn only where the rules say so', async () => {
  for (const endTurnOnRepeat of [true, false]) {
    const s = seam();
    const out: string[] = [];
    for (let i = 0; i < 7; i++) out.push(await decideLocalToolCall('Read', { args: { file_path: 'a' } }, rules({ endTurnOnRepeat }), s.rt));
    assert.deepEqual(out.slice(0, 2), ['tool ok', 'tool ok']);
    assert.ok(out.slice(2).every((o) => o !== 'tool ok'));
    assert.equal(s.ran.length, 2);
    assert.equal(s.notices.some((n) => n.startsWith('tool-loop terminating')), endTurnOnRepeat);
    assert.equal(s.rt.loop.terminationRequested(), true, 'the detector still records the request');
  }
});

test('seam: arguments, the batch loop and result trimming', async () => {
  assert.deepEqual(parseToolArguments(undefined), { args: {} });
  assert.deepEqual(parseToolArguments('{"a":1}'), { args: { a: 1 } });
  assert.deepEqual(parseToolArguments('"x"'), { args: {}, argError: 'arguments JSON parsed to a non-object (string)' });
  assert.match(parseToolArguments('{oops').argError ?? '', /^arguments not JSON-parseable \(.+\); received: "\{oops"$/);
  let stop = false;
  assert.deepEqual(await dispatchLocalToolCalls([1, 2, 3], () => stop, async (n) => { if (n === 2) stop = true; return n * 10; }), [10, 20]);
  const text = 'x'.repeat(1000);
  assert.equal(truncateLocalToolResult('Bash', text, 'Fixture', 400, 400), text, 'within head + tail + 200');
  assert.equal(truncateLocalToolResult('Bash', 'y'.repeat(1001), 'Fixture', 400, 400), `${'y'.repeat(400)}\n\n[... 201 bytes of tool output elided by Arco to keep Fixture context lean ...]\n\n${'y'.repeat(400)}`);
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
  const read = truncateLocalToolResult('Read', lines, 'Fixture', 10, 10);
  assert.ok(read.startsWith('line 0\n') && read.includes('[... 100 lines elided by Arco to keep Fixture context lean — re-read with explicit line range if needed ...]') && read.endsWith('line 299'));
});

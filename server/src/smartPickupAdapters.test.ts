import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { claudeAdapter, codexAdapter, cursorAdapter, ollamaAdapter, EvaluatorRefused, isStartupFailure } from './smartPickupAdapters.js';

const dir = await mkdtemp(join(tmpdir(), 'arco-evaluator-adapters-'));
after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const req = { model: 'm', instructions: 'Classify.', prompt: 'DATA', timeoutMs: 2000, maxOutputTokens: 64 };
const ANSWER = '{"action":"defer","reason":"ack_or_status"}';

test('Ollama: one non-streaming chat request with a schema, an output cap and no tools', async () => {
  const bodies: Record<string, unknown>[] = [];
  let reply: (res: import('node:http').ServerResponse) => void = (res) => res.end(JSON.stringify({ message: { content: ANSWER } }));
  const server = createServer((r, res) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { bodies.push(JSON.parse(b)); reply(res); }); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const a = ollamaAdapter({ base: async () => base });
  try {
    assert.equal(await a.evaluate(req), ANSWER);
    const body = bodies[0];
    assert.equal(body.stream, false);
    assert.equal('tools' in body, false);
    assert.deepEqual((body.options as { num_predict: number }).num_predict, 64);
    assert.deepEqual(((body.format as { properties: { action: { enum: string[] } } }).properties.action.enum), ['wake', 'defer', 'ask']);
    reply = (res) => res.end(JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'shell' } }] } }));
    await assert.rejects(a.evaluate(req), /tool_attempted/);
    reply = (res) => res.end(JSON.stringify({ message: { content: 'x'.repeat(10_000) } }));
    await assert.rejects(a.evaluate(req), /output_too_long/);
    reply = () => { /* never answers */ };
    await assert.rejects(a.evaluate({ ...req, timeoutMs: 100 }), (err: unknown) => err instanceof Error);
  } finally { server.closeAllConnections(); server.close(); }
});

test('Claude: one Messages request without tools from Native credentials; non-text answers refused', async () => {
  const sent: Record<string, unknown>[] = [];
  let content: unknown[] = [{ type: 'text', text: ANSWER }];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'm', content, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const a = claudeAdapter({ fetchImpl, tokens: async () => ({ accessToken: 'synthetic-token' }), hasCredentials: async () => true });
  assert.deepEqual(await a.capability(), { provider: 'claude', available: true });
  assert.equal(await a.evaluate(req), ANSWER);
  assert.equal('tools' in sent[0], false);
  assert.equal(sent[0].max_tokens, 64);
  assert.equal(sent[0].stream, undefined);
  content = [{ type: 'tool_use', id: 't', name: 'shell', input: {} }];
  await assert.rejects(a.evaluate(req), /non_text_answer/);
  const none = claudeAdapter({ hasCredentials: async () => false });
  const cap = await none.capability();
  assert.equal(cap.available, false);
  assert.match(cap.reason!, /Claude Native sign-in/);
});

test('Claude utility accepts thinking blocks, refuses other content and identifies oversized replies', async () => {
  let content: unknown[] = [{ type: 'thinking', thinking: 'private thought' }, { type: 'text', text: 'Tidy proposal' }, { type: 'redacted_thinking', data: 'private data' }];
  let stopReason = 'end_turn';
  const fetchImpl = (async () => new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'm', content, stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const a = claudeAdapter({ fetchImpl, tokens: async () => ({ accessToken: 'fixture' }) });
  assert.equal(await a.evaluate({ ...req, freeText: true }), 'Tidy proposal');
  content = [{ type: 'thinking', thinking: 'private thought' }];
  await assert.rejects(a.evaluate({ ...req, freeText: true }), /empty_answer/);
  content = [{ type: 'text', text: 'x'.repeat(513) }];
  await assert.rejects(a.evaluate({ ...req, freeText: true }), /output_too_long/);
  content = [{ type: 'text', text: 'unfinished' }]; stopReason = 'max_tokens';
  await assert.rejects(a.evaluate({ ...req, freeText: true }), /output_too_long/);
  stopReason = 'end_turn'; content = [{ type: 'thinking', thinking: 'private thought' }, { type: 'tool_use', name: 'secret name', input: {} }];
  const logs: string[] = []; const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => logs.push(args.join(' '));
  try { await assert.rejects(a.evaluate({ ...req, freeText: true }), /non_text_answer/); }
  finally { console.warn = originalWarn; }
  assert.match(logs.join(' '), /non_text_answer; block types: thinking,tool_use/);
  assert.doesNotMatch(logs.join(' '), /private thought|secret name/);
});

test('Claude utility requests resolve aliases and identify provider, auth and timeout failures', async () => {
  let model = '';
  let status = 200;
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    model = JSON.parse(String(init?.body)).model;
    if (status === 0) return await new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    if (status !== 200) return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model unavailable' } }), { status, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'Answer' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const a = claudeAdapter({ fetchImpl, tokens: async () => ({ accessToken: 'synthetic-token' }), hasCredentials: async () => true });
  assert.equal(await a.evaluate({ ...req, model: 'haiku', freeText: true }), 'Answer');
  assert.notEqual(model, 'haiku');
  status = 404;
  await assert.rejects(a.evaluate(req), /provider_http_404/);
  status = 401;
  await assert.rejects(a.evaluate(req), /not_signed_in/);
  status = 0;
  await assert.rejects(a.evaluate({ ...req, timeoutMs: 30 }), /timeout/);
});

// Cursor requests name a model the fake offers.
const creq = { ...req, model: 'auto' };
const CATALOG = ['auto', 'grok-4.7-medium', 'grok-4.7-high', 'grok-4.7-high-fast'];

// A stand-in `cursor-agent acp` speaking newline-delimited JSON-RPC.
const FAKE_CURSOR = `
const mode = process.env.FAKE_CURSOR_MODE;
const log = process.env.FAKE_CURSOR_LOG;
const fs = require('node:fs');
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (log && m.method) fs.appendFileSync(log, JSON.stringify({ method: m.method, params: m.params, cwd: process.cwd(), argv: process.argv.slice(2) }) + '\\n');
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1 } });
    else if (m.method === 'session/new') {
      const reply = () => send({ id: m.id, result: { sessionId: 's1', modes: { currentModeId: 'agent', availableModes: (mode === 'noask' ? ['agent'] : ['agent', 'plan', 'ask']).map((id) => ({ id })) }, models: { currentModelId: 'default[]', availableModels: [{ modelId: 'default[]', name: 'Auto' }, { modelId: 'grok-4.7[reasoning_effort=high,fast=true]', name: 'grok-4.7' }] } } });
      if (mode === 'slowstart') setTimeout(reply, Number(process.env.FAKE_CURSOR_START_MS)); else reply();
    }
    else if (m.method === 'session/set_mode') send({ id: m.id, result: {} });
    else if (m.method === 'session/set_config_option') send({ id: m.id, result: { configOptions: [{ id: 'model', currentValue: mode === 'unconfirmed' ? 'default[]' : m.params.value }] } });
    else if (m.method === 'session/prompt') {
      if (mode === 'hang') return;
      if (mode === 'permission') { send({ id: 900, method: 'session/request_permission', params: { options: [{ optionId: 'allow-once', kind: 'allow_once' }] } }); return; }
      if (mode === 'tool') send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file' } } });
      if (mode === 'fs') { send({ id: 901, method: 'fs/read_text_file', params: { path: '/etc/hostname' } }); return; }
      send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ${JSON.stringify(ANSWER)} } } } });
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    }
  }
});
`;

test('Cursor: fresh ACP agent in an empty folder, no capabilities, refuses any tool or permission and stops on time', async () => {
  const script = join(dir, 'fake-cursor.cjs');
  await writeFile(script, FAKE_CURSOR);
  const log = join(dir, 'cursor.log');
  const make = (mode: string) => {
    process.env.FAKE_CURSOR_MODE = mode;
    process.env.FAKE_CURSOR_LOG = log;
    return cursorAdapter({ launch: (model) => [process.execPath, [script, 'acp', '--model', model]], catalog: async () => CATALOG });
  };
  try {
    assert.equal(await make('answer').evaluate({ ...creq, model: 'auto' }), ANSWER);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const init = calls.find((c) => c.method === 'initialize');
    assert.deepEqual(init.params.clientCapabilities, {}, 'no file or terminal capability');
    const session = calls.find((c) => c.method === 'session/new');
    assert.deepEqual(session.params.mcpServers, []);
    assert.match(session.cwd, /arco-evaluator-/, 'runs in an empty temporary folder');
    assert.deepEqual(init.argv, ['acp', '--model', 'auto'], 'no --force');
    const setMode = calls.find((c) => c.method === 'session/set_mode');
    assert.equal(setMode?.params.modeId, 'ask', 'Ask mode: no edits or command execution');
    assert.ok(calls.findIndex((c) => c.method === 'session/set_mode') < calls.findIndex((c) => c.method === 'session/prompt'), 'mode set before the prompt');
    assert.ok(!calls.some((c) => c.method === 'session/load'), 'never resumes a session');
    for (const mode of ['permission', 'tool', 'fs']) {
      await assert.rejects(make(mode).evaluate(creq), (err: unknown) => err instanceof EvaluatorRefused && /tool_attempted/.test(err.message), mode);
    }
    const started = Date.now();
    await assert.rejects(make('hang').evaluate({ ...creq, timeoutMs: 300 }), (err: unknown) => err instanceof Error && err.message === 'timeout');
    assert.ok(Date.now() - started < 3000);
    await assert.rejects(make('noask').evaluate(creq), /startup_no_ask_mode/, 'fails closed without Ask mode');
    // The model is selected over ACP and confirmed before the prompt; another
    // variant, an unknown model or an unconfirmed switch gets no answer.
    await writeFile(log, '');
    assert.equal(await make('answer').evaluate({ ...creq, model: 'grok-4.7-high-fast' }), ANSWER);
    const sets = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.method === 'session/set_config_option');
    assert.deepEqual(sets.map((c) => c.params.value), ['grok-4.7[reasoning_effort=high,fast=true]']);
    await assert.rejects(make('answer').evaluate({ ...creq, model: 'grok-4.7-medium' }), /startup_model_unavailable/);
    await assert.rejects(make('answer').evaluate({ ...creq, model: 'no-such-model' }), /startup_model_unavailable/);
    await assert.rejects(make('unconfirmed').evaluate({ ...creq, model: 'grok-4.7-high-fast' }), /startup_model_unconfirmed/);
  } finally {
    delete process.env.FAKE_CURSOR_MODE; delete process.env.FAKE_CURSOR_LOG;
  }
});

test('Cursor: start-up has its own allowance, separate from the answer time limit', async () => {
  const script = join(dir, 'fake-cursor.cjs');
  await writeFile(script, FAKE_CURSOR);
  process.env.FAKE_CURSOR_MODE = 'slowstart';
  process.env.FAKE_CURSOR_START_MS = '600';
  const adapter = cursorAdapter({ launch: (model) => [process.execPath, [script, 'acp', '--model', model]], catalog: async () => CATALOG });
  try {
    // A 600 ms start with a 300 ms answer limit still answers: start-up time is not answer time.
    assert.equal(await adapter.evaluate({ ...creq, timeoutMs: 300, startupTimeoutMs: 5000 }), ANSWER);
    // A start beyond the start-up allowance is a start-up failure, not an answer timeout.
    await assert.rejects(adapter.evaluate({ ...creq, timeoutMs: 5000, startupTimeoutMs: 200 }), (err: unknown) => err instanceof EvaluatorRefused && err.message === 'startup_timeout' && isStartupFailure(err.message));
    assert.equal(isStartupFailure('timeout'), false);
    assert.equal(isStartupFailure('tool_attempted'), false);
  } finally {
    delete process.env.FAKE_CURSOR_MODE; delete process.env.FAKE_CURSOR_START_MS;
  }
});

test('Cursor: a timeout stops the agent once, and --verbose tracing reports phases and frames', async () => {
  const script = join(dir, 'fake-cursor.cjs');
  await writeFile(script, FAKE_CURSOR);
  const kills: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { const line = args.map(String).join(' '); if (line.includes('smart-pickup:cursor')) kills.push(line); else original(...args); };
  try {
    process.env.FAKE_CURSOR_MODE = 'hang';
    await assert.rejects(cursorAdapter({ launch: (model) => [process.execPath, [script, 'acp', '--model', model]], catalog: async () => CATALOG }).evaluate({ ...creq, timeoutMs: 200 }), /timeout/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(kills.length, 1, `one kill per request, got ${kills.length}`);
    process.env.FAKE_CURSOR_MODE = 'answer';
    const lines: string[] = [];
    await cursorAdapter({ launch: (model) => [process.execPath, [script, 'acp', '--model', model]], catalog: async () => CATALOG }).evaluate({ ...creq, trace: (l) => lines.push(l) });
    for (const p of ['initialize', 'session_new', 'set_mode', 'first_token', 'prompt']) assert.ok(lines.some((l) => l.startsWith(`phase ${p} `)), p);
    assert.ok(lines.some((l) => l.startsWith('-> ') && l.includes('"session/set_mode"')));
    assert.ok(lines.some((l) => l.startsWith('<- ') && l.includes('agent_message_chunk')));
  } finally {
    console.log = original;
    delete process.env.FAKE_CURSOR_MODE;
  }
});

// A stand-in `codex app-server` speaking newline-delimited JSON-RPC.
const FAKE_CODEX = `
const mode = process.env.FAKE_CODEX_MODE;
const log = process.env.FAKE_CODEX_LOG;
const fs = require('node:fs');
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const item = (type, extra) => ({ type, id: 'i-' + type, ...extra });
const note = (method, params) => send({ method, params: { threadId: 't1', turnId: 'u1', ...params } });
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (log && m.method) fs.appendFileSync(log, JSON.stringify({ method: m.method, params: m.params, cwd: process.cwd(), argv: process.argv.slice(2) }) + '\\n');
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
    else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 't1' }, model: 'm' } });
    else if (m.method === 'turn/interrupt') send({ id: m.id, result: {} });
    else if (m.method === 'turn/start') {
      send({ id: m.id, result: { turn: { id: 'u1' } } });
      if (mode === 'hang') return;
      if (mode === 'approval') { send({ id: 900, method: 'item/commandExecution/requestApproval', params: {} }); return; }
      if (mode === 'command') note('item/started', { item: item('commandExecution', { command: 'ls' }) });
      if (mode === 'filechange') note('item/started', { item: item('fileChange', {}) });
      if (mode === 'mcp') note('item/started', { item: item('mcpToolCall', {}) });
      if (mode === 'web') note('item/started', { item: item('webSearch', {}) });
      if (mode === 'big') note('item/completed', { item: item('agentMessage', { text: 'x'.repeat(5000), phase: 'final_answer' }) });
      note('item/started', { item: item('reasoning', { summary: [], content: [] }) });
      note('item/completed', { item: item('agentMessage', { text: 'thinking aloud', phase: 'commentary' }) });
      note('item/completed', { item: item('agentMessage', { text: ${JSON.stringify(ANSWER)}, phase: 'final_answer' }) });
      note('turn/completed', { turn: { id: 'u1', status: mode === 'failed' ? 'failed' : 'completed', error: null } });
    }
  }
});
`;

test('Codex: one-shot app-server in an empty folder, read-only, no approvals, web off, only the final answer', async () => {
  const script = join(dir, 'fake-codex.cjs');
  await writeFile(script, FAKE_CODEX);
  const log = join(dir, 'codex.log');
  const make = (mode: string) => {
    process.env.FAKE_CODEX_MODE = mode;
    process.env.FAKE_CODEX_LOG = log;
    return codexAdapter({ launch: () => [process.execPath, [script, '-c', 'mcp_servers={}', 'app-server']], usable: async () => ({ available: true }) });
  };
  try {
    assert.deepEqual(await make('answer').capability(), { provider: 'codex', available: true });
    assert.equal(await make('answer').evaluate({ ...req, model: 'gpt-6-luna' }), ANSWER, 'the commentary message is not the answer');
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const init = calls.find((c) => c.method === 'initialize');
    assert.deepEqual(init.argv, ['-c', 'mcp_servers={}', 'app-server'], 'no MCP servers');
    const thread = calls.find((c) => c.method === 'thread/start');
    assert.match(thread.cwd, /arco-evaluator-/, 'runs in an empty temporary folder');
    assert.equal(thread.params.sandbox, 'read-only');
    assert.equal(thread.params.approvalPolicy, 'never');
    assert.equal(thread.params.config.web_search, 'disabled');
    assert.equal(thread.params.ephemeral, true);
    assert.equal(thread.params.model, 'gpt-6-luna');
    const bare = (path: string) => path.replace(/^\/private(?=\/var\/)/, '');
    assert.equal(bare(thread.params.cwd), bare(thread.cwd), 'the thread runs in the process folder');
    const turn = calls.find((c) => c.method === 'turn/start');
    assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.equal(turn.params.approvalPolicy, 'never');
    assert.ok(!calls.some((c) => c.method === 'thread/resume' || c.method === 'thread/fork'), 'never resumes');
    for (const mode of ['approval', 'command', 'filechange', 'mcp', 'web']) {
      await assert.rejects(make(mode).evaluate(req), (err: unknown) => err instanceof EvaluatorRefused && /tool_attempted/.test(err.message), mode);
    }
    await assert.rejects(make('big').evaluate(req), /output_too_long/);
    await assert.rejects(make('failed').evaluate(req), /turn_failed/);
    const started = Date.now();
    await assert.rejects(make('hang').evaluate({ ...req, timeoutMs: 300 }), (err: unknown) => err instanceof Error && err.message === 'timeout');
    assert.ok(Date.now() - started < 3000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(make('hang').evaluate({ ...req, signal: controller.signal }), /cancelled/);
  } finally {
    delete process.env.FAKE_CODEX_MODE; delete process.env.FAKE_CODEX_LOG;
  }
});

test('Codex is offered only when enabled and signed in', async () => {
  const off = codexAdapter({ usable: async () => ({ available: false, reason: 'Codex is not signed in.' }) });
  assert.deepEqual(await off.capability(), { provider: 'codex', available: false, reason: 'Codex is not signed in.' });
});

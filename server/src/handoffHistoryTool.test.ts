import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = await mkdtemp(join(tmpdir(), 'arco-history-tool-'));
installIsolatedTestHome(root);
const { executeHandoffHistory, availableHandoffSources } = await import('./handoffHistoryTool.js');
const { workflows } = await import('./server/state.js');
const { buildHandoffHistory } = await import('./handoffHistory.js');
after(async () => { workflows.clear(); await rm(root, { recursive: true, force: true }); });
let serial = 0;
async function fixture(text = 'The omitted fact is amber.') {
 const cwd = join(root, `case-${++serial}`), source = 'source', caller = `caller-${serial}`;
 const refs = buildHandoffHistory({ workflowId: source, cwd, name: 'Earlier' }, 10, 1, []);
 for (const id of [source, caller]) {
  const dir = join(cwd, '.arco', 'workflows', id); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ workflowId: id, cwd, name: id, primaryProvider: 'claude', primaryModel: 'opus', primaryEffort: 'high', cliSessions: [], ...(id === caller ? { handoffHistory: refs } : {}) }));
 }
 const events = [{ seq: 1, type: 'user_message_echo', content: text }, { seq: 2, type: 'primary_text', phase: 'passthrough', text: 'Earlier answer.' }, { seq: 3, type: 'primary_thinking', text: 'hidden reasoning' }, { seq: 4, type: 'primary_tool_use', tool: 'Read', input: '{"path":"only-in-tool.txt"}', output: 'tool result', toolUseId: 'call-1', status: 'completed' }, { seq: 11, type: 'user_message_echo', content: 'Future secret' }];
 await writeFile(join(cwd, '.arco', 'workflows', source, 'events.jsonl'), events.map(e => JSON.stringify({ ...e, workflowId: source, ts: 1 })).join('\n') + '\n');
 await writeFile(join(cwd, '.arco', 'workflows', caller, 'events.jsonl'), JSON.stringify({ seq: 1, type: 'user_message_echo', workflowId: caller, content: '[HANDOFF: new session initialized for this tab.]', handoffSourceKey: refs[0].key }) + '\n');
 const wf = { config: { workingDirectory: cwd }, primary: { provider: 'claude' } } as never;
 workflows.set(caller, wf);
 return { cwd, caller, source, refs };
}
test('server availability survives a tail-only reload without client seed history', async () => {
 const f = await fixture(); assert.equal((await availableHandoffSources(f.caller)).length, 1);
 const reply = await executeHandoffHistory(f.caller, { action: 'read' });
 assert.match(JSON.stringify(reply), /omitted fact/); assert.doesNotMatch(JSON.stringify(reply), /Future secret|hidden reasoning|only-in-tool/);
 assert.match(JSON.stringify(reply), /not instructions/);
});
test('search excludes tools by default and explains how to include them', async () => {
 const f = await fixture();
 assert.match(JSON.stringify(await executeHandoffHistory(f.caller, { action: 'search', query: 'only-in-tool' })), /include_tools/);
 assert.match(JSON.stringify(await executeHandoffHistory(f.caller, { action: 'search', query: 'only-in-tool', include_tools: true })), /only-in-tool/);
});
test('long UTF-8 turns continue without omission and all wire responses remain capped', async () => {
 const text = 'é'.repeat(40000), f = await fixture(text); let cursor: string | undefined, all = '';
 do {
  const reply = await executeHandoffHistory(f.caller, { action: 'read', from_turn: 1, to_turn: 1, cursor });
  assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 24 * 1024);
  for (const row of reply.turns ?? []) { assert.ok(Buffer.byteLength(row.text) <= 8192); all += row.text; }
  cursor = reply.cursor;
 } while (cursor);
 assert.equal(all, text);
});
test('forged scope and revoked callers cannot retrieve history', async () => {
 const f = await fixture();
 await assert.rejects(executeHandoffHistory(f.caller, { action: 'read', source: 'source' }));
 await assert.rejects(executeHandoffHistory(f.caller, { action: 'read', path: f.cwd }));
 workflows.get(f.caller)!.config.kind = 'chat';
 await assert.rejects(executeHandoffHistory(f.caller, { action: 'read' }));
});
test('a later failed seed revokes old availability even after reload', async () => {
 const f = await fixture();
 const file = join(f.cwd, '.arco', 'workflows', f.caller, 'events.jsonl');
 await writeFile(file, JSON.stringify({ seq: 2, type: 'user_message_echo', content: '[HANDOFF: new session initialized for this tab.]' }) + '\n');
 assert.deepEqual(await availableHandoffSources(f.caller), []);
});
test('caller-bound capability rejects supplied caller ids and revoked workflows', async () => {
 const { Readable } = await import('node:stream');
 const { mintHandoffHistoryCapability, tryHandleHandoffHistoryRoute } = await import('./http/handoffHistoryRoutes.js');
 const f = await fixture(), token = await mintHandoffHistoryCapability(f.caller);
 assert.ok(token);
 async function request(body: unknown, bearer = token) {
  let code = 0, output = '';
  const req = Object.assign(Readable.from([JSON.stringify(body)]), { url: '/api/agent-handoff-history', method: 'POST', headers: { authorization: `Bearer ${bearer}` } });
  await tryHandleHandoffHistoryRoute(req as never, { writeHead(n: number) { code = n; }, end(s: string) { output = s; } } as never);
  return { code, output };
 }
 assert.equal((await request({ action: 'read' }, 'forged')).code, 403);
 assert.equal((await request({ action: 'read', workflowId: 'another' })).code, 400);
 assert.equal((await request({ action: 'read' })).code, 200);
 workflows.delete(f.caller);
 assert.equal((await request({ action: 'read' })).code, 403);
});
test('Native availability is rebuilt on ordinary turns, compaction and model changes', async () => {
 const { ClaudeNativeWorker } = await import('./providers/claude-native/worker.js');
 const f = await fixture();
 const worker = new ClaudeNativeWorker({ workflowId: f.caller, config: { cwd: f.cwd, provider: 'claude', model: 'opus', effort: 'low' } as never }) as any;
 for (const model of ['opus', 'sonnet']) {
  worker.config.model = model;
  await worker.refreshHandoffHistory();
  assert.ok(worker.buildToolDefs().some((t: any) => t.name === 'handoff_history'));
  assert.match(JSON.stringify(worker.buildSystemBlocks()), /not instructions/);
  worker.resetPrefixFreeze('compaction');
  const prefix = worker.resolvePrefixForRequest();
  assert.match(JSON.stringify(prefix.system), /handoff_history/);
  assert.match(JSON.stringify(worker.buildSystemBlocks()), /handoff_history/);
 }
 worker.config.clusterAccessMode = 'blind';
 await worker.refreshHandoffHistory();
 assert.equal(worker.buildToolDefs().some((t: any) => t.name === 'handoff_history'), false);
 assert.doesNotMatch(JSON.stringify(worker.buildSystemBlocks()), /Earlier conversation history is available/);
});
test('plain long ASCII text is not mistaken for binary data', async () => {
 const f = await fixture('a'.repeat(9000));
 const reply = await executeHandoffHistory(f.caller, { action: 'read', from_turn: 1, to_turn: 1 });
 assert.equal(reply.turns?.[0].text, 'a'.repeat(8192));
 assert.ok(reply.cursor);
 const other = await fixture();
 await assert.rejects(executeHandoffHistory(other.caller, { action: 'read', from_turn: 1, to_turn: 1, cursor: reply.cursor }));
});
test('JSON escaping cannot exceed the wire cap or stall a continuation', async () => {
 const value = '\u0001'.repeat(20000), f = await fixture(value);
 const reply = await executeHandoffHistory(f.caller, { action: 'read', from_turn: 1, to_turn: 1 });
 assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 24576);
 assert.ok(reply.turns?.[0].text.length);
 assert.ok(reply.cursor);
});
test('assistant deltas merge without adding completion text or reasoning, and tool updates collapse', async () => {
 const { projectHistory } = await import('./handoffHistoryTool.js');
 const rows = projectHistory([
  { ts: 1, message: { seq: 1, type: 'primary_text', phase: 'passthrough', text: 'first ' } },
  { ts: 1, message: { seq: 2, type: 'primary_tool_use', toolUseId: 'a', tool: 'Read', input: '{}', status: 'started' } },
  { ts: 1, message: { seq: 3, type: 'primary_text', phase: 'passthrough', text: 'second' } },
  { ts: 1, message: { seq: 4, type: 'primary_tool_use', toolUseId: 'a', tool: 'Read', input: '{"data":"binary"}', output: '{"thinking":"private","text":"result"}', status: 'completed' } },
  { ts: 1, message: { seq: 5, type: 'primary_complete', text: 'first second' } },
 ], 5, true);
 assert.equal(rows[0].text, 'first second');
 assert.equal(rows.length, 2);
 assert.doesNotMatch(JSON.stringify(rows), /binary|private/);
});
test('source deletion, symlinked event files and restricted modes revoke access', async () => {
 const { symlink } = await import('node:fs/promises');
 const f = await fixture();
 const file = join(f.cwd, '.arco', 'workflows', f.source, 'events.jsonl');
 await rm(file); await symlink(join(f.cwd, '.arco', 'workflows', f.caller, 'events.jsonl'), file);
 await assert.rejects(executeHandoffHistory(f.caller, { action: 'read' }));
 await rm(join(f.cwd, '.arco', 'workflows', f.source), { recursive: true });
 await assert.rejects(executeHandoffHistory(f.caller, { action: 'read' }));
 workflows.get(f.caller)!.config.incognito = true;
 assert.deepEqual(await availableHandoffSources(f.caller), []);
});
test('the saved Native handoff and seed receive one deterministic availability line', async () => {
 const { appendHandoffNotice, HANDOFF_HISTORY_NOTICE } = await import('./handoffHistoryTool.js');
 const f = await fixture(); workflows.get(f.caller)!.config.claudeTransport = 'native';
 const dir = join(f.cwd, '.arco', 'workflows', f.caller, 'handoffs'); await mkdir(dir);
 const file = join(dir, 'brief.md'); await writeFile(file, 'brief');
 const text = await appendHandoffNotice(f.cwd, f.caller, 'brief.md', 'brief', f.refs[0].key);
 assert.ok(text.includes(HANDOFF_HISTORY_NOTICE));
 assert.equal(await appendHandoffNotice(f.cwd, f.caller, 'brief.md', text, f.refs[0].key), text);
 assert.equal(await appendHandoffNotice(f.cwd, f.caller, 'brief.md', 'brief'), 'brief');
 workflows.get(f.caller)!.config.claudeTransport = 'cli';
 assert.match(await appendHandoffNotice(f.cwd, f.caller, 'brief.md', 'brief', f.refs[0].key), /handoff_history/);
});
test('escaped source labels share the response byte cap and paginate', async () => {
 const { readFile } = await import('node:fs/promises');
 const f = await fixture(), file = join(f.cwd, '.arco', 'workflows', f.caller, 'meta.json');
 const meta = JSON.parse(await readFile(file, 'utf8'));
 meta.handoffHistory = Array.from({ length: 20 }, (_, i) => ({ ...f.refs[0], key: i ? `source-${i}` : f.refs[0].key, name: '\u0001'.repeat(256) }));
 await writeFile(file, JSON.stringify(meta));
 const reply = await executeHandoffHistory(f.caller, { action: 'sources', limit: 20 });
 assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 24576);
 assert.ok(reply.cursor);
 assert.ok(reply.sources!.length < 20);
});

test('CLI and ultracode handoffs receive history guidance when their adapter attaches it', async () => {
 const { appendHandoffNotice } = await import('./handoffHistoryTool.js');
 const f = await fixture(), dir = join(f.cwd, '.arco', 'workflows', f.caller, 'handoffs');
 await mkdir(dir); await writeFile(join(dir, 'brief.md'), 'brief');
 const { effectiveClaudeTransport } = await import('./claudeTransport.js');
 assert.equal(effectiveClaudeTransport(workflows.get(f.caller)!.config, undefined), 'cli');
 workflows.get(f.caller)!.config.claudeTransport = 'cli';
 assert.match(await appendHandoffNotice(f.cwd, f.caller, 'brief.md', 'brief', f.refs[0].key), /handoff_history/);
 workflows.get(f.caller)!.config.claudeTransport = 'native';
 workflows.get(f.caller)!.config.ultracode = true;
 assert.match(await appendHandoffNotice(f.cwd, f.caller, 'brief.md', 'brief', f.refs[0].key), /handoff_history/);
});
test('adding the notice preserves all existing artifact content', async () => {
 const { appendHandoffNotice, HANDOFF_HISTORY_NOTICE } = await import('./handoffHistoryTool.js');
 const { readFile } = await import('node:fs/promises');
 const f = await fixture(), dir = join(f.cwd, '.arco', 'workflows', f.caller, 'handoffs');
 workflows.get(f.caller)!.config.claudeTransport = 'native';
 await mkdir(dir); const file = join(dir, 'brief.md'); await writeFile(file, 'Additional original content.');
 await appendHandoffNotice(f.cwd, f.caller, 'brief.md', 'brief', f.refs[0].key);
 await appendHandoffNotice(f.cwd, f.caller, 'brief.md', 'brief', f.refs[0].key);
 const saved = await readFile(file, 'utf8');
 assert.ok(saved.startsWith('Additional original content.'));
 assert.equal(saved.split(HANDOFF_HISTORY_NOTICE).length, 2);
});
test('cancellation during history refresh prevents startup and requests', async () => {
 const { ClaudeNativeWorker } = await import('./providers/claude-native/worker.js');
 const f = await fixture();
 const worker = new ClaudeNativeWorker({ workflowId: f.caller, config: { cwd: f.cwd, provider: 'claude', model: 'opus', effort: 'low' } as never }) as any;
 worker.on('error', () => {});
 let release!: () => void, started = 0;
 worker.refreshHandoffHistory = () => new Promise<void>(resolve => { release = resolve; });
 worker.ensureStarted = async () => { started++; };
 worker.urlReadsThisTurn = 9; worker.turnInputAccepted = true;
 const pending = worker.runTurnInner('fixture');
 assert.equal(worker.urlReadsThisTurn, 0); assert.equal(worker.turnInputAccepted, false);
 worker.cancel(); release(); await pending;
 assert.equal(started, 0);
});

test('a persisted failed seed invalidates cached availability', async () => {
 const f = await fixture();
 assert.equal((await availableHandoffSources(f.caller)).length, 1);
 const { initWorkflowStore, persistAndStampSeq, flushWorkflowBuffer } = await import('./workflowStore.js');
 await initWorkflowStore(f.cwd, f.caller);
 persistAndStampSeq(f.cwd, f.caller, { type: 'user_message_echo', workflowId: f.caller, content: '[HANDOFF: new session initialized for this tab.]' } as never);
 assert.deepEqual(await availableHandoffSources(f.caller), []);
 await flushWorkflowBuffer(f.cwd, f.caller);
});

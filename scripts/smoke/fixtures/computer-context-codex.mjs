// App-server peer for fresh-context lifecycle tests; no inference/network.
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
if (!process.argv.includes('app-server')) {
  if (process.cwd().includes('archon-input-observation-')) {
    let text='';for await(const chunk of process.stdin)text+=chunk;
    const input=JSON.parse(text),result={workers:input.workers.map((w)=>({id:w.id,needs_input:w.text.includes('NEEDS_OPERATOR_INPUT')?true:w.text.includes('UNKNOWN_INPUT')?null:false}))};
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:10,cached_input_tokens:0}}));
    process.exit(0);
  }
  console.log(process.argv.includes('--version') ? 'codex-cli 0.163.0' : 'Logged in using ChatGPT');
  process.exit(0);
}
const home = process.env.CODEX_HOME ?? process.env.ARCHON_COMPUTER_TEST_CODEX_HOME;
if (!home?.includes('archon-computer-')) throw Error('Fixture requires an isolated Codex home');
const sessions = join(home, 'sessions', '2026', '10', '17'); mkdirSync(sessions, { recursive: true });
let threadId, ephemeral = false, turn = 0;
let pendingTimer, pendingTurnId;
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => out({ id, result });
const notify = (method, params) => out({ method, params });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (!m.method) continue;
  if (m.method === 'initialize') { reply(m.id, { userAgent: 'computer-context-fixture' }); continue; }
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    ephemeral = m.params.ephemeral === true;
    threadId = m.method === 'thread/resume' ? m.params.threadId : randomUUID();
    const durablePrivate = ephemeral && process.env.ARCHON_COMPUTER_FIXTURE_DURABLE_PRIVATE === '1';
    reply(m.id, { thread: { id: threadId, ephemeral: ephemeral && !durablePrivate, path: ephemeral && !durablePrivate ? null : 'fixture-rollout' }, model: 'gpt-6-luna' }); continue;
  }
  if (m.method === 'turn/start') {
    const turnId = `turn-${++turn}`;
    const text = m.params.input.map((item) => item.text ?? '').join('');
    appendFileSync(join(home, 'fixture-turns.jsonl'), JSON.stringify({ threadId, text, pid: process.pid }) + '\n');
    reply(m.id, { turn: { id: turnId } });
    notify('turn/started', { threadId, turn: { id: turnId } });
    const input = text.includes('large') ? 60000 : 1000;
    const usage = { inputTokens: input, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: input + 3 };
    notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: usage, last: usage, modelContextWindow: 100000 } });
    // Yield so the browser can request a fresh start and queue a follow-up.
    pendingTurnId = turnId;
    if (/\bhang\b/.test(text)) {
      notify('item/agentMessage/delta', { threadId, turnId, itemId: turnId, delta: 'Checking the screen.' });
      pendingTimer = setInterval(() => {
        notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: usage, last: usage, modelContextWindow: 100000 } });
        notify('item/started', { threadId, turnId, item: { id: `wait-${Date.now()}`, type: 'mcpToolCall', server: 'code-runner', tool: 'wait', arguments: {}, error: null } });
      },50);
      continue;
    }
    pendingTimer = setTimeout(() => {
      pendingTurnId = undefined;
      notify('item/agentMessage/delta', { threadId, turnId, itemId: turnId, delta: `Completed ${text}.` });
      if (!ephemeral) appendFileSync(join(sessions, `rollout-fixture-${threadId}.jsonl`), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 3, total_tokens: input + 3 }, model_context_window: 100000,
      } } }) + '\n');
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null } });
    }, text.startsWith('[Archon activity update') ? Number(process.env.ARCHON_COMPUTER_FIXTURE_ACTIVITY_DELAY_MS ?? 20) : text.includes('slow') ? 1200 : 20);
    continue;
  }
  if (m.method === 'turn/interrupt') {
    clearTimeout(pendingTimer);
    reply(m.id, {});
    if (pendingTurnId) notify('turn/completed', { threadId, turn: { id: pendingTurnId, status: 'interrupted', error: null } });
    pendingTurnId = undefined;
    continue;
  }
  if (m.method === 'thread/compact/start') {const compactId=`compact-${++turn}`;reply(m.id,{});notify('turn/started',{threadId,turn:{id:compactId}});notify('thread/compacted',{threadId});setTimeout(()=>notify('turn/completed',{threadId,turn:{id:compactId,status:'completed',error:null}}),250);continue;}
  if (m.id !== undefined) reply(m.id, {});
}

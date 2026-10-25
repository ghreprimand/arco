// A deterministic Claude CLI / Codex exec / Codex app-server peer.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const claude = process.argv[1].endsWith('claude');
const appserver = process.argv.includes('app-server');
const record = (event, prompt = '') => appendFileSync(process.env.ARCO_INTERRUPT_JOURNAL, JSON.stringify({ event, prompt, pid: process.pid }) + '\n');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
if (process.argv.includes('--version')) { console.log('codex-cli 0.164.0'); process.exit(); }
if (!appserver && !process.argv.includes('-p') && !process.argv.includes('exec')) { console.log('fixture --json --model --config --sandbox --ask-for-approval'); process.exit(); }
const threadId = 'interrupt-fixture-thread';
let turn = 0, current = '', timer;
const say = (text) => appserver
  ? out({ method: 'item/agentMessage/delta', params: { threadId, turnId: current, itemId: `say-${turn}`, delta: text } })
  : claude ? out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
    : out({ type: 'item.completed', item: { type: 'agent_message', id: 'say', text } });
function finish(status = 'completed') {
  record(status);
  if (appserver) {
    out({ method: 'turn/completed', params: { threadId, turn: { id: current, status, error: null } } });
    current = '';
  } else {
    out(claude ? { type: 'result', result: 'DONE', duration_ms: 1, total_cost_usd: 0 }
      : { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    process.exit();
  }
}
function start(prompt) {
  record('start', prompt);
  const marker = prompt.includes('HOLD') ? 'HOLD' : prompt.includes('CORRECTION') ? 'CORRECTION' : 'FOLLOW';
  say(`READY ${marker}`);
  if (marker !== 'HOLD') timer = setTimeout(() => finish(), 400);
}
if (appserver) {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const m = JSON.parse(line), reply = (result) => out({ id: m.id, result });
    if (m.method === 'turn/start') {
      if (current) throw new Error('Concurrent turns!');
      current = `turn-${++turn}`; reply({ turn: { id: current } });
      out({ method: 'turn/started', params: { threadId, turn: { id: current } } });
      start(JSON.stringify(m.params.input));
    } else if (m.method === 'turn/interrupt') {
      record('interrupt'); clearTimeout(timer); reply({});
      // Force the client to wait for interrupted completion, beyond the RPC ack.
      timer = setTimeout(() => finish('interrupted'), 250);
    } else if (m.method === 'turn/steer') {
      record('steer', JSON.stringify(m.params.input)); reply({ turnId: current });
    } else if (m.method === 'initialize') reply({ userAgent: 'interrupt-fixture' });
    else if (m.method === 'model/list') reply({ data: [], nextCursor: null });
    else if (m.method === 'thread/start' || m.method === 'thread/resume') reply({ thread: { id: threadId }, model: 'gpt-5.5' });
    else if (m.id !== undefined) reply({});
  }
} else {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  out(claude ? { type: 'system', subtype: 'init', session_id: 'interrupt-claude-session' }
    : { type: 'thread.started', thread_id: threadId });
  process.on('SIGTERM', () => {
    record('interrupt'); clearTimeout(timer);
    setTimeout(() => { record('interrupted'); process.exit(); }, 250);
  });
  start(prompt);
  setInterval(() => {}, 60_000);
}

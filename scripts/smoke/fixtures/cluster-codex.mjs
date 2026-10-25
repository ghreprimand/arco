#!/usr/bin/env node
// Protocol fixture only: no inference, credentials or external requests.
// It starts the real compiled cluster MCP child from the provider's argv.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const argv = process.argv.slice(2);
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('codex exec app-server --json --model --config --sandbox --ask-for-approval --output-last-message');
  process.exit(0);
}
if (!argv.includes('app-server')) {
  // Login state is a marker in CODEX_HOME: `login status` reports it and
  // `login --device-auth` prints the real CLI's shape, then completes itself.
  const marker = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'fixture-login');
  if (argv.includes('--version')) console.log('codex-cli 0.163.0');
  else if (argv.includes('login') && argv.includes('status')) {
    if (existsSync(marker)) console.log('Logged in using ChatGPT');
    else { console.log('Not logged in'); process.exit(1); }
  } else if (argv.includes('login')) {
    console.log('Follow these steps to sign in with ChatGPT using device code authorization:\n');
    console.log('1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.example.test/codex/device\x1b[0m\n');
    console.log('2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mARCO-FIXTURE-CODE\x1b[0m\n');
    await delay(3000);
    mkdirSync(join(marker, '..'), { recursive: true });
    writeFileSync(marker, '');
    console.log('Successfully logged in');
  } else if (argv.includes('exec')) {
    for await (const _chunk of process.stdin) { /* Consume the review prompt. */ }
    out({ type: 'thread.started', thread_id: `fixture-review-${process.pid}` });
    out({ type: 'item.completed', item: { id: 'review', type: 'agent_message', text: '# Fixture review\n\nSynthetic review completed through the compiled provider transport.' } });
    out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } });
  } else console.log('codex --json --model --config --sandbox --ask-for-approval');
  process.exit(0);
}

const overrides = {};
for (let i = 0; i < argv.length - 1; i++) {
  if (argv[i] !== '-c') continue;
  const argument = argv[++i], at = argument.indexOf('=');
  try { overrides[argument.slice(0, at)] = JSON.parse(argument.slice(at + 1)); } catch { /* Other TOML overrides. */ }
}
const children = new Set();
async function clusterTools() {
  const command = overrides['mcp_servers.arco-cluster.command'];
  const args = overrides['mcp_servers.arco-cluster.args'];
  assert.equal(command, 'node');
  assert.ok(args[0].endsWith('/server/dist/mcp/clusterMcpServer.js'));
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  // MCP diagnostics stay off the provider's JSON-RPC stdout.
  child.stderr.resume();
  const waiting = new Map(); let sequence = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Fixture MCP timeout: ${method}`)); }, 10000);
    waiting.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line), pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
  });
  child.on('exit', () => {
    children.delete(child);
    for (const pending of waiting.values()) pending.reject(new Error('Fixture MCP child exited'));
    waiting.clear();
  });
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'arco-fixture', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request('tools/list', {});
  for (const name of ['peer_list', 'peer_send', 'peer_read', 'cluster_task_create', 'cluster_task_claim', 'cluster_task_complete']) assert.ok(listed.tools.some(tool => tool.name === name));
  return {
    async call(name, arguments_ = {}) {
      const result = await request('tools/call', { name, arguments: arguments_ });
      assert.ok(!result.isError, `Fixture tool failed: ${name}`);
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      try { return JSON.parse(text); } catch { return text; }
    },
    close() { child.stdin.end(); },
  };
}

let threadId = `fixture-thread-${process.pid}`, turnId = '', turn = 0, pending;
const reply = (id, result) => out({ id, result });
const notify = (method, params) => out({ method, params });
const say = text => notify('item/agentMessage/delta', { threadId, turnId, itemId: `text-${turn}`, delta: text });
const finish = (status = 'completed') => notify('turn/completed', { threadId, turn: { id: turnId, status, error: null } });
async function receive(message) {
  if (!message.method && message.id === 'fixture-finish' && pending) {
    assert.equal(message.result?.answers?.finish?.answers?.[0], 'Finish');
    const { tools, task } = pending; pending = undefined;
    writeFileSync('fixture-result.txt', 'Fixture worker edited the mounted project.\n');
    const completed = await tools.call('cluster_task_complete', { id: task.id, summary: 'Synthetic work completed; operator review remains required.' });
    assert.equal(completed.status, 'review');
    tools.close(); say('ARCO_FIXTURE_COMPLETED'); finish(); return;
  }
  if (!message.method) return;
  switch (message.method) {
    case 'initialize': reply(message.id, { userAgent: 'arco-cluster-fixture' }); break;
    case 'initialized': break;
    case 'account/read': reply(message.id, { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' }, requiresOpenaiAuth: false }); break;
    case 'model/list': reply(message.id, { data: [{ id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'Fixture model', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }], defaultReasoningEffort: 'low', inputModalities: ['text'] }], nextCursor: null }); break;
    case 'thread/start': case 'thread/resume':
      threadId = message.params?.threadId || threadId;
      reply(message.id, { thread: { id: threadId }, model: 'gpt-5.5' }); break;
    case 'thread/goal/clear': reply(message.id, { cleared: false }); break;
    case 'turn/start': {
      turnId = `turn-${++turn}`;
      reply(message.id, { turn: { id: turnId } });
      notify('turn/started', { threadId, turn: { id: turnId } });
      const prompt = JSON.stringify(message.params.input);
      if (prompt.includes('ARCO_SMOKE_COORDINATE')) {
        const tools = await clusterTools();
        const peers = await tools.call('peer_list'); assert.ok(peers.length);
        const plan = await tools.call('cluster_plan_read'); assert.match(JSON.stringify(plan), /ARCO_FIXTURE_PLAN/);
        const task = await tools.call('cluster_task_create', { title: 'Fixture mounted-file edit', reviewRequired: true }); assert.ok(task.id);
        const claimed = await tools.call('cluster_task_claim', { id: task.id }); assert.equal(claimed.status, 'in_progress');
        for (const peer of peers) await tools.call('peer_send', { to: peer.workflowId, content: 'ARCO_FIXTURE_NOTE: task is claimed; wait for operator review.' });
        pending = { tools, task };
        say(`ARCO_FIXTURE_CLAIMED:${task.id}`);
        out({ id: 'fixture-finish', method: 'item/tool/requestUserInput', params: { threadId, turnId, itemId: 'finish', isBlocking: true, questions: [{ id: 'finish', header: 'Finish', question: 'Finish the synthetic task?', isOther: false, options: [{ label: 'Finish', description: 'Write the synthetic file and submit for review.' }] }] } });
      } else if (prompt.includes('ARCO_SMOKE_READ')) {
        // ARCO_SMOKE_READ expects the coordinator's note; ARCO_SMOKE_READ_HOST
        // expects the acknowledgement a host-served model member sent back.
        const [marker, answer] = prompt.includes('ARCO_SMOKE_READ_HOST')
          ? ['ARCO_FIXTURE_HOST_ACK', 'ARCO_FIXTURE_HOST_ACK_RECEIVED']
          : ['ARCO_FIXTURE_NOTE', 'ARCO_FIXTURE_MAILBOX_RECEIVED'];
        const tools = await clusterTools(); const messages = await tools.call('peer_read'); tools.close();
        assert.ok(prompt.includes(marker) || JSON.stringify(messages).includes(marker), `mailbox lacks ${marker}`);
        say(answer); finish();
      } else if (prompt.includes('ARCO_SMOKE_CANCEL')) say('ARCO_FIXTURE_WAITING_FOR_CANCEL');
      else { say('ARCO_FIXTURE_REPLY'); finish(); }
      break;
    }
    case 'turn/interrupt':
      pending?.tools.close(); pending = undefined;
      reply(message.id, {}); finish('interrupted'); break;
    default: if (message.id !== undefined) reply(message.id, {});
  }
}
function cleanup() { for (const child of children) child.kill('SIGTERM'); }
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
for await (const line of readline.createInterface({ input: process.stdin })) {
  try { await receive(JSON.parse(line)); } catch (error) {
    process.stderr.write(`Cluster fixture failed: ${error.message}\n`); cleanup(); process.exit(1);
  }
}
cleanup();

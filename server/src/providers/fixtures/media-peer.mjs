// Local protocol peer: no provider executable, network, credentials or model.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [kind, log, imageCapability] = process.argv.slice(2);
if (kind === 'catalog') { console.log('auto - Auto (current, default)'); process.exit(0); }
function send(frame) { process.stdout.write(JSON.stringify(frame) + '\n'); }
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(log, JSON.stringify(request) + '\n');
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case 'initialize': result = kind === 'codex'
      ? { userAgent: 'arco-fixture' }
      : { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: imageCapability === 'true' } } }; break;
    case 'thread/start': result = { thread: { id: 'thread-fixture' }, model: 'fixture' }; break;
    case 'thread/goal/clear': result = { cleared: false }; break;
    case 'turn/start': result = { turn: { id: 'turn-fixture' } }; break;
    case 'turn/steer': result = { turnId: 'turn-fixture' }; break;
    case 'session/new': result = { sessionId: 'session-fixture', models: { currentModelId: 'default[]', availableModels: [{ modelId: 'default[]' }] } }; break;
    case 'session/set_model': result = {}; break;
    case 'session/set_config_option': result = { configOptions: [{ id: 'model', currentValue: 'default[]' }] }; break;
    case 'session/prompt': result = { stopReason: 'end_turn' }; break;
    default: throw new Error(`Unexpected fixture method ${request.method}`);
  }
  send({ ...(kind === 'cursor' ? { jsonrpc: '2.0' } : {}), id: request.id, result });
}

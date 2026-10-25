// Host-served local model fixture: an Ollama-compatible HTTP server that the
// smoke runs on the Docker host, where an operator's Ollama or LM Studio would
// run. The container reaches it through host.docker.internal. Protocol only:
// no inference, credentials, model files or outbound requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export const HOST_MODEL = 'arco-fixture:latest';

async function body(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text;
}

// One NDJSON /api/chat response: a single assistant chunk, then the done
// envelope the adapter reads token counts from.
function stream(res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  const line = message => res.write(JSON.stringify({ model: HOST_MODEL, created_at: new Date().toISOString(), message, done: false }) + '\n');
  const finish = () => {
    res.end(JSON.stringify({ model: HOST_MODEL, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 3, total_duration: 1_000_000 }) + '\n');
  };
  return {
    text(content) { line({ role: 'assistant', content }); finish(); },
    call(name, args) { line({ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }); finish(); },
  };
}

// Cluster member turn. The adapter advertises the peer tools natively and
// executes each call through Arco's loopback peer routes; the fixture decides
// the next call from the tool history of the current turn.
function chat(request, res) {
  assert.equal(request.model, HOST_MODEL);
  assert.equal(request.stream, true);
  const messages = request.messages;
  const transcript = JSON.stringify(messages);
  const lastUser = [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
  const lastTool = [...messages].reverse().find(message => message.role === 'tool')?.content ?? '';
  const calls = messages.flatMap(message => message.role === 'assistant' && Array.isArray(message.tool_calls) ? message.tool_calls.map(call => call.function.name) : []);
  const reply = stream(res);
  if (!lastUser.includes('ARCO_SMOKE_HOST_REPORT')) return reply.text('ARCO_FIXTURE_HOST_REPLY');
  const advertised = new Set((request.tools ?? []).map(tool => tool.function?.name));
  for (const name of ['peer_list', 'peer_read', 'peer_send']) assert.ok(advertised.has(name), `peer tool not advertised natively: ${name}`);
  const previous = calls.at(-1);
  // The coordinator's note is either injected at turn start or still queued.
  if (previous === undefined) return transcript.includes('ARCO_FIXTURE_NOTE') ? reply.call('peer_list', {}) : reply.call('peer_read', {});
  if (previous === 'peer_read') { assert.match(lastTool, /ARCO_FIXTURE_NOTE/); return reply.call('peer_list', {}); }
  if (previous === 'peer_list') {
    assert.ok(JSON.parse(lastTool).some(peer => peer.role === 'Coordinator'), 'peer_list must expose the coordinator role');
    return reply.call('peer_send', { to: 'Coordinator', content: 'ARCO_FIXTURE_HOST_ACK: host-served model read the coordinator note.' });
  }
  if (previous === 'peer_send') { assert.doesNotMatch(lastTool, /\[error\]/); assert.match(lastTool, /msgId/); return reply.text('ARCO_FIXTURE_HOST_DONE'); }
  assert.fail(`unexpected tool sequence: ${calls.join(', ')}`);
}

export function startHostModel(host) {
  const requests = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    const route = `${req.method} ${req.url}`;
    requests.push(route);
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (route === 'GET /api/version') return json(200, { version: '0.0.0-arco-fixture' });
      if (route === 'GET /api/tags') return json(200, { models: [{ name: HOST_MODEL, model: HOST_MODEL, size: 0, digest: 'fixture', details: { family: 'fixture', parameter_size: '0B' } }] });
      if (route === 'GET /api/ps') return json(200, { models: [] });
      if (route === 'POST /api/show') { await body(req); return json(200, { capabilities: ['completion', 'tools'], parameters: 'num_ctx 8192', model_info: { 'fixture.context_length': 8192 } }); }
      if (route === 'POST /api/chat') return chat(JSON.parse(await body(req)), res);
      json(404, { error: `fixture has no route ${route}` });
    } catch (error) {
      errors.push(`${route}: ${error.message}`);
      process.stderr.write(`Host model fixture failed: ${route}: ${error.message}\n`);
      if (!res.headersSent) json(500, { error: error.message }); else res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve({
      port: server.address().port,
      requests,
      errors,
      close: () => new Promise(done => server.close(done)),
    }));
  });
}

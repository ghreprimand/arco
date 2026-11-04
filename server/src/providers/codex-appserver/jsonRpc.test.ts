import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import { JsonRpcClient } from './jsonRpc.js';

function harness() {
  const toCodex = new PassThrough();
  const fromCodex = new PassThrough();
  const written: Array<Record<string, unknown>> = [];
  toCodex.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) written.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const client = new JsonRpcClient(toCodex, fromCodex);
  const send = (msg: unknown) => fromCodex.write(JSON.stringify(msg) + '\n');
  return { client, written, send };
}

const tick = () => new Promise((r) => setImmediate(r));

test('server→client request with an overlapping id is answered, not routed as a response', async () => {
  const { client, written, send } = harness();
  const pending = client.request('turn/start', {});
  await tick();
  const ourId = written[0].id;
  // Codex's own request reuses our id space.
  send({ id: ourId, method: 'item/commandExecution/requestApproval', params: {} });
  await tick();
  assert.deepEqual(written[1], { id: ourId, result: { decision: 'decline' } });
  // Our call is still pending and resolves on the real response.
  send({ id: ourId, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
});

test('string-id elicitation gets a decline result', async () => {
  const { written, send } = harness();
  send({ id: 'e-1', method: 'mcpServer/elicitation/request', params: {} });
  await tick();
  assert.deepEqual(written[0], { id: 'e-1', result: { action: 'decline', content: null, _meta: null } });
});

test('unhandled request method gets -32601', async () => {
  const { client, written, send } = harness();
  const seen: string[] = [];
  client.on('server_request', (req: { method: string }) => seen.push(req.method));
  send({ id: 7, method: 'account/chatgptAuthTokens/refresh', params: {} });
  await tick();
  assert.equal(written[0].id, 7);
  assert.equal((written[0].error as { code: number }).code, -32601);
  assert.deepEqual(seen, ['account/chatgptAuthTokens/refresh']);
});

test('notifications still emit as notifications', async () => {
  const { client, written, send } = harness();
  const got: string[] = [];
  client.on('notification', (n: { method: string }) => got.push(n.method));
  send({ method: 'turn/started', params: {} });
  await tick();
  assert.deepEqual(got, ['turn/started']);
  assert.equal(written.length, 0);
});

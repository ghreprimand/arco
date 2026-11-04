import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

// A real route and durable log, with an in-process provider fixture and home.
test('catch-up route collects and logs bounded workflow activity; cancellation stops a run', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arco-catch-route-'));
  process.env.ARCO_HOME = join(home, 'state');
  const cwd = join(home, 'project'), id = 'fixture-workflow'; mkdirSync(cwd, { recursive: true });
  const [{ workflows, workflowCwds }, { initWorkflowStore, flushWorkflowBuffer }, { patchSettings }, { setEvaluatorAdaptersForTest, EvaluatorRefused }, { tryHandleUtilityAgentRoutes }] = await Promise.all([
    import('../server/state.js'), import('../workflowStore.js'), import('../settings.js'), import('../smartPickupAdapters.js'), import('./utilityAgentRoutes.js'),
  ]);
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  const restore = setEvaluatorAdaptersForTest({ ollama: {
    provider: 'ollama', capability: async () => ({ provider: 'ollama', available: true }),
    evaluate: async (req) => { calls++; if (calls === 1) { assert.match(req.prompt, /fixture event/); return 'Fixture summary'; } await wait; if (req.signal?.aborted) throw new EvaluatorRefused('cancelled'); return 'unexpected'; },
  } });
  const request = async (url: string, body: unknown) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url }) as IncomingMessage;
    let code = 0, text = '';
    const res = { writeHead: (status: number) => { code = status; }, end: (value: string) => { text = value; } } as unknown as ServerResponse;
    assert.equal(await tryHandleUtilityAgentRoutes(req, res), true);
    return { code, body: JSON.parse(text) };
  };
  try {
    await patchSettings({ utilityAgent: { provider: 'ollama', model: 'tiny' } });
    await initWorkflowStore(cwd, id);
    const dir = join(cwd, '.arco', 'workflows', id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ seq: 1, ts: Date.now() - 500, type: 'user_message_echo', content: 'fixture event' }) + '\n');
    workflows.set(id, { config: { name: 'Fixture', workingDirectory: cwd }, observers: new Set(), primary: { provider: 'ollama' } } as never);
    workflowCwds.set(id, cwd);
    const body = { jobId: 'catch-fixture', scope: 'workflow', id, from: Date.now() - 1000 };
    const result = await request('/api/utility-agent/catch-up', body);
    assert.equal(result.code, 200); assert.equal(result.body.status, 'ok'); assert.equal(result.body.text, 'Fixture summary');
    assert.equal(result.body.facts[0].value, 'fixture event'); assert.ok(result.body.to >= body.from);
    await flushWorkflowBuffer(cwd, id);
    assert.match(readFileSync(join(dir, 'events.jsonl'), 'utf8'), /Catch me up.*Fixture summary/);
    const pending = request('/api/utility-agent/catch-up', { ...body, jobId: 'catch-cancel' });
    for (let i = 0; calls < 2 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 2);
    const cancelled = await request('/api/utility-agent/cancel', { jobId: 'catch-cancel' });
    assert.equal(cancelled.body.cancelled, true); finish(); assert.equal((await pending).body.status, 'cancelled');
    const missing = await request('/api/utility-agent/catch-up', { ...body, jobId: 'catch-missing', id: 'missing' });
    assert.equal(missing.code, 409);
  } finally {
    restore(); workflows.delete(id); workflowCwds.delete(id); await flushWorkflowBuffer(cwd, id); rmSync(home, { recursive: true, force: true });
  }
});

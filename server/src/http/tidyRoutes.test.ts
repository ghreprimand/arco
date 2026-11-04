import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

test('tidy route passes the whole draft and directives to the fixture and logs the result', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arco-tidy-route-')); process.env.ARCO_HOME = join(home, 'state');
  const [{ workflows }, { patchSettings }, { setEvaluatorAdaptersForTest }, { tryHandleTidyRoutes }] = await Promise.all([
    import('../server/state.js'), import('../settings.js'), import('../smartPickupAdapters.js'), import('./tidyRoutes.js'),
  ]);
  let sent = '';
  const restore = setEvaluatorAdaptersForTest({ ollama: { provider: 'ollama', capability: async () => ({ provider: 'ollama', available: true }), evaluate: async (req) => { sent = req.prompt; return 'Fixture proposal'; } } });
  const observed: unknown[] = [];
  const id = 'fixture-workflow';
  const request = async (body: unknown) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: '/api/utility-agent/tidy' }) as IncomingMessage;
    let code = 0, text = '';
    const res = { writeHead: (status: number) => { code = status; }, end: (value: string) => { text = value; } } as unknown as ServerResponse;
    assert.equal(await tryHandleTidyRoutes(req, res), true); return { code, body: JSON.parse(text) };
  };
  try {
    await patchSettings({ utilityAgent: { provider: 'ollama', model: 'tiny' } });
    workflows.set(id, { config: { name: 'Fixture' }, primary: { provider: 'ollama' }, observers: new Set([{ readyState: 1, send: (msg: string) => observed.push(JSON.parse(msg)) }]) } as never);
    const input = { jobId: 'tidy-fixture', workflowId: id, original: 'Keep every file', proposal: 'Earlier draft', directives: ['shorter', 'keep file list'] };
    const result = await request(input);
    assert.equal(result.code, 200); assert.equal(result.body.status, 'ok'); assert.equal(result.body.text, 'Fixture proposal');
    assert.match(sent, /Keep every file/); assert.match(sent, /Earlier draft/); assert.match(sent, /keep file list/);
    assert.ok(observed.some((message) => (message as { type?: string; content?: string }).type === 'system_notice' && (message as { content?: string }).content?.includes('Fixture proposal')));
    assert.equal((await request({ ...input, original: 'x'.repeat(18_000) })).code, 400);
    assert.equal((await request({ ...input, workflowId: 'missing' })).code, 404);
  } finally { restore(); workflows.delete(id); rmSync(home, { recursive: true, force: true }); }
});

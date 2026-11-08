import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';

async function client() {
  const source = await readFile(new URL('./publicProject.ts', import.meta.url), 'utf8');
  const result = await transform(source, { loader: 'ts', format: 'cjs' });
  const module = { exports: {} as typeof import('./publicProject') };
  new Function('require', 'module', 'exports', result.code)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}

test('LA02: starting a plan refreshes an independent client without reposting its stale choice', async t => {
  let serverChoice: boolean | null = false;
  const writes: boolean[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { serverChoice = JSON.parse(String(init.body)).value; writes.push(serverChoice as boolean); }
    return Response.json({ choice: serverChoice });
  });
  const a = await client(); const b = await client();
  assert.equal(await a.rememberPublicChoice('/projects/fixture'), false);
  await b.setPublicChoice('/projects/fixture', true);
  assert.equal(await a.rememberPublicChoice('/projects/fixture'), true);
  assert.equal(serverChoice, true);
  assert.deepEqual(writes, [true]);
  await a.setPublicChoice('/projects/fixture', false);
  assert.equal(await a.rememberPublicChoice('/projects/fixture'), false);
  assert.deepEqual(writes, [true, false]);
});

test('LA02: plan startup waits for an explicit choice write and refuses a failed write', async t => {
  let resolveWrite!: (r: Response) => void;
  const write = new Promise<Response>(resolve => { resolveWrite = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => init?.method === 'POST' ? write : Response.json({ choice: false }));
  const a = await client();
  const saving = a.setPublicChoice('/projects/fixture', true);
  let completed = false;
  const starting = a.rememberPublicChoice('/projects/fixture').then(() => { completed = true; });
  const savedFailure = assert.rejects(saving, /Could not save/);
  const startFailure = assert.rejects(starting, /Could not save/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  resolveWrite(new Response('', { status: 500 }));
  await Promise.all([savedFailure, startFailure]);
  await assert.rejects(a.rememberPublicChoice('/projects/fixture'), /Could not save/);
});

test('LA02: an explicit decision during refresh wins over the older response', async t => {
  let resolveRead!: (r: Response) => void;
  const read = new Promise<Response>(resolve => { resolveRead = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => init?.method === 'POST' ? Response.json({}) : read);
  const a = await client();
  const starting = a.rememberPublicChoice('/projects/fixture');
  await new Promise(resolve => setImmediate(resolve));
  await a.setPublicChoice('/projects/fixture', true);
  resolveRead(Response.json({ choice: false }));
  assert.equal(await starting, true);
});

test('LA02: a remote suggestion does not become an explicit saved choice on plan startup', async t => {
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.notEqual(init?.method, 'POST');
    return Response.json(String(url).includes('/remote?') ? { state: 'public', host: 'github.com' } : { choice: null });
  });
  const a = await client();
  assert.equal(await a.rememberPublicChoice('/projects/fixture'), true);
  assert.equal(a.getPublicChoice('/projects/fixture'), null);
});

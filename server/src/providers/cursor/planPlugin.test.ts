import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFilePlugin } from './filePlugin.js';

test('Cursor print plugin exposes exactly the three read-only plan tools with workflow context', async () => {
  const home = await mkdtemp(join(tmpdir(), 'arco-print-plans-'));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.method ?? '');
    const url = new URL(req.url!, 'http://127.0.0.1');
    assert.equal(url.searchParams.get('path'), home);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ plans: [{ id: 'plan' }], refs: [{ slug: 'spec' }], ref: { title: 'Spec', body: 'Read this first' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const previous = process.env.ARCO_PORT;
  process.env.ARCO_PORT = String((server.address() as { port: number }).port);
  let plugin: Awaited<ReturnType<typeof createFilePlugin>> | undefined;
  const client = new Client({ name: 'fixture', version: '1' });
  try {
    plugin = await createFilePlugin(home, 'member');
    const config = JSON.parse(await readFile(join(plugin.path, 'mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(config.mcpServers).sort(), ['arco', 'arco-files']);
    const transport = new StdioClientTransport({ ...config.mcpServers.arco, stderr: 'pipe', env: { PATH: process.env.PATH!, HOME: home, ARCO_HOME: home, ARCO_PORT: process.env.ARCO_PORT } });
    let stderr = '';
    transport.stderr?.on('data', data => { stderr += String(data); });
    try { await client.connect(transport); } catch (error) { throw new Error(stderr, { cause: error }); }
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['plan_list', 'plan_ref_list', 'plan_ref_read']);
    for (const [name, args] of [['plan_list', {}], ['plan_ref_list', { planId: 'plan' }], ['plan_ref_read', { planId: 'plan', slug: 'spec' }]] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, name);
      assert.ok(JSON.stringify(result).includes(name === 'plan_ref_read' ? 'Read this first' : name === 'plan_list' ? 'plan' : 'spec'));
    }
    const refused = await client.callTool({ name: 'plan_create', arguments: { title: 'No', body: '### Phase\n- [ ] Task' } });
    assert.equal(refused.isError, true);
    assert.deepEqual(requests, ['GET', 'GET', 'GET']);
  } finally {
    await client.close();
    await plugin?.close();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previous === undefined) delete process.env.ARCO_PORT; else process.env.ARCO_PORT = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test('print plugin without workflow identity retains files only', async () => {
  const plugin = await createFilePlugin(process.cwd());
  try {
    const config = JSON.parse(await readFile(join(plugin.path, 'mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(config.mcpServers), ['arco-files']);
  } finally { await plugin.close(); }
});

test('Cursor print passes workflow identity to the plugin only outside Chat', async t => {
  const { installIsolatedTestHome } = await import('../../testSupport/isolatedHome.js');
  const home = await mkdtemp(join(tmpdir(), 'arco-print-context-'));
  installIsolatedTestHome(home);
  const { CursorPrintProvider } = await import('./print.js');
  const { default: childProcess } = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  try {
    for (const interactionMode of ['agent', 'chat'] as const) {
      let captured: string[] | undefined;
      let spawnedCwd: string | undefined;
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      t.mock.method(childProcess, 'spawn', (_command: unknown, args: string[], options: any) => { captured = args; spawnedCwd = options.cwd; return child; });
      t.mock.method(childProcess, 'execFile', ((_command: string, _args: string[], _options: any, callback: any) => { queueMicrotask(() => callback(Object.assign(new Error('probe'), { code: 1 }), '', "error: unknown option '--arco-chat-capability-probe'")); return child; }) as any);
      syncBuiltinESMExports();
      const worker = CursorPrintProvider.create('fixture', { cwd: home, workflowId: 'member', model: 'auto', effort: 'low', interactionMode });
      worker.on('error', () => {});
      worker.spawn('Read the plan');
      for (let n = 0; !captured && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(captured);
      assert.equal(captured.includes('--plugin-dir'), interactionMode !== 'chat');
      const path = interactionMode === 'chat' ? undefined : captured[captured.indexOf('--plugin-dir') + 1];
      if (path) {
        const plugin = JSON.parse(await readFile(join(path, 'mcp.json'), 'utf8'));
        assert.ok(plugin.mcpServers.arco.args.includes('member'));
      }
      child.emit('close', 0, null);
      child.emit('exit', 0, null);
      // Worker cleanup owns these folders; a second rm races it on Windows.
      const cleanupPath = path ? dirname(path) : spawnedCwd;
      assert.ok(cleanupPath);
      for (let n = 0; n < 100; n++) {
        if (await access(cleanupPath).then(() => false, () => true)) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await assert.rejects(access(cleanupPath), { code: 'ENOENT' });
      t.mock.restoreAll(); syncBuiltinESMExports();
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(home, { recursive: true, force: true }); }
});

test('Cursor plugin has a private parent and cleanup preserves other runs', async () => {
  const first = await createFilePlugin(process.cwd(), 'fixture');
  const second = await createFilePlugin(process.cwd());
  try {
    assert.ok((await realpath(first.path)).split(sep).filter(Boolean).length >= 3);
    assert.notEqual(dirname(first.path), dirname(second.path));
    await access(join(first.path, '.cursor-plugin', 'plugin.json'));
    await access(join(first.path, 'mcp.json'));
    await first.close();
    await assert.rejects(access(dirname(first.path)), { code: 'ENOENT' });
    await access(join(second.path, 'mcp.json'));
  } finally { await first.close(); await second.close(); }
  await assert.rejects(access(dirname(second.path)), { code: 'ENOENT' });
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cliFileReadGuidance, FILE_READ_GUIDANCE } from './providerFileContent.js';
import type { WorkerConfig } from '@arco/shared';

const codex = { provider: 'codex', workflowId: 'guidance', cwd: '.', model: 'fixture', effort: 'medium' } as WorkerConfig;
test('Codex file instructions require a project MCP server and are absent in Chat', () => {
  assert.equal(cliFileReadGuidance(codex), FILE_READ_GUIDANCE);
  assert.equal(cliFileReadGuidance({ ...codex, workflowId: undefined }), undefined);
  assert.equal(cliFileReadGuidance({ ...codex, workflowId: undefined }, 'appserver'), FILE_READ_GUIDANCE);
  assert.equal(cliFileReadGuidance({ ...codex, cwd: undefined }), undefined);
  assert.equal(cliFileReadGuidance({ ...codex, interactionMode: 'chat' }), undefined);
});
test('Claude CLI instructions require the file-bearing MCP entry in the supplied config', () => {
  const home = mkdtempSync(join(tmpdir(), 'arco-guidance-'));
  const path = join(home, 'mcp.json');
  const config = { ...codex, provider: 'claude', clusterMcpConfigPath: path } as WorkerConfig;
  try {
    assert.equal(cliFileReadGuidance(config), undefined);
    writeFileSync(path, JSON.stringify({ mcpServers: { 'arco-cluster': {} } }));
    assert.equal(cliFileReadGuidance(config), undefined);
    writeFileSync(path, JSON.stringify({ mcpServers: { arco: { command: 'node', args: [] } } }));
    assert.equal(cliFileReadGuidance(config), FILE_READ_GUIDANCE);
    assert.equal(cliFileReadGuidance({ ...config, interactionMode: 'chat' }), undefined);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('app-server sends guidance in agent turns and omits it in Chat', async () => {
  const { CodexAppServerWorker } = await import('./codex-appserver/worker.js');
  for (const interactionMode of ['agent', 'chat'] as const) {
    const worker = new CodexAppServerWorker('guidance', { ...codex, interactionMode }, undefined) as any;
    let request: any;
    worker.rpc = { request: async (_method: string, params: any) => { request = params; return { turn: { id: 'turn' } }; } };
    worker.threadId = 'thread';
    await worker.beginTurn('Read the document', 'Keep this instruction');
    const text = request.input.find((item: any) => item.type === 'text').text;
    assert.ok(text.includes('Keep this instruction'));
    assert.equal(text.includes(FILE_READ_GUIDANCE), interactionMode === 'agent');
  }
});

test('Cursor solo file connections carry guidance; absent file tools do not', async () => {
  const { CursorAcpWorker } = await import('./cursor/worker.js');
  const { closeClusterLoopbackMcp } = await import('../mcp/clusterMcpLoopback.js');
  const cwd = mkdtempSync(join(tmpdir(), 'arco-cursor-guidance-'));
  try {
    for (const hasFolder of [true, false]) {
      const id = `guidance-${hasFolder}`;
      const worker = new CursorAcpWorker(id, { ...codex, provider: 'cursor', cwd: hasFolder ? cwd : undefined }, undefined) as any;
      try {
        const servers = await worker.resolveMcpServers();
        assert.equal(servers.length, hasFolder ? 1 : 0);
        let text = '';
        worker.rpc = { request: async (_method: string, params: any) => { text = params.prompt.map((item: any) => item.text ?? '').join(''); return { stopReason: 'end_turn' }; } };
        worker.bootstrapped = true;
        worker.sessionId = 'session';
        worker.applyModelIfChanged = async () => {};
        await worker.beginTurn('Read the document');
        assert.equal(text.includes(FILE_READ_GUIDANCE), hasFolder);
      } finally { closeClusterLoopbackMcp(id); }
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('exec and Claude CLI include file guidance only with the attached workflow server', async (t) => {
  const childProcess = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { ClaudeProvider } = await import('./claude.js');
  const { CodexProvider } = await import('./codex.js');
  const cwd = mkdtempSync(join(tmpdir(), 'arco-cli-guidance-'));
  const path = join(cwd, 'mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: { arco: { command: 'node', args: [] } } }));
  try {
    for (const provider of ['claude', 'codex'] as const) for (const attached of [true, false]) {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      let argv: string[] = [];
      let input = '';
      child.stdin.on('data', data => { input += String(data); });
      t.mock.method(childProcess.default, 'spawn', ((_command: string, args: string[]) => { argv = args; return child; }) as any);
      syncBuiltinESMExports();
      try {
        const config = { ...codex, provider, cwd: attached ? cwd : undefined, clusterMcpConfigPath: attached ? path : undefined };
        const worker = (provider === 'claude' ? ClaudeProvider : CodexProvider).create('guidance', config);
        worker.on('error', () => {});
        worker.spawn('Read the document');
        for (let count = 0; count < 200 && !argv.length; count++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(argv.length, 'fixture child started');
        const guidance = provider === 'claude' ? argv[argv.indexOf('--append-system-prompt') + 1] ?? '' : input;
        assert.equal(guidance.includes(FILE_READ_GUIDANCE), attached, provider);
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

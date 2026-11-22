import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';

test('Claude researcher retries authentication once without unsafe flags', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-worker-credentials-'));
  installIsolatedTestHome(root);
  const store = await import('../clusterStore.js');
  const project = join(root, 'project');
  await mkdir(project);
  const [first, second, standard, unowned] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  try {
    const cluster = await store.createCluster({ cwd: project, memberWorkflowIds: [first, second, standard, unowned] });
    for (const id of [first, second, unowned]) await store.setMemberAccessMode(cluster.clusterId, id, 'isolated');
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'preserved');
    const { ClaudeProvider, isClaudeCliAuthFailure } = await import('./claude.js');
    assert.equal(isClaudeCliAuthFailure('Failed to authenticate: OAuth token revoked.'), true);
    assert.equal(isClaudeCliAuthFailure('rate limit reached'), false);
    const cli = ClaudeProvider.create(first, { model: 'sonnet', effort: 'medium', clusterAccessMode: 'isolated', skipPermissions: true, tools: ['Bash'], additionalDirectories: ['/private'], clusterMcpConfigPath: '/private/mcp.json' });
    const cliArgs = (cli as unknown as { buildArgs(): string[] }).buildArgs();
    assert.ok(!cliArgs.includes('--dangerously-skip-permissions'));
    assert.ok(!cliArgs.includes('--add-dir'));
    assert.ok(!cliArgs.includes('--mcp-config'));
    assert.ok(!cliArgs.includes('--tools'));
    const { StreamParser } = await import('../workers/StreamParser.js');
    const researcher = ClaudeProvider.create('researcher-retry', { model: 'sonnet', effort: 'medium', clusterAccessMode: 'researcher' }) as any;
    const processFixture = new EventEmitter();
    researcher.process = processFixture;
    researcher.parser = new StreamParser();
    researcher._status = 'running';
    let launches = 0; let results = 0; const retryErrors: string[] = []; const retryNotices: string[] = [];
    researcher._launch = async () => { launches++; };
    researcher.on('result', () => { results++; });
    researcher.on('error', (error: string) => retryErrors.push(error));
    researcher.on('system_notice', (notice: string) => retryNotices.push(notice));
    researcher.wireEvents();
    researcher.parser.emit('stream_error', { errorType: 'authentication_error', message: 'OAuth token revoked', transient: false });
    researcher.parser.emit('result', { text: 'Failed to authenticate', costUsd: 0, durationMs: 0 });
    assert.equal(results, 0, 'a successful-looking auth result must not settle the research turn');
    processFixture.emit('close');
    await Promise.resolve();
    assert.equal(launches, 1, 'the researcher retries once with a new pass');
    researcher.process = new EventEmitter();
    researcher.parser = new StreamParser();
    researcher.wireEvents();
    researcher.parser.emit('stream_error', { errorType: 'authentication_error', message: 'OAuth token revoked', transient: false });
    assert.equal(launches, 1, 'the second failure does not trigger another retry');
    assert.match(retryErrors[0], /after a fresh access pass/);
    assert.equal(retryNotices.some((notice) => notice.startsWith('[AUTH:claude]')), false);

  } finally { await rm(root, { recursive: true, force: true }); }
});

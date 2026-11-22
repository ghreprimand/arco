import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';

test('Codex isolated policy requires the expected restrictions', { skip: process.platform !== 'linux' }, async () => {
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
    const { codexIsolatedProfileArgs, isExpectedCodexIsolationConfig } = await import('./codexIsolatedPolicy.js');
    const mailUrl = `http://${[127, 0, 0, 1].join('.')}:32000/mcp/${'a'.repeat(64)}`;
    const profileConfig = { default_permissions: 'arco-isolated', permissions: { 'arco-isolated': { filesystem: { '/': 'read', [['', 'home', 'worker'].join('/')]: 'deny', '/run/arco-pass': 'deny', '/run/arco-check.json': 'deny', '/work': 'write' }, network: { enabled: true } } }, mcp_servers: { 'arco-cluster': { url: mailUrl, default_tools_approval_mode: 'approve', environment_id: 'local' } } };
    assert.equal(isExpectedCodexIsolationConfig(profileConfig, mailUrl), true);
    const withoutPassDeny = structuredClone(profileConfig);
    delete (withoutPassDeny.permissions['arco-isolated'].filesystem as Record<string, string>)['/run/arco-pass'];
    assert.equal(isExpectedCodexIsolationConfig(withoutPassDeny, mailUrl), false);
    assert.equal(isExpectedCodexIsolationConfig({ ...profileConfig, permissions: { 'arco-isolated': { ...profileConfig.permissions['arco-isolated'], extends: 'untrusted' } } }, mailUrl), false);
    assert.equal(isExpectedCodexIsolationConfig({ ...profileConfig, mcp_servers: { 'arco-cluster': { ...profileConfig.mcp_servers['arco-cluster'], environment_id: 'remote' } } }, mailUrl), false);
    assert.equal(isExpectedCodexIsolationConfig(profileConfig, mailUrl + 'x'), false);
    assert.equal(isExpectedCodexIsolationConfig({ ...profileConfig, mcp_servers: { ...profileConfig.mcp_servers, untrusted: {} } }, mailUrl), false);
    assert.equal(isExpectedCodexIsolationConfig({ ...profileConfig, permissions: { 'arco-isolated': { ...profileConfig.permissions['arco-isolated'], network: { enabled: true, dangerously_allow_all_unix_sockets: true } } } }, mailUrl), false);
    const mailArgs = codexIsolatedProfileArgs(`http://${[127, 0, 0, 1].join('.')}:32000/mcp/${'a'.repeat(64)}`);
    assert.ok(mailArgs.includes('mcp_servers.arco-cluster.default_tools_approval_mode=\"approve\"'));
    assert.throws(() => codexIsolatedProfileArgs('https://example.com/other'), /Invalid isolated worker mail endpoint/);

  } finally { await rm(root, { recursive: true, force: true }); }
});

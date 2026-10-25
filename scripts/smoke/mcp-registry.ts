// ARCO_OPS_PLAN.md §E1 — MCP registry smoke (no live server, no real ~/.arco).
//
// Drives the §E1 modules directly against a temp $ARCO_HOME:
//   • registry CRUD round-trip + persistence (create / list / upsert / remove);
//   • classifyDangerous flags write/delete/exec/etc. and passes read/list/get;
//   • per-workflow allowlist enable/disable changes the servers merged into the
//     mcpConfigWriter output (asserts the written `mcpServers` object), and a
//     disabled server is absent;
//   • dangerous-and-UNticked tools land in the CLI --disallowedTools set while
//     ticked ones don't (asserts computeRegistryWiring's disallowedTools);
//   • the Codex `-c` override form carries enabled servers;
//   • probeServer end-to-end against a tiny fake MCP stdio child (initialize +
//     tools/list) — connects, lists, classifies, tears down.
//
// Run: npm run smoke:mcp-registry   (no :3001 needed)

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  // Point both ARCO_HOME (registry) and the smoke's fake cwd at temp dirs.
  const root = await mkdtemp(join(tmpdir(), 'arco-mcp-smoke-'));
  const arcoHome = join(root, 'arco-home');
  const cwd = join(root, 'project');
  await mkdir(arcoHome, { recursive: true });
  await mkdir(cwd, { recursive: true });
  process.env.ARCO_HOME = arcoHome;

  // Import AFTER setting ARCO_HOME so the registry resolves the temp path.
  const registry = await import('../../server/src/mcp/registry.js');
  const { classifyDangerous, probeServer } = await import('../../server/src/mcp/client.js');
  const { computeRegistryWiring, registryKey } = await import('../../server/src/mcp/registryWiring.js');
  const mcpConfigWriter = await import('../../server/src/mcp/mcpConfigWriter.js');

  let serverId = '';

  await step('classifyDangerous: dangerous verbs flagged', () => {
    for (const n of ['write_file', 'delete_thing', 'remove_item', 'exec_cmd', 'run_shell', 'kill_proc', 'http_post', 'patch_record', 'create_repo', 'spawn_worker']) {
      assert(classifyDangerous(n) === true, `expected ${n} dangerous`);
    }
  });

  await step('classifyDangerous: read verbs safe', () => {
    for (const n of ['read_file', 'list_dir', 'get_user', 'search_code', 'query_db', 'describe_table', 'readme_lookup']) {
      assert(classifyDangerous(n) === false, `expected ${n} safe`);
    }
  });

  await step('registry: create + list persists', async () => {
    const def = await registry.create({ name: 'demo', command: 'node', args: ['/tmp/x.mjs'], env: { TOKEN: 's3cr3t' }, enabled: true });
    serverId = def.id;
    const all = await registry.list();
    assertEq(all.length, 1, 'one server registered');
    assertEq(all[0].command, 'node', 'command persisted');
    assertEq(all[0].enabled, true, 'enabled persisted');
    // Persistence: the file exists and round-trips the secret env (env is
    // persisted but never logged — registry layer logs ids/names only).
    const raw = JSON.parse(await readFile(join(arcoHome, 'mcp', 'registry.json'), 'utf8'));
    assertEq(raw.servers[0].env.TOKEN, 's3cr3t', 'env persisted to disk');
  });

  await step('registry: upsert patches in place', async () => {
    const updated = await registry.upsert(serverId, { name: 'demo2', enabled: false });
    assert(updated, 'upsert returned def');
    assertEq(updated!.name, 'demo2', 'name patched');
    assertEq(updated!.enabled, false, 'enabled patched');
    assertEq(updated!.command, 'node', 'command preserved');
    const reloaded = await registry.get(serverId);
    assertEq(reloaded!.name, 'demo2', 'patch persisted');
  });

  await step('wiring: disabled-global server is never wired', async () => {
    // Server is currently enabled:false globally. Even with a per-tab enable,
    // computeRegistryWiring must NOT wire it (master switch off).
    const defs = await registry.list();
    const wiring = computeRegistryWiring(defs, [
      { serverId, enabled: true, allowedDangerousTools: [], tools: [] },
    ]);
    assertEq(wiring.registryServers.length, 0, 'global-disabled server absent');
  });

  await step('wiring: enabled + allowed merges server; denylist computes disallowedTools', async () => {
    await registry.upsert(serverId, { enabled: true });
    const defs = await registry.list();
    const tools = [
      { name: 'read_thing', dangerous: false },
      { name: 'delete_thing', dangerous: true },
      { name: 'write_thing', dangerous: true },
    ];
    // delete ticked (allowed back), write NOT ticked (stays denied).
    const wiring = computeRegistryWiring(defs, [
      { serverId, enabled: true, allowedDangerousTools: ['delete_thing'], tools },
    ]);
    assertEq(wiring.registryServers.length, 1, 'server wired');
    const key = registryKey(serverId);
    assertEq(wiring.registryServers[0].key, key, 'namespace key matches');
    assertEq(wiring.registryServers[0].env!.TOKEN, 's3cr3t', 'env carried into wiring');
    // write_thing is dangerous-and-unticked → disallowed; delete_thing ticked → not.
    assert(wiring.disallowedTools.includes(`mcp__${key}__write_thing`), 'unticked dangerous denied');
    assert(!wiring.disallowedTools.includes(`mcp__${key}__delete_thing`), 'ticked dangerous allowed');
    // read_thing is safe → never in the disallowed set.
    assert(!wiring.disallowedTools.some((t) => t.endsWith('read_thing')), 'safe tool never denied');
  });

  await step('wiring: per-tab disable hides the server', async () => {
    const defs = await registry.list();
    const wiring = computeRegistryWiring(defs, [
      { serverId, enabled: false, allowedDangerousTools: [], tools: [] },
    ]);
    assertEq(wiring.registryServers.length, 0, 'per-tab-disabled server absent');
    assertEq(wiring.disallowedTools.length, 0, 'no disallowed entries for disabled server');
  });

  await step('DD11b wiring: disabled-list denies safe + overrides a dangerous tick', async () => {
    const defs = await registry.list();
    const key = registryKey(serverId);
    const tools = [
      { name: 'read_thing', dangerous: false },
      { name: 'delete_thing', dangerous: true },
      { name: 'noisy_get', dangerous: false },
    ];
    const wiring = computeRegistryWiring(defs, [
      // delete_thing ticked-on (normally allowed) but ALSO disabled ⇒ disable
      // wins. noisy_get is safe but disabled. read_thing untouched. A never-
      // probed disabled tool (`phantom`) must still be denied on CLI.
      { serverId, enabled: true, allowedDangerousTools: ['delete_thing'], disabledTools: ['delete_thing', 'noisy_get', 'phantom'], tools },
    ]);
    assertEq(wiring.registryServers.length, 1, 'server wired');
    assert(wiring.registryServers[0].disabledTools?.includes('noisy_get'), 'disable-list carried to Native entry');
    assert(wiring.disallowedTools.includes(`mcp__${key}__noisy_get`), 'safe-but-disabled denied (CLI)');
    assert(wiring.disallowedTools.includes(`mcp__${key}__delete_thing`), 'ticked-but-disabled denied (CLI)');
    assert(wiring.disallowedTools.includes(`mcp__${key}__phantom`), 'never-probed disabled tool denied (CLI)');
    assert(!wiring.disallowedTools.includes(`mcp__${key}__read_thing`), 'untouched safe tool still allowed');
  });

  await step('DD11b persists: setMcpAllow round-trips disabledTools + preserves on omit', async () => {
    const { ensureMeta, setMcpAllow, readMeta } = await import('../../server/src/workflowMeta.js');
    const wfid = 'wf-dd11b-0000';
    await ensureMeta(cwd, {
      workflowId: wfid, name: 'dd11b', cwd, createdAt: 0, lastActiveAt: 0,
      primaryProvider: 'claude', primaryModel: 'claude-opus-4-8', primaryEffort: 'high',
      cliSessions: [], operator: 'test', lastEventSeq: null, lastTranscriptSeq: null, compactedAt: null,
    } as Parameters<typeof ensureMeta>[1]);
    // Set a disable-list.
    await setMcpAllow(cwd, wfid, { serverId, enabled: true, allowedDangerousTools: [], disabledTools: ['noisy_get'] });
    let meta = await readMeta(cwd, wfid);
    assert(meta?.mcpAllow?.[0].disabledTools?.includes('noisy_get'), 'disable-list persisted to meta.json');
    // A later tick edit that OMITS disabledTools must preserve the existing list.
    await setMcpAllow(cwd, wfid, { serverId, enabled: true, allowedDangerousTools: ['delete_thing'] });
    meta = await readMeta(cwd, wfid);
    assert(meta?.mcpAllow?.[0].disabledTools?.includes('noisy_get'), 'disable-list preserved when omitted');
    assert(meta?.mcpAllow?.[0].allowedDangerousTools.includes('delete_thing'), 'tick edit applied');
  });

  await step('writeFor: registry servers land in mcp-config.json mcpServers', async () => {
    const defs = await registry.list();
    const { registryServers } = computeRegistryWiring(defs, [
      { serverId, enabled: true, allowedDangerousTools: [], tools: [{ name: 'read_thing', dangerous: false }] },
    ]);
    const path = await mcpConfigWriter.writeFor(cwd, 'wf-smoke-1', { port: 3001, registryServers });
    assert(path, 'writeFor returned a path');
    const cfg = JSON.parse(await readFile(path!, 'utf8'));
    const key = registryKey(serverId);
    assert(cfg.mcpServers[key], 'registry server present under its key');
    assertEq(cfg.mcpServers[key].command, 'node', 'command written');
    assertEq(cfg.mcpServers[key].env.TOKEN, 's3cr3t', 'env written into mcp-config');
  });

  await step('writeFor: no registry servers + nothing else ⇒ file unlinked', async () => {
    const path = await mcpConfigWriter.writeFor(cwd, 'wf-smoke-1', { port: 3001, registryServers: [] });
    assertEq(path, undefined, 'writeFor returns undefined when nothing applies');
  });

  await step('buildCodexMcpOverrides: registry server emits -c mcp_servers overrides', async () => {
    const defs = await registry.list();
    const { registryServers } = computeRegistryWiring(defs, [
      { serverId, enabled: true, allowedDangerousTools: [], tools: [] },
    ]);
    const overrides = mcpConfigWriter.buildCodexMcpOverrides('wf-smoke-1', { port: 3001, registryServers });
    const key = registryKey(serverId);
    assert(overrides.includes(`mcp_servers.${key}.command="node"`), 'codex command override present');
    assert(overrides.some((o) => o.startsWith(`mcp_servers.${key}.env=`)), 'codex env override present');
  });

  await step('probeServer: end-to-end against a fake MCP stdio child', async () => {
    // Tiny newline-delimited JSON-RPC MCP child: initialize + tools/list.
    const childPath = join(root, 'fake-mcp.mjs');
    await writeFile(childPath, FAKE_MCP_CHILD, 'utf8');
    const result = await probeServer(
      { id: 'probe', name: 'probe', command: process.execPath, args: [childPath], env: {}, enabled: true, createdAt: 0 },
      { timeoutMs: 8000 },
    );
    assert(result.ok, `probe ok (error: ${result.error ?? 'none'})`);
    assertEq(result.tools.length, 2, 'two tools listed');
    const del = result.tools.find((t) => t.name === 'delete_thing');
    const read = result.tools.find((t) => t.name === 'read_thing');
    assert(del?.dangerous === true, 'delete_thing classified dangerous');
    assert(read?.dangerous === false, 'read_thing classified safe');
  });

  await step('probeServer: bounded failure on a non-MCP child', async () => {
    // A child that never speaks JSON-RPC must time out, not hang the smoke.
    const result = await probeServer(
      { id: 'bad', name: 'bad', command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'], env: {}, enabled: true, createdAt: 0 },
      { timeoutMs: 1200 },
    );
    assertEq(result.ok, false, 'probe failed (no handshake)');
    assert(typeof result.error === 'string' && result.error.length > 0, 'error reported');
  });

  await step('registry: remove clears the entry', async () => {
    const ok = await registry.remove(serverId);
    assertEq(ok, true, 'remove returned true');
    assertEq((await registry.list()).length, 0, 'registry empty after remove');
  });

  await rm(root, { recursive: true, force: true });
  summary('mcp-registry');
}

// Fake MCP stdio server — newline-delimited JSON-RPC 2.0 (the framing the
// dependency-free client speaks). initialize → notifications/initialized →
// tools/list. Logs only to stderr (stdout is the MCP wire).
const FAKE_MCP_CHILD = `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } });
    } else if (m.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [
        { name: 'read_thing', description: 'reads', inputSchema: { type: 'object', properties: {} } },
        { name: 'delete_thing', description: 'deletes', inputSchema: { type: 'object', properties: {} } },
      ] } });
    } else if (m.id !== undefined && m.id !== null) {
      send({ jsonrpc: '2.0', id: m.id, result: {} });
    }
  }
});
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
process.stderr.write('[fake-mcp] up\\n');
`;

main().catch((err) => {
  console.error('mcp-registry smoke crashed:', err);
  process.exit(1);
});

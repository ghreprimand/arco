// ARCHON_OPS_PLAN.md §E1 (E1-Native) — Claude Native MCP host smoke.
//
// Covers the two surfaces E1-Native added WITHOUT booting a real Native turn
// (that needs the Anthropic API — the full turn path is the UI recipe):
//
//   • connectServer → listTools → callTool (success + an isError result) →
//     close against a fake MCP stdio child (reuses mcp-registry.ts's child
//     pattern, extended with a tools/call handler);
//   • idempotent double-close (no throw, child already dead);
//   • spawn-failure yields an ERROR-REPORTING closed session (no throw): every
//     callTool resolves to `{isError:true}`, listTools is empty;
//   • the pure registryToolDefs filter: dangerous-unticked EXCLUDED,
//     dangerous-ticked INCLUDED, safe ALWAYS included, names namespaced
//     `mcp__<key>__<tool>`, and a top-level oneOf/allOf/anyOf is dropped.
//
// Run: npm run smoke:mcp-native   (no :3001 needed)

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'archon-mcp-native-smoke-'));

  const { connectServer } = await import('../../server/src/mcp/client.js');
  const { registryToolDefs, parseRegistryToolName, registryNamespace, isRegistryToolAllowed } =
    await import('../../server/src/providers/claude-native/registryTools.js');

  // Write the fake MCP child once; reused across the session steps.
  const childPath = join(root, 'fake-mcp.mjs');
  await writeFile(childPath, FAKE_MCP_CHILD, 'utf8');

  await step('connectServer: handshake + listTools caches tools w/ schema', async () => {
    const session = await connectServer(
      { id: 'reg-aaaa1111', name: 's', command: process.execPath, args: [childPath], env: {}, enabled: true, createdAt: 0 },
      { initTimeoutMs: 8000 },
    );
    const tools = session.listTools();
    assertEq(tools.length, 3, 'three tools listed');
    const read = tools.find((t) => t.name === 'read_thing');
    const del = tools.find((t) => t.name === 'delete_thing');
    assert(read?.dangerous === false, 'read_thing safe');
    assert(del?.dangerous === true, 'delete_thing dangerous');
    assert(read?.inputSchema !== undefined, 'inputSchema passed through');
    session.close();
  });

  await step('callTool: success returns text, isError false', async () => {
    const session = await connectServer(
      { id: 'reg-aaaa1111', name: 's', command: process.execPath, args: [childPath], env: {}, enabled: true, createdAt: 0 },
    );
    const r = await session.callTool('read_thing', { path: '/x' });
    assertEq(r.isError, false, 'success not flagged error');
    assert(r.text.includes('ok:/x'), `text carries result (got ${r.text})`);
    session.close();
  });

  await step('callTool: isError tool result is surfaced as isError true', async () => {
    const session = await connectServer(
      { id: 'reg-aaaa1111', name: 's', command: process.execPath, args: [childPath], env: {}, enabled: true, createdAt: 0 },
    );
    const r = await session.callTool('boom', {});
    assertEq(r.isError, true, 'isError result flagged');
    assert(r.text.includes('kaboom'), `error text surfaced (got ${r.text})`);
    session.close();
  });

  await step('close: idempotent double-close does not throw', async () => {
    const session = await connectServer(
      { id: 'reg-aaaa1111', name: 's', command: process.execPath, args: [childPath], env: {}, enabled: true, createdAt: 0 },
    );
    session.close();
    session.close(); // must be a no-op, not a throw
    // A call after close resolves to a clean error, never hangs.
    const r = await session.callTool('read_thing', {});
    assertEq(r.isError, true, 'call after close is an error result');
  });

  await step('connectServer: spawn failure → error-reporting closed session', async () => {
    const session = await connectServer(
      { id: 'reg-bad00000', name: 'bad', command: join(root, 'does-not-exist-binary'), args: [], env: {}, enabled: true, createdAt: 0 },
      { initTimeoutMs: 1500 },
    );
    assertEq(session.listTools().length, 0, 'no tools on a failed session');
    const r = await session.callTool('anything', {});
    assertEq(r.isError, true, 'failed session reports error on call');
    assert(r.text.startsWith('[error]'), 'error sentinel');
    session.close(); // must not throw
  });

  await step('registryToolDefs: denylist by omission + namespacing', async () => {
    // Build a fake sessions map directly — registryToolDefs is pure over the
    // session's listTools(), so no spawn needed here.
    const key = 'reg-cccc2222';
    const fakeSession = {
      listTools: () => [
        { name: 'read_thing', description: 'reads', dangerous: false, inputSchema: { type: 'object' as const, properties: { p: { type: 'string' } } } },
        { name: 'delete_thing', description: 'deletes', dangerous: true, inputSchema: { type: 'object' as const, properties: {} } },
        { name: 'write_thing', description: 'writes', dangerous: true, inputSchema: { type: 'object' as const, properties: {} } },
        // Top-level oneOf must be dropped (Anthropic 400s on it).
        { name: 'list_thing', description: 'lists', dangerous: false, inputSchema: { type: 'object' as const, properties: { a: {} }, oneOf: [{ required: ['a'] }] } },
      ],
      callTool: async () => ({ text: '', isError: false }),
      close: () => { /* noop */ },
    };
    const sessions = new Map([[key, fakeSession]]);
    // delete ticked (allowed back), write NOT ticked (stays omitted).
    const defs = registryToolDefs(
      [{ key, command: 'node', args: [], allowedDangerousTools: ['delete_thing'] }],
      sessions,
    );
    const names = defs.map((d) => d.name);
    assert(names.includes(`mcp__${key}__read_thing`), 'safe tool included + namespaced');
    assert(names.includes(`mcp__${key}__list_thing`), 'safe tool w/ oneOf still included');
    assert(names.includes(`mcp__${key}__delete_thing`), 'ticked dangerous included');
    assert(!names.includes(`mcp__${key}__write_thing`), 'unticked dangerous OMITTED');
    assertEq(defs.length, 3, 'exactly safe+safe+ticked');
    // oneOf dropped from the emitted schema.
    const listDef = defs.find((d) => d.name === `mcp__${key}__list_thing`)!;
    assert(!('oneOf' in listDef.input_schema), 'top-level oneOf dropped');
    assertEq((listDef.input_schema as { type: string }).type, 'object', 'schema type object');
    // namespace + parse round-trip.
    assertEq(registryNamespace(key), `mcp__${key}__`, 'namespace prefix');
    const parsed = parseRegistryToolName(`mcp__${key}__read_thing`);
    assert(parsed?.key === key && parsed?.tool === 'read_thing', 'parse round-trips');
    assertEq(parseRegistryToolName('Bash'), null, 'non-registry name parses null');
  });

  await step('DD11b registryToolDefs: disabled tools OMITTED (safe + ticked-dangerous)', async () => {
    const key = 'reg-disable00';
    const fakeSession = {
      listTools: () => [
        { name: 'read_thing', description: 'reads', dangerous: false, inputSchema: { type: 'object' as const, properties: {} } },
        { name: 'noisy_get', description: 'noisy', dangerous: false, inputSchema: { type: 'object' as const, properties: {} } },
        { name: 'delete_thing', description: 'deletes', dangerous: true, inputSchema: { type: 'object' as const, properties: {} } },
      ],
      callTool: async () => ({ text: '', isError: false }),
      close: () => { /* noop */ },
    };
    const sessions = new Map([[key, fakeSession]]);
    // delete_thing ticked-on but ALSO disabled (disable wins); noisy_get safe-but-disabled.
    const defs = registryToolDefs(
      [{ key, command: 'node', args: [], allowedDangerousTools: ['delete_thing'], disabledTools: ['noisy_get', 'delete_thing'] }],
      sessions,
    );
    const names = defs.map((d) => d.name);
    assert(names.includes(`mcp__${key}__read_thing`), 'untouched safe tool still emitted');
    assert(!names.includes(`mcp__${key}__noisy_get`), 'safe-but-disabled OMITTED');
    assert(!names.includes(`mcp__${key}__delete_thing`), 'ticked-but-disabled OMITTED (disable wins)');
    assertEq(defs.length, 1, 'only the untouched safe tool survives');
    // Dispatch guard rejects a disabled tool even though the session is open.
    const servers = [{ key, command: 'node', args: [], allowedDangerousTools: ['delete_thing'], disabledTools: ['noisy_get', 'delete_thing'] }];
    assert(!isRegistryToolAllowed(servers, key, 'noisy_get'), 'disabled safe tool rejected at dispatch');
    assert(!isRegistryToolAllowed(servers, key, 'delete_thing'), 'disabled+ticked tool rejected at dispatch');
    assert(isRegistryToolAllowed(servers, key, 'read_thing'), 'untouched safe tool still allowed');
  });

  await step('registryToolDefs: server with no open session contributes nothing', async () => {
    const defs = registryToolDefs(
      [{ key: 'reg-dddd3333', command: 'node', args: [] }],
      new Map(), // no session opened
    );
    assertEq(defs.length, 0, 'no session ⇒ no tools');
  });

  await step('isRegistryToolAllowed: dispatch-time guard rejects hallucinated dangerous calls', async () => {
    // The model can emit a tool_use for a name buildToolDefs() never advertised
    // (guessed off a safe sibling's namespace). The dispatch guard must reject
    // it even though the server session is open — matching the CLI guarantee.
    const key = 'reg-eeee4444';
    const servers = [{ key, command: 'node', args: [], allowedDangerousTools: ['delete_thing'] }];
    assert(isRegistryToolAllowed(servers, key, 'read_thing'), 'safe tool allowed');
    assert(isRegistryToolAllowed(servers, key, 'delete_thing'), 'ticked dangerous allowed');
    assert(!isRegistryToolAllowed(servers, key, 'write_thing'), 'unticked dangerous REJECTED at dispatch');
    assert(!isRegistryToolAllowed(servers, 'reg-unknown', 'read_thing'), 'unknown server rejected');
  });

  await rm(root, { recursive: true, force: true });
  summary('mcp-native');
}

// Fake MCP stdio server — initialize → notifications/initialized → tools/list →
// tools/call. read_thing echoes its `path`; boom returns an isError result.
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
        { name: 'read_thing', description: 'reads', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
        { name: 'delete_thing', description: 'deletes', inputSchema: { type: 'object', properties: {} } },
        { name: 'boom', description: 'always errors', inputSchema: { type: 'object', properties: {} } },
      ] } });
    } else if (m.method === 'tools/call') {
      const name = m.params && m.params.name;
      if (name === 'boom') {
        send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'kaboom' }], isError: true } });
      } else {
        const p = (m.params && m.params.arguments && m.params.arguments.path) || '';
        send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok:' + p }] } });
      }
    } else if (m.id !== undefined && m.id !== null) {
      send({ jsonrpc: '2.0', id: m.id, result: {} });
    }
  }
});
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
process.stderr.write('[fake-mcp] up\\n');
`;

main().catch((err) => {
  console.error('mcp-native smoke crashed:', err);
  process.exit(1);
});

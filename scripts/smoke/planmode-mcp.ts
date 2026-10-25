// DD11a — plan-mode MCP-write leak fix smoke.
//
// Before DD11a, the Native registry-MCP dispatch checked the per-tab denylist
// (isRegistryToolAllowed) but NOT plan mode: a write MCP tool the operator had
// ticked on for normal use would still execute while the worker was planning,
// even though native Write/Edit short-circuit. This covers the three pure
// surfaces the fix adds, without booting a Native turn (that needs the API):
//
//   • isMcpToolReadOnly — annotation-first (readOnlyHint/destructiveHint),
//     verb fallback, fail-closed on the ambiguous case;
//   • registryToolDefs(planMode=true) — non-readonly tools OMITTED from the
//     schema (model never sees them) while readonly tools still emit;
//   • isRegistryToolReadOnly — the dispatch-time guard against a hallucinated
//     write tool_use, including annotation-overrides and unknown-tool fail-closed;
//   • connectServer captures the server's `annotations` onto the session tool.
//
// Run: npm run smoke:planmode-mcp   (no :3001 needed)

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'arco-planmode-mcp-smoke-'));

  const { connectServer, isMcpToolReadOnly } = await import('../../server/src/mcp/client.js');
  const { registryToolDefs, isRegistryToolReadOnly } =
    await import('../../server/src/providers/claude-native/registryTools.js');

  await step('isMcpToolReadOnly: annotation-first wins over the name', () => {
    // readOnlyHint:true on a scary name ⇒ read-only (server's explicit say-so).
    assert(isMcpToolReadOnly({ name: 'delete_everything', annotations: { readOnlyHint: true } }), 'readOnlyHint:true ⇒ readonly');
    // readOnlyHint:false on a read-ish name ⇒ NOT read-only.
    assert(!isMcpToolReadOnly({ name: 'get_thing', annotations: { readOnlyHint: false } }), 'readOnlyHint:false ⇒ not readonly');
    // destructiveHint:true ⇒ NOT read-only.
    assert(!isMcpToolReadOnly({ name: 'list_thing', annotations: { destructiveHint: true } }), 'destructiveHint:true ⇒ not readonly');
  });

  await step('isMcpToolReadOnly: verb fallback + fail-closed', () => {
    assert(isMcpToolReadOnly({ name: 'read_file' }), 'read verb ⇒ readonly');
    assert(isMcpToolReadOnly({ name: 'searchDocs' }), 'search verb (camelCase) ⇒ readonly');
    assert(!isMcpToolReadOnly({ name: 'write_file' }), 'write verb ⇒ not readonly');
    // No dangerous AND no read verb ⇒ fail-closed (ambiguous ⇒ not readonly).
    assert(!isMcpToolReadOnly({ name: 'frobnicate' }), 'ambiguous name fails closed');
    // destructiveHint:false alone is NOT a readonly assertion ⇒ verb decides.
    assert(isMcpToolReadOnly({ name: 'get_x', annotations: { destructiveHint: false } }), 'destructiveHint:false + read verb ⇒ readonly');
    assert(!isMcpToolReadOnly({ name: 'frob', annotations: { destructiveHint: false } }), 'destructiveHint:false + ambiguous ⇒ fail-closed');
  });

  await step('registryToolDefs(planMode): non-readonly OMITTED, readonly emitted', () => {
    const key = 'reg-plan0000';
    const fakeSession = {
      listTools: () => [
        { name: 'read_thing', description: 'reads', dangerous: false },
        { name: 'list_thing', description: 'lists', dangerous: false },
        // safe-by-denylist (no dangerous verb) but also no read verb ⇒
        // fail-closed under plan mode despite being shown normally.
        { name: 'frobnicate', description: 'does a thing', dangerous: false },
        // dangerous + operator-ticked ⇒ visible normally, but a WRITE ⇒
        // hidden under plan mode.
        { name: 'delete_thing', description: 'deletes', dangerous: true },
        // annotation override: a scary name the server marks read-only.
        { name: 'purge_cache_stats', description: 'reports', dangerous: true, annotations: { readOnlyHint: true } },
      ],
      callTool: async () => ({ text: '', isError: false }),
      close: () => { /* noop */ },
    };
    const sessions = new Map([[key, fakeSession]]);
    const servers = [{ key, command: 'node', args: [], allowedDangerousTools: ['delete_thing', 'purge_cache_stats'] }];

    // Normal mode: denylist applies (delete + purge ticked-in), frob shown.
    const normal = registryToolDefs(servers, sessions).map((d) => d.name);
    assert(normal.includes(`mcp__${key}__read_thing`), 'normal: read shown');
    assert(normal.includes(`mcp__${key}__frobnicate`), 'normal: frob shown');
    assert(normal.includes(`mcp__${key}__delete_thing`), 'normal: ticked delete shown');

    // Plan mode: only provably-readonly tools survive.
    const planned = registryToolDefs(servers, sessions, undefined, true).map((d) => d.name);
    assert(planned.includes(`mcp__${key}__read_thing`), 'plan: read survives');
    assert(planned.includes(`mcp__${key}__list_thing`), 'plan: list survives');
    assert(planned.includes(`mcp__${key}__purge_cache_stats`), 'plan: annotation-readonly survives');
    assert(!planned.includes(`mcp__${key}__frobnicate`), 'plan: ambiguous OMITTED (fail-closed)');
    assert(!planned.includes(`mcp__${key}__delete_thing`), 'plan: write OMITTED even if ticked');
    assertEq(planned.length, 3, 'plan: exactly the three readonly tools');
  });

  await step('isRegistryToolReadOnly: dispatch guard + unknown fail-closed', () => {
    const fakeSession = {
      listTools: () => [
        { name: 'read_thing', description: '', dangerous: false },
        { name: 'delete_thing', description: '', dangerous: true },
        { name: 'audit_log', description: '', dangerous: false, annotations: { readOnlyHint: true } },
      ],
      callTool: async () => ({ text: '', isError: false }),
      close: () => { /* noop */ },
    };
    assert(isRegistryToolReadOnly(fakeSession, 'read_thing'), 'read allowed in plan mode');
    assert(isRegistryToolReadOnly(fakeSession, 'audit_log'), 'annotation-readonly allowed');
    assert(!isRegistryToolReadOnly(fakeSession, 'delete_thing'), 'write rejected in plan mode');
    assert(!isRegistryToolReadOnly(fakeSession, 'never_advertised'), 'unknown tool fails closed');
  });

  await step('connectServer captures server-declared annotations', async () => {
    const childPath = join(root, 'fake-annotated-mcp.mjs');
    await writeFile(childPath, FAKE_ANNOTATED_CHILD, 'utf8');
    const session = await connectServer(
      { id: 'reg-anno0000', name: 's', command: process.execPath, args: [childPath], env: {}, enabled: true, createdAt: 0 },
      { initTimeoutMs: 8000 },
    );
    const tools = session.listTools();
    const ro = tools.find((t) => t.name === 'do_thing');
    assert(ro?.annotations?.readOnlyHint === true, 'readOnlyHint captured onto session tool');
    assert(isMcpToolReadOnly(ro!), 'captured annotation drives the classifier');
    const plain = tools.find((t) => t.name === 'plain_thing');
    assert(plain?.annotations === undefined, 'tool without annotations has none');
    session.close();
  });

  await rm(root, { recursive: true, force: true });
  summary('planmode-mcp');
}

// Fake MCP stdio server emitting an annotated tool + a plain one.
const FAKE_ANNOTATED_CHILD = `
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
        { name: 'do_thing', description: 'a read-only thing', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
        { name: 'plain_thing', description: 'no annotations', inputSchema: { type: 'object', properties: {} } },
      ] } });
    } else if (m.id !== undefined && m.id !== null) {
      send({ jsonrpc: '2.0', id: m.id, result: {} });
    }
  }
});
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
process.stderr.write('[fake-annotated-mcp] up\\n');
`;

main().catch((err) => {
  console.error('planmode-mcp smoke crashed:', err);
  process.exit(1);
});

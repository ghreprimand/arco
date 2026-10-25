// `archon` MCP plan tools — end-to-end over real stdio MCP.
//
// Spawns the same `archonMcpServer` child that Claude CLI and both Codex
// transports spawn, speaks MCP to it over stdin/stdout, and drives the tools
// exactly as a model would. That's the point: the previous smoke
// (`plan-attach`) proves the REST recipe works, this one proves the tool
// wrapper a model actually calls does.
//
// Covers: tools/list advertises all three; plan_create rejects an unstructured
// body with an actionable error; a structured body creates AND attaches (the
// workflow gets a real plan_attached event); plan_list sees it; plan_attach
// re-attaches after a detach; allowUnstructured is a genuine escape hatch.
//
// Run with a server up (dev or prod, port 3001):
//   npm run smoke:plan-mcp
//
// Exits 0 on all-pass, 1 on any failure. No model spend.

import { connect, step, assert, assertEq, summary } from './lib.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

// Minimal MCP stdio client — one pending request at a time is plenty here.
class McpStdio {
  private child: ChildProcess;
  private rl: Interface;
  private nextId = 1;
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();

  constructor(workflowId: string, cwd: string) {
    const entry = resolve('server/src/mcp/archonMcpServer.ts');
    this.child = spawn('npx', ['tsx', entry, workflowId, cwd, '3001'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr?.on('data', () => { /* the child logs to stderr by contract; ignore */ });
    this.rl = createInterface({ input: this.child.stdout! });
    this.rl.on('line', (line) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { return; }
      const id = msg.id as number | undefined;
      if (typeof id === 'number' && this.pending.has(id)) {
        this.pending.get(id)!(msg);
        this.pending.delete(id);
      }
    });
  }

  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`MCP ${method} timed out`)), 30000);
      this.pending.set(id, (msg) => { clearTimeout(timer); res(msg); });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async handshake(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'archon-smoke', version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
  }

  // Returns the tool's text payload, parsed as JSON when it is JSON, plus the
  // isError flag the model would see.
  async callTool(name: string, args: unknown): Promise<{ isError: boolean; payload: any }> {
    const msg = await this.request('tools/call', { name, arguments: args });
    const result = msg.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    const text = result?.content?.[0]?.text ?? '';
    let payload: unknown = text;
    try { payload = JSON.parse(text); } catch { /* plain text */ }
    return { isError: result?.isError === true, payload };
  }

  close(): void { this.rl.close(); this.child.kill(); }
}

const GOOD_BODY = `# Release plan

### Phase 1 — Setup

- [ ] first task
  - [ ] indented subtask
- [x] already done

### Phase 2 — Ship

- [ ] release it
`;

const BAD_BODY = `# Release plan

We will do the setup, then ship it. First we handle the config, then the
release. Everything should be tested along the way.
`;

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-smoke-planmcp-'));
  console.log(`Plan-MCP smoke — cwd ${cwd}`);
  console.log('');

  const c = await connect();
  let wfid = '';
  let planId = '';
  let mcp: McpStdio | null = null;

  await step('create workflow + MCP handshake', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke Plan MCP', primaryProvider: 'claude', primaryModel: 'claude-sonnet-5',
        primaryEffort: 'low', skipPermissions: true, workingDirectory: cwd, claudeTransport: 'native',
      },
    });
    wfid = (await c.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created')).workflowId as string;
    mcp = new McpStdio(wfid, cwd);
    await mcp.handshake();
  });

  await step('tools/list advertises plan_create, plan_attach, plan_list', async () => {
    const msg = await mcp!.request('tools/list', {});
    const tools = ((msg.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name).sort();
    assertEq(tools.join(','), 'plan_attach,plan_create,plan_list', `three plan tools exposed (got: ${tools.join(',')})`);
  });

  await step('plan_create REJECTS an unstructured body with an actionable error', async () => {
    const { isError, payload } = await mcp!.callTool('plan_create', { title: 'Prose Plan', body: BAD_BODY });
    assert(isError, 'flagged as a tool error so the model retries');
    assertEq(payload.error, 'plan_body_unstructured', 'names the problem');
    assert(Array.isArray(payload.problems) && payload.problems.length === 2, 'reports both missing headings and missing checkboxes');
    assert(String(payload.fix).includes('allowUnstructured'), 'points at the escape hatch');
    // And nothing was created.
    const list = await mcp!.callTool('plan_list', {});
    assertEq(list.payload.plans.length, 0, 'no plan created by the rejected call');
  });

  await step('plan_create with a structured body creates AND attaches', async () => {
    const { isError, payload } = await mcp!.callTool('plan_create', { title: 'MCP Release Plan', body: GOOD_BODY });
    assert(!isError, `call succeeded (got: ${JSON.stringify(payload).slice(0, 200)})`);
    assert(payload.ok === true && payload.planId, 'returns ok + the new plan id');
    assertEq(payload.attached, true, 'reports attached');
    planId = payload.planId;
    const att = await c.waitFor((x) => x.type === 'plan_attached', 8000, 'plan_attached');
    assertEq(att.planId as string, planId, 'the workflow really got plan_attached');
    assertEq(att.title as string, 'MCP Release Plan', 'title round-trips');
  });

  await step('plan_list sees it', async () => {
    const { payload } = await mcp!.callTool('plan_list', {});
    assertEq(payload.plans.length, 1, 'one plan listed');
    assertEq(payload.plans[0].id, planId, 'the one we created');
  });

  await step('plan_attach re-attaches after a detach', async () => {
    c.send({ type: 'plan_detach', workflowId: wfid });
    await c.waitFor((x) => x.type === 'plan_detached', 8000, 'plan_detached');
    const { isError, payload } = await mcp!.callTool('plan_attach', { planId });
    assert(!isError && payload.ok === true, `re-attach succeeded (got: ${JSON.stringify(payload).slice(0, 200)})`);
    const att = await c.waitFor((x) => x.type === 'plan_attached', 8000, 'plan_attached');
    assertEq(att.planId as string, planId, 'same plan back');
  });

  await step('allowUnstructured is a real escape hatch', async () => {
    const { isError, payload } = await mcp!.callTool('plan_create', {
      title: 'Prose Plan', body: BAD_BODY, allowUnstructured: true,
    });
    assert(!isError && payload.ok === true, 'operator-sanctioned prose plan is allowed through');
    await c.waitFor((x) => x.type === 'plan_attached', 8000, 'plan_attached');
  });

  await step('teardown', async () => {
    mcp!.close();
    c.send({ type: 'remove_workflow', workflowId: wfid });
    await new Promise((r) => setTimeout(r, 600));
    rmSync(cwd, { recursive: true, force: true });
  });

  c.close();
  summary('plan-mcp');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// EFFICIENCY_PLAN.md Phase D — headless WS smoke.
//
// Covers the protocol surfaces Phase D shipped:
//   1. workflow_created reply carries the new-tab `efficiencyFactForce='off'`
//      default when the client omits the field.
//   2. meta.json on disk persists the toggle.
//   3. update_primary_config flips the toggle to 'on' and re-flips to 'off';
//      both transitions persist to meta.json.
//   4. Creating a workflow with explicit `efficiencyFactForce='on'` is
//      respected (operator override beats the default).
//
// Does NOT cover (real Anthropic-API spend required):
//   - The fact-force gate actually firing inside a Native worker turn.
//   - The model emitting facts before re-issuing an edit.
//   - The `tool_gate_triggered` event lighting up in the chat.
// Those are in the manual recipe in the Phase D devlog entry.
//
// Run with the dev server up:
//   npm run dev:server  &
//   npm run smoke:phase-d
//
// Exits 0 on all-pass, 1 on any failure.

import { connect, step, assert, assertEq, summary, type AnyMessage } from './lib.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface MetaShape {
  efficiencyFactForce?: 'on' | 'off';
  workflowId: string;
  [k: string]: unknown;
}

function readMeta(cwd: string, workflowId: string): MetaShape {
  const path = join(cwd, '.archon', 'workflows', workflowId, 'meta.json');
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as MetaShape;
}

async function waitForMeta(cwd: string, workflowId: string, predicate: (m: MetaShape) => boolean, timeoutMs = 3000): Promise<MetaShape> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const meta = readMeta(cwd, workflowId);
      if (predicate(meta)) return meta;
    } catch { /* meta not yet written */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`meta.json predicate not satisfied within ${timeoutMs}ms`);
}

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-smoke-d-'));
  console.log(`Phase D smoke — cwd ${cwd}`);
  console.log('');

  const c = await connect();

  let defaultWfid = '';
  let explicitOnWfid = '';

  await step('create Native workflow (no efficiencyFactForce field) — server defaults to "off"', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke D Default',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const m = await c.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created') as AnyMessage & { config: { efficiencyFactForce?: string } };
    defaultWfid = m.workflowId as string;
    assert(typeof defaultWfid === 'string' && defaultWfid.length > 0, 'workflowId returned');
    assertEq(m.config.efficiencyFactForce, 'off', 'config.efficiencyFactForce defaulted to "off"');
  });

  await step('meta.json persists efficiencyFactForce="off"', async () => {
    const meta = await waitForMeta(cwd, defaultWfid, (m) => m.efficiencyFactForce === 'off');
    assertEq(meta.efficiencyFactForce, 'off', 'meta.json efficiencyFactForce="off"');
  });

  await step('update_primary_config flips toggle to "on"', async () => {
    c.send({
      type: 'update_primary_config',
      workflowId: defaultWfid,
      efficiencyFactForce: 'on',
    });
    const meta = await waitForMeta(cwd, defaultWfid, (m) => m.efficiencyFactForce === 'on');
    assertEq(meta.efficiencyFactForce, 'on', 'meta.json reflects flip to "on"');
  });

  await step('update_primary_config re-flips toggle to "off"', async () => {
    c.send({
      type: 'update_primary_config',
      workflowId: defaultWfid,
      efficiencyFactForce: 'off',
    });
    const meta = await waitForMeta(cwd, defaultWfid, (m) => m.efficiencyFactForce === 'off');
    assertEq(meta.efficiencyFactForce, 'off', 'meta.json reflects flip back to "off"');
  });

  await step('create Native workflow with explicit efficiencyFactForce="on" — operator override respected', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke D Explicit On',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
        efficiencyFactForce: 'on',
      },
    });
    const m = await c.waitFor(
      (x) => x.type === 'workflow_created' && (x as AnyMessage & { config: { name: string } }).config?.name === 'Smoke D Explicit On',
      8000,
      'workflow_created (explicit on)',
    ) as AnyMessage & { config: { efficiencyFactForce?: string } };
    explicitOnWfid = m.workflowId as string;
    assertEq(m.config.efficiencyFactForce, 'on', 'explicit "on" not overridden by new-tab default');
    const meta = await waitForMeta(cwd, explicitOnWfid, (mm) => mm.efficiencyFactForce === 'on');
    assertEq(meta.efficiencyFactForce, 'on', 'meta.json reflects explicit "on"');
  });

  await step('teardown: remove workflows + rm cwd', async () => {
    if (defaultWfid) c.send({ type: 'remove_workflow', workflowId: defaultWfid });
    if (explicitOnWfid) c.send({ type: 'remove_workflow', workflowId: explicitOnWfid });
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('Phase D smoke');
}

main().catch((err) => {
  console.error('Phase D smoke crashed:', err);
  process.exit(2);
});

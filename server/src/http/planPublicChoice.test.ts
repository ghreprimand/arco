import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpDeps } from './router.js';

const root = mkdtempSync(join(tmpdir(), 'arco-public-plan-'));
installIsolatedTestHome(root);
const { tryHandleWorkflowDataRoutes } = await import('./workflowDataRoutes.js');
const { setPublicProjectChoice } = await import('../publicProjectChoice.js');
const { workflows, workflowCwds } = await import('../server/state.js');
after(() => rmSync(root, { recursive: true, force: true }));

test('agent plan creation reports missing public guardrails without silently changing the plan', async () => {
  const cwd = join(root, 'project'); mkdirSync(cwd);
  await setPublicProjectChoice(cwd, true);
  const events: Array<{ type: string; body?: string }> = [];
  const workflowId = 'public-fixture';
  const observer = { readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) };
  workflows.set(workflowId, { config: { name: 'Fixture', incognito: true }, observers: new Set([observer]) } as never);
  workflowCwds.set(workflowId, cwd);
  async function create(body: string) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ title: 'Fixture', body, workflowId, attach: true }))]), { method: 'POST', url: `/api/plans?path=${encodeURIComponent(cwd)}`, headers: {} }) as IncomingMessage;
    let code = 0, text = '';
    const res = { writeHead: (status: number) => { code = status; }, end: (value: string) => { text = value; } } as unknown as ServerResponse;
    assert.equal(await tryHandleWorkflowDataRoutes(req, res, { handlePlanAttach: async () => {} } as unknown as HttpDeps), true);
    assert.equal(code, 200, text);
    return JSON.parse(text) as { publicProject: boolean; needsGuardrails: boolean; plan: { body: string } };
  }
  const plain = '# Fixture\n\n### Phase\n- [ ] Task\n';
  const missing = await create(plain);
  assert.equal(missing.publicProject, true);
  assert.equal(missing.needsGuardrails, true);
  assert.equal(missing.plan.body, plain);
  assert.equal(events.at(-1)?.type, 'plan_candidate_ready');
  assert.equal(events.at(-1)?.body, plain);
  const present = await create('# Fixture\n\n## Privacy and public safety\nProtect secrets.\n\n### Phase\n- [ ] Task\n');
  assert.equal(present.needsGuardrails, false);
  await setPublicProjectChoice(cwd, false);
  assert.equal((await create(plain)).needsGuardrails, false);
  workflows.delete(workflowId);
  workflowCwds.delete(workflowId);
});

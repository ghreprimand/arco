// Isolated server: no provider turns or credentials.
import { connect, assert, assertEq, summary, step } from './lib.js';

const wsUrl = process.env.ARCO_SMOKE_WS_URL!;
const base = wsUrl.replace(/^ws:/, 'http:').replace(/\/ws$/, '');
const cwd = process.env.ARCO_SMOKE_PROJECT!;
const projectRoot = process.env.ARCO_SMOKE_ROOT!;

async function main() {
  const choice = await fetch(`${base}/api/public-project/choice`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: cwd, value: true }),
  });
  assert(choice.ok, 'save public project choice');
  const c = await connect();
  await step('public native plan without rules goes to review', async () => {
    c.send({ type: 'create_workflow', config: { name: 'Fixture', primaryProvider: 'claude', primaryModel: 'fixture', skipPermissions: false, workingDirectory: cwd, claudeTransport: 'native' } });
    const created = await c.waitFor(m => m.type === 'workflow_created', 8000);
    const workflowId = created.workflowId as string;
    const body = '# Fixture plan\n\n### Phase\n- [ ] Task\n';
    c.send({ type: '__debug_native_plan_set', workflowId, plan: body });
    const candidate = await c.waitFor(m => m.type === 'plan_candidate_ready' && m.workflowId === workflowId, 8000);
    assertEq(candidate.body, body, 'review candidate carries the plan');
    await c.waitFor(m => m.type === 'plan_set' && m.workflowId === workflowId, 8000);
    assert(!c.peekMessages().some(m => m.type === 'plan_attached' && m.workflowId === workflowId), 'no plan is silently attached');
  });
  await step('public Genesis project seeds a plan with privacy rules', async () => {
    c.send({ type: 'create_workflow', config: { name: 'Genesis fixture', primaryProvider: 'claude', primaryModel: 'fixture', skipPermissions: false, workingDirectory: '', genesisSeed: { title: 'Public seed', spark: 'Fixture idea', concept: '', theCase: '', buildDirection: '' } } });
    const created = await c.waitFor(m => m.type === 'workflow_created', 8000);
    const workflowId = created.workflowId as string;
    c.send({ type: 'genesis_scaffold', workflowId, root: projectRoot, publicProject: true });
    const done = await c.waitFor(m => m.type === 'genesis_scaffolded' && m.workflowId === workflowId, 15000);
    assert(typeof done.cwd === 'string' && typeof done.planId === 'string', 'scaffold returns project and plan');
    const params = new URLSearchParams({ path: done.cwd as string, planId: done.planId as string });
    const response = await fetch(`${base}/api/plans/body?${params}`);
    const result = await response.json() as { plan: { body: string } };
    assert(result.plan.body.includes('## Privacy and public safety'), 'seed plan has guardrails');
    const saved = await fetch(`${base}/api/public-project/choice?path=${encodeURIComponent(done.cwd as string)}`);
    assertEq((await saved.json() as { choice: boolean }).choice, true, 'new project remembers choice');
  });
  await c.close();
  summary('Public-plan server');
}
void main().catch(err => { console.error(err); process.exitCode = 1; });

// Plan create+attach over the REST surface — the exact recipe `planAuthoringNote`
// (turnEngine.ts) hands to every worker on a plan-less turn.
//
// This exists because the note is a promise made to the model on every turn. If
// the endpoint, its payload shape, or the attach side-effect ever drifts, the
// note silently becomes instructions for something that doesn't work — and the
// symptom is the 2026-07-28 failure all over again: a worker burning turns on
// curl probes, or reporting "Plan attached" when nothing attached. Assert the
// recipe verbatim, including the jq --rawfile two-step.
//
// Run with a server up (dev or prod, port 3001):
//   npm run smoke:plan-attach
//
// Exits 0 on all-pass, 1 on any failure. No model spend.

import { connect, step, assert, assertEq, summary } from './lib.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const PLAN_BODY = `# Release plan

### Phase 1 — Setup

- [ ] first task
  - [ ] a subtask, indented
- [x] already done

### Phase 2 — Ship

- [ ] release it
`;

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-smoke-planattach-'));
  const bodyFile = join(cwd, 'draft-plan.md');
  console.log(`Plan-attach smoke — cwd ${cwd}`);
  console.log('');

  const c = await connect();
  let wfid = '';
  let planId = '';

  await step('create workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke Plan Attach', primaryProvider: 'claude', primaryModel: 'claude-sonnet-5',
        primaryEffort: 'low', skipPermissions: true, workingDirectory: cwd, claudeTransport: 'native',
      },
    });
    wfid = (await c.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created')).workflowId as string;
    assert(wfid.length > 0, 'workflowId returned');
  });

  await step('jq --rawfile | curl POST /api/plans creates AND attaches', async () => {
    writeFileSync(bodyFile, PLAN_BODY);
    const cmd =
      `jq -n --rawfile body ${JSON.stringify(bodyFile)} --arg t 'Smoke Release Plan' ` +
      `'{title:$t,body:$body,workflowId:"${wfid}",attach:true}' ` +
      `| curl -sS --fail-with-body -X POST 'http://127.0.0.1:3001/api/plans?path=${encodeURIComponent(cwd)}' ` +
      `-H 'Content-Type: application/json' -d @-`;
    const out = execFileSync('/usr/bin/bash', ['-lc', cmd], { encoding: 'utf8' });
    const parsed = JSON.parse(out) as { plan?: { id: string; title: string; body: string } };
    assert(parsed.plan?.id, `response echoes the created plan id (got: ${out.slice(0, 200)})`);
    planId = parsed.plan!.id;
    assertEq(parsed.plan!.title, 'Smoke Release Plan', 'title round-trips');
    assert(parsed.plan!.body.includes('- [ ] first task'), 'markdown body survives the jq round-trip verbatim');

    const att = await c.waitFor((x) => x.type === 'plan_attached', 8000, 'plan_attached');
    assertEq(att.planId as string, planId, 'plan_attached names the new plan');
  });

  await step('detach, then POST /api/plans/attach re-attaches the existing plan', async () => {
    c.send({ type: 'plan_detach', workflowId: wfid });
    await c.waitFor((x) => x.type === 'plan_detached', 8000, 'plan_detached');
    const cmd =
      `curl -sS --fail-with-body -X POST ` +
      `'http://127.0.0.1:3001/api/plans/attach?path=${encodeURIComponent(cwd)}&planId=${planId}&workflowId=${wfid}'`;
    const out = execFileSync('/usr/bin/bash', ['-lc', cmd], { encoding: 'utf8' });
    assert(JSON.parse(out).ok === true, `attach returns ok (got: ${out.slice(0, 200)})`);
    const att = await c.waitFor((x) => x.type === 'plan_attached', 8000, 'plan_attached');
    assertEq(att.planId as string, planId, 're-attached the same plan');
  });

  await step('a loose markdown file is NOT a plan', async () => {
    // The failure mode the note exists to prevent: writing a file into
    // .arco/plans/ does nothing, because index.json is the source of truth.
    writeFileSync(join(cwd, '.arco', 'plans', 'hand-written-plan.md'), PLAN_BODY);
    const out = execFileSync('/usr/bin/bash', ['-lc',
      `curl -sS 'http://127.0.0.1:3001/api/plans?path=${encodeURIComponent(cwd)}'`], { encoding: 'utf8' });
    const plans = (JSON.parse(out) as { plans: Array<{ id: string }> }).plans;
    assertEq(plans.length, 1, 'only the properly-created plan is listed');
    assertEq(plans[0].id, planId, 'the loose file is invisible to listPlans');
  });

  await step('teardown', async () => {
    c.send({ type: 'remove_workflow', workflowId: wfid });
    await new Promise((r) => setTimeout(r, 600));
    rmSync(cwd, { recursive: true, force: true });
  });

  c.close();
  summary('plan-attach');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

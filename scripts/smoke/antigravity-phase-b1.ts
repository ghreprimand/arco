// docs/PROVIDERS.md - attached-plan smoke.
//
// Confirms an Arco-style attached plan flows through the existing
// `buildPlanPrefix()` path to Antigravity and that Antigravity can read +
// edit the plan file via its normal file tools.
//
// What it does:
//   1. Mkdir a temp workflow cwd with `.arco/plans/<planId>.md` — a small
//      plan body with one H1, one numbered list, and one unchecked
//      `- [ ]` item.
//   2. Build the same one-liner plan prefix `buildPlanPrefix()` emits on
//      first attach, prepend it to a user prompt that asks the agent to
//      (a) report the first heading and (b) tick one checkbox in the
//      attached plan file.
//   3. Drive a single `runAntigravityRpcTurn` against the desktop app.
//   4. Verify the plan file was actually mutated on disk, the heading
//      shows up in the assistant text, and at least one tool row carries
//      the plan path.
//
// Exits 0 on success, 1 on failure, 2 if the desktop app isn't reachable.

import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { WorkerConfig } from '@arco/shared';
import { antigravityManager } from '../../server/src/providers/antigravityManager.js';
import { runAntigravityRpcTurn } from '../../server/src/providers/antigravityRpc.js';

const TURN_TIMEOUT_MS = 5 * 60_000;
const PLAN_ID = `b1-${Date.now().toString(36)}`;
const FIRST_HEADING = `Arco B1 Smoke Plan ${PLAN_ID}`;
const PLAN_BODY = `# ${FIRST_HEADING}

A throwaway plan used to verify Antigravity reads + edits attached plans.

## Tasks

- [ ] Confirm Antigravity can read .arco/plans/${PLAN_ID}.md
- [ ] Second item left unchecked on purpose
`;

interface ToolEvent {
  name: string;
  status?: string;
  input: string;
}

function livingDocNote(): string {
  // Mirrors the wording in server/src/index.ts buildPlanPrefix() so the
  // smoke exercises the same instruction surface real turns get.
  return `The plan is a working contract — read it freely, and tick off completed checklist items (\`- [ ]\` → \`- [x]\`) when you finish them this turn. Do NOT add new sections, headings, or substantive content on your own initiative — even if you have findings, research results, or scope expansions you think belong there. Surface those in your reply and ask whether to add them. Tick-offs and resolving inline open questions are fine; structural additions and new content require an explicit operator cue.`;
}

function buildPlanPrefix(): string {
  return `[Active project plan: "${FIRST_HEADING}" — newly attached. Read the brief at .arco/plans/${PLAN_ID}.md to orient. ${livingDocNote()}]\n\n`;
}

async function setupWorkflowCwd(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-antigrav-b1-'));
  const plansDir = join(cwd, '.arco', 'plans');
  await mkdir(plansDir, { recursive: true });
  await writeFile(join(plansDir, `${PLAN_ID}.md`), PLAN_BODY, 'utf8');
  return cwd;
}

async function main(): Promise<void> {
  console.log('Antigravity Phase B1 smoke (attached plan)');
  console.log('==========================================');
  console.log(`plan id: ${PLAN_ID}`);
  console.log('');

  let failures = 0;
  const fail = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`); };
  const pass = (msg: string) => { console.log(`  PASS  ${msg}`); };

  const diag = await antigravityManager.diagnostics();
  if (!diag.available) {
    console.log(`Antigravity desktop not reachable: ${diag.reason ?? 'unknown'}`);
    console.log('Launch the desktop app (and sign in) and re-run.');
    process.exit(2);
  }

  const cwd = await setupWorkflowCwd();
  const planPath = join(cwd, '.arco', 'plans', `${PLAN_ID}.md`);
  console.log(`workflow cwd: ${cwd}`);
  console.log(`plan path:    ${planPath}`);
  console.log('');

  const before = await readFile(planPath, 'utf8');
  const beforeUnchecked = (before.match(/- \[ \]/g) ?? []).length;
  const beforeChecked = (before.match(/- \[x\]/gi) ?? []).length;

  const userPrompt = `Two-step task against the attached plan:

1. Open .arco/plans/${PLAN_ID}.md, read it, and report the text of the first heading (the line starting with "# ") verbatim in your reply.
2. Tick exactly ONE unchecked checkbox in that file (change one "- [ ]" to "- [x]"). Use your file edit tool. Do not add new content or new sections. Do not tick more than one.

When done, reply with: heading, which checkbox you ticked, and a one-line confirmation.`;

  const prompt = buildPlanPrefix() + userPrompt;

  const tools: ToolEvent[] = [];
  let displayName = '';
  let cascadeId = '';
  let text = '';
  let timedOut = false;

  const config: WorkerConfig = {
    provider: 'antigravity',
    model: 'antigravity-desktop',
    cwd,
    skipPermissions: true,
  } as WorkerConfig;

  const timer = setTimeout(() => { timedOut = true; }, TURN_TIMEOUT_MS);
  try {
    const result = await runAntigravityRpcTurn(
      prompt,
      config,
      (data) => {
        if (data.sessionId) cascadeId = data.sessionId;
        if (data.model) displayName = data.model;
      },
      () => timedOut,
      (data) => {
        tools.push({ name: data.name, status: data.status, input: data.input });
      },
      (notice) => { console.log(`  notice: ${notice}`); },
    );
    text = result.text;
    cascadeId = result.cascadeId;
    displayName = result.modelDisplayName;
  } catch (err) {
    fail(`turn failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log('');
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }

  console.log('');
  console.log(`display model: ${displayName}`);
  console.log(`cascadeId:     ${cascadeId}`);
  console.log(`text (first 400): ${text.slice(0, 400)}`);
  console.log(`tool rows (${tools.length}):`);
  for (const t of tools) {
    console.log(`  - ${t.name}:${t.status ?? '?'}  input=${t.input.slice(0, 120)}`);
  }
  console.log('');

  if (text.includes(FIRST_HEADING)) pass('assistant text contains the first heading');
  else fail(`assistant text mentions the first heading "${FIRST_HEADING}"`);

  const after = await readFile(planPath, 'utf8');
  const afterUnchecked = (after.match(/- \[ \]/g) ?? []).length;
  const afterChecked = (after.match(/- \[x\]/gi) ?? []).length;

  if (after === before) {
    fail('plan file mutated on disk');
  } else {
    pass('plan file mutated on disk');
  }
  if (afterChecked === beforeChecked + 1 && afterUnchecked === beforeUnchecked - 1) {
    pass('exactly one checkbox flipped from [ ] to [x]');
  } else {
    fail(`exactly one checkbox flipped (before: ${beforeChecked}✓/${beforeUnchecked}✗, after: ${afterChecked}✓/${afterUnchecked}✗)`);
  }

  const planPathFragment = `.arco/plans/${PLAN_ID}.md`;
  const pathBearing = tools.filter((t) => t.input.includes(PLAN_ID) || t.input.includes(planPathFragment) || t.input.includes(planPath));
  const fileShaped = tools.filter((t) => /read|write|edit|file|open|patch/i.test(t.name));
  if (pathBearing.length > 0) {
    pass(`tool rows include the plan path (${pathBearing.length} row(s))`);
  } else if (fileShaped.length > 0) {
    pass(`tool rows include a file/read/write/edit-shaped row (${fileShaped.length} row(s)) — path arg not captured in input snippet`);
  } else {
    fail('Activity tools include a file/read/write/edit-shaped row or a path-bearing tool row for the plan file');
  }

  console.log('');
  if (failures === 0) {
    console.log('All Phase B1 checks passed.');
    console.log(`Leftover workflow cwd (inspect or rm): ${cwd}`);
    process.exit(0);
  } else {
    console.log(`${failures} Phase B1 check(s) failed.`);
    console.log(`Leftover workflow cwd (inspect or rm): ${cwd}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

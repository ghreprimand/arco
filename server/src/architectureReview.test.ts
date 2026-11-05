import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

// P8.5 Architecture review: deterministic facts, the report's candidates, ADD
// TO PLAN and RECORD DECISION, and the routes that run them.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-arch-review-')));
installIsolatedTestHome(root);
const review = await import('./architectureReview.js');
const { createPlan, readPlan, readPlanRef, listPlanRefs } = await import('./planStore.js');
const { tryHandleArchitectureReviewRoutes } = await import('./http/architectureReviewRoutes.js');
const { addProject } = await import('./projects.js');
const { workflows } = await import('./server/state.js');
const { listSkills, readBuiltinSkill, copyBuiltinSkill, readSkillBody } = await import('./skills.js');
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
const lines = (n: number, prefix = 'const x = 1;') => Array.from({ length: n }, (_, i) => `${prefix} // ${i}`).join('\n') + '\n';

function write(cwd: string, rel: string, text: string): void {
  mkdirSync(join(cwd, ...rel.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(cwd, ...rel.split('/')), text);
}

function repo(name: string, withGit = true): string {
  const cwd = join(root, name); mkdirSync(cwd, { recursive: true });
  write(cwd, 'src/engine.ts', 'export const a = 1;\nexport function b() {}\nexport class C {}\n' + lines(300));
  write(cwd, 'src/engine.test.ts', lines(20));
  write(cwd, 'src/panel.tsx', 'export function Panel() {}\n' + lines(120));
  write(cwd, 'src/util.ts', 'export const u = 1;\n' + lines(40));
  write(cwd, 'tools/report.py', 'def run():\n    pass\nclass Report:\n    pass\ndef _private():\n    pass\n');
  write(cwd, 'tests/test_report.py', 'def test_run():\n    pass\n');
  write(cwd, 'node_modules/dep/index.js', lines(5000));
  write(cwd, 'README.md', lines(900));
  if (withGit) {
    git(cwd, 'init', '-q');
    write(cwd, '.gitignore', 'node_modules/\n');
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'one');
    for (let i = 0; i < 3; i++) { write(cwd, 'src/panel.tsx', `export function Panel() {}\n${lines(121 + i)}`); git(cwd, 'commit', '-qam', `panel ${i}`); }
    write(cwd, 'src/util.ts', 'export const u = 2;\n' + lines(40)); git(cwd, 'commit', '-qam', 'util');
  }
  return cwd;
}

test('test files are recognized and matched to what they test', () => {
  for (const f of ['src/a.test.ts', 'src/a.spec.tsx', 'tests/test_a.py', 'pkg/a_test.go', 'src/__tests__/a.ts', 'src/ATest.java']) assert.equal(review.isTestFile(f), true, f);
  for (const f of ['src/a.ts', 'src/testing.ts', 'src/contest.py']) assert.equal(review.isTestFile(f), false, f);
  assert.deepEqual(['src/a.test.ts', 'tests/test_a.py', 'pkg/a_test.go', 'src/a.spec.tsx'].map(review.testedStem), ['a', 'a', 'a', 'a']);
});

test('facts in a Git repository: largest, most changed, untested and exports; dependencies and docs left out', async () => {
  const cwd = repo('git-project');
  const f = await review.gatherArchitectureFacts(cwd, null);
  assert.equal(f.git, true);
  assert.equal(f.sourceFiles, 4);
  assert.equal(f.testFiles, 2);
  assert.deepEqual(f.largest.map((x) => x.path), ['src/engine.ts', 'src/panel.tsx', 'src/util.ts', 'tools/report.py']);
  assert.equal(f.largest[0].lines, 303);
  assert.deepEqual(f.mostChanged, [{ path: 'src/panel.tsx', commits: 4 }, { path: 'src/util.ts', commits: 2 }, { path: 'src/engine.ts', commits: 1 }, { path: 'tools/report.py', commits: 1 }]);
  assert.deepEqual(f.untested.map((x) => x.path), ['src/panel.tsx', 'src/util.ts']);
  assert.equal(f.untestedCount, 2);
  assert.deepEqual(f.mostExports, [{ path: 'src/engine.ts', exports: 3 }, { path: 'tools/report.py', exports: 2 }, { path: 'src/panel.tsx', exports: 1 }, { path: 'src/util.ts', exports: 1 }]);
  const text = review.renderArchitectureFacts(f);
  assert.match(text, /^<arco-architecture-facts>/);
  assert.match(text, /- src\/panel.tsx: 4/);
  assert.match(text, /- none recorded/);
  assert.doesNotMatch(text, /node_modules|README/);
  // The same project gives the same facts.
  assert.equal(review.renderArchitectureFacts(await review.gatherArchitectureFacts(cwd, null)), text);
});

test('imports in test files are resolved to project modules', () => {
  assert.deepEqual(review.importedModules('src/ws/turn.test.ts', [
    "import { a } from './engine.js';",
    "import b from '../providers/worker';",
    "import type { C } from '../ui/index.tsx';",
    "const d = await import('./lazy.mjs');",
    "const e = require('./legacy.cjs');",
    "import './side-effect';",
    "import x from 'node:fs'; import y from '@arco/shared';",
    "import z from '../../../outside.js';",
  ].join('\n')).sort(), ['src/providers/worker', 'src/ui', 'src/ws/engine', 'src/ws/lazy', 'src/ws/legacy', 'src/ws/side-effect']);
  assert.deepEqual(review.importedModules('tests/test_jobs.py', 'from app.jobs import run\nimport app.util\nfrom .helpers import x\nfrom . import conftest\n').sort(), ['*/app/jobs', '*/app/util', 'tests', 'tests/helpers']);
});

test('a source file that a test imports under another name counts as tested', async () => {
  const cwd = repo('imported-project');
  write(cwd, 'src/robustness.test.ts', "import { Panel } from './panel.js';\n" + lines(5));
  write(cwd, 'src/lib/index.ts', 'export const i = 1;\n' + lines(10));
  write(cwd, 'src/lib.test.ts', "import { i } from './lib';\n");
  write(cwd, 'app/jobs.py', 'def run():\n    pass\n');
  write(cwd, 'tests/test_scheduler.py', 'from app.jobs import run\n');
  git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'tests by import');
  const f = await review.gatherArchitectureFacts(cwd, null);
  assert.deepEqual(f.untested.map((x) => x.path), ['src/util.ts']);
  assert.equal(f.untestedCount, 1);
  assert.match(review.renderArchitectureFacts(f), /Source files that no test file matches by name or imports: 1\./);
});

test('facts in a folder without Git skip change history and still list the rest', async () => {
  const cwd = repo('plain-folder', false);
  const f = await review.gatherArchitectureFacts(cwd, '## Not pursued: Merge the panels');
  assert.equal(f.git, false);
  assert.equal(f.mostChanged, null);
  assert.deepEqual(f.largest.map((x) => x.path), ['src/engine.ts', 'src/panel.tsx', 'src/util.ts', 'tools/report.py']);
  const text = review.renderArchitectureFacts(f);
  assert.match(text, /not a Git repository/);
  assert.match(text, /Merge the panels/);
});

function conversation(cwd: string, id: string, candidates: unknown, name = 'architecture-review-2026-11-05'): void {
  const dir = join(cwd, '.arco', 'workflows', id, 'artifacts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), '# Architecture review\n');
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(candidates));
}

const CANDIDATES = {
  version: 1,
  candidates: [
    { id: 'c1', title: 'One owner for turn boundaries', files: ['src/engine.ts', 'src/panel.tsx'], problem: 'Two places.', proposal: 'One function.', benefits: { locality: 'One place.', leverage: 'Less to learn.', tests: 'At the function.' }, strength: 'Strong' },
    { id: 'c2', title: 'Split the panel', files: ['src/panel.tsx'], problem: 'Large.', proposal: 'Split.', benefits: { locality: 'x', leverage: 'y', tests: 'z' }, strength: 'nonsense' },
    { id: 'c1', title: 'Duplicate id is dropped' },
    { title: 'No id is dropped' },
  ],
  recommendation: 'c1',
};

test('a report is read from its JSON file, checked and cleaned', async () => {
  const cwd = repo('reports', false);
  conversation(cwd, 'conv-a', CANDIDATES);
  const dir = join(cwd, '.arco', 'workflows', 'conv-a');
  const r = await review.readArchitectureReport(dir, 'artifacts/architecture-review-2026-11-05.md');
  assert.deepEqual(r.candidates.map((c) => [c.id, c.strength]), [['c1', 'Strong'], ['c2', 'Speculative']]);
  assert.equal(r.recommendation, 'c1');
  assert.equal(r.data, 'artifacts/architecture-review-2026-11-05.json');
  await assert.rejects(review.readArchitectureReport(dir, 'artifacts/notes.md'), /Choose an architecture review report/);
  await assert.rejects(review.readArchitectureReport(dir, 'artifacts/../../x/architecture-review-a.md'), /Choose an architecture review report/);
  await assert.rejects(review.readArchitectureReport(dir, 'artifacts/architecture-review-missing.md'), /no candidates file/);
  writeFileSync(join(dir, 'artifacts', 'architecture-review-bad.json'), '{');
  await assert.rejects(review.readArchitectureReport(dir, 'artifacts/architecture-review-bad.md'), /not valid JSON/);
});

test('ADD TO PLAN adds one item under the Architecture review heading with its own reference doc', async () => {
  const cwd = repo('add-to-plan', false);
  conversation(cwd, 'conv-b', CANDIDATES);
  const plan = await createPlan(cwd, { title: 'Release', body: '# Release\n\n### Phase 1\n- [ ] Ship it\n' });
  const r = await review.readArchitectureReport(join(cwd, '.arco', 'workflows', 'conv-b'), 'artifacts/architecture-review-2026-11-05.md');
  const first = await review.addCandidateToPlan(cwd, plan.id, r, 'c1');
  assert.equal(first.slug, 'arch-one-owner-for-turn-boundaries');
  const second = await review.addCandidateToPlan(cwd, plan.id, r, 'c1');
  assert.equal(second.slug, 'arch-one-owner-for-turn-boundaries-2');
  await review.addCandidateToPlan(cwd, plan.id, r, 'c2');
  const body = (await readPlan(cwd, plan.id))!.body;
  assert.equal(body, '# Release\n\n### Phase 1\n- [ ] Ship it\n\n### Architecture review\n- [ ] One owner for turn boundaries [Architecture](ref:arch-one-owner-for-turn-boundaries)\n- [ ] One owner for turn boundaries [Architecture](ref:arch-one-owner-for-turn-boundaries-2)\n- [ ] Split the panel [Architecture](ref:arch-split-the-panel)\n');
  const ref = await readPlanRef(cwd, plan.id, first.slug);
  assert.match(ref!.body, /^# One owner for turn boundaries/);
  assert.match(ref!.body, /- `src\/engine.ts`/);
  assert.match(ref!.body, /Tests at the new seam first; no behavior change/);
  await assert.rejects(review.addCandidateToPlan(cwd, plan.id, r, 'c9'), /not in the report/);
});

test('the item goes to the end of an existing Architecture review section, before the next heading', () => {
  const body = '# P\n\n### Architecture review\n- [ ] A\n\n### Later\n- [ ] B\n';
  assert.equal(review.insertUnderHeading(body, '### Architecture review', '- [ ] C'), '# P\n\n### Architecture review\n- [ ] A\n- [ ] C\n\n### Later\n- [ ] B\n');
  assert.equal(review.insertUnderHeading('', '### Architecture review', '- [ ] C'), '### Architecture review\n- [ ] C\n');
});

test('RECORD DECISION appends to the decisions doc, which the next review reads', async () => {
  const cwd = repo('decisions', false);
  conversation(cwd, 'conv-c', CANDIDATES);
  const plan = await createPlan(cwd, { title: 'Release', body: '# Release\n' });
  const r = await review.readArchitectureReport(join(cwd, '.arco', 'workflows', 'conv-c'), 'artifacts/architecture-review-2026-11-05.md');
  await assert.rejects(review.recordCandidateDecision(cwd, plan.id, r, 'c2', '  '), /Give the reason/);
  await review.recordCandidateDecision(cwd, plan.id, r, 'c2', 'The panel is being replaced next release.', new Date('2026-11-05T12:00:00Z'));
  await review.recordCandidateDecision(cwd, plan.id, r, 'c1', 'Done another way.', new Date('2026-11-06T12:00:00Z'));
  const doc = (await readPlanRef(cwd, plan.id, 'decisions'))!.body;
  assert.match(doc, /^# Decisions/);
  assert.match(doc, /## Not pursued: Split the panel\n- Date: 2026-11-05\n- Files: `src\/panel.tsx`\n- Reason: The panel is being replaced next release\./);
  assert.ok(doc.indexOf('Split the panel') < doc.indexOf('One owner for turn boundaries'));
  assert.equal((await readPlan(cwd, plan.id))!.body, '# Release\n', 'the plan body is unchanged');
  const facts = await review.architectureReviewFacts(cwd, plan.id);
  assert.match(facts, /Not pursued: Split the panel/);
});

test('the built-in skill is listed as built-in and operator-only, in Arco\'s words', async () => {
  const cwd = repo('skills', false);
  const catalog = await listSkills(cwd);
  assert.deepEqual(catalog.builtin, [{ slug: 'architecture-review', name: 'Architecture review', description: review.ARCHITECTURE_REVIEW_SKILL.description, scope: 'builtin', operatorOnly: true }]);
  const body = readBuiltinSkill('architecture-review')!.body;
  for (const word of ['Deletion test', 'Seam', 'architecture-review-YYYY-MM-DD.json', 'one question at a time', 'ADD TO PLAN', 'RECORD DECISION']) assert.ok(body.includes(word), word);
  assert.equal(readBuiltinSkill('other'), null);
  // EDITABLE COPY: an ordinary operator-only skill with the same text.
  const copy = await copyBuiltinSkill('architecture-review', 'project', cwd);
  assert.equal(copy.name, 'Architecture review (copy)');
  const full = await readSkillBody('project', copy.slug, cwd);
  assert.equal(full?.operatorOnly, true);
  assert.equal(full?.body.trim(), body.trim());
  await assert.rejects(copyBuiltinSkill('other', 'project', cwd), /not found/);
});

async function post(action: string, payload: Record<string, unknown>): Promise<{ code: number; body: Record<string, unknown> }> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), { method: 'POST', url: `/api/architecture-review/${action}` }) as IncomingMessage;
  let code = 0, text = '';
  const res = { writeHead: (status: number) => { code = status; }, end: (value: string) => { text = value; } } as unknown as ServerResponse;
  assert.equal(await tryHandleArchitectureReviewRoutes(req, res), true);
  return { code, body: JSON.parse(text) };
}

test('routes: registered projects only, a plan must be attached, confirmation required', async () => {
  const cwd = repo('routes', false);
  conversation(cwd, 'conv-d', CANDIDATES);
  const report = 'artifacts/architecture-review-2026-11-05.md';
  assert.equal((await post('candidates', { path: cwd, workflowId: 'conv-d', report })).code, 403);
  assert.equal((await addProject(cwd)).ok, true);
  const listed = await post('candidates', { path: cwd, workflowId: 'conv-d', report });
  assert.equal(listed.code, 200);
  assert.equal(listed.body.plan, null);
  assert.equal((listed.body.candidates as unknown[]).length, 2);
  const noPlan = await post('add-to-plan', { path: cwd, workflowId: 'conv-d', report, candidateId: 'c1', confirm: true });
  assert.equal(noPlan.code, 409);
  const plan = await createPlan(cwd, { title: 'Release', body: '# Release\n' });
  workflows.set('conv-d', { planId: plan.id, config: {} } as never);
  try {
    assert.equal((await post('add-to-plan', { path: cwd, workflowId: 'conv-d', report, candidateId: 'c1' })).code, 400);
    const added = await post('add-to-plan', { path: cwd, workflowId: 'conv-d', report, candidateId: 'c1', confirm: true });
    assert.equal(added.code, 200);
    assert.equal((added.body.plan as { title: string }).title, 'Release');
    const decided = await post('record-decision', { path: cwd, workflowId: 'conv-d', report, candidateId: 'c2', reason: 'Not now.', confirm: true });
    assert.equal(decided.code, 200);
    assert.deepEqual((await listPlanRefs(cwd, plan.id)).map((r) => r.slug).sort(), ['arch-one-owner-for-turn-boundaries', 'decisions']);
    assert.match(readFileSync(join(cwd, '.arco', 'plans', `${plan.id}.md`), 'utf8'), /ref:arch-one-owner-for-turn-boundaries/);
    assert.equal((await post('candidates', { path: cwd, workflowId: 'conv-d', report: 'artifacts/x.md' })).code, 400);
  } finally { workflows.delete('conv-d'); }
});

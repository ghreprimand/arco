import { projectFiles, scanBudget } from './projectScan.js';
// P8.5 Architecture review: a built-in, operator-only skill. Arco gathers
// deterministic facts about the project (no model), the agent explores and
// writes a report of candidates to the conversation's artifacts, and the
// operator turns a picked candidate into a plan item (ADD TO PLAN) or records
// why it is not pursued (RECORD DECISION) in the attached plan's `decisions`
// reference doc, which later reviews read. Read-only for the project until the
// operator acts; nothing runs on its own schedule. See docs/ARCHITECTURE_REVIEW.md.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { listPlanRefs, readPlan, readPlanRef, updatePlan, writePlanRef } from './planStore.js';
import { slugify } from './skills.js';

const run = promisify(execFile);

export { ARCHITECTURE_REVIEW_SKILL, ARCHITECTURE_REVIEW_SLUG } from './architectureSkill.js';
export const DECISIONS_REF = 'decisions';

// ---------------------------------------------------------------------------
// Facts

const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|scala|vue|svelte)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.arco', 'vendor', 'target', 'coverage', '.next', '.venv', 'venv', '__pycache__']);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_DECISIONS_BYTES = 16 * 1024;
const LIST = 15;

export function isTestFile(rel: string): boolean {
  const base = path.posix.basename(rel);
  return /\.(?:test|spec)\.[^.]+$/i.test(base) || /^test_.+\.py$/i.test(base) || /_test\.(?:go|py)$/i.test(base) || /(?:^|\/)(?:__tests__|tests?)\//i.test(rel) || /Tests?\.(?:java|kt|cs|swift)$/.test(base);
}

// The name a test file is about: report.test.ts, test_report.py and
// report_test.go all cover "report".
export function testedStem(rel: string): string {
  return path.posix.basename(rel).replace(/\.(?:test|spec)(?=\.[^.]+$)/i, '').replace(/^test_/i, '').replace(/_test(?=\.[^.]+$)/i, '').replace(/Tests?(?=\.[^.]+$)/, '').replace(/\.[^.]+$/, '').toLowerCase();
}

function stem(rel: string): string { return path.posix.basename(rel).replace(/\.[^.]+$/, '').toLowerCase(); }

const MAX_TEST_BYTES = 64 * 1024 * 1024;
const CODE_EXT = /\.(?:[cm]?[jt]sx?|py)$/i;

// The project-relative module names a test file imports: relative JavaScript
// and TypeScript specifiers (`./worker.js`, `../ws/turnEngine`), resolved
// against the test's folder, and Python modules (`from pkg.mod import x`,
// `from .mod import x`). Package names and path aliases are left out.
export function importedModules(testRel: string, text: string): string[] {
  const dir = path.posix.dirname(testRel);
  const out = new Set<string>();
  const add = (p: string) => { const n = path.posix.normalize(p).replace(CODE_EXT, '').replace(/\/index$/, ''); if (!n.startsWith('..')) out.add(n); };
  if (/\.py$/i.test(testRel)) {
    for (const m of text.matchAll(/^\s*(?:from\s+(\.*)([A-Za-z_][\w.]*)?\s+import|import\s+([A-Za-z_][\w.]*))/gm)) {
      const dots = m[1] ?? '';
      const name = (m[2] ?? m[3] ?? '').replace(/\./g, '/');
      if (dots) add(path.posix.join(dir, ...Array(Math.max(0, dots.length - 1)).fill('..'), name));
      else if (name) out.add(`*/${name}`);
    }
    return [...out];
  }
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) add(path.posix.join(dir, m[1]));
  return [...out];
}

// True when some test imports `rel`: its path without the extension (or its
// folder, for an index file) is a resolved import; a Python module also counts
// when an absolute import ends with its path.
function importedBy(rel: string, imports: Set<string>): boolean {
  const bare = rel.replace(CODE_EXT, '');
  if (imports.has(bare) || (/\/index$/.test(bare) && imports.has(bare.replace(/\/index$/, '')))) return true;
  if (!/\.py$/i.test(rel)) return false;
  for (let i = bare.indexOf('/'); i >= 0; i = bare.indexOf('/', i + 1)) if (imports.has(`*/${bare.slice(i + 1)}`)) return true;
  return imports.has(`*/${bare}`);
}

async function gitLines(cwd: string, args: string[]): Promise<string[] | null> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 20_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
    return stdout.split('\n').filter(Boolean);
  } catch { return null; }
}

async function listFiles(cwd: string): Promise<{ files: string[]; git: boolean; partial?: boolean }> {
  const tracked = await gitLines(cwd, ['ls-files', '--cached', '--others', '--exclude-standard']);
  if (tracked) return { files: tracked.filter((f) => !f.split('/').some((p) => SKIP_DIRS.has(p))).slice(0, MAX_FILES).sort(), git: true };
  const out: string[] = [];
  const budget = scanBudget(20_000, 1000);
  for await (const file of projectFiles(cwd, { budget, skip: SKIP_DIRS, respectGitIgnore: true, maxDepth: 64 })) {
    out.push(path.relative(cwd, file.path).split(path.sep).join('/'));
    if (out.length >= MAX_FILES) { budget.partial = true; break; }
  }
  return { files: out.sort(), git: false, partial: budget.partial };
}

function countExports(rel: string, text: string): number {
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/i.test(rel)) return (text.match(/^export\s/gm) ?? []).length;
  if (/\.py$/i.test(rel)) return (text.match(/^(?:def|class|async def)\s+[A-Za-z]/gm) ?? []).length;
  if (/\.go$/i.test(rel)) return (text.match(/^func\s+(?:\([^)]*\)\s*)?[A-Z]/gm) ?? []).length;
  if (/\.rs$/i.test(rel)) return (text.match(/^pub\s/gm) ?? []).length;
  return 0;
}

export interface ArchitectureFacts {
  partial?: boolean;
  git: boolean;
  sourceFiles: number;
  testFiles: number;
  largest: Array<{ path: string; lines: number }>;
  mostChanged: Array<{ path: string; commits: number }> | null;
  untested: Array<{ path: string; lines: number }>;
  untestedCount: number;
  mostExports: Array<{ path: string; exports: number }>;
  decisions: string | null;
}

export async function gatherArchitectureFacts(cwd: string, decisions: string | null = null): Promise<ArchitectureFacts> {
  const { files, git, partial } = await listFiles(cwd);
  const tests = files.filter((f) => SOURCE_EXT.test(f) && isTestFile(f));
  const sources = files.filter((f) => SOURCE_EXT.test(f) && !isTestFile(f));
  const tested = new Set(tests.map(testedStem));
  // A source file also counts as tested when a test imports it, so tests with
  // another name (turnRobustness.test.ts covering worker.ts) are seen.
  const imports = new Set<string>();
  let testBytes = 0;
  for (const rel of tests) {
    if (testBytes >= MAX_TEST_BYTES) break;
    try {
      const full = path.join(cwd, ...rel.split('/'));
      const st = await fs.lstat(full);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      testBytes += st.size;
      for (const m of importedModules(rel, await fs.readFile(full, 'utf8'))) imports.add(m);
    } catch { continue; }
  }
  const measured: Array<{ path: string; lines: number; exports: number }> = [];
  let total = 0;
  for (const rel of sources) {
    if (total >= MAX_TOTAL_BYTES) break;
    let text: string;
    try {
      const full = path.join(cwd, ...rel.split('/'));
      const st = await fs.lstat(full);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      text = await fs.readFile(full, 'utf8'); total += st.size;
    } catch { continue; }
    const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    measured.push({ path: rel, lines, exports: countExports(rel, text) });
  }
  const byLines = [...measured].sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  const untestedAll = byLines.filter((m) => !tested.has(stem(m.path)) && !importedBy(m.path, imports));
  let mostChanged: ArchitectureFacts['mostChanged'] = null;
  if (git) {
    const log = await gitLines(cwd, ['log', '--since=180.days', '-n', '2000', '--name-only', '--pretty=format:']);
    if (log) {
      const known = new Set(sources);
      const counts = new Map<string, number>();
      for (const f of log) if (known.has(f)) counts.set(f, (counts.get(f) ?? 0) + 1);
      mostChanged = [...counts].map(([p, commits]) => ({ path: p, commits })).sort((a, b) => b.commits - a.commits || a.path.localeCompare(b.path)).slice(0, LIST);
    }
  }
  return {
    git, partial,
    sourceFiles: sources.length,
    testFiles: tests.length,
    largest: byLines.slice(0, LIST).map(({ path: p, lines }) => ({ path: p, lines })),
    mostChanged,
    untested: untestedAll.slice(0, 20).map(({ path: p, lines }) => ({ path: p, lines })),
    untestedCount: untestedAll.length,
    mostExports: [...measured].filter((m) => m.exports > 0).sort((a, b) => b.exports - a.exports || a.path.localeCompare(b.path)).slice(0, LIST).map(({ path: p, exports }) => ({ path: p, exports })),
    decisions: decisions ? decisions.slice(0, MAX_DECISIONS_BYTES) : null,
  };
}

export function renderArchitectureFacts(f: ArchitectureFacts): string {
  const out: string[] = ['<arco-architecture-facts>', 'Facts gathered by Arco for this review (measured, not estimated).', ''];
  if (f.partial) out.push('Results truncated: project discovery reached its entry or time budget.', '');
  out.push(`Source files: ${f.sourceFiles}. Test files: ${f.testFiles}.${f.git ? '' : ' This folder is not a Git repository, so change history is not available.'}`, '');
  out.push('Largest source files (lines):');
  for (const x of f.largest) out.push(`- ${x.path}: ${x.lines}`);
  if (f.mostChanged) {
    out.push('', 'Most often changed source files (commits in the last 180 days):');
    if (f.mostChanged.length === 0) out.push('- none');
    for (const x of f.mostChanged) out.push(`- ${x.path}: ${x.commits}`);
  }
  out.push('', `Source files that no test file matches by name or imports: ${f.untestedCount}. The largest of them (lines):`);
  for (const x of f.untested) out.push(`- ${x.path}: ${x.lines}`);
  out.push('', 'Files with the most exported names:');
  for (const x of f.mostExports) out.push(`- ${x.path}: ${x.exports}`);
  out.push('', 'Decisions already recorded for this project:');
  out.push(f.decisions?.trim() ? f.decisions.trim() : '- none recorded');
  out.push('</arco-architecture-facts>');
  return out.join('\n');
}

// The facts block added to the built-in skill when the operator runs it.
export async function architectureReviewFacts(cwd: string, planId: string | undefined): Promise<string> {
  return renderArchitectureFacts(await gatherArchitectureFacts(cwd, await readDecisions(cwd, planId)));
}

export async function readDecisions(cwd: string, planId: string | undefined): Promise<string | null> {
  if (!planId) return null;
  const ref = await readPlanRef(cwd, planId, DECISIONS_REF).catch(() => null);
  return ref?.body ?? null;
}

// ---------------------------------------------------------------------------
// Report candidates

export type CandidateStrength = 'Strong' | 'Worth exploring' | 'Speculative';
export interface ArchitectureCandidate {
  id: string; title: string; files: string[]; problem: string; proposal: string;
  benefits: { locality: string; leverage: string; tests: string }; strength: CandidateStrength;
}
export interface ArchitectureReport { report: string; data: string; candidates: ArchitectureCandidate[]; recommendation?: string }

const REPORT_NAME = /^architecture-review-[A-Za-z0-9_.-]{1,80}\.(?:md|json|html)$/;
const MAX_REPORT_JSON = 512 * 1024;
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// `report` is an artifact path such as artifacts/architecture-review-2026-11-05.md;
// the candidates come from the .json file next to it.
export async function readArchitectureReport(conversationDir: string, report: string): Promise<ArchitectureReport> {
  const rel = report.replace(/\\/g, '/');
  if (!rel.startsWith('artifacts/') || rel.includes('/../') || !REPORT_NAME.test(path.posix.basename(rel))) throw new Error('Choose an architecture review report.');
  const data = rel.replace(/\.(?:md|html|json)$/, '.json');
  const root = await fs.realpath(path.join(conversationDir, 'artifacts'));
  const file = path.join(conversationDir, ...data.split('/'));
  const st = await fs.lstat(file).catch(() => null);
  if (!st || !st.isFile()) throw new Error('The report has no candidates file next to it.');
  if (st.size > MAX_REPORT_JSON) throw new Error('The candidates file is too large.');
  const real = await fs.realpath(file);
  if (!real.startsWith(root + path.sep)) throw new Error('Choose an architecture review report.');
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(real, 'utf8')); } catch { throw new Error('The candidates file is not valid JSON.'); }
  const raw = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(raw)) throw new Error('The candidates file has no candidates list.');
  const seen = new Set<string>();
  const candidates: ArchitectureCandidate[] = [];
  for (const c of raw.slice(0, 50)) {
    const o = (c ?? {}) as Record<string, unknown>;
    const id = text(o.id, 40); const title = text(o.title, 200);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const b = (o.benefits ?? {}) as Record<string, unknown>;
    const strength = (['Strong', 'Worth exploring', 'Speculative'] as const).find((s) => s === o.strength) ?? 'Speculative';
    candidates.push({
      id, title,
      files: Array.isArray(o.files) ? o.files.map((f) => text(f, 300)).filter(Boolean).slice(0, 30) : [],
      problem: text(o.problem, 4000), proposal: text(o.proposal, 4000),
      benefits: { locality: text(b.locality, 1000), leverage: text(b.leverage, 1000), tests: text(b.tests, 1000) },
      strength,
    });
  }
  const recommendation = text((parsed as { recommendation?: unknown }).recommendation, 40);
  return { report: rel, data, candidates, ...(recommendation && seen.has(recommendation) ? { recommendation } : {}) };
}

function candidateDoc(c: ArchitectureCandidate, report: string): string {
  return [
    `# ${c.title}`, '',
    `From the architecture review \`${report}\` (candidate ${c.id}, ${c.strength}).`, '',
    '## Files', ...(c.files.length ? c.files.map((f) => `- \`${f}\``) : ['- (none listed)']), '',
    '## Problem', c.problem || '(not given)', '',
    '## Proposed change', c.proposal || '(not given)', '',
    '## Expected benefit',
    `- Locality: ${c.benefits.locality || '(not given)'}`,
    `- Leverage: ${c.benefits.leverage || '(not given)'}`,
    `- Tests: ${c.benefits.tests || '(not given)'}`, '',
    '## Building it', '- Preserve behavior; follow the project\'s testing directive.', '',
  ].join('\n');
}

// Adds `item` as the last line of the section under `heading`, creating the
// section at the end of the plan when it does not exist.
export function insertUnderHeading(planBody: string, heading: string, item: string): string {
  const lines = planBody.replace(/\s+$/, '').split('\n');
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at < 0) return `${lines.join('\n')}${lines.join('').trim() ? '\n\n' : ''}${heading}\n${item}\n`.replace(/^\n+/, '');
  let end = at + 1;
  while (end < lines.length && !/^#{1,3} /.test(lines[end])) end++;
  let last = end; while (last > at + 1 && !lines[last - 1].trim()) last--;
  lines.splice(last, 0, item);
  return `${lines.join('\n')}\n`;
}

const plainTitle = (t: string) => t.replace(/[\[\]\n\r]/g, ' ').replace(/\s+/g, ' ').trim();

// ADD TO PLAN: one unticked item under "### Architecture review" in the
// attached plan, linked to a new reference doc holding the candidate.
export async function addCandidateToPlan(cwd: string, planId: string, report: ArchitectureReport, candidateId: string): Promise<{ slug: string; item: string }> {
  const c = report.candidates.find((x) => x.id === candidateId);
  if (!c) throw new Error('That candidate is not in the report.');
  const plan = await readPlan(cwd, planId);
  if (!plan) throw new Error('The attached plan was not found.');
  const existing = new Set((await listPlanRefs(cwd, planId)).map((r) => r.slug));
  const base = `arch-${slugify(c.title)}`.slice(0, 56).replace(/-+$/, '');
  let slug = base; for (let i = 2; existing.has(slug); i++) slug = `${base}-${i}`;
  for (let n = 2; ; n++) {
    const written = await writePlanRef(cwd, planId, slug, candidateDoc(c, report.report), { createOnly: true });
    if (written.ok) break;
    if (written.error !== 'ref already exists') throw new Error(written.error);
    slug = `${base}-${n}`;
  }
  const item = `- [ ] ${plainTitle(c.title)} [Architecture](ref:${slug})`;
  const saved = await updatePlan(cwd, planId, (current) => ({ body: insertUnderHeading(current.body, '### Architecture review', item) }));
  if (!saved) throw new Error('The attached plan was not found.');
  return { slug, item };
}

// RECORD DECISION: appends to the plan's `decisions` reference doc, which the
// next review's facts include.
export async function recordCandidateDecision(cwd: string, planId: string, report: ArchitectureReport, candidateId: string, reason: string, now = new Date()): Promise<void> {
  const c = report.candidates.find((x) => x.id === candidateId);
  if (!c) throw new Error('That candidate is not in the report.');
  const why = reason.replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!why) throw new Error('Give the reason for the decision.');
  if (!(await readPlan(cwd, planId))) throw new Error('The attached plan was not found.');
  const initial = '# Decisions\n\nRecorded by RECORD DECISION in an architecture review. Later reviews read this list and do not suggest these again.\n';
  const entry = ['', `## Not pursued: ${plainTitle(c.title)}`, `- Date: ${now.toISOString().slice(0, 10)}`, `- Files: ${c.files.length ? c.files.map((f) => `\`${f}\``).join(', ') : '(none listed)'}`, `- Reason: ${why}`, `- From: \`${report.report}\``, ''].join('\n');
  const written = await writePlanRef(cwd, planId, DECISIONS_REF, (prior) => `${(prior ?? initial).replace(/\s+$/, '')}\n${entry}`);
  if (!written.ok) throw new Error(written.error);
}

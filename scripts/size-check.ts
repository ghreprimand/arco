// File-size budget guardrail for Arco's project-wide size refactor.
//
// Why: a handful of monoliths (index.ts, RightPanel.tsx, protocol.ts, ...) drove
// merge pain and oversized hot-reload blast radius. The size refactor breaks
// them up; this script keeps them broken up. It fails CI when a hand-written
// source file crosses the hard budget, so the monoliths cannot silently regrow.
//
// Buckets:
//   - code (.ts/.tsx/.js/.mjs/.css): HARD budget — exit 1 when exceeded.
//   - docs (.md):                    soft budget — warn only (unless --strict-docs).
//   - data (.json):                  soft budget — warn only.
// Excluded entirely: node_modules, dist/build/coverage, generated bindings,
// lockfiles, archived docs (docs/archive/), and append-only logs (DEVLOG.md).
//
// Usage:
//   npm run size:check              report + fail on code-budget breach
//   npm run size:check -- --top 30  show 30 largest tracked files
//   npm run size:check -- --strict-docs   also fail on oversized active docs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const CODE_BUDGET = 2000;
const DOCS_BUDGET = 2000;
const DATA_BUDGET = 2000;

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.css']);
const DOCS_EXT = new Set(['.md']);
const DATA_EXT = new Set(['.json']);

// Path fragments that exclude a file from every bucket.
const EXCLUDE_PATTERNS: RegExp[] = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)coverage\//,
  /(^|\/)\.git\//,
  // Generated ts-rs bindings — see project memory "Codex bindings ts-rs gotcha".
  /(^|\/)codex-appserver\/bindings\//,
  // Vendored third-party code — not a refactor target (see VENDOR.md). The
  // Odysseus image editor (H2) ships galleryEditor.js at ~3.8k lines + a ~5.3k
  // extracted CSS; both are upstream artifacts, not Arco monoliths.
  /(^|\/)vendor\//,
  // Lockfiles.
  /(^|\/)package-lock\.json$/,
  // Read-only historical docs.
  /(^|\/)docs\/archive\//,
  // Append-only log; never a refactor target.
  /(^|\/)DEVLOG\.md$/,
];

interface Entry {
  path: string;
  lines: number;
  bucket: 'code' | 'docs' | 'data';
  budget: number;
}

function ext(path: string): string {
  const i = path.lastIndexOf('.');
  return i < 0 ? '' : path.slice(i);
}

function bucketFor(path: string): Pick<Entry, 'bucket' | 'budget'> | null {
  const e = ext(path);
  if (CODE_EXT.has(e)) return { bucket: 'code', budget: CODE_BUDGET };
  if (DOCS_EXT.has(e)) return { bucket: 'docs', budget: DOCS_BUDGET };
  if (DATA_EXT.has(e)) return { bucket: 'data', budget: DATA_BUDGET };
  return null;
}

function trackedFiles(): string[] {
  // Tracked files PLUS untracked-but-not-ignored files, so freshly-extracted
  // modules are budgeted before they're committed. Deduped; deleted-in-worktree
  // files (still in the index) are filtered out by the existsSync check below.
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set(out.split('\n').filter(Boolean))];
}

function countLines(path: string): number {
  // Match `wc -l`: count newline characters.
  const buf = readFileSync(path);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return n;
}

function main(): void {
  const argv = process.argv.slice(2);
  const strictDocs = argv.includes('--strict-docs');
  const topIdx = argv.indexOf('--top');
  const topN = topIdx >= 0 ? Number(argv[topIdx + 1]) || 15 : 15;

  const entries: Entry[] = [];
  for (const path of trackedFiles()) {
    if (EXCLUDE_PATTERNS.some((re) => re.test(path))) continue;
    const b = bucketFor(path);
    if (!b) continue;
    if (!existsSync(path)) continue; // deleted in worktree but still in the index
    entries.push({ path, lines: countLines(path), ...b });
  }

  entries.sort((a, b) => b.lines - a.lines);

  const codeOver = entries.filter((e) => e.bucket === 'code' && e.lines > e.budget);
  const docsOver = entries.filter((e) => e.bucket === 'docs' && e.lines > e.budget);
  const dataOver = entries.filter((e) => e.bucket === 'data' && e.lines > e.budget);

  console.log(`size:check — ${entries.length} tracked files scanned (code budget ${CODE_BUDGET} lines)\n`);

  console.log(`Top ${topN} largest:`);
  for (const e of entries.slice(0, topN)) {
    const flag = e.lines > e.budget ? (e.bucket === 'code' ? ' ✗' : ' ⚠') : '';
    console.log(`  ${String(e.lines).padStart(6)}  [${e.bucket}] ${e.path}${flag}`);
  }
  console.log('');

  if (docsOver.length) {
    console.log(`⚠  ${docsOver.length} active doc(s) over ${DOCS_BUDGET} lines (warning${strictDocs ? ', strict' : ''}):`);
    for (const e of docsOver) console.log(`     ${String(e.lines).padStart(6)}  ${e.path}`);
    console.log('');
  }
  if (dataOver.length) {
    console.log(`⚠  ${dataOver.length} data file(s) over ${DATA_BUDGET} lines (warning):`);
    for (const e of dataOver) console.log(`     ${String(e.lines).padStart(6)}  ${e.path}`);
    console.log('');
  }

  if (codeOver.length) {
    console.error(`✗  ${codeOver.length} source file(s) over the ${CODE_BUDGET}-line hard budget:`);
    for (const e of codeOver) console.error(`     ${String(e.lines).padStart(6)}  ${e.path}`);
    console.error('\nSplit these before they regrow.');
    process.exit(1);
  }

  if (strictDocs && docsOver.length) {
    console.error(`✗  --strict-docs: ${docsOver.length} active doc(s) over budget.`);
    process.exit(1);
  }

  console.log('✓  All source files within the hard budget.');
}

main();

// Doc-sync validation guardrail for Archon's in-app help system.
//
// Why: the contextual-help registry (HELP_CONTENT), the in-app manual sections,
// and the data-help attributes scattered across ~41 client components must stay
// in lockstep. Nothing at compile time enforces that a data-help="foo" key has a
// matching HELP_CONTENT entry, or that an entry's manualSection link resolves to
// a real manual section id. Without a checker, the help system silently rots as
// features land. This script makes the per-phase "ship your data-help + manual
// section" obligation (WORKBENCH_EXPANSION_PLAN.md Part J) enforceable instead of
// aspirational. Pure static validation — no LLM, no doc generation (Part J fence).
//
// What it checks:
//   (1a) Every static data-help key used in a component has a HELP_CONTENT entry.
//        A used key with no entry → ERROR.
//   (1b) Every HELP_CONTENT entry is referenced by at least one data-help usage.
//        An unreferenced entry → WARNING (not error). Rationale: direction (1a) is
//        the dangerous direction (a clicked element with no help text). Direction
//        (1b) flags entries authored ahead of their element — the normal state
//        mid-coverage-pass (J2 raises coverage 40%→90% by wiring these). Failing
//        the build on those would make every feature phase that pre-authors help
//        red, which is the opposite of useful. An entry is NOT flagged if it is
//        used statically, falls under a dynamic-key prefix, OR is the parent
//        prefix of a more-specific used key (e.g. chat.seed-pill ← .handoff/.spawn).
//   (2)  Every manualSection referenced from a HELP_CONTENT entry resolves to a
//        real Section id under client/src/help/manualSections/. Dangling → ERROR.
//   (3)  Coverage: fraction of interactive elements carrying a data-help. This is
//        INFORMATIONAL only — it never fails the build (survey put it ~40%).
//
// Usage:
//   npm run docs:check                 report + fail on a real orphan / dangling link
//   npm run docs:check -- --self-test  run the built-in fixture self-test (proves
//                                       the checker fails loudly on broken input)
//
// ---------------------------------------------------------------------------
// Heuristics (documented per Part J's "be pragmatic / prefer warnings over false
// errors" guidance — false positives would make the gate untrustworthy):
//
// data-help usages are collected from these syntactic forms in client/src/**/*.tsx:
//   - data-help="literal"                         → static key
//   - data-help={'literal'} / data-help={`literal`} (no ${})  → static key
//   - data-help={ cond ? 'a' : 'b' : ... }        → every quoted string literal
//                                                     inside the braces is a static
//                                                     key (covers ChatMessage's
//                                                     user/system/agent conditional
//                                                     and the cluster role toggle).
//   - data-help={`...${x}...`} (has ${})           → DYNAMIC: recorded as a prefix
//                                                     (text before the first ${}),
//                                                     NOT hard-checked against
//                                                     HELP_CONTENT, reported separately.
//   - data-help={identifier} (e.g. {helpKey}, {help}, {dataHelp}) → forwarded prop;
//                                                     the identifier itself is not a
//                                                     key. The real keys arrive via
//                                                     the aliased-prop forms below.
//
// Aliased props — components that forward a help key through a prop instead of
// putting data-help directly on the JSX (Field's helpKey=, FilesTab's help:,
// CheckpointActions' dataHelp=). Literal string values of these are treated as
// static data-help usages:
//   - helpKey="literal"  /  helpKey={'literal'}
//   - dataHelp="literal" /  dataHelp={'literal'}
//   - help: 'literal'   (object-literal property, value shaped like a help key)
// The `help:` object form is matched only when the value matches the help-key
// shape (a dotted/hyphenated lowercase token) to avoid sweeping up unrelated
// `help:` properties. New forwarder prop names would need adding here — documented
// so future drift is a known, greppable edge.
//
// Dynamic-key coverage for direction (1b): a HELP_CONTENT entry is considered
// referenced if its key (a) appears as a static usage, OR (b) starts with the
// static prefix of any dynamic usage (e.g. dynamic `rightpanel.tab.${t.id}` has
// prefix `rightpanel.tab.` which covers `rightpanel.tab.files` etc.). This avoids
// false "unreferenced" errors for entries that are only ever reached via a
// computed key.
//
// Interactive-element heuristic for coverage (3): per-file count of JSX opening
// tags `<button`, `<input`, `<select`, `<textarea`, plus any opening tag carrying
// an `onClick=` attribute. An element "has help" if that same tag (or, for the
// aliased-prop components, the tag's line) carries data-help / helpKey / dataHelp.
// This is a deliberately rough proxy — it under-counts forwarded-prop helpers and
// over-counts decorative onClick handlers — hence informational only.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve our own directory in a way that works whether tsx loads this as ESM
// (import.meta.url) or transpiles to CJS (__dirname). size-check.ts gets away
// without this because it never resolves paths relative to itself.
const SCRIPT_DIR =
  typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const CLIENT_SRC = join(REPO_ROOT, 'client', 'src');
const CONTENT_DIR = join(CLIENT_SRC, 'help', 'content');
const MANUAL_DIR = join(CLIENT_SRC, 'help', 'manualSections');

// Shape of a help key: lowercase-ish dotted/hyphenated token. Used to validate
// the `help:` object-property form so we don't sweep up arbitrary `help:` props.
const KEY_SHAPE = /^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)+$/;

interface UsageScan {
  staticKeys: Map<string, string[]>; // key -> files it appears in
  dynamicPrefixes: { prefix: string; file: string; raw: string }[];
}

// ---------------------------------------------------------------------------
// File walking — git-tracked + untracked-not-ignored .tsx under client/src, so a
// freshly-added component is checked before it's committed. Mirrors size-check.ts.
// ---------------------------------------------------------------------------
function clientTsxFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'client/src'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set(out.split('\n').filter((p) => p.endsWith('.tsx')))]
    .map((p) => join(REPO_ROOT, p))
    .filter((p) => existsSync(p));
}

function contentFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'client/src/help/content'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out.split('\n').filter((p) => p.endsWith('.tsx')).map((p) => join(REPO_ROOT, p)).filter(existsSync);
}

function manualFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'client/src/help/manualSections'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out.split('\n').filter((p) => p.endsWith('.tsx')).map((p) => join(REPO_ROOT, p)).filter(existsSync);
}

// ---------------------------------------------------------------------------
// Extractors. All regex-based (the repo's house style for scripts/*.ts).
// ---------------------------------------------------------------------------

// Pull every quoted string literal out of a fragment (single, double, backtick).
function literalsIn(fragment: string): { value: string; dynamic: boolean }[] {
  const out: { value: string; dynamic: boolean }[] = [];
  const re = /(["'`])((?:\\.|(?!\1).)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) {
    const quote = m[1];
    const value = m[2];
    const dynamic = quote === '`' && value.includes('${');
    out.push({ value, dynamic });
  }
  return out;
}

// Scan one source file for data-help / helpKey / dataHelp / help: usages.
function scanUsages(src: string, file: string, acc: UsageScan): void {
  const addStatic = (key: string) => {
    const arr = acc.staticKeys.get(key) ?? [];
    if (!arr.includes(file)) arr.push(file);
    acc.staticKeys.set(key, arr);
  };

  // data-help="..."  and  data-help={ ... }. The brace form may span lines and
  // contain nested braces (`style={{…}}`, `${…}` interpolation, the conditional
  // chain in ChatMessage), so we balance-match the braces by hand rather than
  // with a (brittle) regex.
  const anchorRe = /data-help\s*=\s*/g;
  let a: RegExpExecArray | null;
  while ((a = anchorRe.exec(src))) {
    let i = a.index + a[0].length;
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      // data-help="literal"
      const close = src.indexOf(ch, i + 1);
      if (close > i) addStatic(src.slice(i + 1, close));
      continue;
    }
    if (ch !== '{') continue;
    // Balance-match the brace expression starting at i.
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const expr = src.slice(i + 1, j).trim();
    if (!expr) continue;
    // Collect string literals inside the expression. A bare identifier
    // (data-help={helpKey}) yields no literals here — the real keys come from
    // the aliased-prop forms below. A template literal that contains ${ is a
    // dynamic usage (recorded as a prefix); plain literals are static keys.
    for (const lit of literalsIn(expr)) {
      if (lit.dynamic) {
        acc.dynamicPrefixes.push({ prefix: lit.value.split('${')[0], file, raw: lit.value });
      } else {
        addStatic(lit.value);
      }
    }
  }
  let m: RegExpExecArray | null;

  // Aliased-prop forwarders: helpKey= / dataHelp= with a literal value.
  const aliasRe = /(?:helpKey|dataHelp)\s*=\s*(?:(["'])((?:\\.|(?!\1).)*)\1|\{\s*(["'`])((?:\\.|(?!\3).)*)\3\s*\})/g;
  while ((m = aliasRe.exec(src))) {
    const value = m[2] ?? m[4];
    if (value === undefined) continue;
    if (m[3] === '`' && value.includes('${')) {
      acc.dynamicPrefixes.push({ prefix: value.split('${')[0], file, raw: value });
    } else {
      addStatic(value);
    }
  }

  // help: 'literal' / 'data-help': 'literal' / dataHelp: 'literal' object-property
  // forms (FilesTab tab descriptors; spread-into-JSX `{ 'data-help': key }`;
  // HeaderDropdown's `HeaderMenuItem[]` descriptors that forward `data-help={item.dataHelp}`).
  // Guarded by KEY_SHAPE so unrelated `help:` props don't get swept in.
  const propRe = /(?:\bhelp|\bdataHelp|['"]data-help['"])\s*:\s*(["'])((?:\\.|(?!\1).)*)\1/g;
  while ((m = propRe.exec(src))) {
    const value = m[2];
    if (KEY_SHAPE.test(value)) addStatic(value);
  }

  // const/let helpKey = <conditional chain of literals> — the codebase's
  // established local-variable indirection (e.g. ClusterRightPanel computes a
  // helpKey then spreads `{ 'data-help': helpKey }`). Collect the literals out of
  // the assignment's right-hand side, up to the terminating `;`. Each branch is a
  // real key the operator can land on; an `undefined` branch contributes nothing.
  const assignRe = /\b(?:const|let)\s+helpKey\s*=\s*([\s\S]*?);/g;
  while ((m = assignRe.exec(src))) {
    for (const lit of literalsIn(m[1])) {
      if (lit.dynamic) acc.dynamicPrefixes.push({ prefix: lit.value.split('${')[0], file, raw: lit.value });
      else if (KEY_SHAPE.test(lit.value)) addStatic(lit.value);
    }
  }
}

// HELP_CONTENT registry keys + their manualSection (if any). Keys are top-level
// object properties: a quoted string at the start of a (indented) line followed
// by `: {`. manualSection is `manualSection: 'id'`.
function scanContent(src: string): { keys: string[]; links: { key: string; section: string }[] } {
  const keys: string[] = [];
  const keyRe = /^\s*(["'])((?:\\.|(?!\1).)*)\1\s*:\s*\{/gm;
  let m: RegExpExecArray | null;
  // Track the most-recent key so we can attribute a manualSection to it. The
  // registries declare manualSection a few lines after the key opens; pairing by
  // textual order is good enough (and we also report the section regardless).
  const links: { key: string; section: string }[] = [];
  // Walk the file once, recording key positions, then attach each manualSection
  // to the nearest preceding key.
  const keyPositions: { key: string; index: number }[] = [];
  while ((m = keyRe.exec(src))) {
    keys.push(m[2]);
    keyPositions.push({ key: m[2], index: m.index });
  }
  const secRe = /manualSection\s*:\s*(["'])((?:\\.|(?!\1).)*)\1/g;
  while ((m = secRe.exec(src))) {
    const at = m.index;
    let owner = '';
    for (const kp of keyPositions) {
      if (kp.index <= at) owner = kp.key;
      else break;
    }
    links.push({ key: owner, section: m[2] });
  }
  return { keys, links };
}

// Manual Section ids: `id: 'foo'` inside the section object literals.
function scanSectionIds(src: string): string[] {
  const ids: string[] = [];
  const re = /\bid\s*:\s*(["'])((?:\\.|(?!\1).)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) ids.push(m[2]);
  return ids;
}

// Coverage: count interactive opening tags and how many carry a help attribute.
// "Carries help" = the tag itself has data-help/helpKey/dataHelp, OR a help
// attribute appears in the ~200 chars immediately before the tag — the common
// `<span data-help="…"><button …>` wrapper idiom (the capture-phase click handler
// resolves help off the nearest [data-help] ancestor, so a wrapper counts). Still
// a rough proxy: forwarded-prop helpers (Field's helpKey) are under-counted and
// decorative onClick handlers over-counted. Informational only.
function scanCoverage(src: string): { interactive: number; withHelp: number } {
  const tagRe = /<(button|input|select|textarea)\b[^>]*?>|<[A-Za-z][^>]*?\bonClick\s*=[^>]*?>/g;
  let interactive = 0;
  let withHelp = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src))) {
    interactive++;
    const tag = m[0];
    const window = src.slice(Math.max(0, m.index - 200), m.index);
    if (/data-help|helpKey|dataHelp/.test(tag) || /data-help|helpKey|dataHelp/.test(window)) withHelp++;
  }
  return { interactive, withHelp };
}

// ---------------------------------------------------------------------------
// Core check (operates on supplied file lists so the self-test can inject fixtures)
// ---------------------------------------------------------------------------
interface Inputs {
  componentFiles: string[];
  contentFiles: string[];
  manualFiles: string[];
}

interface Result {
  errors: string[];
  warnings: string[];
  coverage: { interactive: number; withHelp: number };
  dynamicCount: number;
  entryCount: number;
  usedStaticCount: number;
}

function check(inputs: Inputs): Result {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Collect usages from component files.
  const usage: UsageScan = { staticKeys: new Map(), dynamicPrefixes: [] };
  const coverage = { interactive: 0, withHelp: 0 };
  for (const f of inputs.componentFiles) {
    const src = readFileSync(f, 'utf8');
    scanUsages(src, f, usage);
    const c = scanCoverage(src);
    coverage.interactive += c.interactive;
    coverage.withHelp += c.withHelp;
  }

  // 2. Collect HELP_CONTENT entries + manualSection links.
  const entryKeys = new Set<string>();
  const links: { key: string; section: string }[] = [];
  for (const f of inputs.contentFiles) {
    const { keys, links: l } = scanContent(readFileSync(f, 'utf8'));
    for (const k of keys) entryKeys.add(k);
    links.push(...l);
  }

  // 3. Collect manual section ids.
  const sectionIds = new Set<string>();
  for (const f of inputs.manualFiles) {
    for (const id of scanSectionIds(readFileSync(f, 'utf8'))) sectionIds.add(id);
  }

  // (1a) used static key with no entry.
  for (const [key, files] of usage.staticKeys) {
    if (!entryKeys.has(key)) {
      const where = files.map((f) => f.replace(REPO_ROOT + '/', '')).join(', ');
      errors.push(`data-help key "${key}" has no HELP_CONTENT entry (used in: ${where})`);
    }
  }

  // (1b) entry referenced by no usage → WARNING. Covered (silently) if a static
  // usage matches, the key falls under a dynamic prefix, OR the key is the parent
  // prefix of a used key (a more-specific child key landing on a nested element).
  const dynPrefixes = usage.dynamicPrefixes.map((d) => d.prefix);
  const usedKeys = [...usage.staticKeys.keys()];
  for (const key of entryKeys) {
    if (usage.staticKeys.has(key)) continue;
    if (dynPrefixes.some((p) => p.length > 0 && key.startsWith(p))) continue;
    if (usedKeys.some((u) => u.startsWith(key + '.'))) continue;
    warnings.push(`HELP_CONTENT entry "${key}" is never referenced by any data-help usage (pre-authored or stale — wire the element or remove the entry)`);
  }

  // (2) dangling manualSection.
  for (const { key, section } of links) {
    if (!sectionIds.has(section)) {
      errors.push(`HELP_CONTENT entry "${key}" links to manualSection "${section}" which does not exist`);
    }
  }

  return {
    errors,
    warnings,
    coverage,
    dynamicCount: usage.dynamicPrefixes.length,
    entryCount: entryKeys.size,
    usedStaticCount: usage.staticKeys.size,
  };
}

function report(r: Result): void {
  console.log(`docs:check — ${r.entryCount} HELP_CONTENT entries, ${r.usedStaticCount} static data-help keys, ${r.dynamicCount} dynamic usage(s)\n`);

  const pct = r.coverage.interactive === 0 ? 0 : Math.round((r.coverage.withHelp / r.coverage.interactive) * 100);
  console.log(
    `Coverage (informational): ${r.coverage.withHelp}/${r.coverage.interactive} interactive elements carry data-help — ${pct}%`,
  );
  console.log('  (heuristic: <button/<input/<select/<textarea + any onClick= tag; forwarded-prop helpers under-counted)\n');

  for (const w of r.warnings) console.log(`⚠  ${w}`);
  if (r.warnings.length) console.log('');

  if (r.errors.length) {
    console.error(`✗  ${r.errors.length} doc-sync error(s):`);
    for (const e of r.errors) console.error(`     ${e}`);
    console.error('\nFix the drift (add the missing entry / correct the key / point manualSection at a real id).');
    console.error('See CONTRIBUTING.md "Doc-sync" and docs/CLIENT.md § help system.');
    return;
  }
  console.log('✓  Help registry, data-help usages, and manualSection links are all in sync.');
}

// ---------------------------------------------------------------------------
// Self-test: inject a broken data-help key + a dangling manualSection into a temp
// fixture set and assert the checker reports both, then assert the clean tree is
// green. Proves the gate fails loudly without touching real files.
// ---------------------------------------------------------------------------
function selfTest(): void {
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'docs-check-selftest-'));
  const comp = join(dir, 'Broken.tsx');
  const content = join(dir, 'content.tsx');
  const manual = join(dir, 'manual.tsx');
  // A component using a key that has no entry + a key that does.
  writeFileSync(comp, `<button data-help="fixture.missing">x</button>\n<button data-help="fixture.present">y</button>`);
  // An entry that is referenced but links to a dangling section, plus an
  // unreferenced entry.
  writeFileSync(
    content,
    `export const x = {\n  'fixture.present': { title: 'p', body: null, manualSection: 'no-such-section' },\n  'fixture.orphan': { title: 'o', body: null },\n};`,
  );
  writeFileSync(manual, `export const s = [{ id: 'real-section', title: 't', group: 'g', body: null }];`);

  const r = check({ componentFiles: [comp], contentFiles: [content], manualFiles: [manual] });
  rmSync(dir, { recursive: true, force: true });

  const expect = [
    // (1a) and (2) are hard errors.
    ['missing-entry ERROR', r.errors.some((e) => e.includes('fixture.missing') && e.includes('no HELP_CONTENT entry'))],
    ['dangling-section ERROR', r.errors.some((e) => e.includes('no-such-section'))],
    // (1b) is a warning, not an error — assert it surfaces as a warning AND does
    // not leak into errors (so it can't fail the build).
    ['unreferenced-entry WARNING', r.warnings.some((w) => w.includes('fixture.orphan') && w.includes('never referenced'))],
    ['unreferenced-entry is NOT an error', !r.errors.some((e) => e.includes('fixture.orphan'))],
  ] as const;

  console.log('docs:check --self-test\n');
  let ok = true;
  for (const [name, pass] of expect) {
    console.log(`  ${pass ? '✓' : '✗'} reports ${name}`);
    if (!pass) ok = false;
  }
  // The present key with an entry should NOT error for missing-entry.
  const falsePositive = r.errors.some((e) => e.includes('fixture.present') && e.includes('no HELP_CONTENT entry'));
  console.log(`  ${!falsePositive ? '✓' : '✗'} no false positive for a key that has an entry`);
  if (falsePositive) ok = false;

  console.log('');
  if (ok) {
    console.log('✓  self-test passed (checker fails loudly on broken input).');
    process.exit(0);
  }
  console.error('✗  self-test FAILED — the checker did not flag the injected breakage.');
  process.exit(1);
}

function main(): void {
  if (process.argv.slice(2).includes('--self-test')) {
    selfTest();
    return;
  }
  const r = check({
    componentFiles: clientTsxFiles(),
    contentFiles: contentFiles(),
    manualFiles: manualFiles(),
  });
  report(r);
  process.exit(r.errors.length ? 1 : 0);
}

main();

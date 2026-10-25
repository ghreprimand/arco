// Genesis M2 — scaffold writer + seed-doc safety smoke.
//
// PURE — NO WebSocket, NO server boot, NO live model. Exercises the hardened
// scaffold writer's rejection paths (Appendix D) against a real temp dir, plus a
// happy-path write and the deterministic seed-doc generation. Mirrors the M2
// acceptance clause: "the writer rejects a malicious path."
//
// Run: npm run smoke:genesis-scaffold  (no dev server needed)

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SCAFFOLD_FILE_CAP,
  assertSafeScaffoldPath,
  buildSeedDocs,
  slugify,
  uniqueProjectDir,
  writeScaffold,
} from '../../server/src/genesis/scaffold.js';
import { ALTERNATIVE_DIR, assessCodebase, gatherProjectContext } from '../../server/src/genesis/creative.js';
import { emptyGenesisSeed } from '@archon/shared';
import type { GenesisSeed } from '@archon/shared';

let passes = 0;
let fails = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  PASS  ${label}`); passes++; }
  else { const m = `${label}${detail ? `: ${detail}` : ''}`; console.log(`  FAIL  ${m}`); failures.push(m); fails++; }
}

async function rejects(label: string, fn: () => Promise<unknown> | unknown, mustMatch?: RegExp): Promise<void> {
  try {
    await fn();
    check(label, false, 'expected a throw but none occurred');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(label, mustMatch ? mustMatch.test(msg) : true, mustMatch ? `message was "${msg}"` : '');
  }
}

const SEED: GenesisSeed = {
  title: 'Port Watch!',
  spark: 'A terminal dashboard that watches my local dev servers and shows which ports are live.',
  concept: 'A live grid of detected dev servers with one-click open.',
  theCase: 'I lose track of which servers I left running; this surfaces them at a glance.',
  buildDirection: 'Node + a tiny TUI; reuse lsof scanning; first step is the port scanner.',
};

async function main(): Promise<void> {
  // ── assertSafeScaffoldPath: string-level rejections ──
  await rejects('reject empty path', () => assertSafeScaffoldPath(''), /non-empty/);
  await rejects('reject non-string path', () => assertSafeScaffoldPath(42 as unknown as string), /non-empty/);
  await rejects('reject absolute path', () => assertSafeScaffoldPath('/etc/passwd'), /relative/);
  await rejects('reject home-rooted path', () => assertSafeScaffoldPath('~/secrets'), /relative/);
  await rejects('reject parent traversal', () => assertSafeScaffoldPath('../escape.md'), /traverse/);
  await rejects('reject mid-path traversal', () => assertSafeScaffoldPath('a/../../b.md'), /traverse/);
  await rejects('reject backslash path', () => assertSafeScaffoldPath('a\\b.md'), /backslash/);
  await rejects('reject NUL byte path', () => assertSafeScaffoldPath('a\0b.md'), /NUL/);
  await rejects('reject dotfile component', () => assertSafeScaffoldPath('.ssh/key'), /hidden|dotfile/);
  await rejects('reject nested dotfile', () => assertSafeScaffoldPath('docs/.hidden'), /hidden|dotfile/);
  await rejects('reject nested gitignore', () => assertSafeScaffoldPath('docs/.gitignore'), /hidden|dotfile/);
  check('accept a normal nested path', assertSafeScaffoldPath('docs/guide.md') === 'docs/guide.md');
  check('accept root .gitignore', assertSafeScaffoldPath('.gitignore') === '.gitignore');
  check('normalize redundant slashes', assertSafeScaffoldPath('a//b.md') === 'a/b.md');

  // ── slugify / uniqueProjectDir ──
  check('slugify lowercases + dashes', slugify('Port Watch!') === 'port-watch');
  check('slugify empty → fallback', slugify('') === 'untitled-project');

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-genesis-'));
  try {
    const dir1 = await uniqueProjectDir(tmpRoot, 'Port Watch!');
    check('uniqueProjectDir slugified name', path.basename(dir1) === 'port-watch', path.basename(dir1));
    await fs.mkdir(dir1);
    const dir2 = await uniqueProjectDir(tmpRoot, 'Port Watch!');
    check('uniqueProjectDir avoids collision', path.basename(dir2) === 'port-watch-2', path.basename(dir2));

    // ── seed docs ──
    const docs = buildSeedDocs(SEED);
    check('seed docs are the 7 expected files',
      docs.map((d) => d.path).join(',') === '.gitignore,README.md,SPEC.md,TODO.md,AGENTS.md,CLAUDE.md,GEMINI.md',
      docs.map((d) => d.path).join(','));
    check('.gitignore ignores Arco metadata', docs[0].content.includes('.archon/'));
    check('.gitignore ignores local agent notes', docs[0].content.includes('AGENTS.md') && docs[0].content.includes('CLAUDE.md') && docs[0].content.includes('GEMINI.md'));
    check('README carries the concept', docs[1].content.includes(SEED.concept));
    check('SPEC carries the spark', docs[2].content.includes(SEED.spark));
    check('AGENTS.md carries the case', docs[4].content.includes(SEED.theCase));
    const publicDocs = buildSeedDocs({ ...SEED, github: { create: true, visibility: 'public' } });
    check('public GitHub seed adds public safety directive', publicDocs.some((d) => d.path === 'AGENTS.md' && /Public Repository Safety/.test(d.content)));
    const emptyDocs = buildSeedDocs(emptyGenesisSeed());
    check('empty seed still yields 7 docs', emptyDocs.length === 7);
    check('empty seed README has placeholder', /not captured yet/i.test(emptyDocs[1].content));

    // ── happy-path write ──
    const target = await uniqueProjectDir(tmpRoot, 'write-test');
    await fs.mkdir(target);
    const res = await writeScaffold(target, docs);
    check('writeScaffold wrote 7 files', res.written.length === 7, String(res.written.length));
    const readme = await fs.readFile(path.join(target, 'README.md'), 'utf8');
    check('written README matches', readme.includes(SEED.concept));

    // ── no-overwrite ──
    await rejects('refuse to overwrite existing file',
      () => writeScaffold(target, [{ path: 'README.md', content: 'x' }]), /already exists/);

    // ── duplicate path within one run ──
    const dupTarget = await uniqueProjectDir(tmpRoot, 'dup-test');
    await fs.mkdir(dupTarget);
    await rejects('reject duplicate path in one run',
      () => writeScaffold(dupTarget, [{ path: 'a.md', content: '1' }, { path: 'a.md', content: '2' }]), /duplicate/);

    // ── file-count cap ──
    const capTarget = await uniqueProjectDir(tmpRoot, 'cap-test');
    await fs.mkdir(capTarget);
    const tooMany = Array.from({ length: SCAFFOLD_FILE_CAP + 1 }, (_, i) => ({ path: `f${i}.md`, content: 'x' }));
    await rejects('reject over the file-count cap', () => writeScaffold(capTarget, tooMany), /cap/);

    // ── symlinked ancestor ──
    const symTarget = await uniqueProjectDir(tmpRoot, 'sym-test');
    await fs.mkdir(symTarget);
    const outside = path.join(tmpRoot, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(symTarget, 'link'));
    await rejects('reject write through a symlinked ancestor',
      () => writeScaffold(symTarget, [{ path: 'link/evil.md', content: 'x' }]), /symlink/);
    // The escaped target stays empty.
    const leaked = await fs.readdir(outside);
    check('symlinked-ancestor write did not leak a file', leaked.length === 0, leaked.join(','));

    // ── non-directory target ──
    const filePath = path.join(tmpRoot, 'a-file');
    await fs.writeFile(filePath, 'x');
    await rejects('reject a non-directory target',
      () => writeScaffold(filePath, [{ path: 'a.md', content: 'x' }]), /not a real directory/);

    // ── M3 Creative mode: codebase assessment ──
    // A sparse project (a couple of files, no git) is NOT established → no warning.
    const sparse = await uniqueProjectDir(tmpRoot, 'sparse-proj');
    await fs.mkdir(sparse);
    await fs.writeFile(path.join(sparse, 'index.js'), 'console.log(1)');
    const sparseInfo = await assessCodebase(sparse);
    check('sparse codebase is not established', sparseInfo.established === false, JSON.stringify(sparseInfo));
    check('sparse codebase has no warning', !sparseInfo.warning);

    // A large project (over the file threshold) IS established → warning fires and
    // names the ALTERNATIVE/ guardrail.
    const big = await uniqueProjectDir(tmpRoot, 'big-proj');
    await fs.mkdir(big);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => fs.writeFile(path.join(big, `mod-${i}.ts`), `export const x${i} = ${i};`)),
    );
    const bigInfo = await assessCodebase(big);
    check('large codebase is established', bigInfo.established === true, JSON.stringify({ ...bigInfo, warning: undefined }));
    check('large codebase fileCount is at least 50', bigInfo.fileCount >= 50, String(bigInfo.fileCount));
    check('large-codebase warning mentions ALTERNATIVE', !!bigInfo.warning && bigInfo.warning.includes(ALTERNATIVE_DIR), bigInfo.warning ?? '(none)');
    // The walk skips heavy/generated dirs — a node_modules tree must not inflate the count.
    await fs.mkdir(path.join(sparse, 'node_modules'));
    await fs.writeFile(path.join(sparse, 'node_modules', 'junk.js'), 'x'.repeat(10));
    const sparseAfterNm = await assessCodebase(sparse);
    check('walk skips node_modules', sparseAfterNm.established === false, JSON.stringify(sparseAfterNm));

    // ── M3 Creative mode: project-context snapshot ──
    const ctxProj = await uniqueProjectDir(tmpRoot, 'ctx-proj');
    await fs.mkdir(ctxProj);
    await fs.writeFile(path.join(ctxProj, 'package.json'), JSON.stringify({ name: 'widgetron', description: 'A widget factory.' }));
    await fs.writeFile(path.join(ctxProj, 'README.md'), '# Widgetron\n\nMakes widgets fast.\n');
    await fs.writeFile(path.join(ctxProj, 'tsconfig.json'), '{}');
    const ctx = await gatherProjectContext(ctxProj);
    check('context suggestedTitle from package.json name', ctx.suggestedTitle === 'widgetron', ctx.suggestedTitle);
    check('context block flags Creative mode + existing project', /Existing project \(Creative mode\)/.test(ctx.block));
    check('context block carries the package description', ctx.block.includes('A widget factory.'));
    check('context block carries the README summary', ctx.block.includes('Makes widgets fast.'));
    check('context block detects the TypeScript stack marker', /TypeScript/.test(ctx.block));

    // ── M3 Creative mode: sibling ALTERNATIVE/ scaffold leaves the project untouched ──
    const existing = await uniqueProjectDir(tmpRoot, 'live-proj');
    await fs.mkdir(existing);
    await fs.writeFile(path.join(existing, 'src.ts'), 'export const real = true;');
    const altRoot = path.join(existing, ALTERNATIVE_DIR);
    const altDir = await uniqueProjectDir(altRoot, 'A New Take');
    await fs.mkdir(altDir, { recursive: true });
    const altRes = await writeScaffold(altDir, buildSeedDocs({ ...SEED, title: 'A New Take', creative: true }));
    check('creative scaffold wrote 7 docs', altRes.written.length === 7, String(altRes.written.length));
    check('alternative dir is under ALTERNATIVE/', path.relative(existing, altDir).split(path.sep)[0] === ALTERNATIVE_DIR, path.relative(existing, altDir));
    const existingStill = await fs.readFile(path.join(existing, 'src.ts'), 'utf8');
    check('creative scaffold left the existing file untouched', existingStill === 'export const real = true;');
    const existingTop = await fs.readdir(existing);
    check('creative scaffold added only the ALTERNATIVE dir', existingTop.sort().join(',') === [ALTERNATIVE_DIR, 'src.ts'].sort().join(','), existingTop.join(','));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }

  console.log(`\n${fails === 0 ? 'OK' : 'FAIL'} — ${passes} passed, ${fails} failed`);
  if (fails > 0) {
    console.log('Failures:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

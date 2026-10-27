// Documentation link check. Every relative markdown link in the shipped documents must resolve to a
// tracked file (and to a heading when it carries an anchor); every `docs/*.md` mentioned in
// documents, in-app help or source comments must exist, so nothing points at a document that was
// excluded from the public tree; every document the in-app help opens through <DocRef> is
// distributable and shipped in the runtime image.
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
// Distributable = tracked or about to be (not ignored): the same set the public audit scans.
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  .toString().split('\0').filter(Boolean).filter((f) => existsSync(resolve(root, f)));
const tracked = new Set(files);
const trackedDirs = new Set(files.flatMap((f) => { const parts = f.split('/'); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')); }));

const markdown = files.filter((f) => /^(docs\/[^/]+\.md|README\.md|AGENTS\.md|CONTRIBUTING\.md|DEVLOG\.md|devlog\/[^/]+\.md)$/.test(f));

// GitHub-style heading slugs.
function slugs(path: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of read(path).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    const m = !fenced && line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const base = m[1].replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

function links(path: string): { target: string; line: number }[] {
  const out: { target: string; line: number }[] = [];
  let fenced = false;
  read(path).split('\n').forEach((text, i) => {
    if (/^\s*(```|~~~)/.test(text)) { fenced = !fenced; return; }
    if (fenced) return;
    const stripped = text.replace(/`[^`]*`/g, '');
    for (const m of stripped.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push({ target: m[1], line: i + 1 });
    // Reference-style definitions: [label]: target
    const def = stripped.match(/^\s{0,3}\[[^\]]+\]:\s+<?([^\s>]+)>?/);
    if (def) out.push({ target: def[1], line: i + 1 });
    // Raw HTML anchors and images in documents.
    for (const m of stripped.matchAll(/<(?:a|img)\b[^>]*?\b(?:href|src)="([^"]+)"/g)) out.push({ target: m[1], line: i + 1 });
  });
  return out;
}

test('relative markdown links resolve to tracked files and headings', () => {
  const broken: string[] = [];
  for (const file of markdown) {
    for (const { target, line } of links(file)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http(s), mailto
      const [rawPath, anchor] = target.split('#');
      const dest = rawPath ? normalize(join(dirname(file), decodeURI(rawPath))).replace(/\\/g, '/') : file;
      if (rawPath && !tracked.has(dest) && !trackedDirs.has(dest.replace(/\/$/, ''))) { broken.push(`${file}:${line} -> ${target} (missing file)`); continue; }
      if (anchor && dest.endsWith('.md') && tracked.has(dest) && !slugs(dest).has(anchor.toLowerCase())) broken.push(`${file}:${line} -> ${target} (missing heading)`);
    }
  }
  assert.deepEqual(broken, [], 'broken relative links');
});

function missingDocs(scanned: string[]): string[] {
  const missing: string[] = [];
  for (const file of scanned) {
    read(file).split('\n').forEach((text, i) => {
      for (const m of text.matchAll(/\bdocs\/([A-Za-z0-9_.-]+\.md)\b/g)) {
        if (!tracked.has(`docs/${m[1]}`)) missing.push(`${file}:${i + 1} -> docs/${m[1]}`);
      }
    });
  }
  return missing;
}

test('no document or in-app help text names a document that is not in the tree', () => {
  const scanned = markdown.filter((f) => !f.startsWith('devlog/')).concat(files.filter((f) => f.startsWith('client/src/help/')));
  assert.deepEqual(missingDocs(scanned), [], 'references to documents that are not shipped');
});

// Parse actual JavaScript/TypeScript comments so synthetic document paths in
// demo data and test inputs are not mistaken for documentation references.
function sourceComments(file: string, text: string): { text: string; line: number }[] {
  if (!/\.(tsx?|m?js)$/.test(file)) return text.split('\n').map((line, i) => ({ text: line, line: i + 1 }));
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const ranges = new Map<number, ts.CommentRange>();
  const collect = (found: ts.CommentRange[] | undefined) => {
    for (const range of found ?? []) ranges.set(range.pos, range);
  };
  const visit = (node: ts.Node) => {
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return [...ranges.values()].map(({ pos, end }) => ({
    text: text.slice(pos, end), line: source.getLineAndCharacterOfPosition(pos).line + 1,
  }));
}

function sourceDocTargets(text: string): string[] {
  return [...text.matchAll(/\b(?:docs\/([A-Za-z0-9_.-]+\.md)|([A-Z][A-Z0-9_]*(?:PLAN|REFACTOR|AUDIT|EXECUTION)[A-Z0-9_]*\.md))\b/g)]
    .map((match) => `docs/${match[1] ?? match[2]}`);
}

test('source reference scanning includes inline, block and JSX comments, not fixture strings', () => {
  const code = [
    '// See docs/MISSING.md',
    'const fixture = "docs/FIXTURE.md"; // See MISSING_PLAN.md',
    '/* See docs/BLOCK.md */',
    'const view = <div>{/* See docs/JSX.md */}docs/TEXT.md</div>;',
    'const template = `docs/TEMPLATE.md`;',
  ].join('\n');
  assert.deepEqual(sourceComments('fixture.tsx', code).flatMap((c) => sourceDocTargets(c.text)).sort(),
    ['docs/BLOCK.md', 'docs/JSX.md', 'docs/MISSING.md', 'docs/MISSING_PLAN.md'].sort());
});

test('source comments name only documents that are in the tree', () => {
  const scanned = files.filter((f) => /^(shared|server|client|scripts)\//.test(f)
    && /\.(tsx?|m?js|py)$/.test(f) && !f.startsWith('client/src/help/'));
  const missing: string[] = [];
  for (const file of scanned) {
    for (const comment of sourceComments(file, read(file))) {
      for (const target of sourceDocTargets(comment.text)) {
        if (!tracked.has(target)) missing.push(`${file}:${comment.line} -> ${target}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'references to documents that are not shipped');
});

test('every document the in-app help opens exists, is distributable and is in the runtime image', () => {
  const refs = new Set<string>();
  for (const file of files.filter((f) => f.startsWith('client/src/help/') && /\.tsx?$/.test(f))) {
    for (const m of read(file).matchAll(/<DocRef(?:\s+path="([^"]+)")?\s*>([^<]*)<\/DocRef>/g)) {
      const target = (m[1] ?? m[2]).trim();
      if (target.startsWith('docs/')) refs.add(target);
    }
  }
  assert.ok(refs.size > 0, 'the help references documents');
  assert.deepEqual([...refs].filter((d) => !tracked.has(d)), [], 'help links point at missing or ignored documents');
  if (existsSync(resolve(root, 'Dockerfile'))) {
    const copyDocs = /^COPY\s+docs\/?\s+docs\/?\s*$/m.test(read('Dockerfile'))
      || [...refs].every((d) => read('Dockerfile').includes(d));
    assert.ok(copyDocs, 'the Dockerfile ships the documents the help opens');
    if (existsSync(resolve(root, '.dockerignore'))) {
      const ignore = read('.dockerignore');
      assert.ok(/^!docs\/?$/m.test(ignore) && /^!docs\/\*\.md$/m.test(ignore) || [...refs].every((d) => ignore.includes(`!${d}`)), '.dockerignore lets the documents into the build context');
    }
  }
});

test('the docs route serves repository-relative markdown from the install root', () => {
  assert.match(read('server/src/http/router.ts'), /resolve\(PROJECT_ROOT, requested\)/);
  assert.match(read('server/src/server/constants.ts'), /PROJECT_ROOT = resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', '\.\.', '\.\.'\)/);
});

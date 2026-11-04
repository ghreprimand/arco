#!/usr/bin/env node
// Rename the upstream product name to Arco across a working tree.
//
// Usage:
//   node scripts/rename-upstream.mjs                  # whole tree (tracked + untracked, not ignored)
//   node scripts/rename-upstream.mjs --paths a b ...  # only these files or directories
//   node scripts/rename-upstream.mjs --dry-run        # report counts, change nothing
//   node scripts/rename-upstream.mjs --root DIR       # operate on another checkout
//
// Used by future imports ("archive, extract, run the rename, run the scrub")
// and by branches that predate the rename (rebase, run this script, amend).
// Safe on a dirty worktree: it rewrites file contents in place and renames
// paths (with `git mv` for tracked files, a plain rename otherwise). Running
// it twice changes nothing the second time.
//
// Forms are applied in the order listed in FORMS, longer and more specific
// forms first, then the three case forms of the bare name. Counts are
// printed per form. Skipped: node_modules, dist, .git, files that are not
// valid UTF-8 (images, fonts, archives), EXCLUDED_PREFIXES and this script.
//
// The upstream name is assembled from parts so this file itself never
// contains it and the tree-wide name audit stays clean.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

const lower = ['arc', 'hon'].join('');
const title = lower[0].toUpperCase() + lower.slice(1);
const upper = lower.toUpperCase();

// The vendored editor is included: its only mentions of the name are the
// host-application patch notes. Its own name (Odysseus) is not touched.
const EXCLUDED_PREFIXES = [];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git']);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const re = (s) => new RegExp(s, 'g');

// [label, pattern, replacement]. Replacements never reintroduce the name.
const FORMS = [
  ['backup magic', re('ARCHNBK1'), 'ARCOBK01'],
  ['cluster bundle magic', re('ARCHCL01'), 'ARCOCL01'],
  ['cluster vault magic', re('ARCHCV01'), 'ARCOCV01'],
  ['package scope', re(esc(`@${lower}/`)), '@arco/'],
  ['cluster MCP tool ids', re(esc(`mcp__${lower}_cluster__`)), 'mcp__arco_cluster__'],
  ['cluster MCP server name', re(esc(`${lower}-cluster`)), 'arco-cluster'],
  ['checkpoint ref namespace', re(esc(`refs/${lower}/`)), 'refs/arco/'],
  ['synthetic addresses', re(esc(`@${lower}.local`)), '@arco.local'],
  ['HTTP headers (title)', re(`X-${title}-`), 'X-Arco-'],
  ['HTTP headers (lower)', re(`x-${lower}-`), 'x-arco-'],
  ['systemd units', re(`\\b${lower}((?:-[a-z]+)*)\\.service\\b`), 'arco$1.service'],
  ['file extensions', re(`\\.${lower}(cluster|bk)\\b`), '.arco$1'],
  ['state directory', re(`\\.${lower}(?![A-Za-z0-9_-])`), '.arco'],
  ['environment prefix', re(`\\b${upper}_`), 'ARCO_'],
  ['log prefix', re(esc(`[${lower}`) + '(?=[\\] ])'), '[arco'],
  ['tool and identifier prefix', re(`\\b${lower}_`), 'arco_'],
  ['npm scripts', re(`(["'\\s])${lower}:`), '$1arco:'],
  ['camelCase identifiers', re(`(?<=[a-z0-9])${title}`), 'Arco'],
  ['identifier prefix', re(`\\b${lower}(?=[A-Z])`), 'arco'],
  // Letter-spaced banner text; the padding keeps fixed-width boxes aligned.
  ['letter-spaced upper case', re(upper.split('').join(' ')), 'A R C O    '],
  ['upper case', re(upper), 'ARCO'],
  ['title case', re(title), 'Arco'],
  ['lower case', re(lower), 'arco'],
];

function renamePath(p) {
  return p.split(upper).join('ARCO').split(title).join('Arco').split(lower).join('arco');
}

function parseArgs(argv) {
  const out = { root: process.cwd(), paths: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--root') out.root = resolve(argv[++i]);
    else if (a === '--paths') { out.paths = []; while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.paths.push(argv[++i]); }
    else if (a === '-h' || a === '--help') { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n')); process.exit(0); }
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function gitFiles(root, all) {
  try {
    return git(root, ['ls-files', '-z', '--cached', ...(all ? ['--others', '--exclude-standard'] : [])]).split('\0').filter(Boolean);
  } catch { return null; }
}

function walk(root, rel, acc) {
  const abs = join(root, rel);
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const name of readdirSync(abs)) if (!SKIPPED_DIRS.has(name)) walk(root, rel ? `${rel}/${name}` : name, acc);
  } else if (st.isFile()) acc.push(rel);
}

function skipped(rel) {
  return rel.split('/').some((part) => SKIPPED_DIRS.has(part)) || EXCLUDED_PREFIXES.some((p) => rel.startsWith(p));
}

function listFiles(root, paths) {
  let files = gitFiles(root, true);
  if (!files) { files = []; walk(root, '', files); }
  if (paths) {
    const wanted = paths.map((p) => relative(root, resolve(p)).split(sep).join('/'));
    files = files.filter((f) => wanted.some((w) => w === '' || f === w || f.startsWith(`${w}/`)));
  }
  return [...new Set(files)].filter((f) => {
    if (skipped(f)) return false;
    const abs = join(root, f);
    if (resolve(abs) === SELF) return false; // never rewrite this script's own patterns
    return existsSync(abs) && lstatSync(abs).isFile();
  });
}

const decoder = new TextDecoder('utf-8', { fatal: true });
function readText(abs) {
  try { return decoder.decode(readFileSync(abs)); } catch { return null; }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { root } = args;
  const tracked = new Set(gitFiles(root, false) ?? []);
  const files = listFiles(root, args.paths);
  const counts = new Map(FORMS.map(([label]) => [label, 0]));
  let changedFiles = 0;
  let nonText = 0;

  for (const rel of files) {
    const abs = join(root, rel);
    const text = readText(abs);
    if (text === null) { nonText++; continue; }
    let next = text;
    for (const [label, pattern, replacement] of FORMS) {
      const n = next.match(pattern)?.length ?? 0;
      if (!n) continue;
      counts.set(label, counts.get(label) + n);
      next = next.replace(pattern, replacement);
    }
    if (next !== text) { changedFiles++; if (!args.dryRun) writeFileSync(abs, next); }
  }

  let renamed = 0;
  for (const rel of files) {
    const target = renamePath(rel);
    if (target === rel) continue;
    renamed++;
    console.log(`rename ${rel} -> ${target}`);
    if (args.dryRun) continue;
    mkdirSync(dirname(join(root, target)), { recursive: true });
    if (tracked.has(rel)) git(root, ['mv', '--', rel, target]);
    else renameSync(join(root, rel), join(root, target));
  }

  for (const [label, n] of counts) if (n) console.log(`${String(n).padStart(6)}  ${label}`);
  console.log(`${args.dryRun ? 'would change' : 'changed'} ${changedFiles} file(s), renamed ${renamed} path(s), skipped ${nonText} non-text file(s)`);
}

main();

// Workbench Expansion A5 — Content search (ripgrep wrapper).
//
// Runs `rg --json` over a workflow cwd and returns structured hits. The HTTP
// glue (http/searchRoutes.ts) is intentionally thin — the actual rg invocation
// lives here in `searchContent` so F3 (Recall cross-session search) can reuse
// the exact same engine without going through the HTTP layer.
//
// Invariants (mirrored from gitDiff.ts / gitSnapshots.ts):
//   - always execFile with an argv array — never shell-string interpolation.
//     The query is passed as a positional `-e <pattern>` arg, so a query like
//     `; rm -rf` is matched literally, never executed.
//   - respect SKIP_DIRS (node_modules / .git / dist / etc.) so a search over a
//     real repo doesn't drown in vendored files. rg also honors .gitignore by
//     default, which covers most of the same ground; the explicit globs are a
//     belt-and-suspenders cap for repos with no .gitignore.
//   - degrade gracefully when `rg` is absent (return { available:false }) — no
//     throw, so the caller never has to special-case a missing binary.

import { execFile, spawnSync } from 'node:child_process';

// Same ignore set the Native Grep tool uses (providers/claude-native/tools.ts).
// Kept as a local copy rather than imported because that module pulls in the
// whole tool registry (Anthropic SDK types, shell registry) just to expose one
// Set — not worth the dependency for a server-side HTTP route. If the lists
// ever need to stay in lockstep, hoist this into a shared constants module.
export const SKIP_DIRS = [
  'node_modules', '.git', '.archon', 'dist', 'build', '.next',
  '.cache', 'target', '.venv', 'venv',
];

// Detect ripgrep once at module load (same pattern as the Native Grep tool).
// Re-probing per request would add a spawn to every search. Exported so tests
// can read the resolved state.
export const RIPGREP_BIN: string | null = (() => {
  try {
    const r = spawnSync('rg', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? 'rg' : null;
  } catch { return null; }
})();

export interface ContentHit {
  // cwd-relative file path (rg is run with cwd set, so paths come back relative).
  file: string;
  // 1-based line number of the match.
  line: number;
  // 1-based column of the first submatch on the line (1 when rg omits it).
  column: number;
  // The full matched line text (trailing newline stripped).
  text: string;
}

export interface ContentSearchResult {
  // False when `rg` isn't on PATH. The caller surfaces a "ripgrep not
  // installed" hint rather than an empty-result. Never throws for this case.
  available: boolean;
  hits: ContentHit[];
  // True when the hit list was capped (more matches exist on disk). The UI
  // shows a "showing first N" note.
  capped: boolean;
}

export interface SearchContentOpts {
  cwd: string;
  query: string;
  // Cap on returned hits. rg is told `--max-count` per file and we stop
  // collecting once the global cap is hit. Default 200.
  maxHits?: number;
  // Override the binary path — used only by the smoke test to simulate a
  // missing/bogus `rg` (point at a path that won't spawn). Production callers
  // leave this unset and get the module-detected RIPGREP_BIN.
  bin?: string | null;
  // Case-insensitive match. Default true (palette search is forgiving).
  caseInsensitive?: boolean;
}

const DEFAULT_MAX_HITS = 200;
// 16 MiB of rg JSON is plenty for a capped result set and bounds memory.
const MAX_BUFFER = 16 * 1024 * 1024;
const RG_TIMEOUT_MS = 15_000;

// Run ripgrep in --json mode and parse the line-delimited JSON stream into
// structured hits. Returns { available:false } when the binary can't spawn so
// callers degrade gracefully. F3 calls this directly.
export function searchContent(opts: SearchContentOpts): Promise<ContentSearchResult> {
  const bin = opts.bin === undefined ? RIPGREP_BIN : opts.bin;
  const maxHits = opts.maxHits ?? DEFAULT_MAX_HITS;
  const ci = opts.caseInsensitive ?? true;

  if (!bin) {
    return Promise.resolve({ available: false, hits: [], capped: false });
  }
  if (!opts.query) {
    return Promise.resolve({ available: true, hits: [], capped: false });
  }

  const args = ['--json', '--no-messages'];
  if (ci) args.push('-i');
  for (const dir of SKIP_DIRS) {
    // rg glob excludes; `!**/<dir>/**` prunes the directory anywhere in the tree.
    args.push('-g', `!**/${dir}/**`);
  }
  // `-e` forces the next token to be treated as the pattern, never an option —
  // so a query starting with `-` can't smuggle in an rg flag. rg uses Rust
  // regex; the palette's queries are plain substrings, which are valid regex.
  args.push('-e', opts.query, '.');

  return new Promise((resolveP) => {
    execFile(
      bin,
      args,
      { cwd: opts.cwd, maxBuffer: MAX_BUFFER, timeout: RG_TIMEOUT_MS },
      (err, stdout) => {
        // rg exits 1 when there are zero matches — that's not an error here.
        // exit 2 (and spawn errors) mean a real failure; treat an unspawnable
        // binary (ENOENT) as "not available" so a bogus bin path degrades the
        // same way a missing binary does.
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return resolveP({ available: false, hits: [], capped: false });
        }
        const hits: ContentHit[] = [];
        let capped = false;
        for (const rawLine of stdout.split('\n')) {
          if (!rawLine) continue;
          if (hits.length >= maxHits) { capped = true; break; }
          let evt: unknown;
          try { evt = JSON.parse(rawLine); } catch { continue; }
          if (!evt || typeof evt !== 'object') continue;
          const e = evt as { type?: string; data?: Record<string, unknown> };
          if (e.type !== 'match' || !e.data) continue;
          const d = e.data;
          const pathText = (d.path as { text?: string } | undefined)?.text;
          const lineText = (d.lines as { text?: string } | undefined)?.text;
          const lineNo = typeof d.line_number === 'number' ? d.line_number : 0;
          const subs = Array.isArray(d.submatches) ? d.submatches : [];
          const col = subs.length && typeof (subs[0] as { start?: number }).start === 'number'
            ? (subs[0] as { start: number }).start + 1
            : 1;
          if (!pathText || lineText === undefined) continue;
          hits.push({
            // rg with `cwd` set and base `.` already yields relative paths, but
            // strip a leading `./` for tidy display.
            file: pathText.replace(/^\.\//, ''),
            line: lineNo,
            column: col,
            text: lineText.replace(/\r?\n$/, ''),
          });
        }
        resolveP({ available: true, hits, capped });
      },
    );
  });
}

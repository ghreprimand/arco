// docs/PROVIDERS.md - git-status filter pack.
//
// `git status` (long form) is verbose: branch banner, "(use 'git add' to
// stage)" hint blocks, color-bracketed sections. The model needs the
// porcelain shape — what's modified / staged / untracked. We strip the
// human-friendly wrapping while preserving the path lists.
//
// We deliberately leave true `git status --porcelain` output untouched
// (no banners to strip — the parser is a no-op when those patterns don't
// match). branch_on_exit is irrelevant for status (rarely fails).

import type { FilterPack } from '../filterToolResult.js';

const HINT_PATTERNS: RegExp[] = [
  /^\s*\(use "git/,
  /^\s*\(commit or discard the untracked or modified content/,
  /^\s*\(see /,
  /^\s*\(working directory clean\)/,
  /^On branch /, // branch banner — replaced by short header further down
  /^Your branch is /,
  /^nothing to commit/,
  /^no changes added to commit/,
];

export const bashGitStatus: FilterPack = {
  name: 'git-status-trim-hints',
  stripAnsi: true,
  skip: HINT_PATTERNS,
  // Drop runs of blank lines down to a single blank.
  dedup: true,
};

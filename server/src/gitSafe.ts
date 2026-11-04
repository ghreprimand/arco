// Shared git-argv input validators.
//
// Single source of truth for the "is this operator-supplied value safe to put
// into a `git` argv token" guards. These were originally defined privately in
// gitWorking.ts / gitDiff.ts; Workbench Expansion I3 (gitOps.ts — which mutates
// the real index/working tree/refs) reuses the EXACT same predicates, so they
// live here and the original modules re-export from this file. There is ONE
// definition of each — never fork a divergent copy.
//
// THE CONTRACT: every value below reaches git ONLY as a single element of an
// execFile argv array (never a shell string, never string interpolation into a
// command). The validators are defense-in-depth on top of that:
//   - reject a leading dash so a value can't be parsed as a git flag even when
//     it's a standalone argv token (e.g. `--upload-pack=…`, `--output=…`);
//   - reject characters git's own ref/remote/path grammar forbids.
// Callers ALSO pass `--` before any pathspec so a path can never be re-read as
// an option. See server/src/gitOps.ts and docs/GIT_WORKBENCH.md.

// A working-tree-relative path (stage/unstage pathspec). Reject a leading dash
// (flag smuggling) and NUL. Path traversal is irrelevant — git resolves the
// path against the repo and refuses to leave the work tree, and the `--`
// separator already terminates option parsing. We do NOT additionally reject
// `..`: a legitimately tracked file can sit at `../sibling` only outside the
// repo (git rejects it), so the dash + NUL guard plus `--` is the load-bearing
// part. The smoke's adversarial `../escape` case is rejected by git itself
// (pathspec outside repo) rather than here — but a `-`-leading or NUL path is
// rejected here before git ever sees it.
export function isSafePath(path: string): boolean {
  if (!path || path.startsWith('-')) return false;
  if (path.includes('\0')) return false;
  return true;
}

// A git remote name (origin etc.). A leading dash would parse as a flag even
// via execFile; restrict to git's sane remote-name charset so nothing weird
// sneaks through as a single argv token.
export function isSafeRemote(remote: string): boolean {
  if (!remote || remote.startsWith('-')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(remote);
}

// A branch / tag / stash / upstream ref name. Forbids a leading dash, plus
// whitespace, NUL, and the shell/range/glob metacharacters git's own ref-name
// rules already exclude (`~^:?*[\`), and `..` (range token). Belt-and-suspenders
// over execFile.
export function isSafeRef(ref: string): boolean {
  if (!ref || ref.startsWith('-')) return false;
  if (/[\s\0~^:?*[\\]/.test(ref)) return false;
  if (ref.includes('..')) return false;
  return true;
}

// A revision / sha (HEAD, a branch, a sha, a shadow-ref). Reject a leading dash
// and restrict to the revision charset.
export function isSafeRev(rev: string): boolean {
  if (!rev || rev.startsWith('-')) return false;
  return /^[A-Za-z0-9._/~^@{}-]+$/.test(rev);
}

// H43 — code-skew banner (BORROWED_IMPROVEMENTS_EXECUTION.md Phase 2).
//
// Prod runs the COMPILED build (`node server/dist/index.js`); editing source or
// pulling new commits does NOT touch the running process until the operator
// rebuilds + restarts the service. So the live server can silently drift behind
// the on-disk checkout — an operator commits a fix, sees it in `git log`, and
// assumes it's live when the running dist predates it. This module snapshots the
// git HEAD at boot (the rev the running build was started from) and exposes a
// probe that compares it to the current on-disk HEAD, reporting "N commits
// behind" so the Diagnostics tab can flag a stale prod build.
//
// Dev (tsx watch) hot-reloads source, so skew is meaningless there — the probe
// reports `skipped` under tsx and only WARNs for a built/prod-like runtime.
//
// Subprocess discipline (repo rule): git is invoked via execFile* with an argv
// array (NO shell), a cwd pinned to the repo root, and a timeout. Read-only.

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

// Repo root: this file lives at server/src/diagnostics/codeSkew.ts (or its dist
// mirror server/dist/diagnostics/codeSkew.js) — three levels up is the checkout
// root in both layouts. Pinning cwd matters: the systemd unit sets no
// WorkingDirectory, so the process cwd is not necessarily the repo.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// True when running under the tsx-watch dev runtime (same signal supportBundle's
// serviceMode() uses). Source edits are live there, so code-skew is irrelevant.
export function isDevRuntime(): boolean {
  return (
    process.env.npm_lifecycle_event === 'dev:server' ||
    process.argv.some((a) => a.includes('tsx')) ||
    process.execArgv.some((a) => a.includes('tsx'))
  );
}

// Full HEAD rev, synchronously. Used once at boot. null when not a git checkout
// (e.g. an installed tarball) or git is unavailable — the probe then degrades to
// `skipped` rather than failing.
function readHeadSync(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      timeout: 2000,
      encoding: 'utf8',
    });
    const rev = out.trim();
    return /^[0-9a-f]{40}$/i.test(rev) ? rev : null;
  } catch {
    return null;
  }
}

// undefined = not captured yet; null = captured, but no git checkout.
let bootRev: string | null | undefined = undefined;

// Snapshot the boot rev. Idempotent — the first call wins (mirrors readiness.ts
// BOOTED_AT). index.ts calls this during boot so the rev is the one the running
// build actually started from; a lazy first-probe call is the safe fallback.
export function captureBootRev(): void {
  if (bootRev === undefined) bootRev = readHeadSync();
}

export function getBootRev(): string | null {
  captureBootRev();
  return bootRev ?? null;
}

// ── pure classification (unit-tested) ──────────────────────────────────────

export interface CodeSkewInput {
  dev: boolean;
  bootRev: string | null;
  headRev: string | null;
  // Commits in bootRev..HEAD (the running build is this many behind on-disk
  // HEAD). null when it couldn't be computed (non-linear history / git error).
  behind: number | null;
}

export interface CodeSkewResult {
  status: 'ok' | 'warn' | 'skipped';
  detail: string;
  hint?: string;
}

const short = (rev: string | null): string => (rev ? rev.slice(0, 8) : 'unknown');

export function classifyCodeSkew(input: CodeSkewInput): CodeSkewResult {
  if (input.dev) {
    return { status: 'skipped', detail: 'dev runtime (tsx watch) — source is live, no build to skew' };
  }
  if (!input.bootRev || !input.headRev) {
    return { status: 'skipped', detail: 'not a git checkout (or git unavailable) — skew not measurable' };
  }
  if (input.bootRev === input.headRev) {
    return { status: 'ok', detail: `running build is current (HEAD ${short(input.headRev)})` };
  }
  // HEAD moved since boot → the running dist is stale.
  if (input.behind && input.behind > 0) {
    const plural = input.behind === 1 ? 'commit' : 'commits';
    return {
      status: 'warn',
      detail: `running build is ${input.behind} ${plural} behind on-disk HEAD (boot ${short(input.bootRev)} → HEAD ${short(input.headRev)})`,
      hint: 'rebuild + restart the service to deploy on-disk HEAD: npm run build && systemctl --user restart arco.service',
    };
  }
  // HEAD differs but isn't a linear advance (reset/rebase/force) — still skew.
  return {
    status: 'warn',
    detail: `on-disk HEAD changed since boot (boot ${short(input.bootRev)} → HEAD ${short(input.headRev)})`,
    hint: 'rebuild + restart the service to deploy on-disk HEAD',
  };
}

// ── probe ──────────────────────────────────────────────────────────────────

// Count commits in bootRev..HEAD. null on any git error (e.g. bootRev is not an
// ancestor of HEAD after a rebase) — classifyCodeSkew falls back to a generic
// "HEAD changed" warning in that case.
async function countBehind(bootRev: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-list', '--count', `${bootRev}..HEAD`], {
      cwd: REPO_ROOT,
      timeout: 2000,
    });
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function readHead(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      timeout: 2000,
    });
    const rev = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(rev) ? rev : null;
  } catch {
    return null;
  }
}

export async function probeCodeSkew(): Promise<CodeSkewResult> {
  const dev = isDevRuntime();
  if (dev) return classifyCodeSkew({ dev, bootRev: null, headRev: null, behind: null });
  const boot = getBootRev();
  const head = await readHead();
  let behind: number | null = null;
  if (boot && head && boot !== head) behind = await countBehind(boot);
  return classifyCodeSkew({ dev, bootRev: boot, headRev: head, behind });
}

// H54 — workspace / verify-loop facts (Claude Native).
//
// The single highest-leverage coding steer: tell the agent, up front and once,
// the project's REAL verify commands (build / test / lint) and dev runner, so it
// stops guessing `npm test` in a pnpm+vitest repo or `make` where there's no
// Makefile. Detected deterministically from lockfiles + package.json scripts +
// Makefile targets + ecosystem markers — no model call.
//
// CACHE-STABLE (load-bearing): probed ONCE at worker start and cached. Git
// branch is captured once (stable for the worker's life); we deliberately do NOT
// include live dirty-status — that flips every turn and would break the prompt
// cache (docs/GOTCHAS.md § Claude Native transport). The detection logic is pure
// (`detectProjectFacts`); only `probeProjectFacts` touches disk.

export interface ProjectFacts {
  cwd: string;
  ecosystem: string[]; // 'node' | 'python' | 'rust' | 'go' | 'make'
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  // Ordered verify commands (typecheck/build first, then test, then lint).
  verifyCommands: string[];
  // The single best "did I break it?" command — handed to Handoff/Spawn seeds.
  primaryVerify?: string;
  // Dev / start command, when detected.
  runCommand?: string;
  gitBranch?: string;
  isLinkedWorktree?: boolean;
}

export interface RawSignals {
  // Filenames present directly in cwd (lockfiles + marker files).
  files: string[];
  packageScripts?: Record<string, string>;
  makefileTargets?: string[];
  gitBranch?: string;
  isLinkedWorktree?: boolean;
}

function detectPackageManager(files: string[]): ProjectFacts['packageManager'] | undefined {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('bun.lockb')) return 'bun';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('package-lock.json')) return 'npm';
  return undefined;
}

// Pure: derive facts from gathered raw signals. Tested directly.
export function detectProjectFacts(cwd: string, raw: RawSignals): ProjectFacts {
  const ecosystem: string[] = [];
  const verifyCommands: string[] = [];
  let primaryVerify: string | undefined;
  let runCommand: string | undefined;
  let packageManager: ProjectFacts['packageManager'] | undefined;

  // ── Node ──
  if (raw.packageScripts || raw.files.includes('package.json')) {
    ecosystem.push('node');
    packageManager = detectPackageManager(raw.files) ?? 'npm';
    const pm = packageManager;
    const scripts = raw.packageScripts ?? {};
    const run = (name: string): string => (pm === 'npm' ? `npm run ${name}` : `${pm} ${name}`);
    // Verify priority: typecheck/build → test → lint.
    const buildLike = ['build', 'typecheck', 'tsc', 'compile'].find((s) => scripts[s]);
    const testLike = ['test', 'test:unit', 'vitest', 'jest'].find((s) => scripts[s]);
    const lintLike = ['lint', 'eslint'].find((s) => scripts[s]);
    if (buildLike) verifyCommands.push(run(buildLike));
    if (testLike) verifyCommands.push(scripts[testLike] && testLike === 'test' ? (pm === 'npm' ? 'npm test' : `${pm} test`) : run(testLike));
    if (lintLike) verifyCommands.push(run(lintLike));
    primaryVerify = verifyCommands[0];
    const runLike = ['dev', 'start', 'serve'].find((s) => scripts[s]);
    if (runLike) runCommand = run(runLike);
  }

  // ── Rust ──
  if (raw.files.includes('Cargo.toml')) {
    ecosystem.push('rust');
    verifyCommands.push('cargo build', 'cargo test');
    primaryVerify = primaryVerify ?? 'cargo test';
    runCommand = runCommand ?? 'cargo run';
  }

  // ── Go ──
  if (raw.files.includes('go.mod')) {
    ecosystem.push('go');
    verifyCommands.push('go build ./...', 'go test ./...');
    primaryVerify = primaryVerify ?? 'go test ./...';
  }

  // ── Python ──
  const pyMarkers = ['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini'];
  if (pyMarkers.some((m) => raw.files.includes(m))) {
    ecosystem.push('python');
    verifyCommands.push('pytest');
    primaryVerify = primaryVerify ?? 'pytest';
  }

  // ── Makefile ──
  if (raw.makefileTargets && raw.makefileTargets.length > 0) {
    ecosystem.push('make');
    for (const t of ['check', 'test', 'build', 'lint']) {
      if (raw.makefileTargets.includes(t)) {
        const cmd = `make ${t}`;
        if (!verifyCommands.includes(cmd)) verifyCommands.push(cmd);
        primaryVerify = primaryVerify ?? cmd;
      }
    }
  }

  // primaryVerify is consistently the highest-priority verify command (the
  // first one pushed) regardless of ecosystem, so the Handoff/Spawn seed and the
  // facts block agree on the single "did I break it?" command.
  primaryVerify = verifyCommands[0];

  return {
    cwd,
    ecosystem,
    ...(packageManager ? { packageManager } : {}),
    verifyCommands,
    ...(primaryVerify ? { primaryVerify } : {}),
    ...(runCommand ? { runCommand } : {}),
    ...(raw.gitBranch ? { gitBranch: raw.gitBranch } : {}),
    ...(raw.isLinkedWorktree ? { isLinkedWorktree: true } : {}),
  };
}

// Render the cache-stable system block. Returns null when nothing was detected
// (no facts ⇒ no block ⇒ no input-token cost).
export function renderProjectFactsBlock(facts: ProjectFacts): string | null {
  if (facts.ecosystem.length === 0 && facts.verifyCommands.length === 0 && !facts.gitBranch) return null;
  const lines: string[] = ['--- Workspace facts (auto-detected once at session start) ---'];
  const eco = facts.ecosystem.length > 0 ? facts.ecosystem.join(' + ') : 'unknown';
  const pm = facts.packageManager ? ` (${facts.packageManager})` : '';
  const wt = facts.isLinkedWorktree ? ' [linked worktree]' : '';
  const branch = facts.gitBranch ? ` on branch ${facts.gitBranch}` : '';
  lines.push(`Project: ${eco}${pm}${branch}${wt}`);
  if (facts.verifyCommands.length > 0) {
    lines.push(`Verify your work with: ${facts.verifyCommands.join('; ')}`);
  }
  if (facts.runCommand) {
    lines.push(`Dev/run: ${facts.runCommand}`);
  }
  lines.push('Prefer these detected commands over guessing build/test commands.');
  return lines.join('\n');
}

// Gather raw signals from disk + git, then detect. The only disk-touching entry.
export async function probeProjectFacts(cwd: string): Promise<ProjectFacts> {
  const { promises: fs } = await import('node:fs');
  const { join } = await import('node:path');
  let files: string[] = [];
  try {
    files = await fs.readdir(cwd);
  } catch { /* unreadable cwd — return minimal facts */ }

  let packageScripts: Record<string, string> | undefined;
  if (files.includes('package.json')) {
    try {
      const raw = await fs.readFile(join(cwd, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
      if (pkg.scripts && typeof pkg.scripts === 'object') packageScripts = pkg.scripts;
    } catch { /* malformed package.json — skip scripts */ }
  }

  let makefileTargets: string[] | undefined;
  const makefileName = files.find((f) => f === 'Makefile' || f === 'makefile');
  if (makefileName) {
    try {
      const mk = await fs.readFile(join(cwd, makefileName), 'utf8');
      // A target is a line `name:` (not `.PHONY`, not indented recipe, not a var).
      makefileTargets = [...mk.matchAll(/^([a-zA-Z0-9_-]+):(?![=])/gm)].map((m) => m[1]).filter((t) => !t.startsWith('.'));
    } catch { /* skip */ }
  }

  // Git: branch (once) + linked-worktree detection. A linked worktree has a
  // `.git` FILE (gitdir pointer), not a directory.
  let gitBranch: string | undefined;
  let isLinkedWorktree = false;
  try {
    const gitStat = await fs.stat(join(cwd, '.git')).catch(() => null);
    if (gitStat && gitStat.isFile()) isLinkedWorktree = true;
    const { getGitStatus } = await import('../../git.js');
    const status = await getGitStatus(cwd).catch(() => null);
    if (status && typeof status.currentBranch === 'string') {
      gitBranch = status.currentBranch;
    }
  } catch { /* not a git repo / git unavailable */ }

  return detectProjectFacts(cwd, { files, packageScripts, makefileTargets, gitBranch, isLinkedWorktree });
}


import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const DEFAULT_GRACE_MS = 5000;

// On Unix, a detached child PID is also its process-group ID; signaling the
// group reaches shells and their descendants. Windows has no
// process groups or POSIX signals: `process.kill` ends only one process, while
// `taskkill /T /F` ends it and its descendants.
export function windowsTreeKillArgs(pid: number): string[] {
  return ['/pid', String(pid), '/T', '/F'];
}

export function killProcessTree(pid: number, options?: { graceMs?: number; label?: string }): void {
  const grace = options?.graceMs ?? DEFAULT_GRACE_MS;
  const label = options?.label ? ` (${options.label})` : '';
  if (process.platform === 'win32') {
    console.log(`[arco] killProcessTree pid=${pid}${label} — taskkill /T /F`);
    const killer = spawn('taskkill', windowsTreeKillArgs(pid), { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => signalGroup(pid, 'SIGKILL'));
    killer.on('exit', (code) => { if (code !== 0) signalGroup(pid, 'SIGKILL'); });
    return;
  }
  console.log(`[arco] killProcessTree pid=${pid}${label} — SIGTERM; SIGKILL in ${grace}ms if still alive`);
  // Negative pid = signal to the process group.
  signalGroup(pid, 'SIGTERM');
  setTimeout(() => signalGroup(pid, 'SIGKILL'), grace);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return; // group already gone — nothing to do
    if (code === 'EPERM') {
      console.log(`[arco] killProcessTree pid=${pid} EPERM on group; falling back to direct pid kill`);
    }
    // Fall through to direct PID kill below.
  }
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      console.log(`[arco] killProcessTree pid=${pid} direct kill ${signal} failed: ${(err as Error).message}`);
    }
  }
}

// Signal a shell child spawned by a tool or hook together with everything it
// started. Unix: the child was spawned `detached`, so it leads its own process
// group and a negative pid reaches the whole tree; the direct child is the
// fallback. Windows has no process groups or POSIX signals (`process.kill(-pid)`
// does not exist there), so `taskkill /T /F` ends the tree at once whatever the
// signal; the direct child is the fallback when taskkill cannot run.
//
// Windows with Git Bash: `taskkill /T` follows Windows parent links, and an
// MSYS background job (`cmd &`) or a forked-then-exec'd program loses its
// Windows parent when the forked copy exits, so it survives /T and keeps the
// output pipe open. A child started by spawnShellChild carries a tag in its
// environment that every MSYS process of its tree inherits; the tree kill
// first lists those processes through Git Bash's /proc (msysTreeSweep) and
// ends them by their Windows process ids together with the child.
//
// The returned promise settles once the signal has been delivered: at once on
// Unix, and on Windows when taskkill has finished (or failed and the fallback
// ran). It never rejects.
export function signalChildTree(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): Promise<void> {
  const pid = child.pid;
  if (platform === 'win32') {
    if (!pid) return Promise.resolve();
    const fallback = (): void => { try { child.kill(signal); } catch { /* gone */ } };
    const tree = msysTrees.get(child);
    if (!tree) return runTaskkill([pid], fallback);
    return listMsysTree(tree).then((found) => runTaskkill([pid, ...found], fallback), () => runTaskkill([pid], fallback));
  }
  try {
    if (pid) process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* gone */ }
  }
  return Promise.resolve();
}

/** taskkill arguments that end each process id with its descendants. */
export function windowsTreeKillArgsFor(pids: number[]): string[] {
  return ['/F', '/T', ...[...new Set(pids)].flatMap((p) => ['/PID', String(p)])];
}

// Settles when taskkill has exited, or after the fallback when it could not run.
function runTaskkill(pids: number[], fallback: () => void): Promise<void> {
  return new Promise((resolve) => {
    try {
      const killer = spawn('taskkill', windowsTreeKillArgsFor(pids), { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => { fallback(); resolve(); });
      killer.on('exit', () => resolve());
    } catch {
      fallback();
      resolve();
    }
  });
}

// ── Shell children that can be ended as a whole tree on Windows ──────────────

export const PROCESS_TREE_ENV = 'ARCO_PROCESS_TREE';
const msysTrees = new WeakMap<ChildProcess, { tag: string; bash: string }>();

// How an MSYS program (Git Bash) reads its Windows command line when started
// by a non-MSYS parent: inside double quotes, \\ is one backslash and \" one
// quote; everything else is literal. Node's own quoting
// leaves a run of backslashes alone unless a quote follows, so a command
// holding "C:\\Users" arrived as "C:\Users" and JSON in a hook command
// stopped parsing. Each argument is therefore quoted this way and passed
// verbatim.
export function msysQuote(arg: string): string {
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface ShellChildRun {
  file: string;
  args: string[];
  /** The program is Git Bash (MSYS): quote for MSYS and tag the tree on Windows. */
  msys?: boolean;
}

/** What spawnShellChild passes to spawn; separate so it can be checked on any OS. */
export function shellSpawnPlan(run: ShellChildRun, options: SpawnOptions, platform: NodeJS.Platform = process.platform): { file: string; args: string[]; options: SpawnOptions; tag?: string } {
  const msys = run.msys === true && platform === 'win32';
  const base: SpawnOptions = { ...options, ...shellChildSpawnOptions(platform) };
  if (!msys) return { file: run.file, args: run.args, options: base };
  const tag = randomUUID();
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), [PROCESS_TREE_ENV]: tag };
  // MSYS=noglob turns that unquoting off, so the shell itself runs without it.
  if (typeof env.MSYS === 'string' && /\bnoglob\b/.test(env.MSYS)) env.MSYS = env.MSYS.replace(/\bnoglob\b/g, '').replace(/\s+/g, ' ').trim();
  return {
    file: run.file,
    args: run.args.map(msysQuote),
    options: {
      ...base,
      windowsVerbatimArguments: true,
      argv0: `"${run.file}"`,
      env,
    },
    tag,
  };
}

/** Spawn a tool or hook shell so signalChildTree can end everything it starts. */
export function spawnShellChild(run: ShellChildRun, options: SpawnOptions): ChildProcess {
  const plan = shellSpawnPlan(run, options);
  const child = spawn(plan.file, plan.args, plan.options);
  if (plan.tag) msysTrees.set(child, { tag: plan.tag, bash: run.file });
  return child;
}

/** Tests: the tag spawnShellChild gave a child, if any. */
export function _shellTreeTagForTest(child: ChildProcess): string | undefined {
  return msysTrees.get(child)?.tag;
}

// Prints, one per line, the Windows process id (or, outside Windows, the
// process id) of every MSYS process whose environment holds the tag. Bash
// built-ins only, so it starts nothing per process.
export const MSYS_TREE_SWEEP = [
  'tag=$1',
  'for d in /proc/[0-9]*; do',
  '  [ -r "$d/environ" ] || continue',
  '  hit=',
  '  while IFS= read -r -d \'\' e || [ -n "$e" ]; do',
  '    if [ "$e" = "' + PROCESS_TREE_ENV + '=$tag" ]; then hit=1; break; fi',
  '  done < "$d/environ"',
  '  [ -n "$hit" ] || continue',
  '  w=',
  '  [ -r "$d/winpid" ] && read -r w < "$d/winpid"',
  '  printf \'%s\\n\' "${w:-${d#/proc/}}"',
  'done 2>/dev/null',
  '',
].join('\n');

const SWEEP_TIMEOUT_MS = 5_000;

// Runs MSYS_TREE_SWEEP in the tree's own bash; the ids found, or none after
// SWEEP_TIMEOUT_MS or on any failure (the plain tree kill still runs).
function listMsysTree(tree: { tag: string; bash: string }): Promise<number[]> {
  return msysTreeSweep(tree.bash, tree.tag, process.platform);
}

export function msysTreeSweep(bash: string, tag: string, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env[PROCESS_TREE_ENV];
    let out = '';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(out.split(/\r?\n/).filter((l) => /^\d+$/.test(l.trim())).map((l) => Number(l.trim())));
    };
    const timer = setTimeout(() => { try { sweeper?.kill(); } catch { /* gone */ } finish(); }, SWEEP_TIMEOUT_MS);
    let sweeper: ChildProcess | undefined;
    try {
      const plan = shellSpawnPlan({ file: bash, args: ['-c', MSYS_TREE_SWEEP, 'arco-sweep', tag], msys: true }, { env, stdio: ['ignore', 'pipe', 'ignore'] }, platform);
      // The sweep itself must not carry a tag, or it would list itself.
      if (plan.options.env) delete (plan.options.env as NodeJS.ProcessEnv)[PROCESS_TREE_ENV];
      sweeper = spawn(plan.file, plan.args, plan.options);
      sweeper.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
      sweeper.on('error', finish);
      sweeper.on('close', finish);
    } catch {
      finish();
    }
  });
}

/** Spawn options for such a child: its own process group on Unix, no console window on Windows. */
export function shellChildSpawnOptions(platform: NodeJS.Platform = process.platform): { detached: boolean; windowsHide: true } {
  return { detached: platform !== 'win32', windowsHide: true };
}

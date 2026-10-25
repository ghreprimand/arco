// Process-tree kill helper. When a worker is `spawn(detached: true)`, the
// child process becomes a process group leader, and `process.kill(-pid, sig)`
// (negative pid) sends the signal to the WHOLE group — every descendant
// shell command, find, du, etc.
//
// Without this, killing the worker only takes down the immediate CLI
// (gemini / claude / codex) and any runaway subprocess (e.g. a 60GB `find /`)
// keeps running until OOM hits. Critical for the safety story.
//
// SIGTERM first, then SIGKILL after a grace period, so well-behaved
// processes get a chance to clean up but unkillable ones still die.

const DEFAULT_GRACE_MS = 5000;

export function killProcessTree(pid: number, options?: { graceMs?: number; label?: string }): void {
  const grace = options?.graceMs ?? DEFAULT_GRACE_MS;
  const label = options?.label ? ` (${options.label})` : '';
  console.log(`[archon] killProcessTree pid=${pid}${label} — SIGTERM; SIGKILL in ${grace}ms if still alive`);
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
      console.log(`[archon] killProcessTree pid=${pid} EPERM on group; falling back to direct pid kill`);
    }
    // Fall through to direct PID kill below.
  }
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      console.log(`[archon] killProcessTree pid=${pid} direct kill ${signal} failed: ${(err as Error).message}`);
    }
  }
}

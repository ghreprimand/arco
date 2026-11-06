
import { spawn, type ChildProcess } from 'node:child_process';

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
export function signalChildTree(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  if (platform === 'win32') {
    if (!pid) return;
    try {
      const killer = spawn('taskkill', windowsTreeKillArgs(pid), { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => { try { child.kill(signal); } catch { /* gone */ } });
    } catch {
      try { child.kill(signal); } catch { /* gone */ }
    }
    return;
  }
  try {
    if (pid) process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* gone */ }
  }
}

/** Spawn options for such a child: its own process group on Unix, no console window on Windows. */
export function shellChildSpawnOptions(platform: NodeJS.Platform = process.platform): { detached: boolean; windowsHide: true } {
  return { detached: platform !== 'win32', windowsHide: true };
}

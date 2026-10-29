
import { spawn } from 'node:child_process';

const DEFAULT_GRACE_MS = 5000;

// Windows has no process groups or POSIX signals: `process.kill` there ends
// only the one process. `taskkill /T /F` ends the process and every
// descendant it started (a shell's provider CLI, for example).
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

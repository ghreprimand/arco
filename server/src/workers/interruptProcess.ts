import type { ChildProcess } from 'node:child_process';

// CLI kill() settles its wrapper before SIGTERM's grace period is over.
// Resuming its session then can leave two writers to the same session file.
export async function interruptProcess(child: ChildProcess | null, cancel: () => void): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    cancel();
    return;
  }
  const exited = new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      child.removeListener('exit', done);
      reject(new Error('Interrupted CLI did not exit; refusing to resume its session concurrently.'));
    }, 10_000);
    child.once('exit', done);
  });
  cancel();
  await exited;
}

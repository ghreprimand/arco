export async function runWithCiRetry(runOnce, { ci }) {
  const first = await runOnce();
  if (first.status === 0) return { status: 'pass', first };
  if (!ci) return { status: 'fail', first };

  const retry = await runOnce();
  return retry.status === 0
    ? { status: 'flaky', first, retry }
    : { status: 'fail', first, retry };
}

export function outputTail(run, limit = 4_000) {
  return `${run.stdout || ''}${run.stderr || ''}`.slice(-limit).trim();
}

// Vite can split an error over writes; inspect the collected output as a whole.
export function hasDefaultBackendRefusal(output) {
  return /ECONNREFUSED\s+(?:127\.0\.0\.1|::1):3001(?!\d)/.test(output);
}

export function suiteStatusWithVite(status, output) {
  return hasDefaultBackendRefusal(output) ? 'fail' : status;
}

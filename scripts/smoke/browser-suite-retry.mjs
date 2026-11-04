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

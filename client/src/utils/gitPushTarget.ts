/** Upstream of the branch the commit will land on, not of the branch the tab was on when the dialog opened. */
export function upstreamForFinalBranch(
  status: { currentBranch: string | null; upstream: string | null; branches: Array<{ name: string; upstream: string | null }> },
  finalBranch: string,
  creatingNew: boolean,
): string | null {
  if (creatingNew) return null;
  if (finalBranch === status.currentBranch) return status.upstream;
  return status.branches.find((b) => b.name === finalBranch)?.upstream ?? null;
}

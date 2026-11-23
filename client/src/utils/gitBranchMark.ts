export function gitBranchMark(upstreamGone: boolean | undefined, hasUpstream?: boolean): string {
  return upstreamGone ? ' [deleted on remote]' : hasUpstream === false ? ' [no upstream]' : '';
}

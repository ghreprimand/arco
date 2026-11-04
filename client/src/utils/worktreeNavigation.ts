import { useEffect, useRef, useState } from 'react';

// "VIEW CHANGES" in the GIT dialog's Other work section: open the FILES tab on
// a chosen worktree through the existing worktree picker. The request is held
// until a mounted FILES view picks it up, because the tab may not be mounted
// yet when the dialog closes.
let pending: { workflowId: string; path: string } | null = null;

export function requestWorktreeView(workflowId: string, path: string): void {
  pending = { workflowId, path };
  window.dispatchEvent(new Event('arco:open-worktree'));
}

/** Opens the FILES changes view when a request names one of these workflows. */
export function useWorktreeNavigation(workflowIds: string[], open: () => void): void {
  const callback = useRef(open); callback.current = open;
  const key = workflowIds.join('|');
  useEffect(() => {
    const receive = () => { if (pending && key.split('|').includes(pending.workflowId)) callback.current(); };
    window.addEventListener('arco:open-worktree', receive); receive();
    return () => window.removeEventListener('arco:open-worktree', receive);
  }, [key]);
}

/** The worktree path to select, taken once the matching worktree is in the picker's list. */
export function useRequestedWorktree(workflowId: string, knownPaths: string[], select: (path: string) => void): void {
  const choose = useRef(select); choose.current = select;
  const [tick, setTick] = useState(0);
  const paths = knownPaths.join('\n');
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener('arco:open-worktree', bump);
    return () => window.removeEventListener('arco:open-worktree', bump);
  }, []);
  useEffect(() => {
    if (!pending) return;
    if (pending.workflowId !== workflowId && !paths.split('\n').includes(pending.path)) return;
    if (!paths.split('\n').includes(pending.path)) return;
    const path = pending.path;
    pending = null;
    choose.current(path);
  }, [workflowId, paths, tick]);
}

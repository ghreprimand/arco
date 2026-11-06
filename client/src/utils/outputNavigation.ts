import { useEffect, useRef } from 'react';
let pendingWorkflow: string | null = null;
export function requestOutputs(workflowId: string): void {
  pendingWorkflow = workflowId;
  window.dispatchEvent(new Event('arco:open-outputs'));
}
export function useOutputNavigation(workflowIds: string[], open: () => void): void {
  const callback = useRef(open); callback.current = open;
  const key = workflowIds.join('|');
  useEffect(() => {
    const receive = () => {
      if (!pendingWorkflow || !key.split('|').includes(pendingWorkflow)) return;
      pendingWorkflow = null; callback.current();
    };
    window.addEventListener('arco:open-outputs', receive); receive();
    return () => window.removeEventListener('arco:open-outputs', receive);
  }, [key]);
}
// Opens the container of a panel that is not mounted (the narrow-layout
// slide-out) when Outputs is requested for one of `workflowIds`. The request
// stays pending, so the panel's useOutputNavigation still selects Outputs once
// it mounts.
export function useOutputNavigationOpener(workflowIds: string[], enabled: boolean, open: () => void): void {
  const callback = useRef(open); callback.current = open;
  const key = workflowIds.join('|');
  useEffect(() => {
    if (!enabled) return;
    const receive = () => {
      if (pendingWorkflow && key.split('|').includes(pendingWorkflow)) callback.current();
    };
    window.addEventListener('arco:open-outputs', receive); receive();
    return () => window.removeEventListener('arco:open-outputs', receive);
  }, [key, enabled]);
}

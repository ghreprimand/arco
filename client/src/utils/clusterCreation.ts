import { useAppStore } from '../stores/appStore';

let pending: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;

// One creator submission at a time. The server finishes this id even when
// validation rejects the request before a cluster exists.
export function finishClusterCreation(requestId?: string): void {
  if (requestId && pending?.id !== requestId) return;
  if (pending) clearTimeout(pending.timer);
  pending = null;
  useAppStore.setState({ clusterCreationPending: false });
}

export function submitClusterCreation(send: (requestId: string) => boolean | void): void {
  finishClusterCreation();
  const id = crypto.randomUUID();
  useAppStore.setState({ clusterCreationPending: true });
  const timer = setTimeout(() => {
    if (pending?.id !== id) return;
    const wasPending = useAppStore.getState().clusterCreationPending;
    finishClusterCreation(id);
    if (wasPending) useAppStore.getState().pushNotification('error', 'Cluster creation has not responded. Check saved clusters before retrying.');
  }, 30_000);
  pending = { id, timer };
  try {
    if (send(id) === false) throw new Error('Cluster creation could not be sent. Reconnect and try again.');
  } catch (error) {
    finishClusterCreation(id);
    useAppStore.getState().pushNotification('error', error instanceof Error ? error.message : 'Cluster creation could not be sent.');
  }
}

// Disconnects and fixture acknowledgements also cancel the watchdog.
useAppStore.subscribe(state => {
  if (!state.clusterCreationPending && pending) {
    clearTimeout(pending.timer);
    pending = null;
  }
});

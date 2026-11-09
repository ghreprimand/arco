/** Match the local clock used by the cluster activity feed. */
export function formatActivityTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

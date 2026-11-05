// Size warnings during a turn (P7.4 follow-up). The artifact size check also
// runs at the end of every turn; while a turn runs it repeats on a timer, so a
// very large file written early in a long turn warns while the turn is still
// going. Each item warns once (storage-warnings.json), so repeats cost only
// the bounded artifact walk.
const DEFAULT_INTERVAL_MS = 30_000;

export function turnSizeCheckIntervalMs(): number {
  const n = Number(process.env.ARCO_ARTIFACT_WARN_INTERVAL_MS);
  return Number.isFinite(n) && n >= 50 ? Math.floor(n) : DEFAULT_INTERVAL_MS;
}

interface Watch { timer: ReturnType<typeof setInterval>; running: boolean }
const watches = new Map<string, Watch>();

/** Start (or restart) the periodic check for one workflow's running turn. */
export function watchTurnSizes(workflowId: string, check: () => Promise<void>): void {
  stopTurnSizes(workflowId);
  const watch: Watch = { running: false, timer: setInterval(() => {
    if (watch.running) return;
    watch.running = true;
    void check().catch(() => undefined).finally(() => { watch.running = false; });
  }, turnSizeCheckIntervalMs()) };
  // A watch never keeps the process alive on its own.
  watch.timer.unref?.();
  watches.set(workflowId, watch);
}

/** Stop the periodic check (the turn ended, failed or the tab closed). */
export function stopTurnSizes(workflowId: string): void {
  const watch = watches.get(workflowId);
  if (!watch) return;
  clearInterval(watch.timer);
  watches.delete(workflowId);
}

export function watchingTurnSizes(workflowId: string): boolean {
  return watches.has(workflowId);
}

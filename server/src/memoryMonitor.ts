// H46 — server RSS/heap trend logging (BORROWED_IMPROVEMENTS_EXECUTION.md Phase 2).
//
// A long-lived Arco prod process accumulates memory across many turns,
// Native workers, catalogs, and recall indexes. When the operator later sees the
// RSS guard fire or the box swap, there's no history to tell whether it crept up
// over hours or spiked in one turn. This emits a periodic one-line snapshot of
// process.memoryUsage() (rss / heap / external) with the delta since the last
// sample and the running peak — a cheap trend the operator can grep out of the
// log file.
//
// OFF BY DEFAULT: gated on the SAME signal as structured file logging
// (ARCO_LOG_FILE / ARCO_LOG_DIR → getLogFilePath() non-null). In dev it's
// inert. The lines go through console.log, which the file-logging tee captures.
//
// The interval timer is .unref()'d so it never holds the event loop open — a
// pending memory tick must not delay process exit. A final line is emitted from
// onSignal on the way down so every run's log ends with its high-water mark.

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 min — trend, not spam

const MB = 1024 * 1024;
const mb = (n: number): string => `${(n / MB).toFixed(1)}MB`;
const signedMb = (n: number): string => `${n >= 0 ? '+' : '-'}${(Math.abs(n) / MB).toFixed(1)}MB`;

// Pure formatter (unit-tested). `prevRss` (if given) yields a Δ vs the last
// sample; `peakRss` annotates the running high-water mark.
export function formatMemorySample(
  mem: NodeJS.MemoryUsage,
  opts: { label?: string; prevRss?: number; peakRss?: number } = {},
): string {
  const parts = [
    `rss=${mb(mem.rss)}`,
    `heapUsed=${mb(mem.heapUsed)}`,
    `heapTotal=${mb(mem.heapTotal)}`,
    `external=${mb(mem.external)}`,
  ];
  if (opts.prevRss !== undefined) parts.push(`rssΔ=${signedMb(mem.rss - opts.prevRss)}`);
  if (opts.peakRss !== undefined) parts.push(`rssPeak=${mb(Math.max(opts.peakRss, mem.rss))}`);
  const tag = opts.label ? `[arco][mem:${opts.label}]` : '[arco][mem]';
  return `${tag} ${parts.join(' ')}`;
}

let timer: ReturnType<typeof setInterval> | null = null;
let prevRss = 0;
let peakRss = 0;

// Emit one sample now (also used for the boot baseline + the shutdown final line).
export function logMemorySample(label?: string): void {
  const mem = process.memoryUsage();
  console.log(formatMemorySample(mem, { label, prevRss: prevRss || undefined, peakRss }));
  prevRss = mem.rss;
  if (mem.rss > peakRss) peakRss = mem.rss;
}

// Start periodic sampling iff `enabled`. Returns a stop function (idempotent).
// `enabled` is the caller's gate (getLogFilePath() !== null) so this module
// stays free of env-flag knowledge and is trivial to unit-test.
export function startMemoryMonitor(opts: { enabled: boolean; intervalMs?: number }): () => void {
  if (!opts.enabled) return () => { /* inert */ };
  if (timer) return stopMemoryMonitor; // already running
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  logMemorySample('boot'); // baseline so the trend has a first point
  timer = setInterval(() => logMemorySample(), interval);
  timer.unref(); // never hold the event loop open
  return stopMemoryMonitor;
}

export function stopMemoryMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

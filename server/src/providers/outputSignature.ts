import { createHash } from 'crypto';

// Watchdog instrumentation (docs/CLUSTER_MODE_PLAN.md — worker-watchdog, not yet
// shipped). A stable signature of a tool's output, used to detect
// error-persistence loops: the same failing command recurring with an UNCHANGED
// result is "stuck"; a result that changes between attempts is progress.
//
// Hashing the raw output directly is useless — cargo/test output is full of
// volatile bits (elapsed times, timestamps, line numbers, ANSI colour) that
// drift run-to-run, so two identical errors would hash differently. We normalize
// those out before hashing so the SAME recurring error collapses to one hash.
// This is deliberately lossy and detector-facing; the raw `output` is still
// logged separately for human review. Normalization strictness is the tuning
// knob the offline evaluator exercises (~/.archon/media-scratch/watchdog-eval).
export function outputHash(raw: string): string {
  const norm = raw
    .replace(/\x1b\[[0-9;]*m/g, '') // ANSI colour codes
    .replace(/\d+/g, '#')           // durations / timestamps / line numbers
    .replace(/\s+/g, ' ')           // collapse whitespace runs
    .trim()
    .slice(0, 8192);                // cap hashing work on huge outputs
  return createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

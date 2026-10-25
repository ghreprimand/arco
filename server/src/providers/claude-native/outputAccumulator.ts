// DD2 — bounded-tail output accumulator for Bash (Claude Native).
//
// The old runBashForeground had two faults that this fixes:
//   1. On hitting the 64 KB cap it called killTree() — a long but successful
//      build/test that printed >64 KB was KILLED mid-run, so the model saw a
//      truncated *and* failed command. DD2: never kill on cap; let the process
//      finish, keep a bounded RAM tail, and spill the COMPLETE output to a
//      tempfile (from byte 0) the model can re-read.
//   2. `chunk.toString('utf8')` per chunk splits a multibyte char across the
//      pipe-chunk boundary → mojibake. DD2: decode with a streaming TextDecoder.
//
// This module is the pure core: feed it raw stdout/stderr Buffers, get back a
// bounded UTF-8 tail + dual byte/line truncation accounting + the spill path.
// The spill sink is injected so the accumulator does no I/O itself (the bash
// tool wires a real tempfile; tests wire an in-memory sink).

export interface SpillSink {
  write(chunk: Buffer): void;
  readonly path: string;
}

export interface OutputAccumulatorOpts {
  // Bytes of the model-visible TAIL (the most-recent output). Older bytes beyond
  // this are dropped from RAM (but preserved in the spill file).
  tailByteBudget: number;
  // Max lines in the returned tail. Truncates to the last N lines if exceeded.
  maxLines: number;
  // Once total output exceeds this, the full stream is spilled to a tempfile.
  spillThresholdBytes: number;
  // Lazily create the spill sink the first time the threshold is crossed.
  // Omitted ⇒ no spill (small outputs never touch disk).
  openSpill?: () => SpillSink;
}

export interface AccumulatorResult {
  // Decoded, bounded UTF-8 tail (valid — no split multibyte chars).
  text: string;
  totalBytes: number;
  totalLines: number;
  truncated: boolean;
  // Why the returned text is shorter than the full output (null ⇒ nothing dropped).
  truncatedBy: 'bytes' | 'lines' | null;
  // Absolute path to the complete-from-byte-0 spill file, when one was opened.
  spillPath?: string;
}

const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_BYTE = 0x80;

export class OutputAccumulator {
  private readonly opts: OutputAccumulatorOpts;
  // Bounded RAM tail (raw bytes; decoded lazily at result()).
  private tail: Buffer = Buffer.alloc(0);
  private totalBytes = 0;
  private totalLines = 0;
  private sink: SpillSink | null = null;
  // All raw bytes seen BEFORE the spill opened — flushed into the spill file on
  // open so the file is complete from byte 0. Dropped once the spill is live.
  private preSpill: Buffer[] = [];
  private preSpillBytes = 0;
  private spillOpened = false;

  constructor(opts: OutputAccumulatorOpts) {
    this.opts = opts;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.totalBytes += chunk.length;
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) this.totalLines++;

    // Spill: open lazily once we cross the threshold, flushing everything seen
    // so far so the file starts at byte 0.
    if (this.opts.openSpill) {
      if (!this.spillOpened) {
        this.preSpill.push(chunk);
        this.preSpillBytes += chunk.length;
        if (this.totalBytes > this.opts.spillThresholdBytes) {
          this.sink = this.opts.openSpill();
          this.spillOpened = true;
          for (const b of this.preSpill) this.sink.write(b);
          this.preSpill = [];
          this.preSpillBytes = 0;
        }
      } else if (this.sink) {
        this.sink.write(chunk);
      }
    }

    // Bounded RAM tail: append, then trim from the front to the byte budget.
    this.tail = this.tail.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.tail, chunk]);
    if (this.tail.length > this.opts.tailByteBudget) {
      this.tail = this.tail.subarray(this.tail.length - this.opts.tailByteBudget);
    }
  }

  result(): AccumulatorResult {
    // Trim leading UTF-8 continuation bytes so the decode doesn't start mid-char
    // (the front of the tail was likely cut inside a multibyte sequence).
    let start = 0;
    if (this.tail.length > this.opts.tailByteBudget - 4 || this.totalBytes > this.tail.length) {
      while (start < this.tail.length && (this.tail[start] & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BYTE) {
        start++;
      }
    }
    const decoder = new TextDecoder('utf-8'); // non-fatal: replaces a trailing partial char
    let text = decoder.decode(this.tail.subarray(start));

    const byteTruncated = this.totalBytes > this.tail.length;
    let lineTruncated = false;
    if (this.opts.maxLines > 0) {
      const lines = text.split('\n');
      if (lines.length > this.opts.maxLines) {
        text = lines.slice(lines.length - this.opts.maxLines).join('\n');
        lineTruncated = true;
      }
    }

    const truncated = byteTruncated || lineTruncated;
    // Bytes dropped is the dominant signal; lines only when bytes didn't already
    // explain the cut.
    const truncatedBy: 'bytes' | 'lines' | null = byteTruncated ? 'bytes' : lineTruncated ? 'lines' : null;
    return {
      text,
      totalBytes: this.totalBytes,
      totalLines: this.totalLines,
      truncated,
      truncatedBy,
      ...(this.sink ? { spillPath: this.sink.path } : {}),
    };
  }
}

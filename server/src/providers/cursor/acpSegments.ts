// Reply-segment boundaries for the Cursor ACP stream. Cursor interleaves
// reasoning and tool updates between chunks of one reply, so a chunk that
// follows such an update starts a new segment. When the earlier text does not
// already end in whitespace, a paragraph break keeps the two segments from
// running together in the combined turn text ("fix." + "While").
export class SegmentJoiner {
  private gap = false;

  /** Reasoning or a tool update happened since the last reply chunk. */
  boundary(): void { this.gap = true; }

  /** The text to emit for a reply chunk, given everything emitted so far this turn. */
  chunk(text: string, emittedSoFar: string): string {
    const needsBreak = this.gap && emittedSoFar.length > 0 && !/\s$/.test(emittedSoFar) && !/^\s/.test(text);
    this.gap = false;
    return needsBreak ? `\n\n${text}` : text;
  }

  reset(): void { this.gap = false; }
}

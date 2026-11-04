// docs/ARCHITECTURE.md - operator->agent output bridge (pure core).
//
// Formats a slice of SELECTED terminal output as a quoted context block and
// APPENDS it to the operator's existing composer draft. This is the only
// computational part of K5; the rest is a button + a setDraft call.
//
// THE load-bearing fence: this is operator-action-only. Nothing here sends a
// turn or auto-feeds the agent — it merely produces the new draft string the
// operator then edits/sends themselves. No streaming, no background capture.

// A fenced code block keeps the raw output verbatim (no markdown mangling of
// `$`, backticks, indentation) and reads as "here's a literal terminal dump"
// to the agent. We pick a fence long enough to never collide with backtick
// runs inside the selection (CommonMark: the closing fence must be >= the
// opening and the content may contain shorter runs).
export function buildQuotedTerminalBlock(selection: string): string {
  // Trim only trailing whitespace/newlines so the block ends cleanly; keep
  // leading content intact (indentation can be meaningful in a trace).
  const body = selection.replace(/\s+$/, '');
  let longestRun = 0;
  let run = 0;
  for (const ch of body) {
    if (ch === '`') { run += 1; if (run > longestRun) longestRun = run; }
    else run = 0;
  }
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `Terminal output:\n${fence}\n${body}\n${fence}`;
}

// Append the quoted block to whatever the operator already has in the composer.
// Separated from the current draft by a blank line so it reads as its own
// paragraph; if the draft is empty we don't lead with stray newlines.
export function appendToDraft(currentDraft: string, selection: string): string {
  const block = buildQuotedTerminalBlock(selection);
  const base = currentDraft.replace(/\s+$/, '');
  return base.length > 0 ? `${base}\n\n${block}` : block;
}

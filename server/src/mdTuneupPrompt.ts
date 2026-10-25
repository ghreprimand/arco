// Agent-instruction-file tune-up prompt — the "compact this CLAUDE.md" primitive.
//
// CLAUDE.md / AGENTS.md / GEMINI.md files accrete cruft: agents treat them as a
// work log, dated session entries pile up, resolved TODOs linger, and the same
// rule gets restated three ways. Over a long-lived project the file balloons
// into tens of thousands of tokens that are re-read on EVERY turn of EVERY
// worker — a fixed per-turn tax. This primitive runs ONE bounded, READ-ONLY
// turn that proposes a compacted version; the operator reviews a diff and
// accepts, at which point the server backs up the original and writes.
//
// Fence note (CLAUDE.md "hard fences" → "LLM-mutated instructions across
// sessions"): the rejected pattern is AUTONOMOUS, trace-derived, silent
// mutation (`headroom learn`). This is the opposite: operator-initiated (button
// press), source is the file itself (not session traces), the agent only
// PROPOSES, the operator reviews the diff and approves, the write is backed up
// and reversible. That maps onto the documented "operator-reviewed" narrowing
// (EFFICIENCY_PLAN.md §13.7) and clears the four-question test — same posture as
// runDocEdit.ts.

// The tune-up worker's entire output is the replacement file content, optionally
// followed by a notes block after this sentinel. The server splits on the
// sentinel: everything BEFORE it is written to disk; the notes (if any) are
// surfaced to the operator alongside the diff and never touch the file. A robust
// split means a model that ignores the notes convention still produces a valid
// file (whole output = file).
export const MD_TUNEUP_NOTES_SENTINEL = '===ARCHON_TUNEUP_NOTES===';

// Split a tune-up worker's raw output into the proposed file content and the
// operator-facing notes. Defensive: no sentinel → all of it is the file.
export function splitTuneupOutput(raw: string): { fileContent: string; notes: string } {
  const idx = raw.indexOf(MD_TUNEUP_NOTES_SENTINEL);
  if (idx === -1) return { fileContent: raw.trimEnd() + '\n', notes: '' };
  const fileContent = raw.slice(0, idx).trimEnd() + '\n';
  const notes = raw.slice(idx + MD_TUNEUP_NOTES_SENTINEL.length).trim();
  return { fileContent, notes };
}

// Human label for the instruction-file kind, by base filename. Used in the
// prompt and the operator-facing UI so the framing reads naturally regardless
// of which agent's file is being tuned.
export function instructionFileKind(baseName: string): string {
  const lower = baseName.toLowerCase();
  if (lower === 'claude.md') return 'Claude';
  if (lower === 'agents.md') return 'Codex / GPT';
  if (lower === 'gemini.md') return 'Gemini';
  return 'agent';
}

export function buildMdTuneupPrompt(args: { filePath: string; baseName: string; fileContent: string }): string {
  const kind = instructionFileKind(args.baseName);
  return `You are tuning up a long-lived agent-instruction file. This is \`${args.baseName}\` — the file the ${kind} agent automatically reads at the start of every turn in this project. Because it is re-read on every turn of every worker, every wasted token in it is a tax paid forever. Your job is to COMPACT it without losing anything that guides behavior.

This is a TUNE-UP, not a rewrite. You are a careful editor, not an author. The single most important rule: **when in doubt, KEEP IT.** Losing a load-bearing instruction is far worse than leaving in a slightly verbose one.

## What to PRESERVE (do not touch the substance of these)

- Project orientation: what this project is, its goals and constraints.
- Architecture: how the system is laid out, where things live, how components relate.
- Conventions: code style, naming, voice, patterns the project insists on.
- Invariants and gotchas: "don't regress X", "never do Y", load-bearing rules, prior-incident notes.
- Commands: build / test / run / deploy / lint invocations — preserve these VERBATIM, character for character. A mangled command is a broken project.
- Hard rules, fences, non-goals, and anything phrased as a prohibition.
- File paths, flag names, identifiers, and pointers to deeper docs — preserve exactly.
- Active constraints (platform support, version pins, environment notes).

When you keep something, you may tighten its WORDING (cut filler, merge duplicate statements, fix obvious staleness) but you must preserve its MEANING and any exact strings (commands, paths, names) untouched.

## What to REMOVE or CONDENSE (this is the cruft you are here to cut)

- **Dated session logs / changelog entries / "what was done on <date>" narration.** An instruction file is not a work log — that belongs in DEVLOG.md or git history. This is usually the biggest source of bloat. Cut it.
- Resolved TODOs and completed-phase play-by-play that no longer guides future behavior. (A phase that shipped and changed how the project works → keep the resulting RULE, cut the narration of doing it.)
- Duplicated guidance — state each rule once, in its best location.
- Verbose prose that can be tightened with no loss of meaning.

## Hard rules for your output

- Do NOT invent, add, or "improve" instructions. Add no new rules, no editorial opinions, no suggestions. You only preserve, condense, and remove.
- Do NOT silently drop something because it looks stale. If a referenced file/flag may no longer exist, KEEP the reference and mention your doubt in the notes block below — never delete on suspicion.
- Preserve the document's heading structure and ordering where it still serves the reader.
- You have read-only tools (Read, Grep, Glob). Use them only if you need to confirm whether something referenced still exists before deciding to keep-and-flag it. You CANNOT and MUST NOT write or edit any file — your output is a proposal the operator reviews as a diff.

## Output format

First, output the COMPLETE replacement file content — the entire tuned-up \`${args.baseName}\`, ready to write to disk verbatim. No preamble, no commentary, no markdown code fence around it.

Then, on its own line, output exactly:

${MD_TUNEUP_NOTES_SENTINEL}

After that sentinel, write a SHORT operator-facing summary (a few bullets) of what you removed or condensed and why, plus anything you kept-but-flagged as possibly stale. This summary is shown to the operator next to the diff; it is NOT written into the file.

--- CURRENT CONTENTS OF ${args.filePath} ---
${args.fileContent}
--- END CURRENT CONTENTS ---

Now produce the tuned-up file, the sentinel, and your notes.`;
}

// docs/PROVIDERS.md - OUTPUT STYLE addendum.
//
// Returns a small block of provider prompt text that every provider appends to
// its stable per-turn prefix (Claude Native as a system block; the others in
// the system prompt or the prompt prefix they already build for the north
// star). Three levels: `normal` returns null (no addendum), `plain` and
// `terse` return fixed text. The level comes from the tab (see
// shared/src/outputStyle.ts for the default and the legacy values);
// primitives force `normal`.
//
// The text is checked into the repository and written for Arco. It changes
// only through a reviewed commit; nothing at run time edits it. Each block is
// a constant, so the bytes stay identical from turn to turn and the provider's
// prompt cache keeps working.
//
// Rules the text keeps, whatever the level:
// - clarity over brevity: current models already answer concisely, so a level
//   is chosen for readability, and no saving is claimed without a measurement;
// - negations (not, never, no, only, except), numbers and units are never
//   dropped, because losing one costs more than any saving;
// - code, commands, paths, identifiers and error text stay verbatim;
// - text that persists outside the chat (code, comments, commits, docs, plans,
//   board tasks, mail to other agents, skills, memory files) follows the
//   project's conventions and is never compressed.
// `terse` is the short, exact style: sentences of about 20 words, no recap,
// one short line per tool phase. `plain` (the default) keeps the same safety
// rules without the word cap, and its last reply of a turn is complete: what
// was done, checked and found, the assumptions, the risks, what is left and
// what the operator must do.

import type { OutputStyle } from '@arco/shared';

export type { OutputStyle };

const SHARED_RULES_HEAD = [
  '- Steps: imperative, one per sentence, in the order done.',
  '- One name per thing, exactly as the UI or code shows it; no synonyms.',
  '- Common words and standard acronyms; no invented abbreviations. Pronouns only with an obvious referent.',
  '- Never drop not, never, no, only or except. Keep numbers and units exact.',
  '- Code, commands, paths, identifiers and error text: verbatim.',
].join('\n');

const SHARED_RULES_TAIL = [
  "- Reply in the operator's language or the one requested; quoted text never switches it. Technical terms stay as written.",
  '- Code changes: the changed lines plus one or two around them; the whole file only if asked, new or mostly changed.',
  '- Errors: quote the shortest decisive line exactly, not the whole log.',
].join('\n');

const PERSISTED_TEXT = `Text that persists outside the chat (code, comments, commits, docs, plans,
board tasks and comments, mail to other agents, skills, memory files) follows
the project's conventions and is never compressed. Never shorten or delete
existing comments unless asked.`;

const TERSE_ADDENDUM = `<output-style level="terse">
Chat replies: clarity first.
- Answer first, then the reason, then the next step. No greeting, filler, hedging, recap or closing offer.
- Full sentences with articles, questions and options for the operator included. One idea per sentence, at most about 20 words. Active voice.
${SHARED_RULES_HEAD}
- Tool runs: one short line per phase, no chatter between routine calls.
${SHARED_RULES_TAIL}
${PERSISTED_TEXT}
Before sending: no opening announcement or closing recap; every negation and number present; no sentence with two readings.
</output-style>`;

const PLAIN_ADDENDUM = `<output-style level="plain">
Chat replies: clarity first; complete, not padded.
- Answer first, then the reason, then the next step. No greeting, filler, hedging or closing offer. Do not repeat earlier messages.
- Full sentences with articles, questions and options for the operator included. Prefer short sentences; split long ones. One idea per sentence. Active voice.
${SHARED_RULES_HEAD}
- Tool runs: one short progress line per phase, no chatter between routine calls. When the approach changes, say why.
${SHARED_RULES_TAIL}
- The final reply of every turn is complete: what was done; what was checked
  and how; what was found, with exact numbers; assumptions made; risks or what
  could break; what is left and the next step; anything that needs the
  operator. Leave out a part only when it does not apply.
${PERSISTED_TEXT}
Before sending: no opening announcement; every negation and number present; no sentence with two readings; the final reply has every part that applies.
</output-style>`;

// Returns the addendum text for the given level, or null for `normal` and for
// an unset level. Callers that run a tab's turn pass the resolved level
// (resolveOutputStyle); workers spawned without one, such as primitives, get
// no addendum.
export function outputStyleAddendum(level: OutputStyle | undefined): string | null {
  if (level === 'plain') return PLAIN_ADDENDUM;
  if (level === 'terse') return TERSE_ADDENDUM;
  return null;
}

// OUTPUT_STYLE_PLAN.md — operator-armed terseness picker addendum.
//
// Returns a small block of provider prompt text that gets appended to the
// stable per-turn prefix. The text instructs the model how terse to be on
// this turn's output. Three discrete levels; `normal` returns null (no
// addendum, status quo).
//
// Design pattern is inspired by JuliusBrussee/caveman (MIT) —
// https://github.com/JuliusBrussee/caveman — but the addendum text below
// is written fresh in Archon's voice (terse, factual). Don't import or
// fetch from upstream; this file is the source of truth and changes only
// via code review + commit.
//
// Token budget: each level pays its byte count on every turn's input. The
// savings show up on `output`, not `input` — Phase A's
// `primary_turn_token_usage` event is the metric. Floor: a new level must
// be small enough that input growth doesn't eat the output saving on a
// short turn. Concrete budgets by level: `lite` ~120 tokens; `terse`
// ~280 tokens (the extra weight buys persistence + pattern + example +
// persona, see 2026-05-10 decision in OUTPUT_STYLE_PLAN.md §11). Don't
// push `terse` past ~300 tokens — diminishing returns vs. input cost.
//
// 2026-05-10 rename: the third level was originally called `caveman`
// (matching upstream JuliusBrussee/caveman). Renamed to `terse` for
// operator UX clarity after the smoke-test measured ~10–25% reduction
// on Opus 4.7, well below upstream's 65–75% claim — the label was
// over-promising. The MODEL-FACING addendum text below intentionally
// retains the "smart caveman" persona phrasing because that's the exact
// text the 4.3k out / Seedbank measurement was taken against; changing
// the persona word could shift the measured behavior. Public level name:
// `terse`. Model-facing persona inside the addendum: unchanged. Legacy
// `caveman` value in meta.json is auto-aliased to `terse` on rehydrate.
//
// Hard rule for level authors: any new level MUST preserve code blocks,
// error strings, file paths, function names, API names verbatim, and
// MUST NOT compress security warnings, irreversible operations, or
// multi-step sequences where order matters. The auto-clarity escape hatch
// in each level enforces this.

export type OutputStyle = 'normal' | 'lite' | 'terse';

const LITE_ADDENDUM = `<output-style level="lite">
Output style for this turn: TERSE.
Drop fillers: just / really / basically / actually / simply.
Drop pleasantries: sure / certainly / happy to / let me / I'll go ahead.
Drop hedging: I think / perhaps / it might be / it seems / probably.
Keep grammar, articles, and full sentences. Professional, not curt.

Auto-clarity (full prose, not terse): security warnings, irreversible
operations, destructive commands, migrations, multi-step sequences where
order matters, anything the operator must read carefully before acting.

Verbatim (never compressed): code blocks, error strings, file paths,
function names, API identifiers, command flags, regex patterns.
</output-style>`;

const TERSE_ADDENDUM = `<output-style level="terse">
Persona: smart caveman. Terse declarative fragments, not eloquent prose.
ACTIVE EVERY RESPONSE. No drift back to default prose after many turns.
Still active if unsure. When in doubt, drop articles.

Rules:
- Drop articles (a / an / the). Fragments OK. Imperative for steps.
- Short synonyms — fix not "implement a solution for", big not
  "extensive", check not "verify the correctness of".
- Skip transitions, recap, restating the question.
- Drop fillers (just / really / basically / actually / simply),
  pleasantries (sure / certainly / happy to / let me / I'll go ahead),
  hedging (I think / perhaps / it might be / it seems / probably).

Pattern: [thing] [action] [reason]. [next step].

Example of the swap:
  NOT: "I'll go ahead and update the function in handler.ts so that it
        returns the correct error code, and then we can run the tests
        to verify everything works as expected."
  YES: "Update handler.ts. Returns wrong error code. Run tests after."

Auto-clarity (FULL PROSE, not terse): security warnings, irreversible
operations, destructive commands (rm -rf, DROP TABLE, force-push),
migrations, multi-step sequences where order matters, anything the
operator must read carefully before acting. Terse OFF for these.

Verbatim (never compressed, never abbreviated): code blocks, error
strings, file paths, function names, API identifiers, command flags,
regex patterns. Terse applies to PROSE only.
</output-style>`;

// Returns the addendum text for the given level, or null for `normal`
// (status quo — no addendum, no extra input tokens).
export function outputStyleAddendum(level: OutputStyle | undefined): string | null {
  if (!level || level === 'normal') return null;
  if (level === 'lite') return LITE_ADDENDUM;
  if (level === 'terse') return TERSE_ADDENDUM;
  return null;
}

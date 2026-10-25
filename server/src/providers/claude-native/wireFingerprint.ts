// Claude-Code wire fingerprint the Native transport presents on the OAuth
// subscription path (messages.create + /v1/models). Single source of truth —
// worker.ts and catalog.ts both read it, so a bump can never split them.
//
// The pin is DELIBERATE, not tracked from `claude --version`: a routine
// `claude update` must not silently change what Anthropic's edge sees
// (CLAUDE_NATIVE_PLAN.md §12 risk #3). Bump only on an observed Anthropic-side
// rejection, and re-validate a Native turn afterwards.
//
// History:
//   2.1.75  — lifted from Pi 2026-05-07; ran ~4 months unchanged.
//   2.1.257 — 2026-09-01. Fable 5.1 turns 400'd with "Claude Code 2.1.75 does
//             not support this model; version 2.1.251 or newer is required".
//             Set to the CLI installed on the box at the time (2.1.257).
//             Verified end-to-end: Fable 5.1 + this UA + FORCED_FIRST_BLOCK →
//             200 with input_transformations=[] (binding beta accepted).
//   2.1.280 — 2026-09-22. Opus 5.5 launch; operator saw the same
//             "version … or newer is required" rejection. Set to the CLI
//             installed on the box (2.1.280).
export const CLAUDE_CLI_VERSION = '2.1.280';
export const CLAUDE_CLI_USER_AGENT = `claude-cli/${CLAUDE_CLI_VERSION}`;

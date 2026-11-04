// Claude-Code wire fingerprint the Native transport presents on the OAuth
// subscription path (messages.create + /v1/models). Single source of truth —
// worker.ts and catalog.ts both read it, so a bump can never split them.
//
// The pin is DELIBERATE, not tracked from `claude --version`: a routine
// `claude update` must not silently change what Anthropic's edge sees
// (docs/PROVIDERS.md risk #3). Bump only on an observed Anthropic-side
// rejection, and re-validate a Native turn afterwards.
//
// Fable 5.1 requires CLI version 2.1.251 or newer. Keep the pinned version
// compatible with the supported models and validate changes across call sites.
export const CLAUDE_CLI_VERSION = '2.1.280';
export const CLAUDE_CLI_USER_AGENT = `claude-cli/${CLAUDE_CLI_VERSION}`;

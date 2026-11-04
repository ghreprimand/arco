// docs/PROVIDERS.md - filter dispatcher. Resolves a tool call
// (`toolName` + input record) to a `FilterPack` for the active operator
// mode. Returns `null` for passthrough.
//
// Mode semantics (matches `WorkflowConfig.efficiencyToolFilter`):
//   off          — never returns a pack; raw output flows through.
//   conservative — tests + git-status + find/grep/ls (default ship).
//   aggressive   — conservative + npm install / cargo build / docker build /
//                  git push (deferred named follow-ups; not yet authored).
//
// **Aggressive packs are deliberately deferred.** Phase C ships conservative
// only per §2.4 ("don't ship aggressive defaults — new filter packs ship as
// opt-in until measured for at least a week"). The `aggressive` mode currently
// resolves to the conservative pack list; promoting filters into it requires
// a follow-up phase with operator data showing the conservative wins are
// real and the aggressive packs don't bury operator-relevant errors.

import type { FilterPack } from '../filterToolResult.js';
import { bashCargoTest } from './bash-cargo-test.js';
import { bashJestVitest } from './bash-jest-vitest.js';
import { bashPytest } from './bash-pytest.js';
import { bashGitStatus } from './bash-git-status.js';
import { bashFind } from './bash-find.js';
import { bashGrep } from './bash-grep.js';
import { bashLs } from './bash-ls.js';

export type FilterMode = 'off' | 'conservative' | 'aggressive';

// Map a Bash command (the `command` field from the Bash tool input) to a
// pack. Match on the leading whitespace-delimited token after stripping
// common prefixes (`sudo`, `time`, env-var assignments). Conservative
// matching — we don't try to parse pipelines; if the user runs
// `cargo test | tee out.log`, the leading `cargo test` still wins.
function classifyBashCommand(command: string): FilterPack | null {
  const cmd = command.replace(/^\s*(?:sudo\s+|time\s+|nice\s+(?:-n\s*-?\d+\s+)?|[A-Z][A-Z0-9_]*=\S+\s+)+/, '').trimStart();
  // Take the first token + the second token (so `cargo test`, `git status`,
  // `npm install` resolve via the joined prefix).
  const m = cmd.match(/^(\S+)(?:\s+(\S+))?/);
  if (!m) return null;
  const head = m[1];
  const sub = m[2];
  if ((head === 'cargo' && sub === 'test') || head === 'cargo-test') return bashCargoTest;
  if (head === 'jest' || (head === 'npx' && sub === 'jest')) return bashJestVitest;
  if (head === 'vitest' || (head === 'npx' && sub === 'vitest')) return bashJestVitest;
  if (head === 'pytest' || (head === 'python' && /pytest/.test(cmd)) || (head === 'python3' && /pytest/.test(cmd))) return bashPytest;
  if (head === 'git' && sub === 'status') return bashGitStatus;
  if (head === 'find') return bashFind;
  if (head === 'grep' || head === 'rg' || head === 'egrep' || head === 'fgrep') return bashGrep;
  if (head === 'ls' || head === 'la' || head === 'll') return bashLs;
  return null;
}

// Resolve a tool call to a filter pack. Returns null on mode=off, on tools
// we don't have a pack for, and on Bash commands that don't match any
// classifier rule.
export function resolveFilterPack(
  toolName: string,
  toolInput: Record<string, unknown>,
  mode: FilterMode,
): FilterPack | null {
  if (mode === 'off') return null;
  // Bash is the only tool we filter today. Read/Write/Edit/Grep (the native
  // Grep tool, distinct from a `Bash(grep ...)` shell-out) are already
  // bounded by `MAX_TOOL_OUTPUT_BYTES`; layering a pack on top changes
  // their semantics for marginal byte savings.
  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    if (!command) return null;
    return classifyBashCommand(command);
  }
  return null;
}

export const ALL_PACKS: FilterPack[] = [
  bashCargoTest,
  bashJestVitest,
  bashPytest,
  bashGitStatus,
  bashFind,
  bashGrep,
  bashLs,
];

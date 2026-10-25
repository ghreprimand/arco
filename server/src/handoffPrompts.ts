// Phase 3 (operator-features) — operator-editable Handoff prompts.
//
// Two override files per scope:
//   <root>/.arco/handoff.prompt.md            — `original-worker` reflection
//   <root>/.arco/handoff.summarizer.prompt.md — `fresh-summarizer` framing
//
// Roots: project (<cwd>) wins over global (~/.arco). When neither exists,
// `runExportContext` falls back to the hard-coded default templates exported
// here. The defaults double as the editor's seed text — the UI shows them as
// the starting point operators can edit, and [RESET TO DEFAULT] writes the
// default verbatim or, more cleanly, deletes the override file (we delete).
//
// Variables substituted into the prompt at run time:
//   {{cwd}}         — workflow's working directory
//   {{wfid}}        — workflow id
//   {{handoffPath}} — absolute path of the artifact the agent must write
//   {{seedPrefix}}  — the literal `[HANDOFF —` Review's `current-session`
//                     scope detects; exposed so operators reference it
//                     instead of hard-coding (and silently drifting from the
//                     server's matcher).
//
// Validation is advisory — `validateOverride` returns warnings the editor
// surfaces in a banner before save, but save is never blocked. The two
// load-bearing checks are documented in `docs/GOTCHAS.md` § Handoff prompt
// overrides: missing `{{handoffPath}}` or `[HANDOFF_COMPLETE]` will produce
// a doc the server can't validate (no file on disk) or a session the
// reflection turn won't gracefully end.

import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { arcoHome } from './arcoHome.js';

// 'ollama-compaction' rides the same project>global>default override + editor
// machinery as the two handoff prompts (WP4). It is not a Handoff mode — it
// frames the Ollama auto-compaction summary call — but the resolution rules,
// file layout, and editor are identical, so reusing this registry avoids a
// parallel copy of the same plumbing. It substitutes no variables.
export type HandoffPromptMode = 'original-worker' | 'fresh-summarizer' | 'ollama-compaction';
export type HandoffPromptScope = 'project' | 'global';

// The literal seed-prefix Review's `current-session` scope detects (see
// `server/src/primitives/reviewContent.ts` and `docs/GOTCHAS.md` §
// Seed-bubble pills). Exposed as the `{{seedPrefix}}` substitution so an
// operator-edited prompt can reference it without forking the constant.
export const HANDOFF_SEED_PREFIX = '[HANDOFF —';

const FILE_BY_MODE: Record<HandoffPromptMode, string> = {
  'original-worker': 'handoff.prompt.md',
  'fresh-summarizer': 'handoff.summarizer.prompt.md',
  'ollama-compaction': 'ollama.compaction.prompt.md',
};

const BODY_MAX = 64 * 1024;

// Default templates. These are the literal strings runExportContext used to
// produce inline; extracting them here is the override mechanism. The
// `{{handoffPath}}` placeholder replaces what was previously a string-
// concat'd absolute path.

const DEFAULT_ORIGINAL_WORKER_TEMPLATE = `[ARCO HANDOFF — INTERNAL INSTRUCTION]

You are being asked to generate a handoff document to preserve this session's context for a successor agent. You have full context of what happened this session; the successor will have none. Your job is to ORIENT the successor, not to transcribe the session.

## Length budget — read this first

The successor is a capable agent with full tool access (Read, Grep, Bash, git). It can and will read the repo. So the handoff is a map, not a mirror.

- Target **1,500–3,000 words** (~2,000–4,000 tokens). Hard ceiling: **~4,500 words / ~6,000 tokens.** A handoff that approaches the size of the work it describes has failed.
- **Never paste file contents, diffs, or full command output.** Reference code as \`path/to/file.ts:line\` and let the successor read it.
- **Omit anything recoverable cheaply.** If \`git log\`, \`git diff\`, or reading one named file would tell the successor something, point them there instead of reproducing it.
- Spend your budget on what the successor CANNOT reconstruct: intent, non-obvious decisions, dead ends already tried, and the precise next step.

## Step 1 — Inspect actual project state

Use your tools (Bash, Read, Grep, Glob) to gather ground-truth state. Do not rely on memory alone — things may have drifted.

- \`git status\` — what's uncommitted
- \`git log --oneline -20\` — recent commits
- \`git diff --stat\` — scope of unstaged changes (if any)
- Read any of these that exist at the repo root: \`CLAUDE.md\`, \`PLAN.md\`, \`DEVLOG.md\`, \`README.md\`. They often encode the project's conventions and current phase.

## Step 2 — Write the handoff document

Use the Write tool to save the handoff document to EXACTLY this absolute path:

{{handoffPath}}

Use this structure (markdown):

\`\`\`
# Handoff — <short session title>

## Session summary
One paragraph: what the operator asked for this session, what you actually did, and whether the ask is fully done or partially done.

## Work completed
The changes that matter for understanding the current state — as a tight, file-referenced list. Format: \`path/to/file.ts:line\` — brief what/why. Reference commit SHAs instead of describing diffs. Do NOT reproduce code or exhaustively enumerate every edit; the successor can read \`git diff\`.

## Key decisions & rationale
Non-obvious design calls, tradeoffs you considered, and why the chosen path won. Include anything the successor would likely re-litigate if they don't know the reasoning.

## Project state
Current branch, uncommitted changes, whether typecheck/tests were clean last run, dev-server state. Use the git output from Step 1.

## Open threads
In-progress work, known issues, TODOs you discovered, gotchas. Anything the successor should know BEFORE they start touching code.

## Next-agent prompt
A complete, self-contained prompt the successor can read cold and act on. Include:
  - What to focus on first (priority order if multiple threads are open)
  - Relevant file paths and line numbers
  - Commands to run to get oriented (\`{{verifyCommand}}\`, \`git log\`, etc.)
  - Any gotchas from "Open threads" the successor needs to internalize
\`\`\`

## Step 3 — Update project docs (if they exist)

If \`DEVLOG.md\` exists at the repo root, prepend a new top-of-file entry summarizing this session. Match the format and depth of neighboring entries if there's an established convention; otherwise use:

\`\`\`
## <YYYY-MM-DD> — <Short session title>

<One to three paragraphs describing what was done, referencing files/commits.>
\`\`\`

If \`PLAN.md\` exists and you completed one or more planned phases this session, update that file:
- Mark the completed phase(s) as shipped in-place.
- Add a one-line deviation note if the as-built differs from the plan.

## Step 4 — Signal completion

End your reply with exactly this token on its own line, as the very last line:

[HANDOFF_COMPLETE]

## Guardrails

- Be concise over exhaustive, but never vague. Pointers (\`path:line\`, commit SHA) beat pasted content every time. Respect the length budget above.
- Do not guess. If something is ambiguous or unknown, say so explicitly in the handoff rather than fabricating.
- Do NOT commit anything to git. Your job is to document state, not change version control.
- If you discover something surprising (e.g., uncommitted changes you didn't make), flag it in "Open threads" — don't clean it up silently.`;

const DEFAULT_FRESH_SUMMARIZER_TEMPLATE = `You are a FRESH agent with full context, writing a handoff document so a different agent can continue this work. You did NOT do the work below — you are reading a record of it.

IMPORTANT — about your source material: the agent who did this work may have been running low on context near the end, so its own narrative in the transcript can be incomplete, vague, or slightly wrong about what actually landed on disk. Do not take the conversation at face value. Specifically:

1. Treat the "Actions taken" digest (files read/written, commands run, tools used) as the GROUND TRUTH for what was actually done — it is a deterministic record extracted from the session's tool calls, not the model's recollection. When the transcript and the digest disagree, the digest wins.
2. Before asserting the current state of any key file or path mentioned in the work, VERIFY it with your tools (Read / Grep / Glob). You have read-only access. Spot-check the files the digest says were written; confirm functions/edits the transcript claims actually exist. Anchor your "Current state" section to what you observe, not what the transcript says.
3. If \`CLAUDE.md\` or \`DEVLOG.md\` exists at the repo root, read it for grounding — it encodes the project's conventions and current phase, and DEVLOG's top entry often states where things actually stand.
4. Do NOT invent details. Where the transcript is ambiguous and your tools can't resolve it, flag the ambiguity explicitly in the handoff rather than guessing.

Output as markdown with exactly these sections in this order:

## Project overview
What the project is and what the operator is trying to accomplish.

## Current state
What has been done so far — files modified, decisions made, tests passing/failing, open artifacts. Ground this in the Actions-taken digest and your own tool-verified observations, not just the transcript narrative.

## Open threads
What's in progress, unresolved, or next. Include anything you found surprising during verification (e.g. a change the transcript claimed that you couldn't confirm on disk).

## Next-agent prompt
A complete, self-contained prompt the incoming agent can read to pick up from here. Include relevant file paths, current branch, and what to focus on first.

## Length budget

The incoming agent has full tool access and will read the repo — this document is a map, not a mirror.
- Target **1,500–3,000 words** (~2,000–4,000 tokens); hard ceiling **~4,500 words / ~6,000 tokens**.
- **Never paste file contents, diffs, or long command output.** Reference code as \`path/to/file.ts:line\`.
- Omit anything the incoming agent can cheaply recover from \`git log\`, \`git diff\`, or reading a named file. Spend the budget on intent, non-obvious decisions, and the precise next step.`;

// Default Ollama auto-compaction summary framing. Dense, factual, no preamble —
// M8 folds the result back into the transcript as a synthetic system/summary
// block, so it must be self-contained prose, not a chat reply. This is the
// SINGLE SOURCE OF TRUTH: ollamaUtility.ts re-exports it as the
// runUtilitySummaryJob fallback default. It lives here (a near-leaf module with
// no Ollama deps) rather than in ollamaUtility.ts to avoid an import cycle
// (ollama → handoffPrompts → ollamaUtility → ollama would be evaluation-order
// fragile because DEFAULT_TEMPLATES references it at module load).
export const DEFAULT_COMPACTION_FRAMING = [
  'You are compacting the older part of a coding conversation to free context.',
  'Summarize the messages below into a dense, factual recap that preserves:',
  '- the task / goal and any decisions made',
  '- files, commands, and identifiers touched',
  '- the current state and any unresolved threads',
  'Output ONLY the recap prose — no preamble, no sign-off, no "here is".',
].join('\n');

export const DEFAULT_TEMPLATES: Record<HandoffPromptMode, string> = {
  'original-worker': DEFAULT_ORIGINAL_WORKER_TEMPLATE,
  'fresh-summarizer': DEFAULT_FRESH_SUMMARIZER_TEMPLATE,
  'ollama-compaction': DEFAULT_COMPACTION_FRAMING,
};

function rootForScope(scope: HandoffPromptScope, cwd: string): string {
  if (scope === 'global') return arcoHome();
  if (!cwd) throw new Error('project scope requires cwd');
  return path.join(cwd, '.arco');
}

function overridePath(scope: HandoffPromptScope, mode: HandoffPromptMode, cwd: string): string {
  const root = rootForScope(scope, cwd);
  const file = FILE_BY_MODE[mode];
  const candidate = path.resolve(root, file);
  const rootResolved = path.resolve(root);
  // Guardrail mirrored from skills.ts: the file must live directly in the
  // scope root. With a fixed basename this is structurally guaranteed, but
  // re-asserting matches the codebase's defensive habit.
  if (!candidate.startsWith(rootResolved + path.sep)) {
    throw new Error('handoff-prompt path escapes scope root');
  }
  return candidate;
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface EffectivePrompt {
  template: string;
  source: 'project' | 'global' | 'default';
  sourcePath: string | null;
}

// Project beats global beats default. Empty / whitespace-only files are
// treated as absent so an operator who wants to "blank" a prompt has to
// use DELETE (which removes the override outright) rather than save an
// empty body and silently fall through.
export async function loadEffectivePrompt(
  mode: HandoffPromptMode,
  cwd: string,
): Promise<EffectivePrompt> {
  if (cwd) {
    const projectPath = overridePath('project', mode, cwd);
    const projectBody = await readIfExists(projectPath);
    if (projectBody && projectBody.trim().length > 0) {
      return { template: projectBody, source: 'project', sourcePath: projectPath };
    }
  }
  const globalPath = overridePath('global', mode, '');
  const globalBody = await readIfExists(globalPath);
  if (globalBody && globalBody.trim().length > 0) {
    return { template: globalBody, source: 'global', sourcePath: globalPath };
  }
  return { template: DEFAULT_TEMPLATES[mode], source: 'default', sourcePath: null };
}

export async function readOverride(
  scope: HandoffPromptScope,
  mode: HandoffPromptMode,
  cwd: string,
): Promise<string | null> {
  return readIfExists(overridePath(scope, mode, cwd));
}

export async function writeOverride(
  scope: HandoffPromptScope,
  mode: HandoffPromptMode,
  cwd: string,
  body: string,
): Promise<void> {
  if (body.length > BODY_MAX) {
    throw new Error(`handoff prompt too long (>${BODY_MAX})`);
  }
  const filePath = overridePath(scope, mode, cwd);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body, 'utf8');
}

export async function deleteOverride(
  scope: HandoffPromptScope,
  mode: HandoffPromptMode,
  cwd: string,
): Promise<boolean> {
  try {
    await fs.unlink(overridePath(scope, mode, cwd));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export interface PromptVariables {
  cwd: string;
  wfid: string;
  handoffPath: string;
  // H54 — the project's detected primary verify command (Handoff/Spawn seeds
  // reuse it instead of the hard-coded `npm run dev`). Falls back to `npm run
  // dev` when no facts were probed, preserving prior behavior.
  verifyCommand?: string;
}

// Substitute {{cwd}} / {{wfid}} / {{handoffPath}} / {{seedPrefix}}. Unknown
// `{{...}}` tokens pass through untouched so an operator can reference Pi-
// style placeholders the agent itself recognizes without our substitutor
// eating them.
export function renderPrompt(template: string, vars: PromptVariables): string {
  const map: Record<string, string> = {
    cwd: vars.cwd,
    wfid: vars.wfid,
    handoffPath: vars.handoffPath,
    seedPrefix: HANDOFF_SEED_PREFIX,
    verifyCommand: vars.verifyCommand ?? 'npm run dev',
  };
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : whole;
  });
}

export interface ValidationReport {
  warnings: string[];
}

// Advisory checks for the editor banner. Save is never blocked — operators
// occasionally want to experiment, and the file-existence check after
// reflection settles is the actual safety net. But these two omissions are
// almost always operator error, so calling them out before save spares a
// failed handoff round-trip.
export function validateOverride(mode: HandoffPromptMode, body: string): ValidationReport {
  const warnings: string[] = [];
  if (mode === 'original-worker') {
    if (!body.includes('{{handoffPath}}')) {
      warnings.push('Missing `{{handoffPath}}` — the agent will not know where to write the handoff document.');
    }
    if (!body.includes('[HANDOFF_COMPLETE]')) {
      warnings.push('Missing `[HANDOFF_COMPLETE]` sentinel — without it the reflection turn has no clean end-of-output marker.');
    }
  }
  // fresh-summarizer doesn't use Write or HANDOFF_COMPLETE — the worker's
  // collected text becomes the artifact directly.
  return { warnings };
}

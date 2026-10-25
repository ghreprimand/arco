// DD10 — parameterized `/prompt` commands. OPERATOR-facing (distinct from the
// model-facing skills in skills.ts): an operator types `/deploy staging fast` in
// the composer and the server replaces it with the expanded body of a template
// file BEFORE the turn is recorded — so events.jsonl carries the real prompt, not
// the shorthand. Templates live in:
//   • <cwd>/.archon/prompts/<name>.md   (project — gated behind DD7 trust)
//   • ~/.archon/prompts/<name>.md       (global  — the operator's own, ungated)
//
// Substitution is bash-positional: `$1`..`$9` / `${1}`..`${N}` are the parsed
// args, `$@` / `$*` are all args space-joined, and `$$` is a literal `$`. An
// unbound positional expands to empty. Args are tokenized with shell-style quotes
// (reusing splitArgs from configValue).
//
// Project-scope is gated behind DD7 trust: a cloned repo can ship a hostile
// `.archon/prompts/*.md`, so a project template only expands when the repo's
// trust decision is 'always'. Global templates are the operator's own.

import { readdir, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';

import { splitArgs } from './configValue.js';
import { archonHome } from './archonHome.js';

export type PromptScope = 'project' | 'global';

export interface PromptSummary {
  name: string;       // the slug == the invocation token (`/<name>`)
  description: string; // optional one-liner from frontmatter
  scope: PromptScope;
  path: string;
}

// Same slug shape as skills — lowercase, digits, dashes; bounded.
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidPromptName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

function projectPromptsRoot(cwd: string): string {
  return path.join(cwd, '.archon', 'prompts');
}
function globalPromptsRoot(): string {
  return path.join(archonHome(), 'prompts');
}

// Parse a leading `/name args…` out of composer text. Returns null when the text
// isn't a slash-invocation (normal turn) so the caller leaves it untouched.
export function parsePromptInvocation(text: string): { name: string; argsRaw: string } | null {
  const m = text.match(/^\/([a-z0-9-]+)(?:[ \t]+([\s\S]*))?$/);
  if (!m) return null;
  const name = m[1];
  if (!isValidPromptName(name)) return null;
  return { name, argsRaw: (m[2] ?? '').trim() };
}

// Does a project template by this name exist? A statable-file check only — no
// content read — so it's safe to call for an UNtrusted repo (DD7 guards folding
// content into the prompt, not the existence probe). Lets the caller explain a
// trust-suppressed expansion without false-positiving on plain `/text`.
export async function projectPromptExists(name: string, cwd: string): Promise<boolean> {
  if (!cwd || !isValidPromptName(name)) return false;
  try {
    const st = await stat(path.join(projectPromptsRoot(cwd), `${name}.md`));
    return st.isFile();
  } catch {
    return false;
  }
}

interface ParsedPromptFile {
  description: string;
  body: string;
}

// Optional `--- description: … ---` frontmatter; everything after is the template.
function parsePromptFile(text: string): ParsedPromptFile {
  if (!text.startsWith('---')) return { description: '', body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { description: '', body: text };
  const block = text.slice(3, end);
  let description = '';
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() === 'description') {
      let v = line.slice(idx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      description = v;
    }
  }
  const afterClose = text.indexOf('\n', end + 1);
  const body = afterClose === -1 ? '' : text.slice(afterClose + 1).replace(/^\n+/, '');
  return { description, body };
}

async function scanPromptScope(scope: PromptScope, cwd: string): Promise<PromptSummary[]> {
  const root = scope === 'global' ? globalPromptsRoot() : (cwd ? projectPromptsRoot(cwd) : '');
  if (!root) return [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const out: PromptSummary[] = [];
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -3);
    if (!isValidPromptName(name)) continue;
    const filePath = path.join(root, file);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    out.push({ name, description: parsePromptFile(text).description, scope, path: filePath });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Catalog for discovery / a future UI. Project scope suppressed when the caller
// passes includeProject:false (untrusted repo).
export async function listPromptCommands(
  cwd: string,
  opts?: { includeProject?: boolean },
): Promise<{ project: PromptSummary[]; global: PromptSummary[] }> {
  const includeProject = opts?.includeProject !== false;
  const [project, global] = await Promise.all([
    includeProject ? scanPromptScope('project', cwd) : Promise.resolve([] as PromptSummary[]),
    scanPromptScope('global', cwd),
  ]);
  return { project, global };
}

// Pure bash-positional substitution. Exported for the unit test.
export function substituteArgs(template: string, args: string[]): string {
  return template
    // ${N} and $N → the Nth arg (1-based), empty if unbound.
    .replace(/\$\{(\d+)\}/g, (_f, n: string) => args[Number(n) - 1] ?? '')
    .replace(/\$([1-9][0-9]*)/g, (_f, n: string) => args[Number(n) - 1] ?? '')
    // $@ / $* → all args, space-joined.
    .replace(/\$[@*]/g, () => args.join(' '))
    // $$ → literal $ (run last so it doesn't eat the markers above).
    .replace(/\$\$/g, '$');
}

export interface ExpandedPrompt {
  expanded: string;
  scope: PromptScope;
  name: string;
  path: string;
}

// Resolve `/name argsRaw` to an expanded prompt. Project templates are only read
// when includeProject is true (DD7 trust). Project wins over global on a name
// clash (operator's repo-local override). Returns null when no template matches
// — the caller then sends the original text as a normal turn.
export async function expandPromptCommand(
  name: string,
  argsRaw: string,
  cwd: string,
  opts?: { includeProject?: boolean },
): Promise<ExpandedPrompt | null> {
  if (!isValidPromptName(name)) return null;
  const includeProject = opts?.includeProject !== false;
  const candidates: Array<{ scope: PromptScope; file: string }> = [];
  if (includeProject && cwd) candidates.push({ scope: 'project', file: path.join(projectPromptsRoot(cwd), `${name}.md`) });
  candidates.push({ scope: 'global', file: path.join(globalPromptsRoot(), `${name}.md`) });
  for (const c of candidates) {
    let text: string;
    try {
      text = await readFile(c.file, 'utf8');
    } catch {
      continue;
    }
    const { body } = parsePromptFile(text);
    const args = splitArgs(argsRaw);
    return { expanded: substituteArgs(body, args).trim(), scope: c.scope, name, path: c.file };
  }
  return null;
}

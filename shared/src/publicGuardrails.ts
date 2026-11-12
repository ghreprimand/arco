// Shared "Privacy and public safety" plan section. One fixed, generic template
// used by the plan draft prompt (when a project is public) and by INSERT
// GUARDRAILS in the plan view. Plain language; no real names or paths.

export const GUARDRAILS_HEADING = 'Privacy and public safety';

export const PUBLIC_GUARDRAILS_TEMPLATE = `## ${GUARDRAILS_HEADING}

This project is public, or will be. Every commit, push and release follows these rules.

**Never committed or published**
- Secrets: tokens, keys, passwords, \`.env\` files and credentials.
- Local details: file paths from a machine, machine and host names, IP addresses and usernames.
- Personal data of anyone.
- Screenshots, logs and recordings that show any of the above.
- Private agent state and instruction files kept for local use.

**Identity**
- Every commit uses the project's chosen author and committer identity, with no other names or tool attributions in commits, pull requests or release notes.

**How the rules are enforced**
- Ignore rules keep private state, local configuration and scratch files out of the repository.
- A secret scanner or a pre-commit check runs before every commit.
- The staged diff is read in full before each commit and each push.

**When something slips**
- Revoke or rotate the secret first.
- Rewriting history does not undo a push that was public: assume anything pushed was seen.
`;

const HEADING_RE = new RegExp(`^#{1,6}\\s*${GUARDRAILS_HEADING}\\s*$`, 'im');

export function hasGuardrails(body: string): boolean {
  return HEADING_RE.test(body);
}

/** Insert the template before the first phase heading (or at the end). Returns the body unchanged when already present. */
export function insertGuardrails(body: string): string {
  if (hasGuardrails(body)) return body;
  const match = /^### .*$/m.exec(body);
  const block = `${PUBLIC_GUARDRAILS_TEMPLATE}\n`;
  if (!match) return `${body.replace(/\s+$/, '')}${body.trim() ? '\n\n' : ''}${PUBLIC_GUARDRAILS_TEMPLATE}`;
  const head = body.slice(0, match.index).replace(/\s+$/, '');
  return `${head}${head ? '\n\n' : ''}${block}${body.slice(match.index)}`;
}

/** Text added to the plan draft prompt when the project is public. */
export const PUBLIC_DRAFT_REQUEST = `This project is public, or will be. Include a "${GUARDRAILS_HEADING}" section of standing rules fitted to this project, placed before the first phase. Do not write testing, gate or CI standing rules unless the operator asked for them. Do not use ### headings inside it: ### lines are phases, so use bold labels and flat lists. Start from this template, name the project-specific risks you can see, and say how each rule is enforced:

${PUBLIC_GUARDRAILS_TEMPLATE}`;

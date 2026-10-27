# Working in Arco

## What Arco is

Arco is a workbench for building and operating software with provider-backed agents and a voice operator on Linux, macOS, and Windows. Changes are limited to privacy scrubs, portability, onboarding, and documentation. Any other change is a bug fix only when a failing test demonstrates it.

Arco carries one name. Packages are `@arco/*`, state lives in `.arco`, environment variables are `ARCO_*`, and MCP servers, tools, headers and protocol constants use Arco. Arco does not share state with the private upstream; a user migrates by copying the home and per-project state folders. Imports from the upstream run `node scripts/rename-upstream.mjs` after extraction and before the scrub.

## Identity

Every commit uses this author and committer identity:

```text
ghreprimand <203024559+ghreprimand@users.noreply.github.com>
```

Set it in the checkout Git configuration. Placeholder identities, model or tool attribution, and co-author or sign-off trailers are not allowed. The pre-commit hook checks author and committer identity and rejects disallowed trailers.

## Porting discipline

Port the upstream implementation; do not redesign it. Each changed file must serve one of four reasons: privacy scrub, portability, onboarding, or documentation. A bug fix needs a failing test and a devlog explanation. Preserve file-by-file parity: every tracked upstream file is imported, renamed, or intentionally excluded with its reason recorded in the import reference. Do not replace existing behavior with a new Arco design.

## Commit and push cadence

One coherent change goes in each commit. Run the local gate before committing:

```sh
npm run build
npm run typecheck
npm run test:unit
npm run audit:public
```

Also run the browser or smoke suite that covers the changed area. Push an accepted commit to `origin/main` in the same turn. Hosted CI runs after the push; fix a red result forward in a new commit. Do not leave accepted changes uncommitted across turns.

Install the hooks with `npm run setup:hooks`. It sets the checkout identity, configures `.githooks`, and disables commit signing. The pre-commit hook checks identity, staged public-safety findings, and the current-month devlog entry. Changes outside `devlog/` and `DEVLOG.md` require a changed `devlog/YYYY-MM.md` archive, using the UTC month. The commit-message hook scans private content and rejects attribution trailers, including `Co-Authored-By`, `Signed-off-by`, `Generated-by`, `Authored-by`, `Committed-by`, and `Assisted-by`. The pre-push hook scans the proposed objects and their ancestry. `npm run audit:public` supports tree, staged diff, identity, message, history, release-history, push, and devlog checks; the audit also runs in CI.

## Review scope

The Director reads the full staged diff before each commit. Blocking findings are data loss, privacy or security defects, build or test failures, and regressions to Arco capability. Wording, structure, extra test ideas, style, and future-proofing become board tasks. Each change gets one correction round; a second round means split or rescope the work.

User-visible changes add a `CHANGELOG.md` bullet under Unreleased in the same commit.

## Development log

`DEVLOG.md` is a newest-first index of monthly archives. Each `devlog/YYYY-MM.md` archive lists entries newest first. Every change commit adds an entry in the same commit; several entries are appropriate when a commit changes several behaviors. A commit that only fixes an earlier devlog entry is allowed only to correct its facts.

Use a `## YYYY-MM-DD -- Title` heading and a horizontal rule between entries. Write 150 to 300 words, in an impersonal voice, with no names, hostnames, local paths, or private evidence. Cover these points in this order:

1. The user-visible behavior now available.
2. The controls, commands, scripts, settings, or files involved, named specifically.
3. What was checked and how, including suite names, meaningful counts, and platforms.
4. What failed during the work and how it was resolved.
5. What remains open.

Reject an entry if it could describe a different project. The pre-commit hook enforces the entry's presence; review enforces its quality. At month rollover, create the new archive and add it to `DEVLOG.md` in the first change commit of that month.

### Template

```markdown
## YYYY-MM-DD -- Short behavior-specific title

Users can now ...

The behavior is controlled through `...` and `...`. The relevant command is `...`; ... stores ... .

Checked with `...` (N passed, M skipped) on ... . During implementation, ... failed because ...; ... resolved it.

Remaining: ... .
```

### Worked example

```markdown
## 2026-10-25 -- Import of the upstream workbench tree

The imported Arco workbench starts from the upstream's tracked implementation while giving a new user an Arco-branded entry point. Provider behavior is unchanged.

The import retained 36 reference docs and excluded 86 of 122 docs, along with five private or replaced root files. Personal paths and identifiers, private network details, local project and repository names, workstation defaults, and private output artifacts were scrubbed or excluded. User-facing names became Arco. The hook suite reported 26 checks passing and one optional Docker/Gitleaks check skipped.

Checked with `npm run build`, `npm run typecheck`, `npm run test:unit` (757 passed), `npm run audit:public --tree`, all 28 upstream `test:*` scripts, and 12 server-free smoke suites. An initial install omitted dev dependencies under a production environment; rerunning with `env -u NODE_ENV npm ci --include=dev` fixed it. Voice tests needed the Arco return phrase, and a template fixture needed a consistent lowercase rename. Hostname-derived theme ids were renamed, with saved upstream ids mapped onto the Arco ids on read. Imported docs still need an ASCII punctuation pass; macOS and Windows remain unverified.

No paid provider calls or credential copies were used. macOS and Windows checks require the operator's hardware. Docker and native first-run instructions remain pending.
```

## Public safety

The public-safety audit checks the staged diff before commit and the full tree on demand. It detects absolute home-directory paths across supported operating systems, personal names and identifiers, unapproved email addresses, private hostnames and IP addresses, token and key patterns, `.env`-style secrets, screenshots and recordings, and Arco-local runtime state paths. Do not commit secrets, tokens, machine-only configuration, private machine or host details, local paths, screenshots or logs containing paths, recordings, transcripts, or personal data.

An intentional scan exception requires a specific reason in the audit allowlist and Director review. Do not weaken the scan to make a finding disappear.

## Verification boundaries

Use temporary homes, synthetic projects, and provider fixtures for routine verification. Do not make paid provider calls or copy credentials without the operator in the loop. `npm run voice:setup` downloads speech components from their upstream sources and runs them locally; acceptance may run it inside a temporary Arco home. Record downloaded components in the notices. Do not redistribute them. Record macOS or Windows acceptance only after running it on the real target hardware with the operator.

## Prose style

Tracked prose uses an impersonal voice and ASCII punctuation. Do not use em-dashes. Do not include names, hostnames, usernames, local paths, or private evidence.

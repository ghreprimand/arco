# Security policy

Arco runs provider-backed agents, local tools, terminals, and a browser-facing
server. Reports involving credentials, project file access, tool execution,
network exposure, or unintended disclosure of stored conversations are relevant
to its security boundaries.

## Supported versions

Arco is pre-release software. Only the current `main` branch receives security
fixes; there are no supported release or long-term maintenance branches. Include
the affected commit from `git rev-parse HEAD` in a report.

## Reporting a vulnerability

Report vulnerabilities privately through the repository's
[GitHub security advisory page](https://github.com/ghreprimand/arco/security/advisories/new).
The same route is available from **Security > Report a vulnerability** in the
repository. Public issues, pull requests, and discussions must not contain
undisclosed vulnerabilities or exploit details.

A useful report includes:

- The affected commit, operating system, browser, and native or Docker setup.
- The provider and transport, when relevant, without account identifiers.
- The expected security boundary and the observed behavior or impact.
- Minimal reproduction steps using synthetic projects, accounts, and data.
- Relevant configuration and short, sanitized log excerpts or a proof of concept.
- Any known workaround and whether the issue affects the current `main` branch.

Remove tokens, keys, credentials, usernames, local paths, private hostnames,
private URLs, and personal or project data from all attachments and excerpts.
Replace identifying values with consistent placeholders while preserving the
structure needed to reproduce the issue. Real credentials are not needed for a
report, including a private report. Testing must use installations and data for
which the reporter has authorization.

## Response expectations

Reports receive best-effort review. There is no guaranteed acknowledgement,
resolution, or release timeline. Follow-up questions, reproduction findings,
and coordination of a fix can take place in the private advisory. Public
disclosure should be coordinated there after the impact and mitigation are
understood. Credit preferences can be included in the report.

Ordinary defects without security impact belong in the
[bug-report form](https://github.com/ghreprimand/arco/issues/new?template=bug_report.yml).
Contribution scope and validation requirements are described in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Outbound release checks

The server requests the latest Arco release from
`https://api.github.com/repos/ghreprimand/arco/releases/latest` 30 seconds after
boot and every six hours, or when CHECK NOW is selected in Settings. It sends
`Accept: application/vnd.github+json` and `User-Agent: arco/<version>` with no
authentication token. GitHub sees the requesting server's public IP address;
no project paths, prompts, credentials or conversation content are sent.

Release metadata is cached in memory. The response can produce a release-note
link and a notice, but never an automatic download, installation or command.
Redirects are refused and release links are restricted to this repository on
GitHub. Requests time out after five seconds. An unavailable, missing or
rate-limited release is silent after one debug log; a later cycle retries.

Turn off **Check for new releases** in Settings > Advanced > CLI and runtime
versions, or supply `ARCO_UPDATE_CHECK=0` to the server process. The environment
setting wins, including for manual checks. DISMISS saves only the dismissed
release version in global settings; later versions can notify again. Release
announcements use the server log, not workflow transcripts. See
[Updating Arco](docs/OPERATIONS.md#updating-arco) for manual update instructions.

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

## Utility agent and Smart AUTO-PICKUP evaluator requests

The utility agent (Settings > Agents and clusters) and the Smart AUTO-PICKUP
evaluator accept only Claude with Native sign-in, Cursor, Codex, Ollama, LM Studio, llama.cpp, Strata, and DeepSeek through Xolotl.
Claude CLI alone cannot serve either role. Codex is offered only while it is
enabled and signed in, and runs in a locked-down one-shot process (see below).
LM Studio, llama.cpp, Strata and DeepSeek requests require the selected model to
be loaded already; they never start, stop or switch a model. Their shared
OpenAI-compatible request sends no tools and rejects returned tool calls.
Utility jobs and evaluator requests are operator-initiated or operator-armed,
are tool-less or contained so that any tool use ends the request, are bounded by a time limit and an abort, and return text plus the facts or
mail snapshot that was sent. Cost and retention follow the chosen provider.

In Smart: Observe-only and Smart: Automatic, Arco sends a snapshot of an idle
cluster member's waiting mail to the evaluator provider and model the operator
chose. The snapshot holds the mail bodies, sender role labels, up to five of
the member's open tasks and, for each sender, the member's own most recent
earlier message to that sender (clipped to 600 characters). Those earlier
messages are kept in server memory only, a few per member pair, and are lost
on restart. The instructions frame the mail as untrusted data. Off
and Rule-based send nothing. The evaluator only proposes wake, wait or ask.
Arco's server code decides whether a turn starts and enforces every limit.

Every evaluator request has a time limit, an abort and an output cap. An error,
timeout, tool attempt, or malformed or oversized answer records no decision and
never wakes a member. Each request reserves a budget slot before it is sent. A
request still in flight when the server stops counts as spent. Arming is
refused when the chosen provider is not available as an evaluator.

- Ollama: one /api/chat request to the configured Ollama address, with no tools,
  schema-constrained output for evaluators (free text for utility jobs) and an
  output token limit.
- Claude: one Messages API request using Claude Native sign-in credentials, with
  no tools declared. Thinking and redacted-thinking blocks are ignored; tool
  use and other non-text content are rejected. It is unavailable with only a
  Claude CLI sign-in.
- Cursor: a new cursor-agent acp process per request, started in a new empty
  temporary folder that is deleted afterwards. It advertises no file or terminal
  capability and no MCP servers, and switches the session to Cursor's Ask mode
  (no edits or command execution) before the prompt; without Ask mode the
  request is refused. Every permission request is refused, and any
  tool call, file or terminal request ends the request and stops the process.
  Cursor Agent's built-in read tools can still begin before the request is
  ended, and they can act on absolute paths outside the temporary folder. This
  gives no new access: the mail comes from cluster members that already have
  file access under the same account, and any such attempt yields no decision.
  Whether Cursor keeps its own record of the one-shot chat is not known; Arco
  never resumes it.
- Codex: a new `codex app-server` process per request, started with no MCP
  servers in a new empty temporary folder that is deleted afterwards. The thread
  is ephemeral and never resumed, with a read-only sandbox, approval policy
  never and web search off. Only the final agent message is kept. Any command,
  file change, MCP, dynamic-tool or web item, and any approval or other request
  from the server, ends the request and kills the process, with no decision.
  Codex has no switch that removes its tools, so this is containment, not
  absence of tools: the read-only sandbox forbids writes and network access,
  but it can still read files on the machine, including outside the temporary
  folder, and a command can begin before the item is seen and the turn ended.
  This gives no new access: the mail comes from cluster members that already
  have file access under the same account, and any such attempt yields no
  decision. Whether Codex keeps its own record of the one-shot thread is not
  known; Arco never resumes it. The request runs on the signed-in Codex account
  and is counted against its usage. Regular Codex workflow workers are not
  changed by this adapter.

## Opening Outputs in the default app

The Outputs **OPEN** button and the click on a name for types without a preview
call `POST /api/outputs/open` with an output id and workflow, never a path. The
server resolves the registered output inside its confined store, requires a
regular file and a loopback client with the session cookie, and starts the
system opener detached with the path as a single argument (no shell, no command
string). Program and script types and files without an extension are refused on
every OS. Each open is logged. An open still hands the file to whatever app the
operating system associates with its type; Arco does not inspect content. The
route answers with an error where no desktop is available (Docker, headless).

## Public-project checks

When a plan-draft control is shown for a project folder, the server reads the folder's Git remotes (`git remote -v`, local only). For a remote on github.com it makes one unauthenticated request to `https://api.github.com/repos/<owner>/<repo>` with a five-second limit and no token, and caches the answer per folder for a day. A repository is treated as public only when GitHub answers 200 with `private: false`; any other answer, error or timeout counts as unknown. GitHub sees the server's public IP address and the owner and repository names from the remote; no project paths, prompts or conversation content are sent. Other hosts (GitLab, Bitbucket, Codeberg) are recognized from the remote text only and receive no request.

The project state check runs `git ls-files` and `git check-ignore` inside a Git project folder and reads the `.arco/.gitignore` file. It changes nothing by itself. RESTORE IGNORE FILE writes the default ignore file after moving an edited one aside as a backup in `.arco/`; STOP TRACKING runs `git rm -r --cached -- .arco`, which removes the folder from the index only and keeps the files on disk. Anything already pushed stays in the remote's history.

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
announcements use the server log, not workflow transcripts. A confirmed
**UPDATE AND RESTART** in Linux user-service mode starts a separate local updater.
It fetches the release tags from the checkout's `origin` and uses npm to install
the selected release's dependencies, then restarts the service. Those operations
use the configured Git and npm network endpoints. The updater refuses tracked
edits and unpushed local commits and attempts rollback on failure. Other modes
show commands for the operator to run. See [Updating Arco](docs/OPERATIONS.md#updating-arco).

# Settings

Where each Settings control lives, what scope it uses, and how release notices,
project locations, auto-compaction and cluster defaults behave.

Settings (the gear in the header) groups every control by task. A search box
looks through all categories at once, including each control's help text.
Each section shows its scope and an "About this setting" disclosure with the
same contextual help as the `?` mode.

## Scopes

- **Global**: stored for this Arco server in the Arco home (`settings.json`
  and the related stores) and applied everywhere.
- **Global, for new workflows**: a default copied into a workflow when it is
  created. A workflow's CONFIG tab overrides it, and changing the default does
  not change existing workflows.
- **Project**: applies to one project folder.
- **Workflow**: per-workflow choices (provider, model, effort, permissions,
  transport, auto-compaction, auto-handoff, north star and the rest) stay in the workflow
  creator and the workflow's CONFIG tab. They are not part of this dialog.

Project skills, handoff prompt overrides and the active-folder suggestion follow the selected workflow or cluster. A selected cluster supplies its shared folder even when no individual member tab is active.

The default fresh summarizer stays unpinned until an explicit picker choice. Opening Settings or loading a model catalog does not save a pin. **CLEAR** restores the per-tab primary fallback. Unrelated settings changes preserve saved Strata and DeepSeek endpoints; an explicit empty endpoint block still resets that provider.

Skill names and descriptions retain quotes and backslashes through repeated edits. IMPORT, MOVE, DUPLICATE and new skill creation reserve room for numeric collision suffixes within the 64-character folder-name limit.

Skill UPDATE binds its preview to every installed file, including hidden files and metadata. A local edit after REVIEW, or while the replacement is staged, refuses the update and keeps that edit. REVIEW again before confirming. Skill editor saves and folder operations share the same mutation lock.

## Addresses

`#settings/<category>` opens a category and `#settings/<category>/<section>`
opens a section, for example `#settings/voice/voice-setup`. Unknown addresses
are ignored. The Connections view and the provider outage banner open the
matching section the same way.

## Provider availability

On a new Arco home, detected Claude, Codex and Cursor sign-ins are enabled,
as are detected Ollama, LM Studio and llama.cpp endpoints or binaries. An
installed runtime may still need to be started or supplied with a model.
Strata and DeepSeek through Xolotl start off and can be enabled explicitly.
An explicit successful check in Connections enables that provider. Existing
settings and saved provider choices are preserved. Use **Enabled providers**
in Settings to change availability at any time.

## Control-location map

Every control the Settings dialog had before it was organized by task, and
where it now lives. The table has one row per section; `navigation.test.ts`
(`client/src/components/settings/`) checks that the rows match the sections
the dialog renders and that every Settings help entry is covered.

Sections: 29.

| Section id | Category | Section | Scope | Controls |
| --- | --- | --- | --- | --- |
| `themes` | Appearance | Theme | Global | Theme family and palette picker, search and categories; default Electric Blue |
| `phosphor` | Appearance | Phosphor effects and softness | Global | Phosphor glow, effects and softness (shown with a Phosphor theme) |
| `font-pack-override` | Appearance | Font pack override | Global | Font pack selector; default Victor Mono |
| `interface-text-size` | Appearance | Interface text size | Global | 90% to 150%; fresh installs default to 110%, existing installs keep their size |
| `layout` | Appearance | Layout | Global (this browser) | Automatic (default: Narrow under 1500, Compact from 1500, Standard from 2000 interface pixels), Standard, Compact or Narrow. Fixed choices apply at every width. Top-bar switch and command palette make the same choice |
| `message-box-size` | Appearance | Message box size | Global (this browser) | Small (default), Medium or Large starting height for every message box |
| `theme-brightness` | Appearance | Background and text brightness | Global | Background brightness, text brightness (default +25) |
| `crisp-text` | Appearance | Crisp text | Global | Crisp text toggle |
| `frosted-glass` | Appearance | Frosted glass and opacity | Global | Frosted glass override, opacity (default 80%) |
| `operator-name` | Appearance | Operator name in chat | Global | Operator label shown in chat |
| `projects` | Projects | Project locations and bookmarks | Global | Project locations with folded Add/Edit and duplicate/alias rename feedback; Bookmarked folders for optional Bookmark folder/Remove bookmark controls; Advanced folder options for independent browsing defaults; non-destructive multi-location Run setup again |
| `project-trust` | Projects | Project trust | Project, rules kept globally | Searchable, scrollable trusted and blocked project list, default trust |
| `enabled-providers` | Providers and models | Enabled providers | Global | Per-provider on/off toggles |
| `authentication` | Providers and models | Sign-in, accounts and local endpoints | Global | A Claude group (Native sign-in first, then CLI sign-in), Codex accounts and profiles, Cursor, then Ollama endpoint, discovery and utility model (compaction summaries, session titles), LM Studio endpoint, Strata endpoint, DeepSeek through Xolotl, and the Ollama, llama.cpp, LM Studio, Strata and GitHub rows |
| `llamacpp-catalog` | Providers and models | llama.cpp model registry | Global | llama.cpp registry editor and preload (shown when llama.cpp is enabled and installed) |
| `catalog` | Providers and models | Model catalog | Global | Model catalog editor |
| `native-subagents` | Agents and clusters | Claude Native sub-agents | Global defaults, including existing workflows | Maximum running at once, maximum starts per turn and sub-agent model; each control opens this section from contextual help |
| `auto-handoff-defaults` | Agents and clusters | Auto-handoff defaults | Global, for new workflows | Off by default; hand off after N compactions (default 5, 1 to 20) and summarizer, with Quick or written modes |
| `utility-agent` | Agents and clusters | Utility agent | Global | Provider and model for side jobs (Claude Native, Cursor, Codex, Ollama, LM Studio, llama.cpp, Strata, or DeepSeek through Xolotl); TEST, CLEAR; not chosen until saved. See [Utility agent](#utility-agent) |
| `notification-channels` | Notifications | Desktop and phone notifications | Global (switches kept by the server; the desktop permission is per browser) | Events (finished, failed, waiting) by place (this computer, phone); browser permission and desktop TEST; SHOW IN BELL controls quiet notices for other tabs; ntfy server, topic with GENERATE, optional token, TEST; message text switch; cluster finished source. See [Notifications](NOTIFICATIONS.md) |
| `board-auto-done` | Agents and clusters | Board auto-done | Global | Checkbox that marks review tasks done when the director signs off as met |
| `skills` | Agents and clusters | Skills | Global or project (the active tab's folder) | Global and project skill lists with extra files, import source and missing referenced skills; NEW, EDIT, delete, IMPORT, UPDATE, TURN OFF/ON, MOVE TO GLOBAL/PROJECT, DUPLICATE, SHARE WITH REPOSITORY |
| `handoff-prompts` | Agents and clusters | Handoff prompts | Global or project (the active tab's folder) | Handoff prompt overrides per mode |
| `voice-setup` | Voice | Voice setup | Global | Local speech status, install log, microphone test, test phrase, model notices |
| `media-access` | Files and media | Media folder access | Global | Outside-folder access switch, allowed folders, revoke all |
| `preview-ports` | Advanced | Preview ports and remote access | Global, for new previews | PREVIEW PORTS, normally 4300-4309; ARCO_PREVIEW_PORTS override, lazy port use, firewall and forwarding guidance; the field waits for SAVE to finish before further editing |
| `transport-defaults` | Advanced | Transport defaults | Global, for new workflows | Codex (default app-server) and Claude (default native) transport defaults for new workflows |
| `app-window-browser` | Advanced | App window browser | Global | Automatic (first found, preserving the existing preference), a detected installation/channel, or another program name or path; used by `arco open`, the Arco shortcut and the explorer window; a missing choice falls back to Automatic |
| `cli-versions` | Advanced | CLI and runtime versions | Global | Arco running version, latest release and date, CHECK NOW, update action or copyable command, Check for new releases, Updating Arco link; Claude, Codex CLI and Ollama daemon versions |

## Appearance and browser rendering

If GPU activity changes between views or browsers, compare the same Arco
instance and view in one browser first. Keep the theme, viewport, browser zoom,
interface scale, and other visible effects the same. Change one condition at a
time and let pointer-driven effects settle before comparing. If needed, repeat
the same comparison in another browser. To check Phosphor decoration,
temporarily turn off **Phosphor effects** in Settings > Appearance, then restore
the previous choice after the comparison. This is reversible and does not
require changing other appearance choices.

When Phosphor effects are enabled, Arco may show a short in-app hint for
recognized non-Chromium browser identities. Browser detection is best-effort;
on iOS, differently branded browser apps may use the same WebKit engine.

Browser compositing draws the workbench and its visual effects. Local model
inference is separate and occurs while a local model is processing a request.
GPU activity by itself does not identify which work is responsible, and an
effects-off comparison is a troubleshooting clue rather than proof of a browser
or Arco defect.

Requests that name a control inside a section open that section and focus the
control: `endpoint-discovery`, `ollama`, `lmstudio`, `strata-endpoint`,
`deepseek`, `codex-profiles`, `native-auth`, `claude-signin` open
`authentication`; `media-unconfined` opens `media-access`;
`default-working-dir` opens `projects`.

## Arco release notices

The version box in the top bar, left of the power button, always shows the
running version. When a newer release is known it becomes an accent box with an
up arrow and the new version, stays that way after the toast is dismissed, opens
the update dialog on click, and shows UPDATING while an update runs.

In Advanced > CLI and runtime versions, **Arco** also shows the running version and
the latest known release with its publication date. **CHECK NOW** asks the
server to refresh the release metadata. **Check for new releases** defaults to
on; disabling it prevents automatic and manual requests. `ARCO_UPDATE_CHECK=0`
in the server environment overrides the checkbox. The **Updating Arco** link
opens the [service, foreground and Docker update procedure](OPERATIONS.md#updating-arco).

The release toast provides **OPEN RELEASE**, the update action and **DISMISS**.
Dismissal saves `updateCheckDismissed` for that version globally and survives
reloads; a newer version can notify again. The checkbox saves `updateCheck`.
The server first checks 30 seconds after boot, then every six hours. It never
downloads or installs updates automatically. Packaged services on Linux, macOS,
and Windows offer **UPDATE AND RESTART** from the version box, toast, or Settings.
It confirms the release and stops running turns at restart. Linux source user
services offer the same action. Other run modes show a copyable command.

### Project location migration

`projectRoots` stores named `{ name, path }` project locations. An absent field migrates
an existing `defaultWorkingDirectory` to one location. An explicit `projectRoots: []`
keeps discovery off, including after later settings changes. New writes preserve
that distinction. `defaultWorkingDirectory` thereafter controls browsing only.
Location paths are normalized and deduplicated, including existing aliases. Projects
under overlapping locations belong to the longest matching location; bookmarked folder paths
and session identity remain unchanged. Removing a location never removes bookmarked
folders, files, saved sessions or trust decisions. Missing locations stay listed. Duplicate canonical paths are refused during edits; adding an existing path offers explicit rename feedback rather than discarding the name.

## Auto-compaction policy

The workflow CONFIG panel has a worker auto-compaction policy and the cluster panel has a cluster default. For cluster members, No worker override means no policy is set on the tab. If the cluster also has no policy, Claude CLI and Codex compact themselves; Claude Native and Ollama use Arco compaction near the context limit. Set a shared policy in the cluster panel under AUTO-COMPACTION. Choose an explicit on or off override or inherit the cluster default; Provider is the default: Claude Native and Ollama use Arco compaction near 90%, while Claude CLI and Codex use their own compaction. Auto-handoff is off by default. The threshold is an integer from 30% through 95%, evaluated for each worker independently. Claude Native and Codex app-server use a fresh completed-turn reading; Codex also needs an existing thread. Ollama checks its estimated request size against the configured backend context window before dispatch. Other transports cannot use this policy. Unknown context never triggers a summary. Fold creates a deterministic digest; Handoff starts a fresh session. Claude Native CONFIG > ADVANCED has the optional Claude API compaction (beta) toggle; it is separate and off for new tabs.

For Ollama, the new policy summarizes only verified completed executions outside the retained tail. The summary boundary is saved atomically in the workflow's `ollama-compact-boundary.json`, bound to project, workflow, session epoch and source events. Later turns and server restarts reuse a matching summary without rewriting raw events. Queued input is replayed in execution order, with the current prompt supplied once. Unverifiable legacy logs, partial or cancelled executions, changed source and unresolved input defer summarization with a notice. Ineffective or failed attempts wait for a lower context reading before retrying. The enabled policy defers automatic Handoff so it cannot rotate the session before the next pre-dispatch check; manual Handoff remains available. Explicit Off stops automatic compaction, including the legacy global automatic setting. Returning to Provider uses the 90% default unless an earlier global Ollama enabled or threshold setting is saved, in which case that setting remains in force. Manual COMPACT remains a next-turn action and uses the same durable boundary when a worker or Provider policy is active.

### Cluster coordination controls

Cluster creation and the existing cluster control bar separate Efficiency (Thorough, Balanced, Lean) from Message guard (Warn only, Hard limit, No limit). New clusters use Balanced, Warn only at 15, a cluster-local board and Keep current Both. Thresholds are integers from 1 to 1000, per sender per primary turn; counts reset on primary turn start and server restart. NOTE appends an instruction and does not change the guard. Existing omitted fields and snapshot fallbacks retain their prior meaning. See [cluster protocol](PROTOCOL_CLUSTER.md) for persistence, warning and counter behavior.

Efficiency guides coordination and testing. Balanced, the default for new clusters, asks for one lowest-level test per real fault, tests for the changed area per change, and the full check once before a release. Browser tests cover journeys that need a real screen, one per journey rather than layout, theme or size permutations. New suites, gates, test tooling and CI checks need operator approval, using the operator-question tool where available. The full check should take about ten minutes; longer runs prompt a proposal to cut work before adding tests. Flaky tests are fixed or deleted, not retried. Lean runs only changed-area tests and adds tests only for faults found; the full check runs only when requested. Thorough tests new behaviour and faults, runs neighbouring tests and the full check before handover. Every level asks what a user would lose before a failure blocks work; cosmetic or momentary faults are noted. Project rules and plans take precedence when they ask for more or less testing. Safety checks, message guards, requested review and landing review remain unchanged.

### Utility agent

The utility agent is one operator-chosen provider and model for short side jobs
outside a workflow turn: **BRIEF**, **CATCH ME UP**, **TIDY**, and the shared
no-tools runner those buttons use. It lives in Settings > Agents and clusters
and is also offered (never selected silently) on the last Welcome screen.

Accepted providers: Claude with Native sign-in, Cursor, Codex, Ollama, LM Studio, llama.cpp, Strata, and DeepSeek through Xolotl. Claude
CLI alone cannot serve. Local choices other than Ollama require the selected model
to already be loaded; Arco does not load or switch a model for these jobs.
Codex runs as a one-shot app-server in an empty temporary
folder with a read-only sandbox, no MCP servers and web search off; any tool
item or approval request ends the request. The choice is unset until saved. **TEST** runs one bounded request;
**CLEAR** removes the saved choice. **USE UTILITY AGENT** on Smart AUTO-PICKUP,
Research, document edit, and handoff summarizer pickers
fills the choice into that picker without changing other saved selections.
BRIEF, CATCH ME UP, and TIDY need a utility agent before they run. TIDY
**ACCEPT** only replaces the composer draft and never sends. Failed requests show the cause when available and identify the model that was tried. Unsupported non-text content and replies that are too long or cut off are reported instead of used.

### AUTO-PICKUP

AUTO-PICKUP is a per-cluster control on the cluster right-panel header (default
Off), not a Settings page. Modes: Off, Rule-based (recommended deterministic wake on idle
mail with acknowledgement, loop and adjustable wake-budget guards), Smart: Observe-only (evaluator proposes wake / wait / ask; log only), and
Smart: Automatic (wake proposals may start a turn after server gates and
limits; evaluator errors instead attempt ordinary pickup once through those same gates, never over a valid wait/ask or expired session). Smart modes need an evaluator (Claude Native, Cursor, Codex, Ollama, LM Studio, llama.cpp, Strata or DeepSeek through Xolotl). The same provider limits apply to the utility agent.
Change **Armed session length** under **AUTO-PICKUP > LIMITS** before arming (5 to 240 minutes, default 30). The dialog shows minutes remaining; expiry turns Smart Off and leaves mail waiting. The chip hover and accessible description explain failures, fallback and expiry. Capped evaluator requests have 8192 tokens of reasoning headroom above the visible-answer limit.

Limits, session expiry, TURN OFF, STOP holds and counters
are described in the in-app manual section AUTO-PICKUP and Smart pickup and in
[cluster protocol](PROTOCOL_CLUSTER.md). Evaluator request contents and adapter
boundaries are in [SECURITY.md](../SECURITY.md#utility-agent-and-smart-auto-pickup-evaluator-requests).

### Local runtime capacity

`localClusterCapacity` (`{ ollama?, llamacpp? }`, integers 1 to 16, default 1) is
set in Connections under Ollama or llama.cpp as "Cluster members that may use
this runtime at once". The creator shows each runtime's use against its limit
and disables CREATE CLUSTER when a runtime is over it; the server refuses a
create, add or replace that would exceed it. Members on Ollama and llama.cpp
together are limited by the larger setting. Different models each load their
own copy into memory; members on the same model share it. Arco still runs local
turns one at a time per runtime unless `ARCO_LOCAL_PROVIDER_SERIAL_QUEUE=0`, and
Ollama's `OLLAMA_MAX_LOADED_MODELS` and `OLLAMA_NUM_PARALLEL` decide what the
runtime accepts. Saving one runtime keeps the other's value; invalid values are
ignored. `ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL=1` lifts the limit.

### Built-in skills

Skill descriptions can be up to 300 characters. Settings > SKILLS lists the built-in skills with an OPERATOR or MODEL badge, TURN OFF and TURN ON. The composer SKILLS menu runs them or creates an EDITABLE COPY. A project or global skill with the same name replaces the built-in. Operator-run (slash): grill-me, grill-with-docs, wait-what, retro; Architecture review via `/improve-codebase-architecture`. Model-invoked (manifest / MODEL badge): proportionate-testing (Arco-owned), grilling, domain-modeling, tdd, diagnosing-bugs, codebase-design, prototype, writing-for-agents. `proportionate-testing` controls how much to test; `tdd` controls how to write one test. Keep it on to ask agents for one test per real fault and operator approval before new suites, gates, tooling or CI checks. Built-in third-party skills and their license are listed in [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES).

## Save outcomes and rapid edits

Rapid changes to notification switches, Ollama compaction fields and service pins are saved in order. Each edit uses the latest saved values, so a later click does not undo an earlier field change.

A refused or incomplete global settings response leaves the previous settings and appearance active and reports a save error. SAVE AS DEFAULTS reports success only after a valid reply.

Workflow CONFIG reports a metadata write failure as a temporary change in the running tab. The change may be lost after restart; retry the save after storage is available. Auto-compaction retains its previous policy if its save fails.

A combined north-star and goal-run update validates the new goal before changing settings. Clearing the goal while arming a run is refused. Fresh workers, replacements and Native Task children keep the standing goal but start without an armed run.


App window browser lists separate supported builds, including stable, beta, dev,
nightly, Brave Origin, ungoogled Chromium and Thorium where detected. Linux reads
known PATH commands, standard desktop entries, Flatpak exports/metadata and Snap
wrappers. macOS reads standard application bundles by identifier and executable;
Windows reads App Paths, registered browser clients and known install folders.
Duplicate names include the program path in the local list. Saved installations
remain selected while present; old family-name choices remain supported.
Automatic preserves the previous first-found browser when it is still installed.
New discoveries follow it, ordered by stable, beta, dev/snapshot and nightly/canary,
then system before user installations. Other installed builds can be chosen from
the list. Opens in includes a version when a safe native executable is known.
A proven wrapper target can supply that version; scripts and AppImages are never
run to detect a version. Failed version reads remain unknown for ten minutes.
No browser window opens while discovering programs or versions.


## Claude Native sub-agents

The **Claude Native sub-agents** group in Settings - Agents and clusters controls existing and new Native Agent tabs. `nativeSubagents.maxRunning` defaults to 4 (1-32), `nativeSubagents.maxStarts` to 8 per parent turn (1-128), and `nativeSubagents.model` to Agent's choice. Per-tab CONFIG overrides individual fields. Blank tab limits inherit Settings; blank Settings limits use the defaults. The model picker offers Use Settings in a tab, explicit Agent's choice, or a catalog model. An empty saved model string means explicit Agent's choice even over a named Settings default.

A selected model overrides agent requests. Agent's choice preserves parent inheritance unless the agent names another model. Admitted extra Tasks queue; calls beyond the turn budget are refused. Cancelling before start refunds a reserved place; started children keep counting. Settings apply next parent turn, including on existing installs. A running turn keeps its snapshot. These limits do not cap spending or add an ask-first prompt. CLI, Codex, Cursor and local providers do not use these Native settings; see [Providers](PROVIDERS.md#claude-native-sub-agent-controls).

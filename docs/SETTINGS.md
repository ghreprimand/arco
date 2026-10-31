# Settings

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

## Addresses

`#settings/<category>` opens a category and `#settings/<category>/<section>`
opens a section, for example `#settings/voice/voice-setup`. Unknown addresses
are ignored. The Connections view and the provider outage banner open the
matching section the same way.

## Control-location map

Every control the Settings dialog had before it was organized by task, and
where it now lives. The table has one row per section; `navigation.test.ts`
(`client/src/components/settings/`) checks that the rows match the sections
the dialog renders and that every Settings help entry is covered.

Sections: 22.

| Section id | Category | Section | Scope | Controls |
| --- | --- | --- | --- | --- |
| `themes` | Appearance | Theme | Global | Theme family and palette picker, search and categories; default Electric Blue |
| `phosphor` | Appearance | Phosphor effects and softness | Global | Phosphor glow, effects and softness (shown with a Phosphor theme) |
| `font-pack-override` | Appearance | Font pack override | Global | Font pack selector; default Victor Mono |
| `interface-text-size` | Appearance | Interface text size | Global | 90% to 150%, default 110% |
| `theme-brightness` | Appearance | Background and text brightness | Global | Background brightness, text brightness (default +30) |
| `crisp-text` | Appearance | Crisp text | Global | Crisp text toggle |
| `frosted-glass` | Appearance | Frosted glass and opacity | Global | Frosted glass override, opacity |
| `operator-name` | Appearance | Operator name in chat | Global | Operator label shown in chat |
| `projects` | Projects | Project locations and bookmarks | Global | Project locations with folded Add/Edit and duplicate/alias rename feedback; Bookmarked folders for optional Bookmark folder/Remove bookmark controls; Advanced folder options for independent browsing defaults; non-destructive multi-location Run setup again |
| `project-trust` | Projects | Project trust | Project, rules kept globally | Trusted and never-trusted project list, default trust |
| `enabled-providers` | Providers and models | Enabled providers | Global | Per-provider on/off toggles |
| `authentication` | Providers and models | Sign-in, accounts and local endpoints | Global | Separate Claude CLI login and Native credential status/recovery, Codex, Cursor, Ollama, llama.cpp, LM Studio, Strata and GitHub sign-in rows, Codex accounts and profiles, Ollama endpoint, discovery and utility model (compaction summaries, session titles), LM Studio endpoint, Strata endpoint, DeepSeek through Xolotl |
| `llamacpp-catalog` | Providers and models | llama.cpp model registry | Global | llama.cpp registry editor and preload (shown when llama.cpp is enabled and installed) |
| `catalog` | Providers and models | Model catalog | Global | Model catalog editor |
| `auto-handoff-defaults` | Agents and clusters | Auto-handoff defaults | Global, for new workflows | Auto-handoff warn and handoff thresholds, summarizer |
| `claude-native-compact-default` | Agents and clusters | Anthropic compaction default | Global, for new workflows | Server-side compaction default for new Claude Native workflows |
| `skills` | Agents and clusters | Skills | Global or project (the active tab's folder) | Global and project skill lists, new, edit and delete |
| `handoff-prompts` | Agents and clusters | Handoff prompts | Global or project (the active tab's folder) | Handoff prompt overrides per mode |
| `voice-setup` | Voice | Voice setup | Global | Local speech status, install log, microphone test, test phrase, model notices |
| `media-access` | Files and media | Media folder access | Global | Outside-folder access switch, allowed folders, revoke all |
| `transport-defaults` | Advanced | Transport defaults | Global, for new workflows | Codex (default app-server) and Claude (default native) transport defaults for new workflows |
| `cli-versions` | Advanced | CLI and runtime versions | Global | Arco running version, latest release and date, CHECK NOW, Check for new releases, Updating Arco link; Claude, Codex CLI and Ollama daemon versions |

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
`deepseek`, `codex-profiles`, `native-auth` open
`authentication`; `media-unconfined` opens `media-access`;
`default-working-dir` opens `projects`.

## Arco release notices

In Advanced > CLI and runtime versions, **Arco** shows the running version and
the latest known release with its publication date. **CHECK NOW** asks the
server to refresh the release metadata. **Check for new releases** defaults to
on; disabling it prevents automatic and manual requests. `ARCO_UPDATE_CHECK=0`
in the server environment overrides the checkbox. The **Updating Arco** link
opens the [service, foreground and Docker update procedure](OPERATIONS.md#updating-arco).

The release toast provides **OPEN RELEASE** and **DISMISS**. Dismissal saves
`updateCheckDismissed` for that version globally and survives reloads; a newer
version can notify again. The checkbox saves `updateCheck`. The server first
checks 30 seconds after boot, then every six hours. It never downloads or
installs updates automatically.

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

The workflow CONFIG panel has a worker auto-compaction policy and the cluster panel has a cluster default. Choose an explicit on or off override or inherit the cluster default; absent policies retain existing provider behavior. The threshold is an integer from 30% through 95%, evaluated for each worker independently. Claude Native and Codex app-server use a fresh completed-turn reading; Codex also needs an existing thread. Ollama checks its estimated request size against the configured backend context window before dispatch. Other transports cannot use this policy. Unknown context never triggers a summary. Fold creates a deterministic digest; Handoff starts a fresh session.

For Ollama, the new policy summarizes only verified completed executions outside the retained tail. The summary boundary is saved atomically in the workflow's `ollama-compact-boundary.json`, bound to project, workflow, session epoch and source events. Later turns and server restarts reuse a matching summary without rewriting raw events. Queued input is replayed in execution order, with the current prompt supplied once. Unverifiable legacy logs, partial or cancelled executions, changed source and unresolved input defer summarization with a notice. Ineffective or failed attempts wait for a lower context reading before retrying. The enabled policy defers automatic Handoff so it cannot rotate the session before the next pre-dispatch check; manual Handoff remains available. Explicit Off stops automatic compaction, including the legacy global automatic setting. Returning to an absent policy restores the existing global Ollama settings. Manual COMPACT remains a separate next-turn action.

### Cluster coordination controls

Cluster creation and the existing cluster control bar separate Efficiency (Thorough, Balanced, Lean) from Message guard (Warn only, Hard limit, No limit). New clusters use Balanced, Warn only at 15, a cluster-local board and Keep current Both. Thresholds are integers from 1 to 1000, per sender per primary turn; counts reset on primary turn start and server restart. NOTE appends an instruction and does not change the guard. Existing omitted fields and snapshot fallbacks retain their prior meaning. See [cluster protocol](PROTOCOL_CLUSTER.md) for persistence, warning and counter behavior.

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

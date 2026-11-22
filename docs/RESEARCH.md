# Research projects

A research project sends one brief to several researchers, each working independently, and gives the answers to a Research Director the operator keeps talking to. It is a cluster with two kinds of member and a folder that describes it.

This page covers the engine: researchers, rounds and the research folder. The start dialog and the research project screen are described with their controls.

## Members

- **Research Director:** a STANDARD member working in the research folder, with the role `Research Director`. It writes the brief, runs rounds with `research_round`, reads the released reports, writes `synthesis.md` and answers follow-ups. It gets research instructions as a system block (`server/src/research/researchDoctrine.ts`).
- **Researchers:** members with the RESEARCHER access mode. A researcher is ISOLATED: it runs in a private workspace under `~/.arco/clusters/<clusterId>/isolates/<workflowId>/workspace`, has no shell, and its file tools cannot leave that workspace. Its research tools stay on: Claude Native gets `web_search`, `web_fetch` and `read_url`; Ollama and llama.cpp get Arco's `WebSearch` (SearXNG) and `WebFetch`. Every message it sends goes to the Research Director, whatever recipient it names. Files return through `peer_send` `artifact_paths` (Claude Native only; up to 8 files, 256 KB).
- **Providers:** Claude Native, Ollama and llama.cpp. Codex, Claude CLI and Cursor researchers need an operating-system sandbox and are refused.
- **Names and letters:** researchers are named `Researcher A`, `Researcher B` and so on. A letter stays with the same researcher across rounds. The operator sees each card's letter, provider and model; blind reports hide authors from the Director only.
- **Where conversations live:** the researchers' workflow folders are in Arco state (`~/.arco/research/<projectId>/.arco/workflows/`), not in the research folder, so the Director cannot read their activity from its working directory. The cluster records this in `memberCwds`.

## Rounds

`research_round` (Research Director only; Claude Native peer tool, the `arco-cluster` MCP server and the local tool runtime, all through `server/src/research/researchRounds.ts`):

The Director's worker gets the tool from the `clusterResearchDirector` flag, which the turn engine sets and `WorkerManager` must pass into the worker configuration. A Claude Native conversation keeps the tool list it started with, so a Director that began without the tool needs a new project.

1. Arco sends the identical brief to every researcher's mailbox and starts a turn on each idle researcher. The message that starts the turn quotes the brief too, because a compaction during the round can drop the mailbox read.
2. A researcher's `peer_send` during the round is held. It is not put in the Director's mailbox, raises no mail event and is not written to the research folder. Several messages from one researcher in a round join into one report.
3. A researcher whose turn ends without sending a report: its final reply becomes the report, marked "taken from final reply". A failed turn marks it failed; the operator's STOP marks it stopped. A researcher still waiting at the deadline is marked timed out.
4. When no researcher is waiting, Arco releases the round: it writes `rounds/round-N/report-<letter>.md`, returned files into `sources/` (named by content hash, so duplicates are kept once) and `round.md`, then puts one message with every report in the Director's mailbox and starts a Director turn (or waits for its current turn to end). Reports too long for one message are summarized with their file paths.

Only one round is open at a time. `timeout_minutes` defaults to 30 and is capped at 240. Deadlines survive a restart.

Researcher file attachments must be regular files in the researcher's workspace. Symbolic links, hard links and paths outside the workspace are refused.

**Targeted messages.** The Director can `peer_send` to `Researcher B` (or `B`). The operator can type to a researcher in its pane. Both are recorded in the latest round's `round.md`. A researcher's reply outside an open round is delivered at once. Mail between the Director and a researcher starts a turn on an idle recipient whatever the cluster's AUTO-PICKUP setting.

## Blind reports

Blind is on by default. While blind:

- `peer_list` shows the Director only `Researcher A`, `Researcher B` and their role, without provider, model, tier, focus or mailbox depth. `peer_send` returns no recipient context for researchers.
- `research.json`, `round.md` and report files carry no provider or model. The mapping lives in `~/.arco/clusters/<clusterId>/research.json` (Arco state) and on the operator's `cluster_state` payload (`research`), which only the client receives.
- `round.md` shows no researcher's outcome until the round is released.

The Director is a STANDARD member with a shell. Its tools and context never carry researcher activity, names or unreleased reports, and its instructions forbid reading Arco's own state; a shell could still read `~/.arco`, so blindness against a determined Director is by instruction, not enforcement.

## The research folder

The folder is created as `<research folder>/<yyyy-mm-dd>-<slug of name>/` (with `-2`, `-3` when taken), where the research folder is the `researchFolder` setting (absolute path). The first research project asks for it and saves it; later changes affect only new projects. Arco never deletes or reuses a research folder.

```
research.json     name, brief, status, dates, letters, rounds; providers and models only when not blind or revealed
brief.md          the operator's brief and the latest round's text as sent
synthesis.md      the Director's latest distilled answer
syntheses/        earlier versions
rounds/round-N/   report-<letter>.md for each researcher that replied, and round.md
sources/          files researchers returned
director-log.md   the operator's messages and the Director's replies, tool calls folded to one line
exports.md        where results were sent
```

The Director's own conversation is kept like any tab's in `<research folder>/.arco/workflows/`.

## Start dialog

**+NEW > RESEARCH** (`client/src/components/WorkflowCreator/ResearchStartForm.tsx`) asks for:

1. **Name** (required, up to 60 characters; names the tab `Research: <name>`, the folder and `research.json`) and **Brief** (required, up to 20,000 characters; everything to research, passed to the Director unchanged).
2. **Researchers**: one row each with Provider, Model and Effort, and `DUPLICATE`, `REMOVE` and `ADVANCED`. Only connected researcher providers are offered. `ADVANCED` sets web searches per turn for Claude (1 to 50, `webSearchMaxUses`) and the context size for Ollama (`num_ctx`). Shortcuts: `ONE OF EACH PROVIDER`, `SAME AS LAST TIME` (the last panel started in this browser) and saved panels. `+ SAVE PANEL` stores the Director and researchers as a cluster preset whose researchers have the RESEARCHER access mode; such presets are listed only here, not under saved cluster presets. More than 8 researchers asks once at start in an Arco confirmation. Saved panels and `SAME AS LAST TIME` keep the ADVANCED limits; a restored provider that is not connected is dropped and a model or effort no longer offered falls back to the provider's default. Row actions are at least 44 px square.
3. **Research Director**: provider, model and effort; any connected cluster provider. It starts with the creator's current provider, model and effort when that provider is connected.
4. **Research folder**: shown from Settings, or asked for and saved the first time (`folderRoot`). Settings > Projects > **Research folder** changes it for new projects.
5. **Blind reports**: on by default.

## Research project screen

A research project opens in an ordinary cluster tab (`ClusterTab`) with these additions:

- **Rounds strip** (`client/src/components/research/ResearchRoundsStrip.tsx`) above the member cards: the project name, `BRIEF` to show the brief, Blind, Revealed or Not blind, `REVEAL` while blind, and one row per round (latest three, `ALL N ROUNDS` for the rest) with each researcher's state and the elapsed time. A row expands to each outcome, "taken from final reply", the failure reason, the deadline and the count of targeted messages. It replaces the empty-plan hint. The question expands when chosen; `REVEAL` asks in an Arco confirmation; actions are at least 44 px square.
- **Member cards** keep their live state and `STOP`. A researcher's card adds one wrapping line: letter, provider and model, isolation, web searches counted once per call from its loaded tool activity, and its state in the latest round. The operator always sees provider and model; blind applies to the Director.
- **Narrow layout:** the member rail labels the Director `RD` and researchers by letter. The rounds strip is at the top of the member list (☰), and the right strip shows `RESULTS` in place of `BOARD`. A stored `BOARD` tab opens as `RESULTS` in a research project.
- **Right panel:** `RESULTS` (new, `ResearchResultsTab.tsx`) opens `brief.md`, `synthesis.md`, `director-log.md`, `exports.md`, each round's `round.md` and the released reports in the file viewer. `BOARD` is hidden in a research project and `RESULTS` in every other cluster. Each round links its summary (`syntheses/round-N.md`, or `synthesis.md` for the latest round), read from `GET /api/research/<clusterId>/summaries`; the top Summary link says Awaiting summary until `synthesis.md` exists.
- **Reveal:** `POST /api/research/<clusterId>/reveal` sets `revealedAt`, rewrites `research.json` and every `round.md` with providers and models, and from then on `peer_list` gives the Director each researcher's provider and model as its focus. It answers 409 for a project that is not blind or not known. Reveal cannot be undone.

## Closing a research project

Closing the research tab is the only cleanup, and only the operator does it (`client/src/components/research/ResearchCloseDialog.tsx`, `server/src/research/researchClose.ts`):

1. `GET /api/research/<clusterId>/close-preview` lists files in each researcher's workspace whose content is not already in `sources/` (compared by the content-hash prefix of the file names), up to 200 files.
2. The Director's scratch question comes first, before anything closes. The dialog then shows the project name, says what is removed and kept and, when there are unsent files, offers **Move N unsent files into sources/ first** (ticked by default).
3. `CLOSE RESEARCH PROJECT` closes the researchers' tabs, which stops their turns, then calls `POST /api/research/<clusterId>/close` with `{ moveUnsent }`. The server waits up to 10 seconds for researcher turns to settle (409 `researcher_busy` otherwise), copies unsent files into `sources/` with hash-prefixed names, appends a **Researcher logs** section to the latest `round.md` (or `researcher-logs.md` when no round ran) with each researcher's turns, web searches, distinct sources opened and the failed tool calls Arco recorded, sets `closedAt` (`research.json` shows `"status": "closed"`), and removes each researcher's `isolates/<workflowId>` folder and the project's folder under `~/.arco/research/`.
4. The Director's tab and the cluster close. The Director's conversation stays in the research folder.

CLOSE RESEARCH PROJECT stays disabled until the unsent-file list is known; a failed list offers RETRY and CANCEL. A failed cleanup keeps the project tab open with the reason. Claude's server-side web search and fetch report a refusal only inside the model's reply, not as a failed tool call, so such failures appear in the researcher's report rather than in the log count. **Startup sweep:** on start, Arco removes folders under `~/.arco/research/` whose project has no cluster left and that have not changed for 10 minutes, and logs the project ids. If any cluster's `research.json` cannot be read, the sweep removes nothing. It never touches a research folder.

**Closed record.** Every close writes the Arco-side research state (author mapping, rounds, dates, `closedAt`) to `~/.arco/research/closed/<projectId>.json` (mode 0600). It is not in the research folder, so a Director resumed later still cannot read who wrote which report; a blind project that was never revealed keeps its authorship there. The startup sweep never removes `closed/`.

**Other deletion paths.** Deleting a research cluster in any other way (a dissolve, a delete from elsewhere, a member removal that collapses the cluster) runs the same server-side close first through a hook in `clusterStore.deleteCluster`: logs written, unsent files moved into `sources/`, the closed record kept. Running researcher turns are not waited for. The startup sweep then handles only crashes.

## Creating a project

`cluster_create_from_scratch` with `research: { name, brief, blind?, folderRoot? }`. `members[0]` becomes the Research Director (STANDARD); every other member becomes a researcher. The server makes the folder, sets the cluster's working directory to it, turns the task board off, names the members and writes `research.json`, `brief.md`, `director-log.md` and `exports.md`. After `cluster_created`, the server starts the Director's first turn through the research wake (`startResearchDirector`): the prompt names the project, carries the brief unchanged and tells the Director to send round 1 with `research_round`, or to ask the operator one question first when the brief is too unclear. The prompt is visible as the Director's first message. Projects made before the name and brief fields (`question`, `conditions`) are read with the question as name and brief. Researchers cannot be added with `cluster_add_fresh_workers`, `cluster_member_add` or `cluster_member_replace`; RESEARCHER is refused outside a research project.

Refusals: `invalid_name`, `invalid_brief`, `no_researchers`, `too_many_researchers` (more than 26), `member[i] researcher_provider_unavailable:<provider>`, `invalid_research_folder`, `research_folder_required`.

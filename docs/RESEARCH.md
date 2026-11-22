# Research projects

A research project sends one brief to several researchers, each working independently, and gives the answers to a Research Director the operator keeps talking to. It is a cluster with two kinds of member and a folder that describes it.

This page covers the engine: researchers, rounds and the research folder. The start dialog and the research project screen are described with their controls. Research wakes are folded in the Director conversation under a research label identifying the brief or released round.

## Members

- **Research Director:** a STANDARD member working in the research folder, with the role `Research Director`. It writes the brief, runs rounds with `research_round`, reads the released reports, writes `synthesis.md` and answers follow-ups. It gets research instructions as a system block (`server/src/research/researchDoctrine.ts`).
- **Researchers:** members with the RESEARCHER access mode. A researcher is ISOLATED and works in a private workspace under `~/.arco/clusters/<clusterId>/isolates/<workflowId>/workspace`. Claude Native, Ollama and llama.cpp have no shell and their file tools cannot leave that workspace. Claude CLI, Codex and Cursor can use a shell only inside the Linux sandbox. Research tools stay on: Claude Native gets `web_search`, `web_fetch` and `read_url`; Ollama and llama.cpp get Arco's `WebSearch` (SearXNG) and `WebFetch`; Claude CLI and Codex use their own web tools through the filtered proxy. Cursor's web search runs on Cursor's servers, so it is accepted only while the researcher's web switch is on; Cursor's web fetch is denied and pages are fetched with the shell through the filtered proxy. Every message goes to the Research Director. Claude Native, Claude CLI and Codex can return up to 8 regular workspace files, 256 KB total, through `peer_send` `artifact_paths`; links and hard links are refused.
- **Providers:** Claude Native, Ollama and llama.cpp. Claude CLI, Codex and Cursor are offered on Linux only after their sandbox availability check passes and the provider is signed in. Codex currently requires CLI version 0.171.0 and Cursor version 2026.11.22 or later; the research picker reports an incompatible installed version. Each researcher has a web switch, on by default. Off removes Native and local web tools and restricts the CLI proxy to provider hosts. Each CLI researcher runs its own preflight and fails closed if it cannot fence the worker.
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

Sandboxed research rounds place distinct synthetic markers in each researcher's workspace and private provider home. Another researcher's marker in output, a tool result or a report marks the round contaminated. The rounds strip and RESULTS show an independence warning; reports from that round should not be treated as independent. Explicit protected paths and loopback addresses in observed file or shell calls produce a separate sandbox access warning; a Cursor researcher reading its own tool output in its sandbox home's `.cursor/projects` folder does not. Warnings seen before release appear in the round record; a later warning appears in the research window and is sent to the Director. These checks are tripwires, not a replacement for the sandbox.

If a Claude CLI or Codex researcher cannot renew its existing sign-in, the research window offers RE-LOGIN outside the researcher. The researcher waits for the sign-in to change and continues with a fresh access pass; its remaining round time is held while it waits. The worker never receives the renewal key.

**Targeted messages.** The Director can `peer_send` to `Researcher B` (or `B`). The operator can type to a researcher in its pane. Both are recorded in the latest round's `round.md`. A researcher's reply outside an open round is delivered at once. Mail between the Director and a researcher starts a turn on an idle recipient whatever the cluster's AUTO-PICKUP setting.

## Adding and removing researchers

`+ ADD RESEARCHER` in MEMBERS (`client/src/components/research/AddResearcherSection.tsx`) sends `research_researcher_add` with one start-dialog row (provider, model, effort, web switch, Advanced) and `catchUp`. `REMOVE` on a researcher card asks in an Arco confirmation (`ResearchRemoveDialog.tsx`) and sends `research_researcher_remove`. Both are handled in `server/src/ws/clusterHandlers.ts`; the round logic is in `researchRounds.ts` (`addResearcher`, `removeResearcher`).

- **Adding.** The row is checked like a start-dialog row, including the sandbox checks, and the member is made like the researchers at project start: RESEARCHER access, a workflow folder in Arco state and the name `Researcher <next letter>`. Letters are never reused, and at most 26 are used in total. The researcher is left out of a round in flight and is included from the next round; `research.json` records `joinedAt` and `includedFromRound`.
- **Catch-up.** With `catchUp` and at least one round sent, the round 1 text runs for the new researcher alone, with the default 30-minute deadline. It gets that text and nothing else: no reports, later round texts or summary. Its reply is held for the catch-up, not for an open round. On release Arco writes `rounds/catch-up-<letter>/` (same layout as a round), sends the report to the Director alone with an instruction to add it to `synthesis.md` and say it arrived later, and starts a Director turn. A catch-up that ends without a report is one line to the Director, without a turn. The rounds strip and RESULTS show a `CATCH-UP <letter>` row.
- **A round during a catch-up.** The new researcher's entry in that round waits, and it receives the round text when its catch-up settles, against the round's own deadline. It therefore works on one brief at a time.
- **Removing.** The researcher stays in `research.json` with `removedAt`, so earlier rounds keep its letter, and its earlier reports, round records and summaries are unchanged. A waiting entry in the open round becomes `removed` and the round is released as soon as everyone else has finished; an open catch-up closes without a message. Its tab closes, which stops a running turn, and its private workspace and provider home are deleted, after moving files it never sent into `sources/` when the operator asks (`GET /api/research/<clusterId>/researchers/<letter>/unsent` lists them). The last researcher cannot be removed.
- **The Director** gets one "Arco research" line on each change, read on its next turn: who joined and from which round, whether a catch-up runs, or who was removed and which researchers later rounds go to. In a blind project the line names the letter only.

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
2. **Researchers**: one row each with Provider, Model and Effort, and `DUPLICATE`, `REMOVE` and `ADVANCED`. Only connected researcher providers are offered. Claude Native and a passing sandboxed Claude CLI are distinct choices; Codex and Cursor also require a passing sandbox check. `ADVANCED` sets web searches per turn for Claude Native (1 to 50, `webSearchMaxUses`) and the context size for Ollama (`num_ctx`). Shortcuts: `ONE OF EACH PROVIDER`, `SAME AS LAST TIME` (the last panel started in this browser) and saved panels. `+ SAVE PANEL` stores the Director and researchers as a cluster preset whose researchers have the RESEARCHER access mode; such presets are listed only here, not under saved cluster presets. More than 8 researchers asks once at start in an Arco confirmation. Saved panels and `SAME AS LAST TIME` keep web access, ADVANCED limits and transport; an unavailable saved Claude CLI or Codex choice remains visible but cannot start. A model or effort no longer offered falls back to the provider's default. Row actions are at least 44 px square.
3. **Research Director**: provider, model and effort; any connected cluster provider. It starts with the creator's current provider, model and effort when that provider is connected.
4. **Research folder**: shown from Settings, or asked for and saved the first time (`folderRoot`). Settings > Projects > **Research folder** changes it for new projects.
5. **Blind reports**: on by default.

## Research project screen

A research project opens in an ordinary cluster tab (`ClusterTab`) with these additions:

- **Rounds strip** (`client/src/components/research/ResearchRoundsStrip.tsx`) above the member cards: the project name, saved folder and `OPEN FOLDER`, the default location in Settings > Projects > Research folder, `BRIEF` to show the brief, Blind, Revealed or Not blind, `REVEAL` while blind, and one row per round (latest three, `ALL N ROUNDS` for the rest) with each researcher's state and the elapsed time. A row expands to each outcome, "taken from final reply", the failure reason, the deadline and the count of targeted messages. It replaces the empty-plan hint. The question expands when chosen; `REVEAL` asks in an Arco confirmation; actions are at least 44 px square.
- **Member cards** keep their live state and `STOP`. A researcher's card adds one wrapping line: letter, provider and model, isolation, web searches counted once per call from its loaded tool activity, and its state in the latest round. The operator always sees provider and model; blind applies to the Director.
- **Controls:** the research cluster bar offers Auto-compaction and SKILLS. Generic member add, replacement and detachment, board and plan controls, cluster snapshots, and unrelated coordination controls are not offered. The server refuses ordinary member additions, access-mode changes, board changes, plan attachments and hidden coordination settings for research projects. Member settings and the per-member web switch remain available in CONFIG and MEMBERS. FILES shows the research folder without the Git sub-tabs or researcher-private locations.
- **Narrow layout:** the member rail labels the Director `RD` and researchers by letter. The rounds strip is at the top of the member list (☰), and the right strip shows `RESULTS` in place of `BOARD`. A stored `BOARD` tab opens as `RESULTS` in a research project.
- **Right panel:** `RESULTS` (new, `ResearchResultsTab.tsx`) opens `brief.md`, `synthesis.md`, `director-log.md`, `exports.md`, each round's `round.md` and the released reports in the file viewer. `RESULTS` is first in a research project; `BOARD` and `PLAN` are hidden there, and `RESULTS` is hidden in every other cluster. Each round links its summary (`syntheses/round-N.md`, or `synthesis.md` for the latest round), read from `GET /api/research/<clusterId>/summaries`; the top Summary link says Awaiting summary until `synthesis.md` exists.
- **Send to a project:** `SEND REPORT`, `SEND SUMMARY` and `SEND PROJECT` choose released material, including catch-up reports from researchers who were later removed. Select an existing folder or open conversation, then independently choose a new copy under `research/`, a reference in an existing plan, or attachments staged in a conversation draft. The draft is not sent. A plan reference owns its linked files beside it; deleting the reference removes those files. A Research Director can propose a selection with `research_send_to_project`; `REVIEW SEND` lets the operator choose its destination. Successful destinations are recorded in `exports.md`; partial copies and receipt failures are reported separately. Existing files are not overwritten.
- **Start a project:** `START PROJECT` uses the latest released summary, or the released project if there is no summary. `START FROM REPORT` and `START FROM SUMMARY` choose a particular result. Preview the files, choose a parent folder and name, then open an Agent tab or cluster. An existing folder needs an explicit choice; a fresh `research/` subfolder prevents overwrites. The first message names the copied files and stays in the draft until sent. If copying or opening fails, the dialog or notice names what was kept. The export log records the opened project. The Research Director can propose this with `research_send_to_project` and `action: start`; the operator reviews and chooses the folder.
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

## Research library

Home lists every research project Arco knows in a **Research library** section between Continue and Projects (`client/src/components/Home/ResearchLibrary.tsx`, `server/src/research/researchLibrary.ts`). The section appears once there is a project or a research folder is set.

- **Index.** `~/.arco/research/library.json` (mode 0600) holds one entry per project: `projectId`, `folder`, `name`, `createdAt`, `addedAt` and `forgotten`. A project is added when it is created or reopened. The index only makes projects findable: status, question, researcher count and round count are read from the folder's `research.json` each time the list loads, so the folder stays the source of truth. `research.json` carries `projectId`; a manifest without it matches on `name` plus `createdAt`.
- **Older projects.** Each list load scans one level of the configured research folder (Settings > Projects > Research folder, at most 500 subfolders) for a `research.json` the index does not know. A project found this way takes its id from the manifest, or from the closed record whose folder matches, or a new id kept only in the index. Arco never writes into a folder only to tag it. Projects outside the research folder appear only when Arco made them, or after LOCATE.
- **Rows.** Name, the first line of the brief, status, dates, researchers still in the project, rounds and the folder path. Five rows show at first, with `Show all N`, and a filter above 10 projects. Status is `Open` when a cluster has the project (OPEN brings its tab back), `Closed` when `research.json` says so (REOPEN), and `Missing` when the folder or its `research.json` is gone, or the manifest belongs to another project (LOCATE and FORGET).
- **LOCATE** opens a folder browser. The server accepts a folder only when its `research.json` belongs to the entry, then updates the entry and the folder in the closed record. Nothing is moved.
- **FORGET** asks once, then marks the entry `forgotten`, so a later scan does not add the project back. The folder and the closed record are left alone.

Nothing in the library creates, moves or deletes a research folder.

## Reopening a project

REOPEN on a Closed row opens a dialog (`client/src/components/research/ResearchReopenDialog.tsx`) built from `GET /api/research/library/<projectId>/reopen`:

- **Research Director.** The saved Director resumes when its conversation is still in the folder (`<folder>/.arco/workflows/<directorWorkflowId>/meta.json`), its provider is on in Settings and signed in. Its tab is registered again from that folder and keeps its saved provider, model and effort. Otherwise the dialog says why and offers a new Research Director with a provider, model and effort row. **Start a new Research Director instead** chooses a new one even when resume is possible.
- **New researchers.** The earlier researchers' workspaces were removed at close, so a reopened project always gets new researchers. The rows are prefilled from the panel that was in the project when it closed; in a blind project that was not revealed they are sorted by provider and model, so their order does not tell the letters. Letters continue: a project closed with A and B reopens with C and D. Letters are never reused and run to Z.
- **REOPEN** sends `cluster_create_from_scratch` with `research.reopen: { projectId, resumeDirector }`. The server checks the rows as the start dialog does, then restores the research state from the closed record in a new cluster in the same folder: `closedAt` is cleared and `reopenedAt` set, the earlier researchers stay in the record marked removed at the close time (their reports, rounds and letters stay), and the new researchers join from the next round. A round or catch-up still open at the close is released with the replies that had arrived; waiting entries read stopped. `research.json` shows `"status": "open"` again.
- **What the Director is told.** A resumed Director gets a note in its mail and no turn: the project was reopened, the earlier researchers are gone, rounds now go to the new letters, continue from `synthesis.md`. A new Director starts with a visible first message telling it to read `research.json`, `brief.md`, `synthesis.md`, `director-log.md` and the latest round, then tell the operator where the project stands. Neither sends a round until the operator asks.
- **Refusals.** A missing folder, a project already open, or a missing closed record (`~/.arco/research/closed/<projectId>.json`) cannot be reopened; the dialog says which, and the files in the folder are unchanged. Arco does not rebuild a project from `research.json` alone, because the round texts and targeted messages it would rewrite are not in the manifest. Refusal codes: `invalid_reopen`, `research_reopen_unavailable: <reason>`, `director_conversation_missing`, `director_busy`, `director_in_another_cluster`, `too_many_researchers`, and the start dialog's row refusals.

Closing a reopened project works as for a new one. Its researcher logs list only the researchers added since the reopen.

## Creating a project

`cluster_create_from_scratch` with `research: { name, brief, blind?, folderRoot? }`. `members[0]` becomes the Research Director (STANDARD); every other member becomes a researcher. The server makes the folder, sets the cluster's working directory to it, turns the task board off, names the members and writes `research.json`, `brief.md`, `director-log.md` and `exports.md`. After `cluster_created`, the server starts the Director's first turn through the research wake (`startResearchDirector`): the prompt names the project, carries the brief unchanged and tells the Director to send round 1 with `research_round`, or to ask the operator one question first when the brief is too unclear. The prompt is visible as the Director's first message. Projects made before the name and brief fields (`question`, `conditions`) are read with the question as name and brief. Researchers cannot be added with `cluster_add_fresh_workers`, `cluster_member_add` or `cluster_member_replace`; RESEARCHER is refused outside a research project.

Refusals: `invalid_name`, `invalid_brief`, `no_researchers`, `too_many_researchers` (more than 26), `member[i] researcher_provider_unavailable:<provider>`, `invalid_research_folder`, `research_folder_required`. A request refused after its dated folder was made removes that folder and its empty subfolders while they are still empty; a folder with any other content is kept.

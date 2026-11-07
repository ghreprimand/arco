# Changelog

User-visible changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and semantic versioning. New entries go under Unreleased; releases appear newest first.

## Unreleased

### Added

- Built-in skills: grill-me, grill-with-docs, wait-what and retro (operator-run slash commands); grilling, domain-modeling, tdd, diagnosing-bugs, codebase-design, prototype and writing-for-agents (model-invoked). Settings can turn each on or off, and an editable copy takes precedence. Architecture review stays its own built-in (slash alias /improve-codebase-architecture).

- Connections > Cursor signs in from Arco: it runs `cursor-agent login` and shows the link to open, and finishes on its own, as for Codex.
- Claude Native hooks read the rest of Claude Code's hook fields: `permissionDecision` `deny`, `ask` (the call waits on an approval card, HOOK ASKS TO CONFIRM) and `allow`; `additionalContext` on every event; `continue: false` with `stopReason`; `systemMessage`; `updatedToolOutput`; `suppressOriginalPrompt`; `onFailure` (`"block"` makes a failing hook block); `async` (runs in the background, its context reaches the model with the next request); `asyncRewake` (exit 2 wakes the model, starting a turn when the tab is idle). Closing or handing off a Claude Native tab ends background hooks and background Bash commands still running, with their processes, and waits until they have ended. `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` limits Stop-hook continuations in a row (default 8).
- On Windows without Git Bash the model gets a PowerShell tool instead of Bash, as in Claude Code, so hooks matching "PowerShell" fire for it. The hardline command floor, the review gate, tool postures and every other Bash check apply to it, and the floor also recognizes the PowerShell and cmd forms of its hazards (Remove-Item -Recurse or rd /s on the drive root, home or project, stopping the Arco task or process).
- Claude Native hooks fire PreCompact before COMPACT, FOLD and SERVER FOLD (matcher `manual` or `auto`; exit 2 or `decision: "block"` skips that compaction) and Notification when an approval card has waited 6 seconds (`permission_prompt`) or 60 seconds after a turn ends with nothing sent since (`idle_prompt`). A hook's `if` field takes one permission rule, such as `Bash(git *)` or `Edit(*.ts)`, and the hook runs only for tool calls that match it; on other events a hook with `if` never runs. Hook input includes `transcript_path` (the tab's event log) and absolute file paths, and during a Task child's turn `agent_id` and `agent_type`, the type the parent asked for, which SubagentStop matchers now match.
- Claude Native hooks accept Claude Code's `args` (exec form: the program starts with its arguments as written, no shell, on every system, with `${CLAUDE_PROJECT_DIR}` filled in) and `shell` (`"bash"` or `"powershell"` for a shell-form hook; in PowerShell the path placeholders become `${env:NAME}`).
- NUDGE ALL WITH MAIL (n) in the cluster NUDGE picker, beside SEND NUDGE, nudges every member with waiting mail in one click, as if they were all ticked: idle members start a turn, busy members get the reminder to read mail at a convenient point. Members without mail are never nudged; with none, the button is unavailable and the reason shows. Also in the command palette as Cluster: nudge all with mail. The NUDGE toast (for SEND NUDGE and NUDGE ALL WITH MAIL) counts how many members were nudged and, when any were busy, how many of those got the busy reminder.
- Layout in Settings > Appearance, the command palette and the top-bar switch offers Automatic, Standard, Compact and Narrow. Automatic picks by window width: Narrow under 1500, Compact from 1500, Standard from 2000 (interface pixels: window width divided by the text size). Fixed choices apply at every width. The short plan hint links to Members when a director is needed. Splitter positions and the choice are saved in this browser.
- UNKEEP undoes KEEP: in ARTIFACTS > STORAGE for every KEEP mark of a conversation, and in OUTPUTS, where a kept artifact now shows Kept, for the mark that covers it. Each asks first; no file is changed.
- Large artifact warnings also arrive while a turn is still running, not only when it ends.
- Cluster tabs have MEMORY > USAGE: token usage for every member's conversations in the project folder, with MEASURE STORAGE and MEASURE ARCO FOLDER.
- Architecture review, a built-in operator-only skill (composer SKILLS > BUILT-IN > RUN). Arco measures the project first: largest files, most-changed files, files without tests, files with many exports, and decisions already recorded. The agent writes a report of candidates to the artifacts and changes no code. In OUTPUTS, CANDIDATES on the report offers ADD TO PLAN (a plan item with its own reference doc) and RECORD DECISION (kept in the plan's decisions doc so later reviews skip it). EDITABLE COPY saves the skill as your own.
- Code reviews and the cluster director also check the shape of a change: duplicated logic, pass-through wrappers, tests that miss the interface, and changes spread over many places. Advisory only.
- App window browser: `arco open` and the Arco shortcut also find Brave and Vivaldi on Windows (for all users or the current user), Vivaldi on macOS and Linux, and Flatpak installs of Chrome, Edge, Brave, Chromium and Vivaldi on Linux. Settings > Advanced > App window browser chooses one (Automatic, a detected browser, or another program name or path) for `arco open`, the shortcut and the explorer window; `arco open --browser <name-or-path>` chooses for one launch. A chosen browser that is not found falls back to Automatic with a message. In Firefox, Safari and other non-Chromium browsers a one-time notice says Arco runs lighter in Chrome, Edge, Brave, Vivaldi or Chromium, with CHOOSE BROWSER and DISMISS.
- Skill management in Settings > SKILLS: IMPORT from a public GitHub link, a folder or a zip file, with every file and the security check shown before saving; UPDATE an imported skill with a per-file diff; TURN OFF and TURN ON; MOVE TO GLOBAL or MOVE TO PROJECT; DUPLICATE; SHARE WITH REPOSITORY for a project skill. Each row shows the skill's extra files, its source and skill names it refers to that are not installed. IMPORT is also in the composer SKILLS menu.
- Docs describe how to leave 0.1.5 for 0.1.4 (stop, install `arco-workbench@0.1.4`, start), what changes after going back, and that `arco storage unseal` is not needed for that step.

### Changed

- OUTPUT STYLE has three levels: NORMAL, PLAIN and TERSE. Lite became Plain: a tab, member, preset, template or New-tab default saved as Lite now uses Plain. Plain is the default; tabs without a saved choice use it, and a saved Normal stays Normal. Plain asks for clear sentences with articles and the answer first, with no word limit, and ends every turn with a complete reply: what was done, what was checked and how, what was found with exact numbers, assumptions, risks, what is left with the next step, and anything that needs the operator. Terse asks for short sentences of about 20 words, no recap, and one short line per tool phase. Both keep every "not", "never", "no", "only" and "except", every number and unit, and code, commands, paths and error text exactly, and neither shortens code, comments, commits, docs, plans, board tasks or messages to other agents. Every provider now applies the style (Claude CLI, Codex exec, Cursor, Ollama, llama.cpp, LM Studio, Strata and DeepSeek as well as Claude Native and Codex app-server), so the picker is on every tab, in the creator and in the cluster member settings. Review, Handoff, DOCS, GIT and the other one-off tasks still use Normal. The picker no longer quotes an output saving.
- Claude Native hooks now follow Claude Code's hooks reference exactly, which changes how existing hooks behave. Only exit code 2 blocks (a prompt, a tool call, or the end of the model's turn); exit 1 and other non-zero exits no longer block, they show a hook error notice in the tab and the action goes ahead. A timed-out hook no longer blocks either. A Stop hook that exits 2 (or returns `decision: "block"`) now keeps the model working with its reason. PostToolUse runs only after a tool that succeeded (PostToolUseFailure after one that failed), its exit-2 stderr and `decision: "block"` reason are added next to the result instead of replacing it, and stderr from a hook that exits 0 is no longer shown to the model. `updatedInput` replaces the whole tool input instead of being merged into it. Matchers follow Claude Code's rules (exact names, `|` or `,` lists, otherwise an unanchored regular expression), identical hooks from two settings files run once, and the default timeout is 600 seconds (30 on UserPromptSubmit). SubagentStop fires in the Task child when it finishes, not in the parent.
- A server whose Arco home is inside the system temporary folder (symbolic links resolved) no longer joins the management hub when `ARCO_HUB_URL` is set: no link, no registration, no heartbeat and no cloud vault requests, and the header hub chip stays hidden. One log line says so; `ARCO_ALLOW_TEMP_HOME=1` joins anyway (`ARCO_HUB_ALLOW_TEMP_HOME=1` also works). Homes outside the temporary folder are unchanged.
- The same server sends no phone notices to an `ARCO_NTFY_URL` it inherited from the environment (with its token and the console link derived from `ARCO_HUB_URL`). A phone address saved in that home's Settings > Notifications still works, and the settings page says when `ARCO_NTFY_URL` is set but not used. One log line says so; `ARCO_ALLOW_TEMP_HOME=1` sends anyway. Homes outside the temporary folder are unchanged.
- Docs and the CONFIG manual name auto-handoff after N compactions and FOLD AT, describe PENDING cancel instead of per-message queue chips with their own ×, and state when to choose HANDOFF versus compaction (three modes).
- The composer groups the north star, pending messages, compaction continuation and skill notices in a compact status line. PENDING opens the message list and its cancellation controls. The tool-call handoff suggestion is removed.

- Auto-handoff now counts compactions instead of watching a context percentage. Auto-compaction handles the context fill; with CONFIG > AUTO-HANDOFF > Hand off after N compactions ticked (default 5, 1 to 20; off by default), Arco starts a fresh session at the end of a turn once the conversation has been compacted N times, in the chosen mode. No warning comes first; afterwards one chat line ("Handed off after 5 compactions") links the handoff document, and the count starts again. Counted: Claude Native and Ollama compactions (auto-compaction must be on), and the compactions the Claude CLI and Codex app-server report. Not counted: Fold. Cursor, Codex exec and providers without compaction cannot be counted; the control says why. The WARN and AUTO percentage sliders and the 75% context warning are gone. Tabs and Settings > Auto-handoff defaults saved with percentages keep their on or off state with 5 compactions.
- Provider letters are the same everywhere: A Claude (Anthropic), C Codex, X Cursor, O Ollama, L llama.cpp, on the top-bar dots, worker cards and the terminal sessions list. Before, C meant Claude on the dots and in terminal sessions but Codex on worker cards. Hover text and screen-reader labels name the provider in full.
- Architecture review facts count a source file as tested when a test file imports it, not only when a test file has the same name. A relative JavaScript or TypeScript import and a Python import both count.
- Dialogs open at sizes suited to their content and remember the chosen size in the browser. Reset size restores the default. Create folder reveals the new-folder fields in output pickers.
- Settings > SKILLS now says that project skills are ignored by Git (inside `.arco`) instead of "version with the repo".
- Docs and help name MEMORY > USAGE on single-worker, chat and cluster tabs (a cluster covers every member in the project folder) and point to ARTIFACTS > STORAGE (MEASURE AGAIN) from anywhere.
- Extending and glossary text no longer say project skills are versioned with the repository; they match Settings > SKILLS (ignored under `.arco`, SHARE WITH REPOSITORY for one skill).
- Install docs cover `EEXIST` when a leftover `arco` link blocks `npm install -g arco-workbench`. SHARE WITH REPOSITORY help notes the refusal when Git still ignores the skill (including a global ignore file) and names the rule.
- Cluster HISTORY and PREVIEW show the member in view (the selected card or tab, the director by default) and name it at the top, with a picker to switch. The member in view is kept when the page reloads. Before, they always showed the first member.
- REWIND CONVERSATION stays visible for providers other than Claude Native, disabled with the reason beside it, instead of being hidden.
- REPLACE and ADD FRESH take the full member settings. REPLACE starts from the member it replaces, and every choice can be changed: provider, model, effort, account, access, name, role, work size, focus, fast mode, tool filter, output style and auto-compaction. ADD FRESH offers the same choices, starting from the first member's tab settings with no work size, focus or own auto-compaction; before, it could not set work size or focus at all.
- Creating, adding and replacing members refuse an empty model, a model of another provider and a model the catalog does not list with the same message on every path. A picked Codex account that is not set up in Settings is refused instead of silently replaced by another account. A Cursor member in the creator may use a Claude or GPT model id that Cursor serves.

### Fixed

- Remote start, stop and restart of a macOS package install address its `arco-workbench` LaunchAgent and the signed-in user, and a remote stop no longer prevents the next start. A macOS SSH target needs `uid`.
- Armed Creative mode in the GENESIS tab always shows DISARM, also on small projects and after a reload.
- Cursor tabs can make or join a cluster from the tab right-click menu, and the refusal for other providers names the providers clusters accept.
- The backup script's usage text shows how it is run (`npx tsx scripts/arco-backup.ts` in a source checkout); there is no `arco backup` command.
- BELL and matching desktop and phone alerts name the tab, or the member and cluster. Hover over a shortened BELL notice to read it in full.

- Cluster creation leaves the director plan draft option off by default. Public-project choices are available in plan review and editing, Genesis and the plans library, and are saved per project for agent-created plans.
- A request path written with `..` segments or another non-canonical form can no longer reach a protected API route without the browser session. Such requests are refused.
- The utility agent, tidy, smart pickup and notification settings routes now require the browser session like every other API route. A saved ntfy access token is only sent to the server it was saved with; after changing to another server, enter the token again.
- MOVE on a plan no longer loses an edit to the plan or its reference documents saved while the move runs. The edit goes with the moved plan; if the plan keeps changing, the move stops and the plan stays where it was.
- After a crash that left a conversation log ending in an incomplete record, the first message saved after the restart is no longer lost. The incomplete record is kept in a separate file beside the log.
- Conversation logs written before 0.1.5 keep every record when they are compressed, read or written back with `arco storage unseal`. Before, records that reused older numbers after a REVERT TO HERE or a restart could be hidden from the history, dropped from the live log by the next compression, or left out of the exported plain log.
- A sealed log segment that disappears while a conversation's history is being read (for example during ARCHIVE or DELETE) is skipped and reported instead of stopping the server. `arco storage unseal` stops for that conversation, keeps its segments and continues with the others.
- Creating a cluster, ADD WORKERS and REPLACE no longer show the new members as their own tabs first. Before, each member appeared as a top-level tab and took focus until the cluster tab opened and folded them in; now the cluster tab appears once with its members.
- The composer stays steady as a running step changes. Long step names are shortened in the toolbar; hover to see the full name.

- Theme colors and fonts now apply to browser choices, form controls, help, and workspace panels across the app. The Preview status wraps within narrow panels.
- A question from the agent, its answer and other rows that arrive during a turn now appear in the chat where they happened: the reply text before them stays above, and the text after them starts a new row below. Before, the question card ended up below all of the turn's text. Each reply row now shows the time it started, not the time the turn started, and a reload shows the same order and times.
- Settings text follows the theme everywhere: the built-in skill rows now look like your own skill rows (with an OPERATOR or MODEL badge), and the Notifications, DeepSeek, project location and Arco version text no longer falls back to the page's plain text color.
- Chat history stays complete and in order after REVERT TO HERE. Before, a checkpoint record was saved with its checkpoint's number instead of the next one, so after a revert and a restart new events reused numbers already in the log: older and newer rows interleaved, some new rows were missing after a reload, and a later log compression could set part of the history aside. Logs saved this way are read in file order with each row once; nothing on disk is rewritten.
- View in Outputs on an artifact preview opens Outputs in the Narrow layout too. Before, it closed the preview and nothing opened, because the side panel there is a strip of buttons until one is clicked.
- The OUTPUT STYLE text under CONFIG no longer runs words together before the style names.
- Cursor tabs run the model chosen in Arco. Before, `cursor-agent acp` ignored the model passed at start, so a tab could run, and bill, the model saved as the Cursor CLI's default. Arco now selects the model on every new and resumed session and confirms it. Cursor runs each model only with the settings saved for it in the Cursor CLI, so when the chosen variant (for example Grok 4.7 Medium) differs, a notice names both models and the model chip shows the one in use. Choosing a Cursor model also makes it the Cursor CLI's default. Chats on Auto now run Auto instead of the CLI's default model.
- Cursor shows "Sign-in rejected" and offers Sign in again when Cursor has rejected the saved sign-in, instead of reporting connected because a token is stored. A rejected sign-in no longer counts toward the limit of three failed starts, so a tab works again as soon as the sign-in is fixed, and a failed start no longer leaves a `cursor-agent` process running.
- Error pop-ups and BELL notices linked to a worker open that worker; if its tab has closed, a message says it is no longer open.
- On Windows, starting a worker or a terminal no longer pauses the server for up to eight seconds. Arco reads each new process's start time in the background (on macOS too) and retries while the process runs, so a process left over after a crash is reliably cleaned up at the next start. Children Arco still runs are ended at shutdown without the check; a process whose start time stays unknown is still never ended and is logged once.
- A missing Codex CLI no longer crashes the server when it checks the model catalog. The picker uses the last available catalog or its fallback list.
- On Windows, the Bash tool and Claude Native hooks run in Git Bash, as in Claude Code, instead of failing because `/bin/sh` does not exist. Arco finds Git Bash through `CLAUDE_CODE_GIT_BASH_PATH`, the Git install of `git` on `PATH`, or the standard install folders, and never uses the WSL `bash.exe`. Before, every tool call matched by a configured hook was refused. Without Git Bash they run in PowerShell (`pwsh`, else Windows PowerShell), as Claude Code does: the model gets a PowerShell tool, the tab shows one notice, and Connections > Claude says how to get Git Bash. With no shell at all the Bash tool reports what is missing, and a hook that cannot start is skipped with a notice (a shell-form PreToolUse hook blocks, as in Claude Code, unless it sets `onFailure`). Timeouts and cancel end the whole command tree on Windows too.
- On Windows with Git Bash, a timed-out or cancelled command or hook now ends with everything it started, including background jobs (`cmd &`), instead of running on and holding the tool call for its full length. Commands and hooks containing backslashes, such as a hook that prints JSON with a Windows path, reach Git Bash unchanged; before, a pair of backslashes arrived as one, so such JSON did not parse and its `updatedInput` was ignored.
- A Claude Native hook that exits without reading its input (for example a PreToolUse hook that only runs `exit 2`) can no longer crash the server with a broken-pipe error. The hook's exit code and output are kept, so the block still applies.
- Menus, dropdowns, usage cards and notices stay inside the window on small screens and at a larger interface text size. One placement rule for all of them opens a menu on the other side of its button or moves it along the edge when it would run past one, and lets a menu taller than the room left scroll inside itself. Before, the provider usage cards and the PROVIDERS panel could run off the left edge, and other menus off the right or bottom edge.
- Inline output copies use owner-only permissions on systems with POSIX permissions.
- The top-bar auth chip panel ([AUTH: CLAUDE CLI] or [AUTH: CLAUDE NATIVE]) closes on a click outside it or Escape, like the other top-bar popovers, instead of only from the chip.
- OUTPUTS can move or copy to an ordinary home folder, keeps each result visible in the dialog, and presents Download as a button.
- An open page shows RELOAD when a restart leaves its session invalid or its build outdated, and reloads automatically when no unsaved work is detected.
- The project-state notice no longer counts the files of a skill shared with SHARE WITH REPOSITORY. STOP TRACKING leaves them tracked and RESTORE IGNORE FILE keeps the share lines, so neither undoes the sharing; any other tracked file in `.arco` still raises the notice. A skill counts as shared when its exception lines are in `.arco/.gitignore`.
- SHARE WITH REPOSITORY no longer leaves its exception lines in `.arco/.gitignore` when it refuses because Git still ignores the skill. The file is left exactly as it was.
- llama.cpp Chat tabs and plan-review turns no longer run a tool call the model writes as `<tool_call>` text, even with AUTO on. Tools stay refused there, as on Ollama and LM Studio.
- CATCH ME UP skips the model for empty ranges, offers wider ranges and keeps failed summaries out of chat.

- VIEW DIFF VS NOW on a checkpoint works in folders that are not Git repositories, and in Git folders it no longer shows untracked files as deleted and re-added.
- REVERT TO HERE says what it will change before it runs: files changed back, files created since that are removed, files deleted since that are restored, and files unchanged, or that nothing would change. Afterwards a result line and the REVERTED row in HISTORY show the counts, with VIEW CHANGES for the diff. The dialog states that only files are restored, not the conversation, task board or other cluster members, and in a cluster that other members' edits in the folder are reverted too.
- RESTORE IGNORE FILE and STOP TRACKING change only projects in the PROJECTS list, and refuse with a message when `.arco` or `.arco/.gitignore` is a link.
- Skills picked with APPLY ONCE in a cluster tab now reach the member. Before, the cluster composer dropped them.
- Saving a skill with the operator-only setting now keeps it. Before, the setting was not saved.
- MOVE TO PROJECT no longer refuses large binary files such as archives and disk images. Only their readable text is scanned, and they are listed as not fully scanned. Random bytes no longer fill the findings list with false IPv6 addresses. A file or copy past the findings limit is listed as not fully scanned instead of stopping the review.
- In the AUTO-PICKUP dialog, the "Advanced: model-assisted" heading sits above Smart: Observe-only. Before, it appeared between that radio button and its label.
- TEST DESKTOP asks the browser for notification permission itself when it has not been asked, and shows the result beside the button: Sent, Blocked (with how to allow notifications in the site settings and browser profile), Not allowed, Not supported or Failed. Before, it only said that permission was needed.
- Real turns now reset the idle nudge count and mark the member idle for MAIL ALERTS, clear the AUTO-PICKUP chain depth when they end, get the end-of-turn artifact size check, and wake the member again when mail arrived during the turn. Before, only some internal turns did.
- Mail stopped by the AUTO-PICKUP chain-depth limit stays in the mailbox. Before, the periodic re-check woke the member again as if the chain had started over. The same holds for mail that arrives just as the recipient's turn ends, before the message's chain depth is recorded.
- Turn-finished BELL notices and desktop alerts now appear for real turns. Before, only test turns produced them, so no operator, auto-pickup or peer-mail turn on any provider raised one. In a cluster tab, members other than the one in view now count as another tab for BELL notices.

## v0.1.4 - 2026-11-05

### Added

- KEEP a whole conversation from the STORAGE view.

- Add a STORAGE lens to the ARTIFACTS window: every project and Arco's own folder, largest first, with COMPRESS OLD LOGS per project and ARCHIVE, RESTORE, DELETE and EMPTY SCRATCH per conversation, each confirmed. Kept items and plans always stay, and an action refuses a linked folder instead of following it. STORAGE SETTINGS holds auto-archive (off by default, never deletes) and a disk budget notice (100 GiB).
- Review artifact copies into project files with Git ignore, repository visibility, size and text checks. KEEP retains protected artifacts in Arco; copying never removes the original, stages or commits it. Large artifact warnings offer KEEP or DISMISS.

- Measure storage in a single-worker or chat tab under MEMORY > USAGE: MEASURE STORAGE (then MEASURE AGAIN) for the project and MEASURE ARCO FOLDER for Arco's own folder, with every byte under one heading (conversation logs, artifacts, worktrees, caches, voice models and more), log bytes by event type, and large files. Read-only. From anywhere, ARTIFACTS > STORAGE offers MEASURE AGAIN.

- Add public-project guardrails: a "This project is public (or will be)" box beside the plan-draft choices (cluster creator, DRAFT A PLAN, PLAN dialog) that makes a drafted plan include a "Privacy and public safety" section, remembered per project folder and suggested from the Git remote (one anonymous GitHub request, cached for a day, only when a plan-draft control is shown); INSERT GUARDRAILS to add the section to an existing plan as an unsaved edit; and a dismissible notice with RESTORE IGNORE FILE and STOP TRACKING when Git tracks or does not ignore a project's `.arco` folder.
- Add optional release labels to cluster board tasks (a RELEASE field in the card drawer, or set by the director), a release filter in the board header, and a ready-to-release line for a chosen release (tasks in, accepted, left). CATCH ME UP lists board changes with their release and a movement summary, and BRIEF on a cluster adds board totals, release progress and the last day's movement. Boards without labels and older saved boards look and load as before.
- Offer LM Studio, llama.cpp, Strata and DeepSeek through Xolotl as utility agents and Smart AUTO-PICKUP evaluators. The selected model must already be loaded; these requests do not load or switch models.
- Add REFINE to the plan draft banner: type a short note and the same agent revises the draft; the new draft replaces the old one, nothing is saved until you attach it, and it can be repeated. In a cluster tab the only save button is ATTACH TO CLUSTER (ATTACH TO WORKER is gone); a single workflow keeps SAVE & ATTACH.
- Show desktop notification permission and a test in Settings, and quiet BELL notices for activity in other tabs with REQUEST PERMISSION, TEST DESKTOP and SHOW IN BELL controls.

### Changed

- Measure storage once a day in the background, read-only, for the disk-budget notice (100 GiB by default). The optional rule that archives conversations closed for a chosen number of days is off by default and never deletes.
- Agents are told to put large intermediate files (builds, disk images, downloads) in the conversation's own scratch folder instead of its artifacts. Nothing in scratch is deleted automatically.
- Seal long conversation logs into compressed pieces once the live log passes 16 MiB. Nothing is deleted, every view still shows the whole history, a damaged piece never hides records the live log still holds, and `arco storage unseal` writes plain logs back before installing an older release.
- Conversation logs no longer store a full copy of the task board on every change, and a cluster plan body is stored once in the plan history instead of in every member's log. Logs grow about half as fast in busy clusters; older logs read as before.
- ARTIFACTS > PLANS groups projects and repeated titles, identifies plans in use and offers MARK DONE for probably finished plans.

- Include recent turns by default in SECOND OPINION when no messages are selected, and show what the models will see.

### Fixed

- Allow ADD TO .GITIGNORE for artifact copies when a project path has a different resolved spelling.

- Allow artifact copies from projects opened through a linked parent folder.

- Scan extensionless artifact copies even when they contain NUL bytes, and ask again before unscanned files are copied into a public repository outside Git ignore.

- Fix long-running tabs losing every user and assistant message: system rows and tool cards now take at most half of the 500-row chat window, and a tab already showing only system rows reloads its recent history from the server once.
- Fix TIDY, CATCH ME UP and BRIEF dialogs being clipped or painted over inside the composer: they open above the whole window on an opaque surface, keep the result or error line and the buttons visible at small window heights, and share one layout with FORWARD and SEND TRANSCRIPT (title in small spaced capitals, close button in the header, actions at the bottom right). The GIT, SPAWN, HANDOFF, REVIEW, PLAN, DOCS, TUNE UP, DEEP RESEARCH and SKILL editor dialogs use the same layout.
- Fix the GIT dialog forgetting its state after VIEW CHANGES (or any close without sending): reopening it in the same tab restores the run-as choice, SHOW OTHER WORK, scroll position, branch, action, commit subject and scope notes, until a request is sent or the tab is closed.
- Apply local public-audit pattern lists in linked worktrees.
- Bound Windows service stop checks and handle a service process that already exited while stopping.
- Read Claude Native utility replies containing thinking blocks, and explain unreadable, non-text and truncated replies separately.
- Show linked instruction-file names on their target in TUNE UP AGENT FILES and explain skipped links.
- Fix UNDO THIS TURN giving no result: after an undo the turn line reads "Undone", UNDO THIS TURN is disabled so it cannot run twice, and the diff opened from it is labelled as the undone change.
- Fix the cluster board hiding finished work: SHOW DONE is now on by default (and remembered once changed), and the task count in the board header matches the tasks drawn, with a note of how many done tasks are hidden when it is off.
- Fix nudges giving no sign they were sent: after clicking a member card's mail mark or sending NUDGE, the mark reads "Nudged" and the composer NUDGE button reads "NUDGED" with a count until the member starts its turn (or two minutes pass). No toast or sound.
- Generate a valid Linux service working directory and provide a guarded `arco service refresh` for existing package installations.
- Fix Home showing every project folder at once: Projects shows two rows of cards, Show all opens the rest in a scrolling area, and search shows every match. The Getting started card now counts any started chat, session or cluster (open or saved) as step 3, and has a HIDE button that is remembered in the browser.

## v0.1.3 - 2026-11-04

### Added

- Add Settings > Notifications: opt-in alerts when a turn finishes (after 15 seconds), fails or is waiting on you, each switchable for this computer (a system notification, only while Arco is not the focused window, one per event, click opens the tab) and for your phone through ntfy (server, topic with GENERATE, optional access token, TEST; no hub needed, message text off by default; in a cluster "finished" comes from the director unless you choose every member). Everything is off by default, and existing `ARCO_NTFY_*` settings keep working. The window title shows a waiting count such as "(2) ARCO".
- Add a status on every workflow tab, cluster tab and Home Continue card: Working, Needs you, New reply (a turn finished while you were elsewhere; cleared when you open the tab) or Idle. Tabs show a colored status dot (hover or assistive technology for the word; Idle has no dot); Home Continue cards keep the word. A member card's waiting mail is a mail mark with a count (muted while busy, highlighted when idle); clicking it nudges that member, and idle mail counts as Needs you on the tab.
- Add CONTINUE a local Claude Code or Codex terminal session from a project card or the session creator (Home reads history when the project menu opens).
- Add captured file changes beneath completed turns, with diff and checkpoint undo; overlapping managed work offers a diff without undo.
- Add SECOND OPINION (formerly COMPARE): from the composer button or selected chat messages, several models each draft the reply you could send. Optional switches add the tab's last three turns and read-only file access (both off by default). USE THIS REPLY puts a draft in the composer to edit; nothing is sent automatically. Picks per model are tallied in this browser.
- Add FORWARD for selected chat messages to one or more cluster members with an optional note. SEND TRANSCRIPT gains the same note, several recipients, and switches for operator messages, agent replies and mail lines; shortened copies of mail a member sent are left out unless ticked.
- Add ADD WORKER identity fields on SPAWN FROM HERE into a cluster (role, tier, focus, access mode) next to provider, model and effort. The source's role is never copied, a second director is refused, the default name is the role plus a number, and focus starts as the first line of the new direction.
- Add a read-only SHOW OTHER WORK section in the GIT dialog for other worktrees and local branches (tab working there, ahead/behind the default branch, uncommitted files, open pull request when the GitHub CLI is available). VIEW CHANGES opens FILES > CHANGES on that worktree.
- Add OPEN on Outputs entries (and clickable names or image previews) to preview or open in the default app; programs and scripts are refused and stay downloadable.
- Add cluster creation that can request a director's reviewable plan draft, and plan hints that make drafting or attaching a plan easier to find.
- Add Settings > Appearance > Message box size (Small by default, Medium, Large): how tall every message box starts, kept in this browser.
- Add a quiet NEW REPLY mark on the director card in a cluster, and GO TO DIRECTOR on a question toast from another member. Focus never moves by itself.
- Add a NEED YOU counter to the cluster member header and make the Board quicker to clear: ACCEPT replaces DONE on review cards, ACCEPT ALL MET accepts met sign-offs, done tasks hide behind SHOW DONE, review tasks older than 7 days fold into an "N older" row, and an optional Settings > Agents and clusters checkbox marks met tasks done automatically. The Board and Plan tabs now say in one line what each is for, and the manual gains a "Plan or board?" section.
- Add Codex as a utility agent and Smart AUTO-PICKUP evaluator option while it is enabled and signed in. Each request is a one-shot read-only Codex session in an empty temporary folder with no MCP servers and web search off; any command, file change, tool, web item or approval request ends it with no decision. Regular Codex workflows are unchanged.
- Add update notices that follow the current attempt, report the installed version once, and avoid repeated punctuation in errors.
- Add package install port selection that remembers an available local port, moves if it becomes occupied, and keeps shortcuts and `arco open` on the running workbench.
- Add Windows package update checks of the recorded service process and bound process-inspection retries before replacing installed files.

### Changed

- Make the in-app manual easier to read: short paragraphs that lead with what a feature is, lists, tables and subheadings, space between paragraphs and a comfortable line length, without changing what it says.
- Publish the npm package as `arco-workbench` (`npm install -g arco-workbench`); the `arco` command, setup, service and update controls are unchanged. Earlier `@ghreprimand/arco` versions are no longer available.
- Move the CTX and OUT readout to the worker header, keeping its values, colors and calibration action.
- Redesign Home with a personal greeting and status, chat/session/cluster start tiles, waiting-first Continue cards, a filterable project grid and a Getting started checklist. The ARCO wordmark shows on Home as on every other screen.
- Regroup the top bar: provider dots open a Providers panel (versions, usage-page links, FREE VRAM with a connected local runtime, CONNECTIONS); KNOWLEDGE, TOOLS and a VOICE mic toggle with its menu sit beside them; BELL, FOCUS, HELP, SETTINGS, the version box and power follow. HELP and SETTINGS are hidden in focus mode. Move the ? help button into the top bar, right of the version box.
- Move the cluster controls into the message box of a cluster tab: NUDGE is a larger button beside the send area that highlights and counts while any member has waiting mail; SEND TO SEVERAL is replaced by a TO chip (for example "TO: BUILDER", "TO: 3 MEMBERS") that opens the member picker; BRIEF CLUSTER becomes a THIS WORKER or WHOLE CLUSTER choice on the composer's BRIEF. The cluster header keeps only the layout row and the plan line, whose "Members" now opens Workspace > Members. The member card's mail mark is larger. The one-time plan hint beside the composer's PLAN button is gone; its sentence is now the button's hover text.
- Open a cluster with the director focused and listed first (until you reorder cards), and keep the message box on the right as the one place to type. The bottom broadcast composer and SHOW BROADCAST are removed; the empty message box names who it reaches (the director by default).
- Rename the ARCHIVE button and window to ARTIFACTS (a live view of what agents produced across all projects); its content is unchanged.
- Show only what was made for you in Outputs by default (generated images, audio and video, documents at the top of the artifacts folder, reports and exports); code files and files in artifact subfolders sit behind an All files toggle. Image entries use a wide uncropped preview above the title, and long titles clamp to two lines with SHOW FULL TEXT / SHOW LESS.
- Unify the composer into one SKILLS menu for Arco playbooks and supported agent-native skills, with NEW SKILL, apply-once and pin controls.
- Show line and token estimates, read-only previews and deterministic hints on TUNE UP AGENT FILES before running a model; an accepted tune-up can be undone from its backup.
- Default Handoff to a quick, deterministic seed from recent conversation, the action digest and Git state. Written handoffs remain available and default to medium writer effort.
- Default auto-handoff to off. Provider auto-compaction now uses Arco compaction near 90% for Claude Native and Ollama; Claude CLI and Codex retain their own compaction. Existing explicit settings are preserved, and Claude API compaction stays opt-in under CONFIG > ADVANCED.
- Change the shipped appearance defaults: Phosphor themes use Victor Mono, frosted glass opacity defaults to 80%, and text brightness defaults to +25. Saved choices are kept, and the brightness reset returns to these defaults.
- Remove the Cookbook (local-model catalog, recommendations and in-app downloads). The System modal Models tab keeps the hardware profile and fit warnings under "model files".
- Hide cluster cloud and remote-management controls while the management hub is disconnected.
- Theme unstyled buttons (utility agent settings, CATCH ME UP, TIDY, BRIEF and the version box) and let Catch me up summarize from the tab start when no visit is recorded.
- Keep workers available to the operator in agent instructions: no sleep or poll longer than 60 seconds inside a turn; the director hands full verification and landing gates to the Tester (or a Builder when there is no Tester) and CI watching to the change's author; the TESTER preset includes landing-gate verification; Claude Native, Codex, Ollama and llama.cpp prompts carry the same no-wait line.
- Point the GIT dialog push instruction at the branch the commit lands on: after NEW BRANCH it tells the agent to run `git push -u <remote> <branch>` instead of pushing to the previous branch's upstream.
- Paint modal dialogs on an opaque surface under Phosphor glass and Frosted so chat text no longer shows through; side panels keep their glass.
- Bring repository guides, the in-app manual and contextual help up to date for 0.1.3 controls (including Notifications, SECOND OPINION, SKILLS, ARTIFACTS, Outputs, plans, tab status, waiting mail, cluster composer TO/NUDGE/BRIEF, auto-handoff defaults and Claude API compaction), give every durable cluster right-panel control its own plain-language help entry, and note that each opened project gets a `.arco` folder whose own `.gitignore` ignores its contents by default.
- Retake the README Home and cluster screenshots for the regrouped top bar, ARCO wordmark on Home, tab status and the cluster plan hint.

### Fixed

- Show Codex usage windows in words (5-hour, Weekly, N-hour, N-day) without the provider prefix, format reset times in local time, and rename the unlabeled "More" disclosure to "Source and login".
- Explain utility agent failures in BRIEF, CATCH ME UP, TIDY and TEST, and identify the model tried when no answer is returned. Claude Native utility requests resolve model aliases and report timeouts and provider errors.
- Name Codex beside Claude Native, Cursor and Ollama in the utility-agent feature index, Settings map, glossary and getting-started guide.
- Home waits until a project menu opens before scanning its terminal session history.
- Prevent instruction tune-up acceptance from writing through unsafe file links, and preserve separate instruction-file backups when tune-ups share a filename and timestamp.
- Keep cluster plan drafts awaiting review until an operator chooses where to attach them.
- Show the path the server actually read for chat file links, report a missing file by its name, open Windows absolute paths, and link filenames that match agent writes or artifacts.
- Replace em-dashes in in-app help and board UI strings with ASCII punctuation.
- Bound Windows process checks, leave unverified orphan PIDs untouched, and stop only service processes matching the command and home configuration.
- Fix Cursor replies: text on either side of reasoning or a tool call is now a separate message, only the latest message shows the blinking cursor, and the cursor no longer adds or removes a line.
- Attach files through same-origin `/upload` so drop, paste and the attach button work when Arco is not on port 3001, and show a visible error naming the file and the reason when an upload fails.
- Clarify the disabled Recall reference tooltip, local-runtime reconnect labels in Settings Authentication, handoff mode hints for providers without a resumable session, and keyboard focus on the Ollama status details.
- Package installation and native modules support Node.js 24 and 26 without compiling during install.
- Make the Recall "summarize on tab close" checkbox work: closing a workflow tab with a saved session starts the usual Recall summary with a toast and an OPEN RECALL link. Incognito tabs and tabs with no session do nothing, and closing is never delayed.

## v0.1.2 - 2026-11-02

### Added

- Add a utility agent: choose one provider and model for short side jobs in Settings > Agents and clusters (or on the last Welcome screen). It is never chosen for you, TEST checks it, and USE UTILITY AGENT fills it into the Smart AUTO-PICKUP evaluator, Research, Cookbook recommendation, document edit and handoff summarizer choices without changing saved ones. BRIEF, CATCH ME UP and TIDY need a utility agent.
- Add BRIEF on each member card and in the composer toolbar, and BRIEF CLUSTER above the member cards: a short synopsis from the utility agent using facts Arco can see (turn state, current step with the same elapsed time and long-running mark as the working indicator, Queued or Delivered for the last operator message from the same state the transcript shows, recent events, pending question, peer mail, board task, uncommitted files), with the facts listed. It sends nothing to any worker.
- Add CATCH ME UP summaries of workflow and cluster activity since the last visit, written by the utility agent. For a cluster, a member that is not loaded or is Incognito is skipped with a note that its activity is not available, instead of failing the whole request.
- Add TIDY in workflow and Chat composers: the utility agent proposes a clearer draft, with refinements, revision history and undo. ACCEPT only replaces the composer text; TIDY never sends. KEEP ORIGINAL and Escape leave the draft unchanged.
- Add an always-present version box in the top bar, right of the power button: it shows the running version, turns into an accent box with an up arrow and the new version when an update is available (and stays that way after the notice is dismissed), opens the update dialog on click, and shows UPDATING while an update runs.
- Add per-user application shortcuts and `arco open` for a dedicated app window.

### Contributors

- Allow local tree-only privacy audit patterns without applying them to published history.

## v0.1.1 - 2026-11-02

### Added

- Document a complete package uninstall path (service removal, npm uninstall, optional permanent data and checkpoint cleanup) in Operations, with a README link and in-app manual entry.
- Show mid-turn message delivery and the current timed working step in workflows and cluster cards.

### Changed

- Cluster coordination treats silence as approval of a stated next step and asks continuing reports to name that step.
- Peer send results and mailbox inspection show recipient activity, current task and latest reply to the sender.
- Director status-only peer messages ask for confirmation before delivery; reports and actionable messages continue normally.
- New homes enable detected provider sign-ins and local runtimes; Strata and DeepSeek through Xolotl start off. Existing provider choices remain intact.
- The usage dropdowns on the provider dots are minimal: the provider name, then the usage bars with percent and reset time (Claude Session and Weekly, Codex its usage lines, Cursor what its source provides), with one small refresh button. Sign-in and account detail stays in Connections and Settings. "Allowance" wording is now "usage limits".

### Fixed

- Project locations that are Git repositories now show the repository and its child folders; workflow names use the selected project display name.
- Windows: the background service no longer leaves a console window open on the desktop. The task now starts Node through a hidden script host launcher, raw output is kept in log files under the Arco home, `arco service logs` shows them, and `arco update` and UPDATE AND RESTART move an older install to the new task definition. Stopping or restarting the Windows service now also ends the Node process, so the port is freed.
- Claude: Welcome and Connections now report Claude as connected only when the selected transport can be used. With Native (the default) selected and no Native credentials, Claude reads "Native: sign-in needed" with SIGN IN FOR NATIVE in place and "Use Claude CLI instead" when the CLI is signed in, and Continue waits for a usable sign-in.
- Settings > Providers and models groups the Claude sign-ins together (Native first, then CLI) ahead of the other accounts and local endpoints, and the link from Connections lands on that group and highlights it.
- Repeated ADD FRESH batches with the same name continue numbering after existing cluster members.
- Fresh service installation on Windows and macOS no longer prints the expected missing-service probe as an error.
- llama.cpp: `llama-server` is now found on PATH on every platform (`llama-server.exe` on Windows) instead of a fixed Linux path, `ARCO_LLAMACPP_BIN` still overrides it, and the not-found message says where to look.

## v0.1.0 - 2026-11-01

### Added

- A local software workbench with project-aware agent conversations, saved and Incognito chats, terminals, files, Git, Preview, Review, Compare, Research, Handoff, Spawn, clusters, plans, Recall, Knowledge, Genesis, Cookbook and Media studio.
- An npm package (`npm install -g arco-workbench`, then `arco setup`) with the `arco` command and per-user background services on Linux, macOS and Windows, plus Docker with a persistent Arco home and explicitly mounted project folders. Public documentation leads with that package install and service; Docker is secondary; source builds are documented for contributors. The package supports setup, foreground start, service management, updates, diagnostics and local voice setup. Source checkouts retain `npm start` and `npm run dev`.
- Skippable Welcome setup (optional operator name, project locations, Connections), Project Home with open work, locations, pins, bookmarks, archive, missing-folder recovery and one-click resume, and Settings organized by task with a control-location map.
- Provider integrations for Claude, Codex, Cursor, Ollama, LM Studio and llama.cpp. Optional Strata and DeepSeek through separately installed external services that Arco does not distribute. New homes default to Claude Native and Codex app-server where those transports apply.
- Clusters with size-ordered templates, at most one director on new work, work-size hints for repeated roles, ROWS member cards by default, local runtime capacity for Ollama and llama.cpp, and connected-only creator launch. AUTO-PICKUP modes: Off (default), Rule-based (the recommended automatic mode), Smart Observe-only and Smart Automatic (advanced evaluator options with durable limits and session expiry).
- Waiting Codex and Claude Native questions surface as a named toast, cluster card highlight and tab mark until settled.
- Optional native voice setup (`arco voice setup` or `npm run voice:setup` in a checkout) with guided microphone testing, Computer voice operator and download notices; voice requires a native install.
- Optional GitHub release notices: in-app toast (**OPEN RELEASE** / **DISMISS**), Settings > Advanced with **CHECK NOW** and opt-out. `npm run arco:update` selects the newest stable release by default; `--ref` and `--main` select a tag or commit with confirmation. It handles Windows checkout path aliases, refuses local changes and rolls back on failure. Packaged installs use `arco update` with rollback; their services offer **UPDATE AND RESTART** on all three platforms. Linux source services also offer **UPDATE AND RESTART**.
- In-app manual and contextual help for reachable controls, public reference documentation, contributor and extending guides, third-party notices and GPL-3.0-only licensing.
- Numbered releases with this changelog and a local release command that prepares commits and tags without pushing.

### Changed

- New homes use Phosphor Electric Blue and Victor Mono at 100% interface scale; a saved theme or font pack is left alone. Interface text size is adjustable from 90% to 150%.
- Project `.arco/` state is ignored by Git by default; customized ignore files are preserved.

The [long-form release notes](docs/releases/v0.1.0.md) describe installation,
provider boundaries, download sources, and platform acceptance status.

import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Pre, Note, Kbd, Sub } from '../../components/UserManual/components';

export const powerFeatures: Section[] = [
  {
  id: 'tasks-tab',
  group: 'Power features',
  title: 'The TASKS tab - Native sub-agent fan-out',
  body: (
  <>
  <p>Native Task children keep the requested model in their live settings, saved metadata and promoted tab.</p>
  <p>
  When a Claude Native tab calls the <Code>Task</Code> tool, the spawned
  sub-agent runs as its own Arco workflow, scoped to its parent. Use the TASKS
  tab to watch those children and promote any of them to a full tab.
  </p>
  <Sub>Where children show up</Sub>
  <ul>
  <li>
  <strong>Task card</strong> on the parent's <Code>Task</Code> chat row. It
  shows the child's status (<Code>running</Code>, <Code>done</Code>,{' '}
  <Code>error</Code> or <Code>cancelled</Code>), elapsed time and workflow id,
  with a <strong>PROMOTE</strong> button that moves the child into the top tab
  strip.
  </li>
  <li>
  <strong>TASKS tab</strong> in the right pane. It appears only once this
  workflow has Task children and lists each one with the same controls.
  </li>
  <li>
  <strong>Tab strip filter.</strong> Children that have not been promoted are
  hidden from the top tab strip, so a fan-out turn does not flood the bar.
  </li>
  </ul>
  <Sub>How fan-out behaves</Sub>
  <p>
  When the model emits several <Code>Task</Code> calls in one turn, Arco runs
  them at the same time. Children share no filesystem state, so this is safe and
  much faster. Other tools stay sequential because they often share the
  project's files.
  </p>
  <p>
  Fan-out is one level deep: a child cannot start Tasks of its own. Arco does
  not build autonomous orchestration trees, and one level is the right ceiling
  for an operator-visible spawn.
  </p>
  <p>
  Cancelling the parent cancels all of its children, and the parent's agent loop
  sees a clean cancellation.
  </p>
  </>
  ),
  },

  {
  id: 'history-tab',
  group: 'Power features',
  title: 'The HISTORY tab - read-only timeline',
  body: (
  <>
  <p>Legacy tar checkpoints are staged and checked before restoring any project file. Links, path escapes, special files and linked destination folders are refused. Archives are limited to 512 MB and 10,000 entries. Ordinary files still restore, while files created after the checkpoint remain. New Git-tree checkpoints use the existing restore path.</p>
  <p>LOAD EARLIER HISTORY advances through saved event pages even when a page contains no narrative rows. Selecting a message inside PRIOR SESSIONS reveals it in chat.</p>
  <p>Saved conversations restore their recent messages together, with their active plan and current terminal list. REWIND CONVERSATION reserves the tab while validating the target. A failed branch-metadata write leaves the conversation head unchanged; cancelled work cannot dispose a newer turn.</p>
  <p>Replayed events retain their saved event time. Reopening HISTORY does not make older events appear newly received.</p>
  <p>
  The <strong>HISTORY</strong> tab in the right pane is a read-only timeline of
  this workflow's narrative events. Use it to find a past moment, label it,
  review from it, branch from it, or restore files to it.
  </p>
  <Sub>Filters</Sub>
  <p>
  A filter strip at the top scopes the list, and the choice persists per
  workflow.
  </p>
  <ul>
  <li><Code>ALL</Code>, <Code>TURNS ONLY</Code>, <Code>TOOL CALLS</Code></li>
  <li><Code>LABELS</Code>, <Code>HANDOFFS</Code>, <Code>REVIEWS</Code>, <Code>CHECKPOINTS</Code></li>
  <li><Code>REWINDS</Code> - the branches abandoned by conversation rewinds, shown with fork markers.</li>
  </ul>
  <p>
  Click a row to scroll to and flash the matching chat message when the event
  has one (user sends and assistant completions). Tool calls, handoffs and
  reviews are listed but do not flash, because they are entry points, not chat
  positions.
  </p>
  <Sub>Checkpoints and one-click revert</Sub>
  <p>
  Each <Code>CHECKPOINT ●</Code> row is a working-tree snapshot Arco took
  automatically before a file-changing turn. It is kept as a hidden git ref, so
  your real HEAD, branch and staged index are never touched. Two actions appear
  when a checkpoint row is selected:
  </p>
  <ul>
  <li>
  <strong>VIEW DIFF VS NOW</strong> opens the diff viewer comparing the
  checkpoint with the live working tree, using the same renderer as the Files{' '}
  <strong>CHANGES</strong> sub-tab. It works in folders that are not Git
  repositories too.
  </li>
  <li>
  <strong>REVERT TO HERE</strong> restores the included files to that checkpoint
  faithfully: files created after it are removed, not just overwritten.
  </li>
  </ul>
  <p>Shadow checkpoints exclude nested Git repositories and worktrees. Their names are shown on the checkpoint, in the confirmation and after a revert. Only included files count or change. Recorded exclusions remain protected if a Git marker moves. Older checkpoints without scope metadata preserve unrecorded folders and explain that limitation. If restoring a file would overwrite a preserved folder, the comparison and revert refuse without changing files. Git-backed behavior is unchanged.</p>
  <p>In non-Git folders, checkpoint discovery has entry and time budgets. Exceeding a byte or scan budget skips the whole checkpoint and shows one notice; no partial checkpoint is published. A budget-limited comparison or REVERT TO HERE changes nothing. The scan limits are ARCO_CHECKPOINT_SCAN_ENTRIES and ARCO_CHECKPOINT_SCAN_MS; the included-byte limit is ARCO_CHECKPOINT_TOTAL_CAP_BYTES. Git-backed checkpoints keep their existing behavior.</p>
  <p>
  Older tar checkpoints keep files created after the checkpoint. On POSIX systems,
  their file and directory permissions are restored too; new directories stay
  private until their contents have been restored.
  </p>
  <p>
  Before anything changes, the confirm dialog counts what the revert would do:
  files changed back, files created since that are removed, files deleted since
  that are restored, and files already unchanged. It says so when nothing would
  change. The restored tree shows up as ordinary uncommitted changes. Reverting
  is blocked while a turn is in progress, so cancel it first.
  </p>
  <p>
  After a revert, a result line under the buttons and the <Code>REVERTED</Code>{' '}
  row in HISTORY show the same counts. <strong>VIEW CHANGES</strong> on either
  opens the diff of what the revert changed.
  </p>
  <p>
  Only files go back. The conversation, the task board and other cluster
  members' conversations stay as they are; REWIND CONVERSATION takes a
  conversation back. In a cluster the checkpoint covers the whole project
  folder, so files other members changed since then are reverted too.
  </p>
  <p>
  Revert is always reversible. Arco first takes a fresh <Code>pre-revert</Code>{' '}
  checkpoint of the current tree, and aborts the whole operation if that safety
  snapshot fails. To undo a revert, revert to the pre-revert marker that appears
  right after it.
  </p>
  <p>
  Workspaces that are not git repositories are checkpointed into a private shadow
  store under <Code>~/.arco/checkpoints/</Code>, and revert there works the same
  way. Files over 32 MiB are skipped and counted, and a snapshot whose included
  total exceeds 1 GiB is skipped, so large models and videos are out of scope.
  Older tar checkpoints remain revertible.
  </p>
  <Sub>Actions on every row</Sub>
  <ul>
  <li>
  <strong>LABEL THIS</strong> pins a free-text note (up to 200 characters) to a
  past event. Labels are saved with the conversation, appear anchored to their
  event, and are append-only: you can re-label freely but not edit or delete.
  </li>
  <li>
  <strong>REVIEW FROM HERE</strong> opens the Review dialog with the scope locked
  to a <Code>FROM hh:mm:ss - label</Code> chip and the VERIFY/CRITIQUE picker
  hidden. The reviewer sees the transcript from that event onward. When the
  anchor is a label, its text is added to the reviewer's framing.
  </li>
  <li>
  <strong>SPAWN FROM HERE</strong> opens the Spawn dialog with the cutoff set to
  that row. The new tab boots with the parent's transcript cut at that point.
  Fresh-summarizer mode and Native original-worker honor the cutoff; CLI
  original-worker ignores it, because resuming the CLI session carries the full
  parent session. The dialog tells you to choose fresh-summarizer if the cutoff
  matters. Inside a cluster, ticking "Spawn into cluster" adds the ROLE, TIER,
  FOCUS and ACCESS fields from ADD WORKER so the new tab joins as a described
  member. Spawning into a cluster is available when the new tab uses Claude or
  Codex; Ollama and llama.cpp tabs join from the tab right-click menu, and Cursor
  members are added with + ADD FRESH in the cluster panel.
  </li>
  <li>
  <strong>REWIND CONVERSATION</strong> (Claude Native only) moves the live
  conversation back to the selected row and starts a fresh branch there. The
  abandoned branch stays on disk, so a rewind is itself reversible: undoing it is
  just another rewind. It uses a two-click confirm (the button becomes{' '}
  <Code>CONFIRM REWIND ↩</Code>, with a CANCEL escape) and is blocked while a
  turn is in flight. For other providers and the Claude CLI the button is shown
  disabled, with the reason beside it.
  </li>
  </ul>
  <Note>
  <strong>Files versus conversation.</strong> REWIND CONVERSATION restores the
  transcript, not the git working tree. The checkpoint row's{' '}
  <strong>REVERT TO HERE</strong> restores files.
  </Note>
  </>
  ),
  },

  {
  id: 'plan-mode-arming',
  group: 'Power features',
  title: 'Operator-armed plan mode (Claude Native)',
  body: (
  <>
  <p>
  Plan mode makes the next turn plan before it edits. Native Claude tabs show a
  button beside NORTH STAR that arms it for that one turn. It is separate from the attached project plan.
  </p>
  <p>
  The control reads <Code>PLAN FIRST (next turn)</Code>.
  Select it, and the next turn runs with <Code>Write</Code> and <Code>Edit</Code>{' '}
  blocked (they return <Code>[error] write tools disabled until ExitPlanMode</Code>).
  The system prompt also nudges the model to call <Code>EnterPlanMode</Code> for
  your task. While armed, the composer placeholder reads{' '}
  <Code>Type your task: plan mode armed for next turn</Code>.
  </p>
  <Sub>Rules</Sub>
  <ul>
  <li><strong>One turn only.</strong> The next send uses and clears it. A reload, tab swap or cancelled send also clears it without firing.</li>
  <li><strong>Visibility.</strong> The button appears only on Claude tabs using Native transport. It is hidden for director, coordinator, reviewer, researcher and documenter cluster members, and members whose roles prohibit code changes.</li>
  <li><strong>What is gated.</strong> Only <Code>Write</Code> and <Code>Edit</Code>. <Code>Bash</Code> is deliberately not gated, because recognizing write intent in arbitrary shell commands (<Code>sed -i</Code>, redirection, <Code>rm</Code> pipelines, in-place git) would be unreliable.</li>
  </ul>
  <p>
  Plan mode guards against the common slip of the model patching files before
  sketching a plan. It is not a write firewall; use a sandbox if you need a hard
  barrier.
  </p>
  <p>
  When the model calls <Code>EnterPlanMode</Code>, the tool result can include
  plan-format advisories. They are warnings only and never reject the plan; the
  model corrects on its next turn.
  </p>
  </>
  ),
  },

  {
  id: 'tool-postures',
  group: 'Power features',
  title: 'Tool postures (Claude Native)',
  body: (
  <>
  <p>
  A tool posture limits which tools a Native Claude tab exposes to the model.
  Fewer tool definitions means fewer tokens and less attention spread.
  </p>
  <p>
  The <strong>posture pill</strong> on the composer cycles the tab through four
  postures in this order: <Code>full</Code>, <Code>coding</Code>,{' '}
  <Code>review</Code>, <Code>chat</Code>.
  </p>
  <ul>
  <li><Code>full</Code> - the default; keeps everything, so existing tabs behave as before until you change it.</li>
  <li><Code>coding</Code> - drops web research (WebFetch and WebSearch), keeps the edit and run core.</li>
  <li><Code>review</Code> - read, inspect and run only: no <Code>Write</Code>, <Code>Edit</Code>, <Code>Task</Code> or web tools.</li>
  <li><Code>chat</Code> - read-only lookup.</li>
  </ul>
  <p>
  Plan-mode arming blocks writes for a single turn; a posture shapes the whole
  toolset for the tab. The posture takes effect on the next turn, is session-local
  and returns to <Code>full</Code> on reload. Optional tools you added
  (<Code>mcp__*</Code>, <Code>peer_*</Code>, <Code>ctx_*</Code>) are never
  removed by a posture.
  </p>
  </>
  ),
  },

  {
  id: 'review-safe-gate',
  group: 'Power features',
  title: 'Review-safe mode - durable approval gate (Claude Native)',
  body: (
  <>
  <p>
  Review-safe mode parks sensitive tool calls until you approve them. Turn it on
  per tab with the <Code>REVIEW SAFE-MODE</Code> toggle in CONFIG (Claude Native
  only, off by default).
  </p>
  <p>
  When it is on, the worker parks each sensitive tool call instead of running it,
  and an editable approval card appears in chat. A fixed classifier decides what
  counts as sensitive; no model judges it.
  </p>
  <p>
  The same card appears, with or without review-safe mode, when a Claude Native
  <Code>PreToolUse</Code> hook answers <Code>ask</Code>: it is labelled HOOK
  ASKS TO CONFIRM and shows the hook's reason.
  </p>
  <ul>
  <li><strong>Edit then approve.</strong> The card pre-fills the proposed tool input in a text box. Edit it if needed, then approve, or deny and revoke.</li>
  <li><strong>Standing approval.</strong> On an unedited approve you can arm "approve all like this". Arco stores an exact signature of what ran and skips the gate only for an exact match on later calls.</li>
  <li><strong>Durable.</strong> Gates and standing rules are saved with the workflow, so they survive a restart.</li>
  </ul>
  <Note>
  Review-safe mode is operator-armed, every gate and resolution is logged in the
  workflow's history, and any standing rule can be revoked.
  </Note>
  </>
  ),
  },

  {
  id: 'preview-tab',
  group: 'Power features',
  title: 'The PREVIEW tab - live dev-server iframe',
  body: (
  <>
  <p>The fitted view stays inside the panel when interface text size changes. Cluster capture controls target the member in view and use the selected capture viewport. Capture controls are disabled when no sender is available.</p>
  <p>
  The <strong>PREVIEW</strong> tab shows the workflow's dev server (Vite, Next,
  Astro, Nuxt, plain Node and so on) inside Arco, so the agent's output is
  visible without leaving the window. Remote previews need their own forwarded
  ports in addition to Arco's control port.
  </p>
  <p>Automatic discovery gives each candidate request 500 ms to respond, so a stalled server does not hold up the discovery loop.</p>
  <Sub>Header controls</Sub>
  <ul>
  <li><strong>PORT</strong> - type the dev-server port, for example <Code>5173</Code> for Vite or <Code>3000</Code> for Next.</li>
  <li><strong>BIND</strong> - bind that port to this workflow. The binding is saved, survives restarts, and is never overwritten by auto-detection.</li>
  <li><strong>RELOAD</strong> - remount the preview, which works even when the dev server ignores cache headers.</li>
  <li><strong>OPEN</strong> - open the preview URL in a new browser tab for a full-window view.</li>
  <li><strong>UNBIND</strong> - clear the binding and remove the preview.</li>
  <li><strong>4:3 / 16:10 / 16:9</strong> - the preview's aspect ratio. The choice applies to every workflow's PREVIEW tab.</li>
  </ul>
  <p>
  Below the controls, <strong>RECENT pills</strong> list this workflow's recently
  bound ports (most recent first, up to 5). Click one to rebind after an UNBIND.
  </p>
  <p>
  Arco checks the dev server first. If it is no longer running, a dialog lists
  every other service listening on the machine (Linux only, with Arco's own
  server left out) so you can bind one of those instead.
  </p>
  <Sub>Auto-detection</Sub>
  <p>
  When the agent runs <Code>npm run dev</Code>, <Code>vite</Code>,{' '}
  <Code>next dev</Code> or similar, Arco finds the port two ways and uses
  whichever answers first.
  </p>
  <ul>
  <li><strong>Command match.</strong> Arco recognizes common dev-server commands, then probes the usual ports (5173, 3000, 4321, 5174, 8080 and others). The first port that responds wins.</li>
  <li><strong>Background process (Linux only).</strong> When the agent starts the server in the background, Arco attributes the listening port directly to that process, with no probing.</li>
  <li><strong>No conflicts.</strong> If another tab already bound the port, auto-detect skips it, so two workflows running dev servers do not fight over ports.</li>
  <li><strong>Manual wins.</strong> A BIND click is sticky. Auto-detect may suggest other ports but never replaces it.</li>
  </ul>
  <p>
  On the first fresh bind for a tab, the right pane switches to PREVIEW once. A
  restart that replays existing bindings never triggers the switch.
  </p>
  <Sub>Sizing</Sub>
  <p>
  The preview always lays out at a fixed 1920-pixel-wide viewport (height 1440,
  1200 or 1080 for the three ratios). It is scaled to the largest box of that
  ratio that fits the right pane and centered, so it is never clipped. The dev
  server sees that fixed width however large the Arco window is.
  </p>
  <Sub>Separate preview ports and remote access</Sub>
  <p>Each open PREVIEW takes one port from <strong>Settings &gt; Advanced &gt; PREVIEW PORTS</strong>, normally <Code>4300-4309</Code>. The panel shows the address. Arco skips ports held by other programs and reports when none is free. Closing the last view, unbinding or removing its workflow releases the port. OPEN stays usable while PREVIEW remains open.</p>
  <p>Previews listen on the same addresses as Arco. They forward assets and live-reload WebSockets to the bound app, strip Arco cookies and Authorization, and cannot use Arco controls. Preview access expires after a disconnected view stops renewing. Service workers are blocked so code cannot remain on a port after another workflow takes it.</p>
  <p>Preview responses cannot clear cookies across ports or set host-wide transport policies, persistent alternate routing or reporting policies. Arco and Domain cookies from the app are discarded; host-only application cookies still work.</p>
  <p>The PREVIEW PORTS field and SAVE are disabled while a save is pending. Both become available when the save finishes or reports an error.</p>
  <p>PREVIEW PORTS accepts up to 100 ports below the host temporary-port range. SAVE affects new previews. <Code>ARCO_PREVIEW_PORTS</Code> overrides the saved setting. A packaged service keeps its installation environment in <Code>service/config.json</Code>; edit that environment and restart to change an override.</p>
  <p>SSH must forward the preview range as well as the Arco port. For each needed port, add a matching local forward, for example <Code>ssh -L 4300:localhost:4300 -L 4301:localhost:4301 host</Code>. Match every port that previews may take. A reverse proxy must preserve Host and forward HTTP plus WebSocket upgrades on the matching preview ports. HTTPS needs TLS on every exposed preview port.</p>
  <p>Tailscale Serve needs one HTTPS entry per preview port, in addition to the Arco control entry. For example: <Code>tailscale serve --bg --https=4300 http://127.0.0.1:4300</Code>. Repeat with matching port numbers for every port in PREVIEW PORTS, normally through 4309, or narrow the setting to the configured entries. Keep the same Tailscale hostname. Check entries with <Code>tailscale serve status</Code>.</p>
  <p>Existing installations with a firewall rule for only Arco must allow the preview range from the intended network. Linux firewalld: <Code>firewall-cmd --permanent --zone=work --add-port=4300-4309/tcp</Code>, then reload; use a zone restricted to that network. ufw: <Code>ufw allow from 192.0.2.0/24 to any port 4300:4309 proto tcp</Code>; replace the documentation subnet with the intended network.</p>
  <p>Windows Defender Firewall: add an inbound TCP rule for local ports <Code>4300-4309</Code>, restricted to the Private profile and intended remote addresses. macOS: allow the Node executable running Arco in System Settings &gt; Network &gt; Firewall &gt; Options; any additional network firewall must allow TCP <Code>4300-4309</Code>. Loopback-only SSH use needs no public inbound preview rule.</p>
  <Note>
  The preview iframe is sandboxed and cannot navigate the Arco window away.
  </Note>
  </>
  ),
  },

  {
  id: 'security-trust',
  group: 'Power features',
  title: 'Security & trust controls',
  body: (
  <>
  <p>
  A few guards keep inputs the model can reach from being trusted by default.
  None of them rely on a model's judgment; they use fixed signals and put you in
  the loop.
  </p>
  <Sub>Browser origins</Sub>
  <p>Arco approves a browser origin by its complete scheme, host and port. Other localhost ports, except the enabled development frontend, and unconfigured tailnet sites cannot use the API or control sockets. Host wildcards do not widen browser approval. The development frontend uses <Code>ARCO_CLIENT_PORT</Code> (normally 5173), only when <Code>ARCO_SERVE_CLIENT</Code> is not 1.</p>
  <p>HTTPS session cookies use Secure. A proxy must declare HTTPS from a trusted peer with an approved HTTPS browser origin. Loopback proxies are trusted; other proxy IPs need <Code>ARCO_TRUSTED_PROXIES</Code>. Forwarding headers alone do not prove TLS.</p>
  <Sub>Project trust</Sub>
  <p>
  When a tab's folder ships a <Code>CLAUDE.md</Code>, project skills or project
  settings from a repo Arco has not seen vouched for, those files are{' '}
  <strong>suppressed</strong>. The turn runs without them and a prompt appears on
  the composer. Trusting records the repo in <Code>~/.arco/trust.json</Code> and
  folds those files into future turns.
  </p>
  <p>
  It is reversible. CONFIG &gt; PROJECT TRUST sets TRUSTED, BLOCKED or ASK for the
  tab's folder (the nearest ancestor wins, so it covers every tab and cluster
  member there). SETTINGS &gt; PROJECT TRUST lists, flips, forgets or adds
  decisions in one place. Search trust decisions filters the scrollable list by path.
  </p>
  <Sub>Skill audit</Sub>
  <p>
  The skill editor's <Code>AUDIT</Code> button runs a scan you start for
  invisible Unicode and known threat patterns. It is diagnostic only and never
  blocks a save.
  </p>
  <Sub>MCP malware check</Sub>
  <p>
  Adding an MCP server from the registry looks up the referenced package on OSV
  (osv.dev). A known-malicious advisory blocks the add unless you explicitly
  override it. The check fails open: if OSV is unreachable, the add is not
  blocked.
  </p>
  <Note kind="info">
  MCP servers no longer inherit Arco's Claude OAuth token or your GitHub token.
  Their environment is an allowlist, not a pass-through.
  </Note>
  </>
  ),
  },

  {
  id: 'github',
  group: 'Power features',
  title: 'GitHub browser',
  body: (
  <>
  <p>Repository README text uses UTF-8. Switching refs, folders or files discards superseded reads. Relative document links decode their file paths separately from fragments, then scroll to the linked section after opening.</p>
<p>Failed or invalid detail reads show an error instead of opening a broken view. Return to the list and reopen the item to retry.</p>
  <p>
  The full-screen GitHub browser lets you browse repos, PRs, issues and Actions
  without leaving Arco.
  </p>
  <ol>
  <li>Log in with <Code>gh auth login</Code> in a terminal first. The browser uses your local <Code>gh</Code> login.</li>
  <li>Choose <Code>GITHUB</Code> in the header TOOLS menu to open it.</li>
  </ol>
  <p>The browser supports:</p>
  <ul>
  <li>Browsing your repos and orgs.</li>
  <li>Walking file trees and reading source files.</li>
  <li>Opening and reading PRs (with diffs) and issues.</li>
  <li>Inspecting Actions runs (jobs, logs, status). RERUN requests another run and shows Rerun requested after GitHub accepts it, including an empty response.</li>
  <li>Cloning a repo to a chosen local path.</li>
  </ul>
  <Note>
  The browser is read-mostly. Its only writes are clone, <Code>+ NEW PR</Code>{' '}
  (create a pull request), MERGE on a pull request and POST COMMENT on an
  issue, plus RERUN on an Actions run, each started by your click. Closing pull requests and other changes
  need <Code>gh</Code> or the website.
  </Note>
  </>
  ),
  },

  {
  id: 'help-system',
  group: 'Power features',
  title: 'In-app help system',
  body: (
  <>
  <p>
  Arco has two kinds of in-app help: this full manual and contextual help mode.
  </p>
  <p>
  <Code>HELP</Code> in the top bar opens a menu with USER MANUAL (this
  reference), POINT AT THINGS and KEYBOARD SHORTCUTS.
  </p>
  <Sub>Pointing at things</Sub>
  <p>
  POINT AT THINGS turns on contextual help mode. Annotated controls get a dashed
  outline on hover. Click one to open a popover with a short explanation. When
  the popover has a manual link, <Code>READ MORE IN MANUAL</Code> opens this
  window at the linked section.
  </p>
  <Note>
  Help mode intercepts clicks on annotated controls while it is active. Press{' '}
  <Kbd>Esc</Kbd> or choose <Code>EXIT POINT AT THINGS</Code> in the HELP menu to
  leave it before using a control normally.
  </Note>
  <p>
  File references opened from chat, help or rendered markdown use a stacked file
  viewer. Its raw/formatted toggle switches between highlighted or rendered
  output and the exact file text.
  </p>
  </>
  ),
  },

  {
  id: 'tool-pills',
  group: 'Power features',
  title: 'Inline tool-call pills',
  body: (
  <>
  <p>
  Each time the agent calls a tool (Bash, Read, Grep, Edit, Write, WebFetch,
  WebSearch, Glob and others), the call appears as a compact row between the
  assistant's messages.
  </p>
  <ul>
  <li>Click a row to expand the full JSON input.</li>
  <li>Click a file path inside it to open the file viewer.</li>
  </ul>
  <p>The icon on each row shows its status:</p>
  <ul>
  <li>● spinning: in progress.</li>
  <li>✓: completed.</li>
  <li>✗: failed, with the error shown inline.</li>
  </ul>
  <Note>
  Inline pills come from the Claude CLI session file, so they appear only on
  Claude CLI tabs. Claude Native, Codex and other providers show their tool
  calls in the ACTIVITY tab on the right instead of between chat messages.
  </Note>
  </>
  ),
  },

  {
  id: 'token-tracking',
  group: 'Power features',
  title: 'Token & cost tracking',
  body: (
  <>
  <p>
  Arco shows how full a worker's context is and how many tokens each turn used.
  The worker header shows context fill, cumulative output and optional speed
  readouts. ACTIVITY &gt; Token Usage shows a session summary and per-turn
  details when the provider reports them.
  </p>
  <ul>
  <li><strong>CTX</strong> - context fill (see the Context window section).</li>
  <li><strong>Last turn</strong> - prompt, cache read, cache create and output tokens for the most recent turn, when the provider reports them.</li>
  <li><strong>Speed (Ollama and Strata)</strong> - the last turn's decode tokens per second and fresh-prefill speed, from engine timings. Hover for counts and durations. Tool, load and network time are excluded, as is any cached prefix. With no timings, no readout shows.</li>
  </ul>
  <Sub>Token Usage in the ACTIVITY tab</Sub>
  <p>
  Token Usage separates retained context from processing telemetry. Claude Native
  web tools can produce large cache-read, cache-write or server-tool byte counts
  during a turn without inflating the next-turn CTX readout.
  </p>
  <p>
  The per-turn breakdown is collapsed by default. Click the{' '}
  <Code>TOKEN USAGE · N turns</Code> header to expand it. The session summary
  stays visible either way, and the expanded list scrolls in its own box so it
  never pushes the live feed off the pane.
  </p>
  <p>
  The <Code>CHECKPOINTS · N</Code> section above it works the same way. One
  checkpoint lands per file-changing turn, so the list scrolls in a short box
  (about five rows, newest first), and its header toggles ▾/▸ to hide it. The
  choice is remembered across tabs. HISTORY still owns revert and view-diff.
  </p>
  <p>Codex prompt totals already include cache hits. Fresh input subtracts those hits; the cached percentage uses the full prompt. Claude reports separate fresh, cache-read and cache-write counts. Session totals normalize each turn before adding them.</p>
  <Sub>Subscription dots</Sub>
  <p>
  The header's live-status dots are separate. Hover the <Code>A</Code> (Claude)
  dot for Claude's 5-hour and weekly subscription burn (not cost, refreshed
  every 3 minutes), or the <Code>X</Code> (Cursor) dot for Cursor's
  included-plan and Other Models quota bars.
  </p>
  <Sub>Fold (Claude Native)</Sub>
  <p>
  As the budget fills, Arco reports the fill percent and the zone it crossed.
  To reclaim room without a full Handoff, use the composer's{' '}
  <Code>⊞ FOLD</Code> button, or the per-tab AUTO-FOLD toggle in CONFIG (off by
  default).
  </p>
  <p>
  Fold trims older history into a digest in place and keeps a verbatim recent
  tail. It is a local reduction with no model call, and the raw transcript stays
  on disk. Tool results can also be evicted per turn when together they spill the
  budget. See the Context window section.
  </p>
  </>
  ),
  },

  {
  id: 'safety-rails',
  group: 'Power features',
  title: 'Safety rails on workers',
  body: (
  <>
  <p>
  Arco enforces a set of limits on every spawned worker so a runaway process
  cannot take the machine down.
  </p>
  <p>Arco&apos;s browser file views use an allowed-root policy that refuses private folders. Built-in file tools stay inside the project folder but can read project content such as <Code>.claude</Code> or <Code>.codex</Code>. Claude Native asks before writes to a small set of sensitive targets, but that is not a read filter. These rules do not sandbox Bash commands or provider CLIs, which follow their own execution, approval and sandbox settings.</p>
  <ul>
  <li>
  <strong>50 MB output cap per turn</strong> (<Code>ARCO_MAX_WORKER_OUTPUT_BYTES</Code>). Beyond that, a truncation notice
  appears and the worker is forced to settle, so a runaway loop cannot fill
  memory with text.
  </li>
  <li>
  <strong>32 GB tree-RSS auto-kill.</strong> The activity poller measures the
  resident memory of the whole worker process tree. Crossing the threshold kills
  the tree and shows the kill in chat. It guards against a runaway command, such as
  an unbounded <Code>find /</Code>, growing a worker without limit.
  </li>
  <li>
  <strong>Process-tree cleanup on cancel.</strong> Cancelling kills the entire
  descendant tree, not just the top process, and detached spawns ensure orphaned
  children come down. After an unclean restart, recorded worker and terminal
  processes are checked against their start times. Each new process's start
  time is read in the background, so starting a worker or terminal never pauses
  Arco. An unknown start time leaves the process alone and keeps its record for
  a later check.
  </li>
  <li>
  <strong>API overload retry.</strong> Transient overload errors get up to 3
  retries with 15, 30 and 60 second backoff against the same session.
  </li>
  <li>
  <strong>Concurrent-writer guard.</strong> See Native sessions &amp; resume.
  </li>
  <li>
  <strong>Stuck-worker breaker.</strong> Arco watches for a worker that gets the
  same failing result back (after fuzzy normalization) and presses on anyway. On
  a sustained loop it raises a stuck-worker notice instead of letting the worker
  burn turns. It keys on persistent errors, not repeated actions, so paging and
  polling stay legitimate.
  </li>
  <li>
  <strong>Hardline command floor (Claude Native).</strong> Native Bash refuses a
  small set of catastrophic commands that no setting overrides: restarting or
  killing Arco itself, and <Code>rm -rf</Code> of the repo root,{' '}
  <Code>$HOME</Code> or <Code>/</Code>. It is a floor, not a sandbox. A blocked
  command returns <Code>[blocked by hardline-command-floor]</Code>.
  </li>
  <li>
  <strong>In-turn tool-loop guardrail.</strong> Within one turn, Arco watches for
  an identical tool call (and especially an identical call with identical output)
  repeating past a threshold. By default it only warns, with a notice in chat. A
  hard stop is opt-in with <Code>ARCO_TOOL_LOOP_GUARD=stop</Code>. It catches a
  wedged turn in a handful of iterations instead of the 1000-iteration ceiling.
  </li>
  </ul>
  <p>
  You can opt a workflow out of the memory guard from CONFIG, for legitimate
  high-memory work. The output cap and tree cleanup cannot be turned off.
  </p>
  </>
  ),
  },

  {
  id: 'remote',
  group: 'Power features',
  title: 'Remote-friendly operation',
  body: (
  <>
  <p>Remote Cursor COMPACT uses the desktop native compression handler with the same busy and saved-session checks.</p>
  <p>Long remote conversations keep updating when older messages leave the retained window. Growing replies update their existing row. The recent window is refreshed together while unsent text and retained scroll positions are kept. Earlier history remains on the computer.</p>
  <p>
  Arco controls need one forwarded port. Live PREVIEW also needs its configured
  preview ports forwarded over SSH. A separate, much narrower hub path
  covers checking on work from a phone.
  </p>
  <p>Existing access through Arco's own address keeps working after Host validation. A reverse proxy preserves Host and states its public scheme. Extra cross-origin callers need their full origin in <Code>ARCO_ALLOWED_ORIGINS</Code>, including scheme and port. The package service keeps that setting; restart after changing it. The separate outbound management hub is unchanged.</p>
  <p>A packaged service saves environment values at first installation. For an installed service, change the <Code>env</Code> values in <Code>service/config.json</Code> under the Arco home, then restart. Reinstalling keeps the prior configuration. Source services and containers use their own environment settings.</p>
  <Sub>Using Arco over SSH</Sub>
  <ol>
  <li>
  Forward only the client port (5173):
  <Pre>{`ssh -L 5173:localhost:5173 you@dev-box`}</Pre>
  </li>
  <li>
  Open <Code>http://localhost:5173</Code> locally.
  </li>
  </ol>
  <p>
  The client server proxies <Code>/ws</Code> and <Code>/api/*</Code> to the Arco
  server on 3001, so port 3001 needs no separate forward. Uploads use the same
  proxy.
  </p>
  <Sub>Remote management (hub link and REMOTE opt-in)</Sub>
  <p>
  This path lets you check on workflows and answer, stop or continue them from a
  phone without exposing the full UI. When <Code>ARCO_HUB_URL</Code> is set, this
  instance connects outbound (tailnet-only) to an <Code>arco-management</Code>{' '}
  hub and registers itself. The header shows a <strong>hub-link chip</strong>
  with connection state and last heartbeat; click it for a one-click local kill
  switch.
  </p>
  <p>
  An instance whose Arco home folder is inside the system temporary folder, such
  as a test server, does not join the hub even when <Code>ARCO_HUB_URL</Code> is
  set, and the chip stays hidden. It also sends no phone messages to an
  inherited <Code>ARCO_NTFY_URL</Code>. Set <Code>ARCO_ALLOW_TEMP_HOME=1</Code>
  to use both anyway.
  </p>
  <p>
  Remote control is <strong>off by default</strong>, and the switches are shown
  only while this instance is connected to the hub.
  </p>
  <ul>
  <li>A standalone workflow opts in with the <Code>◎ REMOTE: OFF</Code> / <Code>◉ REMOTE</Code> toggle on the composer.</li>
  <li>A cluster has one <Code>◉ REMOTE</Code> switch in its header. It shares the cluster and every member as one unit, whatever the member-level flags say.</li>
  </ul>
  <p>Console refresh preserves unsent broadcast text, recipient selections and question answers. Text typed during a pending chat send stays unsent after the earlier message succeeds. SSH lifecycle commands have a completion deadline and bounded captured output.</p>
  <Sub>What the phone console can do</Sub>
  <ul>
  <li>Ongoing chat with a workflow.</li>
  <li>Bounded worker controls: stop, handoff, compact, fold, cancelling queued messages, answering parked questions, and (separately armed) resolving review gates.</li>
  <li>On cluster cards: member messaging and broadcast, manual nudges, stop-all, efficiency, auto-pickup and idle-nudger controls, and read-only mailbox, plan, board and merged-activity views.</li>
  </ul>
  <p>
  The hub routes only this fixed list, and the local instance{' '}
  <strong>re-validates every action against live state</strong> before applying
  it. There is no file browser, shell, git push or credential management, and
  notifications inform but never command. Every remote action is logged in the
  workflow's history.
  </p>
  <p>
  Approving gates from the phone is a <strong>second switch, also off by
  default</strong> (<Code>⛨ GATES</Code>). Without it, gates are visible but
  read-only on the phone. Cluster members follow the cluster-level REMOTE and
  GATES switches, and their individual toggles are ignored while clustered.
  </p>
  </>
  ),
  },

  {
  id: 'notification-center',
  group: 'Power features',
  title: 'Notifications - the header bell + ntfy push',
  body: (
  <>
  <p>
  The <strong>bell</strong> in the header opens a durable notice center with an
  unread badge. It is always visible, even in focus mode, and collects the
  "agent finished" and "something broke" signals you would miss while looking at
  another tab.
  </p>
  <Sub>The notice center</Sub>
  <p>Notices fall into these categories:</p>
  <ul>
  <li><Code>turn-finished</Code>, <Code>attention</Code> (failed or waiting on you), <Code>quota-recovered</Code>, <Code>auth-expired</Code></li>
  <li><Code>terminal-exited</Code>, <Code>preview-failed</Code>, <Code>pr-status</Code>, <Code>port-change</Code></li>
  <li><Code>cluster-nudge</Code>, <Code>computer-watch</Code>, <Code>backup</Code></li>
  </ul>
  <p>
  Use <strong>SHOW IN BELL</strong> to choose categories; a checked box shows that category. The choices are saved on the server. Opening
  the center clears the unread badge, and CLEAR wipes the history.
  </p>
  <p>A notice names its tab, or its member and cluster. Hover over a shortened notice to read it in full. Select a notice or error pop-up linked to a worker to open that worker. If its tab has closed, a message says it is no longer open.</p>
  <Sub>Desktop and phone alerts</Sub>
  <p>
  In Settings &gt; Notifications, tick when a turn finishes, fails or is waiting
  on you, separately for this computer and for your phone. Desktop and phone alerts start off. Quiet BELL notices for other tabs, and for cluster members not in view, start on and use the same SHOW IN BELL choices.
  </p>
  <ul>
  <li><strong>Desktop.</strong> Alerts appear only while Arco is not the focused window, one per event. The window title also shows a waiting count such as (2) ARCO.</li>
  <li><strong>Phone.</strong> Enter an ntfy server and topic (GENERATE makes one) and an optional access token, then press TEST. Message text is left out unless you turn it on. No hub is needed. <Code>ARCO_NTFY_URL</Code> still works when nothing is saved, except on an instance whose Arco home folder is inside the system temporary folder.</li>
  </ul>
  <p>
  Alerts are a one-way prompt, never a command channel. Answering one always goes
  through the Arco window, never a tappable payload.
  </p>
  </>
  ),
  },

  {
  id: 'command-palette',
  group: 'Power features',
  title: 'The command palette - Ctrl/Cmd+P',
  body: (
  <>
  <p>Opening a file or content result replaces the palette with the file viewer. Closing the viewer returns to the same palette query and selection.</p>
  <p>
  The command palette is a fuzzy finder over commands, open tabs, the active
  transcript and project files. Use it to jump anywhere without the mouse.
  </p>
  <ol>
  <li>Press <Kbd>Ctrl/Cmd+P</Kbd> anywhere, even while focus is in the composer. Press it again or <Kbd>Esc</Kbd> to close.</li>
  <li>Use <Kbd>↑</Kbd>/<Kbd>↓</Kbd> to move and <Kbd>↵</Kbd> to activate the highlighted row.</li>
  </ol>
  <Sub>Four sources</Sub>
  <ul>
  <li><strong>Commands</strong> - the toolbar actions (new tab, Settings, Manual, GitHub).</li>
  <li><strong>Tabs</strong> - every open workflow; activating one switches to it.</li>
  <li><strong>Transcript</strong> - rows of the active workflow's chat. Activating one switches to that tab and scrolls the row into view with a brief highlight, as the HISTORY tab does.</li>
  <li><strong>Files</strong> - files at the top level of the active workflow's folder. Activating one opens it in the file viewer.</li>
  </ul>
  <Sub>Content search</Sub>
  <p>
  Start the query with <Code>&gt;</Code> to search file contents across the
  workflow's folder, for example <Code>&gt;TODO</Code>. Each hit shows{' '}
  <Code>file:line</Code> and the matched text, and clicks through to the file
  viewer. The search respects the standard ignore set (<Code>node_modules</Code>,{' '}
  <Code>.git</Code>, <Code>dist</Code> and so on) and <Code>.gitignore</Code>. Files protected from the file browser are omitted from content results.
  </p>
  <Note kind="info">
  Content search needs <Code>ripgrep</Code> (<Code>rg</Code>) on the server's
  PATH, the same soft dependency the Grep tool uses. Without it the palette says
  so instead of failing, and the other three sources still work.
  </Note>
  </>
  ),
  },

  {
  id: 'integrated-terminal',
  group: 'Power features',
  title: 'The integrated terminal',
  body: (
  <>
  <p>The live-session list is authoritative after reconnect. An empty list clears sessions that did not survive a server restart.</p>
  <p>Refreshing one workflow's session list keeps terminal windows for other workflows attached to their own sessions.</p>
  <p>
  Arco includes a real terminal, so you can run system commands without leaving
  the workbench. It opens in a <strong>floating, draggable, resizable
  window</strong> that stays on top and never reflows the two-column layout. Drag
  the title bar to move it and the bottom-right corner to resize it.
  </p>
  <p>When a terminal reconnects, its display reloads the server's bounded scrollback once. The live shell keeps running.</p>
  <Sub>Opening a terminal</Sub>
  <ul>
  <li><Code>TERMINAL</Code> in the header TOOLS menu opens a shell in the active workflow's root.</li>
  <li>In the FILES tab, the <Code>&gt;_</Code> header icon opens one at the Files root, and <strong>right-clicking any directory</strong> opens one rooted there.</li>
  </ul>
  <p>
  All of these open the same floating window. Every session is rooted inside the
  workflow's folder, and a path that escapes it is refused.
  </p>
  <Sub>The shell outlives the window</Sub>
  <p>
  A session belongs to the workflow, not the window. <strong>Closing the window
  detaches</strong>: a <Code>npm run dev</Code> or a <Code>sleep 30</Code> keeps
  running, and reopening re-attaches and repaints the scrollback. Only{' '}
  <Code>KILL</Code>, closing the tab or quitting Arco ends a session.
  </p>
  <Sub>Run in terminal from chat</Sub>
  <p>
  When an agent's reply contains a shell code block (<Code>bash</Code>,{' '}
  <Code>sh</Code>, <Code>shell</Code>, <Code>console</Code> or <Code>zsh</Code>),
  a <Code>▶ RUN IN TERMINAL</Code> chip appears on it. Clicking it opens the
  terminal and <strong>pre-fills the command without running it</strong>. Review
  and edit it, then press Enter yourself. Nothing executes without that keystroke.
  </p>
  <Note kind="info">
  <strong>Operator-only.</strong> The terminal is a human surface; the model can
  never drive it (agents have their own per-turn Bash). The workflow's history
  records session open and kill (with folder and shell) and your command lines.
  The raw byte stream is deliberately excluded.
  </Note>
  <Note kind="warn">
  <strong>Remote-shell caveat.</strong> When Arco is tunneled (for example over
  Tailscale), the terminal is a remote shell on the workstation. It follows the
  same access posture as the rest of Arco (loopback bind by default), so exposing
  Arco remotely exposes the terminal too. The terminal does not sandbox you; your
  commands' effects are yours, as in any shell.
  </Note>
  </>
  ),
  },

  {
  id: 'recall-search',
  group: 'Power features',
  title: 'Recall - cross-session conversation search',
  body: (
  <>
  <p>If OPEN SUMMARY cannot read the saved file, that result offers REGENERATE SUMMARY. Choose it to request a replacement; the failed read does not start a summary by itself.</p>
  <p>When searches overlap, only the newest request changes the visible results, loading state or error.</p>
  <p>Save to KB saves the submitted draft. Edits made while that save is pending remain open and unsaved. Completing an earlier save does not close a newer draft.</p>
  <p>
  <strong>Recall</strong> searches every conversation Arco has ever run, across
  all projects and providers, not just the open tabs. Use it for "find the
  conversation from two weeks ago about X."
  </p>
  <p>
  Open it from <Code>RECALL</Code> in the header KNOWLEDGE menu or the command palette's
  "Recall: search conversations" entry.
  </p>
  <Sub>How it searches</Sub>
  <p>
  Recall uses a machine-wide index and a <strong>deterministic</strong> search
  engine. There is <strong>no model in the loop</strong>, and no AI ranking or
  summarizing.
  </p>
  <ul>
  <li><strong>Titles, summaries and tags</strong> are always searched, with relevance ranking and highlighted snippets.</li>
  <li><strong>Transcript full-text</strong> is a toggle, off by default because it is a bigger scan. When on, the query also streams each conversation&apos;s live and compressed sealed transcript, which surfaces keywords that appear only in the body. It needs <Code>rg</Code> and is disabled without it. Keeping transcripts out of the index keeps it small.</li>
  </ul>
  <p>
  Filter by project, provider and last-active date range. Each result shows the
  title, meta, a match snippet and which field matched.
  </p>
  <Sub>Result actions</Sub>
  <ul>
  <li><strong>Jump to transcript / Resume.</strong> If the conversation is an open tab, this switches to it. An archived conversation that is not open points you to its project folder to resume.</li>
  <li><strong>Summarize / Open summary.</strong> Summarize writes a saved summary of the conversation; once one exists the button opens it. The footer checkbox <strong>summarize on tab close</strong> (off by default) makes closing a tab with a saved session start the same summary, with a toast and an OPEN RECALL link. Incognito tabs and tabs with no session do nothing, and the close is never held up.</li>
  <li><strong>Reference in current tab.</strong> This will insert an excerpt as context into the active tab. It is not available yet; the button is present but disabled.</li>
  </ul>
  <Note>
  Recall is operator-driven retrospective search over your own conversations, a
  fixed projection of what is already saved. The index can be rebuilt from disk:
  delete <Code>~/.arco/recall/recall.db</Code> and the next backfill
  reconstructs it.
  </Note>
  </>
  ),
  },

  {
  id: 'knowledge-base',
  group: 'Power features',
  title: 'The KNOWLEDGE tab - operator-curated project facts',
  body: (
  <>
  <p>A disconnected Distill request shows a retryable error. Retry when connected; no draft is saved as an article automatically.</p>
  <p>
  The KNOWLEDGE tab is a per-project knowledge base that you own. It is a curated
  companion to <Code>CLAUDE.md</Code>: repo layout, gotchas, deploy steps and
  conventions you build up once instead of re-explaining each session.
  </p>
  <p>
  Articles are stored on disk under <Code>.arco/knowledge/</Code> as one markdown
  file each plus a small index, so you can edit and diff them by hand.
  </p>
  <Sub>Articles</Sub>
  <ul>
  <li>Each article has a <strong>title, markdown body and tags</strong>, and an <strong>always-include / on-demand</strong> flag.</li>
  <li>Articles flagged <strong>always include</strong> fold into every turn's system prompt as a <strong>bounded block</strong>. A budget bar shows the running always-include total against the injection budget. Over budget, the block is truncated with an explicit notice, so the knowledge base can never silently bloat a turn's context.</li>
  <li>List, search, edit and delete are plain operator actions.</li>
  </ul>
  <Sub>Adding articles</Sub>
  <p>The "Add from..." wizard offers three sources:</p>
  <ul>
  <li>a blank article;</li>
  <li>a quick link: paste a URL and write a short summary (the URL is not fetched automatically);</li>
  <li>distill from this session, where an agent <strong>drafts</strong> an article from the current transcript.</li>
  </ul>
  <Note>
  <strong>Nothing is auto-saved by a model.</strong> The distill step only drafts.
  The agent has no write tool and no access to the store. The draft lands in
  editable fields and you must explicitly <strong>Save</strong> it. The only model
  involvement is an optional drafting assist, always followed by a human Save.
  </Note>
  </>
  ),
  },
];

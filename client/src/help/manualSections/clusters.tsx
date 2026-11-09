import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Note, Kbd } from '../../components/UserManual/components';

export const clusters: Section[] = [
  {
  id: 'cluster-what-is',
  group: 'Clusters',
  title: 'What a cluster is',
  body: (
  <>
  <p>
  A <strong>cluster</strong> groups workers on one project in a shared tab.
  Use it to coordinate parallel work with peer messages and a shared plan.
  </p>
  <p>
  Each member keeps its own workflow and session. A cluster does not flatten
  members into one conversation.
  </p>
  <p>
  Members can address each other by name or identifier. Each has a mailbox
  for messages that have not yet been delivered.
  </p>
  <p>
  <strong>Why use one:</strong>
  </p>
  <ul>
  <li>
  Parallel exploration - three Claudes attacking the same repo from
  different angles, each in its own tab, swapping notes between turns.
  </li>
  <li>
  Divide-and-conquer - a DIRECTOR member tracking the plan, BUILDER
  members executing slices, a REVIEWER member checking diffs.
  </li>
  <li>
  Cross-provider second opinion - a Claude member and a Codex member
  sharing the same cwd and plan, both able to read each other's
  output.
  </li>
  </ul>
  <Note>
  Clusters are operator-driven. There is no hidden model authority that
  silently decides who works on what. Members route messages between themselves
  via peer tools <em>they</em> choose to invoke; future director-style assists
  must be operator-armed, visible, logged, reversible, and applied through
  task tools or explicit approval.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-tab',
  group: 'Clusters',
  title: 'The cluster tab',
  body: (
  <>
  <p>Sending to one member through TO preserves picked skills, steering intent and composer actions, including when another member is in view. After a successful send, TO returns to the member in view. Computer opens the chooser with the current recipients. Question options keep literal pipes and backslashes in one answer.</p>
  <p>After reconnecting, missing members are requested again if their rehydrate reply was lost. Other members keep their existing state.</p>
  <p>
  The cluster parent tab takes over the full main pane: a member-card
  grid on the left, a focused-member detail pane on the right, and a
  cluster-scoped right panel in place of the per-workflow right panel.
  </p>
  <h4 className="manual-sub">Panel and messages</h4>
  <p>A structured Codex or Claude Native question highlights its member card and shows ? QUESTION. The cluster tab shows a question mark until the question settles. The question toast names the member and opens it when selected.</p>
  <p>
  The right panel is grouped like the workflow panel:
  </p>
  <ul>
  <li>
  <strong>WORKSPACE</strong> - MEMBERS / FILES.
  </li>
  <li>
  <strong>AGENT</strong> - ACTIVITY / REVIEWS / HANDOFFS / PLAN / BOARD /
  MAILBOX.
  </li>
  <li>
  <strong>MEMORY</strong> - HISTORY of the member in view, and USAGE for the whole project folder (token usage of all members, MEASURE STORAGE and MEASURE ARCO FOLDER).
  </li>
  <li>
  <strong>RUNTIME</strong> - PREVIEW / CONFIG / GITHUB.
  </li>
  </ul>
  <p>
  CONFIG is the normal per-workflow pane scoped to one member picked from
  its MEMBER dropdown. REVIEWS and HANDOFFS merge every member&apos;s rows
  into one feed. On a narrow panel the tab row collapses to a grouped
  dropdown.
  </p>
  <p>
    The tab opens on the director, and the message box in the detail pane
  is the one place to type. The TO chip in that message box sends one
  typed message to a picked subset (or EVERYONE).
  </p>
  <p>
    A quiet NEW REPLY mark appears on the director card when a reply
  is waiting, and a question toast offers GO TO DIRECTOR; focus never
  moves by itself.
  </p>
  <h4 className="manual-sub">Creating a cluster</h4>
  <p>
    Right-click any compatible tab
  (Claude, Codex, Ollama or llama.cpp pinned to a cwd that is not already part
  of a cluster). An open Cursor tab cannot join, because its Cursor session
  started without the cluster peer tools; add Cursor members with + ADD FRESH
  in the cluster panel. Other providers cannot receive the peer tools, and the
  menu says so. The context menu offers three modes:
  </p>
  <p>The server also refuses existing Cursor sessions in cluster creation and add-existing requests. Fresh Cursor members remain supported.</p>
  <ul>
  <li>
  <strong>CREATE WITH EXISTING</strong> - multi-pick other same-cwd
  tabs of those providers to gather into a new cluster around the anchor.
  </li>
  <li>
  <strong>CREATE WITH FRESH</strong> - spawn N (1-4) new workflows
  (Claude or Codex) using the provider, model and effort shown in the picker,
  including when the anchor uses Ollama or llama.cpp. Other settings inherit
  from the anchor. The new workflows join it under a new cluster.
  </li>
  <li>
  <strong>ADD TO EXISTING</strong> - when one or more same-cwd
  clusters already exist, pick which to join.
  </li>
  </ul>
  <p>
  The cluster's <Code>cwd</Code> is fixed at creation. Every member:
  existing or freshly spawned - must share it. The fence is enforced
  server-side and at the picker; non-compatible tabs are filtered out
  of the candidate list.
  </p>
  <p>CREATE CLUSTER sends immediately and shows Starting... until the server answers. Another submission is disabled during that wait. A failed send unlocks CREATE CLUSTER. If no response arrives, the wait ends with a notice; check saved clusters before retrying. A director plan draft checks the public-project choice after creation, before starting its model turn. If that check fails, the cluster stays available; use DRAFT A PLAN to retry.</p>
  <h4 className="manual-sub">Saving and moving a cluster</h4>
  <p>Disconnected broadcasts keep the draft, attachments and chosen recipients for retry.</p>
  <p>
    MEMBERS →{' '}
  <Code>SAVE STATE</Code> captures the cluster configuration, plan, and
  each member&apos;s conversation history. Save it locally or directly
  to CLOUD when a management hub is connected.{' '}The <Code>+NEW → CLUSTER</Code> creator exposes the same
  LOCAL list, CLOUD when connected, plus <Code>IMPORT FILE</Code>; restore selects the
  destination project directory and either the last N turns per member
  or all history.
  </p>
  <p>MEMBERS lists saved clusters from this folder first. Folder links that point to the same project match; spaces in folder names are preserved. Show all projects lists every available copy; its number is the total in the selected LOCAL or CLOUD list. This project only restores the filter. The creator always lists all projects. Restore destinations stay unchanged.</p>
  <p>Cloud copies without a matching local folder summary appear under Show all projects. Project paths are not added to cloud metadata.</p>
  <h4 className="manual-sub">Reopening an existing live cluster</h4>
  <p>
    If a browser tab
  disappears while its server-side cluster still exists, open{' '}
  <Code>+NEW → CLUSTER</Code> and use{' '}
  <Code>CLOSED CLUSTERS → REOPEN</Code>. This reconnects
  the original cluster and member IDs; it does not fork from a snapshot.
  </p>
  <ul>
  <li><Code>FILE</Code> exports an integrity-checked <Code>.arcocluster</Code> bundle.</li>
  <li>CLOUD snapshots are AES-256-GCM encrypted before upload to the tailnet management hub. The hub-host vault never receives the key.</li>
  <li>Saving under an existing name asks before replacement. Local replacement is staged completely before the old copy is swapped; SAVE CLOUD also replaces the same-name cloud entry.</li>
  <li>Cloud replacement keeps the previous readable copy until the new entry is published. A failed replacement leaves that copy available.</li>
  <li>Use <Code>COPY VAULT KEY</Code> on one computer and <Code>SET VAULT KEY</Code> on the other. The project itself and provider credentials are never included.</li>
  <li>Restore mints fresh IDs. Runtime arming (REMOTE, remote gates, auto-pickup, idle nudges, and task dispatcher) remains OFF until explicitly re-enabled.</li>
  </ul>
  <h4 className="manual-sub">FRESH spawn - provider / model / effort picker</h4>
  <p>
    Both fresh-worker surfaces (CREATE WITH FRESH in the right-click
  menu, ADD FRESH in the cluster's MEMBERS sub-tab) expose a
  PROVIDER / MODEL / EFFORT picker above the COUNT input.{' '}Defaults
  clone the anchor (or cluster template, for ADD FRESH); the operator
  can override any of the three at spawn time.
  </p>
  <h4 className="manual-sub">FRESH spawn - NAME and ROLE</h4>
  <p>
    ADD FRESH also takes an optional NAME and ROLE above COUNT. One
  worker uses the name as typed; several get numbered suffixes after the
  highest existing number for that name.
  </p>
  <p>
    Below ROLE, ADD FRESH offers WORK SIZE, FOCUS, FAST MODE, TOOL
  FILTER, OUTPUT STYLE and AUTO-COMPACT. They start from the first
  member&apos;s tab settings, with no work size, focus or own
  auto-compaction, and apply to every new worker. FAST MODE and TOOL
  FILTER are shown for Claude, OUTPUT STYLE for every provider.
  </p>
  <p>
    With no
  name, the worker is called after its role (for example Builder #1) or
  Worker #1. ROLE offers the same presets and custom text as a member
  row; the one-director rule applies and a refused role spawns nothing.
  </p>
  <ul>
  <li>
  FRESH workers default to the anchor's settings, and every choice
  in the dialog can be changed at spawn time. Config the dialog does
  not show (cwd, advanced flags, skipPermissions, etc.) still
  inherits from the anchor.
  </li>
  <li>
  Mixed clusters are supported for providers with peer-tool wiring.
  Claude and Codex use the native/MCP peer substrate; Ollama and
  llama.cpp use Arco's local server-side tool registry, so local
  workers can also see <Code>peer_send</Code> / <Code>peer_read</Code>{' '}
  across the cluster.
  </li>
  <li>
  Providers without a peer-tool path remain ineligible. The cluster
  member fence is{' '}
  <strong>Claude / Codex / Ollama / llama.cpp / Cursor</strong>.
  LM Studio, Strata and DeepSeek are not cluster members. Cursor
  is fresh-spawn membership only, wired via a loopback StreamableHTTP
  MCP server for peer tools.
  </li>
  <li>
  <strong>Local capacity.</strong> Each local runtime (Ollama,
  llama.cpp) has a setting in Connections, "Cluster members that may
  use this runtime at once" (default 1, range 1 to 16). The server
  refuses a create, add or replace that would exceed it; Ollama and
  llama.cpp members together are limited by the larger setting.
  Different models each load their own copy into memory; members on
  the same model share it. Local turns still run one at a time per
  runtime unless <Code>ARCO_LOCAL_PROVIDER_SERIAL_QUEUE=0</Code>.{' '}
  <Code>ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL=1</Code> lifts the limit.
  </li>
  </ul>
  <h4 className="manual-sub">Right-panel splitter</h4>
  <p>
    A 4 px col-resize divider sits
  between the member trio (grid + detail) and the cluster right panel.
  Drag to resize; position persists per-browser to{' '}
  <Code>arco.clusterRightPanelWidth</Code> in localStorage. Range{' '}
  <Code>0.18 - 0.5</Code>.
  </p>
  <h4 className="manual-sub">TO: recipients</h4>
  <p>
    The chip in the message box's bottom row,
  for example <Code>TO: BUILDER</Code>, shows who the next message goes to; it
  starts as the member in view. Click it to pick one or several members (or
  EVERYONE).
  </p>
  <p>
    Idle members start a
  fresh turn; busy members receive it as a follow-up. The toast reads{' '}
  <em>X of N members</em>. For a single member, type in that member&apos;s
  message box in the detail pane instead.
  </p>
  <p>
    Message box starting height is
  SMALL / MEDIUM / LARGE under Settings &gt; Appearance.
  </p>
  <Note>
  Closing the cluster tab keeps its members alive as plain workflows
  (peer tools stay registered). Tear-down only happens when the{' '}
  <Code>×</Code> on the cluster tab is clicked and confirmed.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-grid',
  group: 'Clusters',
  title: 'The member grid',
  body: (
  <>
  <p>
  The member grid shows all cluster members at a glance. Select a card
  to open that member&apos;s conversation in the detail pane.
  </p>
  <p>
  LAYOUT defaults to ROWS, with AUTO, COLS and GRID also available; the
  selection persists in the browser. In AUTO and GRID, cards-per-row
  clamps to <Code>clamp(ceil(sqrt(N)), 1, 4)</Code> - 2 members → 2
  columns, 3-4 → 2×2, 5-6 → 3×2, 7-9 → 3×3, 10+ rolls vertically at 4
  columns.
  </p>
  <p>
  A 4 px splitter separates the grid from the focused-member detail
  pane on the right; drag to resize. The split position persists to
  localStorage as <Code>clusterGridSplit</Code>.
  </p>
  <p>
  Click any card to focus that member. The focused card gets an accent
  outline; the right detail pane swaps to that member's full chat,
  composer, and primitive bar.
  </p>
  <p>
  <strong>What a card shows:</strong>
  </p>
  <ul>
  <li>
  <strong>Status dot</strong> - solid + pulsing while the member is
  busy; outlined while idle. A turn is working from acceptance until it settles, including when its first activity is a tool call.
  </li>
  <li>
  <strong>Friendly name</strong> in bold (operator-set rename, or
  <Code>wfid</Code> prefix as fallback) plus IDLE/WORKING tag. A{' '}
  mail mark with a count shows the messages waiting for the
  member; they are delivered at its next turn. It is muted while the
  member is busy. When the member is idle with mail it is highlighted
  like a question, the tab counts as Needs you, and clicking the mark
  nudges that member and the mark reads Nudged until that member
  starts its turn (the composer NUDGE button reads NUDGED and a
  count meanwhile). It makes no sound and shows no pop-up.
  </li>
  <li>
  <strong>Second line</strong> - 8-char workflowId prefix and, if
  set, a role chip (preset label, or <Code>CUSTOM</Code> for
  free-form roles).
  </li>
  <li>
  <strong>Body</strong> - the last settled assistant reply or tool step.
  It updates at most once a second and never shows reasoning fragments.
  </li>
  </ul>
  </>
  ),
  },
  {
  id: 'cluster-rename',
  group: 'Clusters',
  title: 'Renaming members',
  body: (
  <>
  <p>
  Rename members from the MEMBERS tab to make cards, rows and headers
  easier to recognize. Cluster names can be set there too.
  </p>
  <ol>
  <li>
  On each row in the MEMBERS sub-tab, click the <Code>RENAME</Code>{' '}
  affordance next to the member's name.
  </li>
  <li>
  Edit the inline field (pre-filled with the current operator-set name;
  empty if none - the placeholder shows the wfid prefix).
  </li>
  <li>
  Press <Kbd>Enter</Kbd> to commit, or <Kbd>Esc</Kbd> to cancel.
  </li>
  </ol>
  <ul>
  <li>Capped at 64 characters.</li>
  <li>
  Empty commit clears the override; the member falls back to its
  8-char wfid prefix everywhere - card, sub-tab row, detail pane
  header.
  </li>
  <li>
  Persisted to the member's <Code>meta.json</Code>, so the rename
  survives server restart and rehydrates with the workflow.
  </li>
  </ul>
  <p>
  The cluster itself can be renamed the same way from the NAME row
  above the member list. Empty clears back to the derived{' '}
  <Code>&lt;basename(cwd)&gt; · &lt;short-id&gt;</Code>.
  </p>
  </>
  ),
  },
  {
  id: 'cluster-templates',
  group: 'Clusters',
  title: 'Built-in templates',
  body: (
  <>
  <p>
  The <Code>+NEW → CLUSTER</Code> creator offers seven size-ordered
  templates plus <strong>Build my own</strong> so a roster can be
  started from a known shape.
  </p>
  <ul>
  <li>Pair - builder and reviewer.</li>
  <li>Small team - director, builder, tester.</li>
  <li>Research - director and two researchers.</li>
  <li>Medium team - director, builder, tester, documenter.</li>
  <li>Full team - Medium team plus researcher.</li>
  <li>Parallel build - director, two builders, tester, documenter.</li>
  <li>Large team - Full team plus a second builder.</li>
  </ul>
  <p>
  Choosing a template opens a review that lists each member&apos;s role
  and a separate <strong>Recommended model</strong> line (model band and
  effort with a short reason).{' '}Repeated roles offer an optional <strong>Work size</strong> choice:
  Research starts unset; Parallel build and Large team recommend Heavy
  and Standard for the two builders, both editable. Unique roles get no
  work-size control.
  </p>
  <p>
  Provider and model come from connected providers only; Arco never
  picks a model. <Code>USE THESE MEMBERS</Code> replaces the member
  list. Effort starts at most at HIGH. A cluster may have at most one
  director.
  </p>
  <p>
  Member cards on the cluster tab default to the <strong>ROWS</strong>{' '}
  layout (AUTO, COLS and GRID remain available); the choice persists in
  the browser. Local Ollama and llama.cpp capacity is set in Connections
  as <Code>Cluster members that may use this runtime at once</Code>{' '}
  (default 1, range 1 to 16).
  </p>
  </>
  ),
  },
  {
  id: 'cluster-roles',
  group: 'Clusters',
  title: 'Role presets',
  body: (
  <>
  <p>
  A <strong>role hint</strong> tags one member with a short description
  of its job so the worker reads that framing before drafting a reply.
  </p>
  <p>
    A cluster can have at most one director. Roles beginning with Director
  or Coordinator count as director roles. New creates, role edits that
  would add a second director, and preset saves that would create two are
  refused.
  </p>
  <p>
  Existing clusters that already have two directors remain intact, show
  a warning on the MEMBERS rows, and still allow <Code>REPLACE</Code>{' '}
  that preserves both directors&apos; roles.
  </p>
  <p>
  The hint is injected as a forced system block during that member's
  turn. Empty hint → no block injected; the member runs unrolled.
  Examples: "track the plan and assign slices" or "execute one slice
  end-to-end and report back."
  </p>
  <p>
  Six role presets are available:
  </p>
  <ul>
  <li>
  <strong>DIRECTOR</strong> - adds to the cluster plan, fans work
  out to peers, integrates results, and avoids removing plan items.
  </li>
  <li>
  <strong>BUILDER</strong> - executes one slice end-to-end and
  reports back via <Code>peer_send</Code>.
  </li>
  <li>
  <strong>REVIEWER</strong> - inspects another member's diff /
  output and reports concerns.
  </li>
  <li>
  <strong>RESEARCHER</strong> - reads code / docs / external
  material and answers focused questions.
  </li>
  <li>
  <strong>TESTER</strong> - writes and runs tests against peer
  work and full verification on request (for example a landing
  gate); reports via <Code>peer_send</Code>; modifies test files
  only.
  </li>
  <li>
  <strong>DOCUMENTER</strong> - reads peer work via{' '}
  <Code>peer_read</Code> and writes / updates docs (README, guides,
  comments); modifies docs only.
  </li>
  </ul>
  <h4 className="manual-sub">Setting one</h4>
  <ol>
  <li>
  On each member's row in MEMBERS, click <Code>SET</Code> (or{' '}
  <Code>EDIT</Code> if one is already set).
  </li>
  <li>
  In the popover, pick one of the six presets, <Code>CLEAR</Code>, or{' '}
  <Code>CUSTOM…</Code>.
  </li>
  <li>
  A preset commits the canonical text and closes the popover.{' '}
  <Code>CLEAR</Code> wipes the hint. <Code>CUSTOM…</Code> opens an
  inline free-form editor (≤120 chars).
  </li>
  </ol>
  <p>
  After commit, the row shows{' '}
  <Code>ROLE &lt;preset.label&gt;</Code> for preset matches, or a
  truncated free-form preview otherwise. The button flips to{' '}
  <Code>EDIT</Code> and the popover highlights the currently active
  preset when reopened.
  </p>
  <Note>
  Director uniqueness is enforced (at most one). Other role hints are
  advisory, not gate-keeping: a member with <Code>REVIEWER</Code> set
  can still edit files; the worker just reads the hint and is more
  likely to behave accordingly. Combine with the cluster plan for harder
  structure.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-tiers',
  group: 'Clusters',
  title: 'Work size for the director',
  body: (
  <>
  <p>
  Work size guides which tasks the director gives a member. It does not
  change the member's model or effort and matters most when several
  members can take the same work.
  </p>
  <p>
  Template review offers a choice only for repeated roles: Research
  starts unset, while the two-builder templates recommend Heavy and
  Standard, both editable. Director rows do not need a work-size hint.
  </p>
  <p>
  A <strong>work-size hint</strong> is an operator-set label on each
  cluster member. The director (an LLM running on one of the members)
  reads it from <Code>peer_list</Code> and uses it to match task
  complexity to member capacity. Three values:
  </p>
  <ul>
  <li>
  <strong>LIGHT</strong> - quick edits, renames and simple commands.
  </li>
  <li>
  <strong>STANDARD</strong> - normal feature work.
  </li>
  <li>
  <strong>HEAVY</strong> - large or architectural changes and complex refactors.
  </li>
  </ul>
  <h4 className="manual-sub">Setting one</h4>
  <ol>
  <li>
  On each member row in MEMBERS, click a tier pill (LIGHT / STANDARD /
  HEAVY). The active pill is highlighted.
  </li>
  <li>
  Click the active pill again to clear the tier, or use{' '}
  <Code>UNSET</Code> on the right.
  </li>
  </ol>
  <p>
  With no tier, the member appears in <Code>peer_list</Code> without a{' '}
  <Code>tier</Code> field - "no opinion." The row also shows a small
  badge next to the IDLE / WORKING status when a tier is set.
  </p>
  <h4 className="manual-sub">What the director sees</h4>
  <p>
    Each <Code>peer_list</Code>{' '}
  row carries <Code>workflowId</Code>, <Code>displayName</Code>,{' '}
  <Code>pendingForThem</Code>, and (optionally) <Code>tier</Code>.
  The <Code>peer_list</Code> tool description tells the model what
  each value means. Work size guides task choice; it does not change
  model or effort. The dispatcher does not auto-assign from work size,
  and there is no quality gating.
  </p>
  <Note>
  Tier complements <Code>role</Code> rather than replacing it. Role
  describes <em>what</em> a member does (DIRECTOR / BUILDER / etc.);
  work size describes the size of task it can take. A cluster with
  one DIRECTOR + two BUILDERs (one LIGHT, one HEAVY) gives the
  director a clean two-axis dispatch.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-focus',
  group: 'Clusters',
  title: 'Member focus (sub-specialty)',
  body: (
  <>
  <p>
  <strong>Focus</strong> is an optional per-member free-form string
  (≤160 chars) describing what THIS specific member specializes in.{' '}Where <Code>role</Code> describes the canonical category (DIRECTOR /
  BUILDER / REVIEWER / etc.) and <Code>tier</Code> describes capability
  level, <Code>focus</Code> describes flavor - for example{' '}
  <em>"React frontend, Zustand store patterns"</em>,{' '}
  <em>"database performance + sqlc-generated code"</em>, or{' '}
  <em>"docs and changelog writing"</em>.
  </p>
  <h4 className="manual-sub">What the director sees</h4>
  <p>
    The <Code>peer_list</Code>{' '}
  tool returns a <Code>focus</Code> field on each row that has one,
  and the tool description tells the director to prefer a peer whose
  focus matches the task. Pure metadata - no server-side routing.
  </p>
  <h4 className="manual-sub">Setting one</h4>
  <p>
    Two places:
  </p>
  <ul>
  <li>
  On a cluster member row in the MEMBERS sub-tab - click the dashed
  FOCUS field, type the specialty, ↵ commits, Esc cancels.
  </li>
  <li>
  In the <strong>+NEW</strong> cluster builder, each member row's
  full editor has a FOCUS input below ROLE. Saved presets include
  the focus, so loading a preset re-applies focus alongside role and
  tier.
  </li>
  </ul>
  <Note>
  When multiple members share a role (e.g. two BUILDERs), set distinct
  focus strings so the director can route by specialty instead of
  round-robin. With one Claude builder focused on <em>"UI / React"</em>{' '}
  and one Codex builder focused on <em>"backend / SQL"</em>, "fix the
  login form" goes to the first, "add a new query" goes to the second.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-member-replacement',
  group: 'Clusters',
  title: 'Replacing members and access modes',
  body: (
  <>
  <p>Fresh workers, replacements and Native Task children inherit the standing goal but not an armed goal run. Each new tab needs its own explicit run.</p>
  <p>
  Use <Code>REPLACE</Code> on a row in the MEMBERS sub-tab for a
  genuinely fresh worker in the same cluster slot.
  </p>
  <h4 className="manual-sub">Replacing a member</h4>
  <p>
  Arco creates a new workflow ID and provider session and swaps the
  roster entry in one step. The dialog starts from the old member, and
  every choice can be changed: provider, model, effort, account, access,
  NAME, ROLE, WORK SIZE, FOCUS, FAST MODE, TOOL FILTER, OUTPUT STYLE and
  AUTO-COMPACT. Settings the dialog does not show are copied. The old
  workflow stays on disk but leaves the cluster.
  </p>
  <p>
  REPLACE, ADD FRESH and the creator refuse an empty model, a model of
  another provider and a model the catalog does not list with the same
  message. A picked Codex account that is not set up in Settings is
  refused; Arco never switches to another account.
  </p>
  <p>
  Two independent switches control what crosses the boundary:
  </p>
  <ul>
  <li>
  <strong>INCLUDE PRIOR WORKFLOW HISTORY</strong> is OFF by default.
  When ON, Arco renders the old transcript plus an action digest
  into one explicit replacement-context seed turn. This costs a
  model call and does not resume or reuse the former provider
  session.
  </li>
  <li>
  <strong>TRANSFER ACTIVE TASK ASSIGNMENTS</strong> reassigns the
  old workflow&apos;s non-done, non-archived board tasks to the new
  workflow ID. Turn it OFF when the worker should arrive without
  inherited work.
  </li>
  </ul>
  <p>
  Both REPLACE and ADD FRESH offer three access postures:
  </p>
  <ul>
  <li>
  <strong>STANDARD</strong> - normal cluster context and project
  access.
  </li>
  <li>
  <strong>BLIND</strong> - project files remain available, but the
  worker receives no cluster plan, board, roster, role, focus,
  efficiency, or progress context. Its only cluster tools are{' '}
  <Code>peer_send</Code> and <Code>peer_read</Code>. Use this for an
  independent auditor that may inspect the project but should not be
  primed by the cluster&apos;s conclusions. It cannot claim or
  transition board tasks itself: when substantive work is complete,
  it reports the result by peer mail and asks a STANDARD member or
  the operator to update the board. It must not probe Arco&apos;s
  local APIs or workflow storage to recover the withheld state.
  </li>
  <li>
  <strong>ISOLATED</strong> - Claude Native only. The worker runs in
  a private durable scratch directory at{' '}
  <Code>
  ~/.arco/clusters/&lt;clusterId&gt;/isolates/&lt;wfid&gt;/workspace
  </Code>{' '}
  and cannot read the project cwd, project instructions, knowledge,
  attachments, hooks, registry MCPs, or use a shell. It receives
  only mailbox send/read for cluster communication. History and
  task transfer are forced OFF.
  </li>
  </ul>
  <p>
  An isolated worker can return files without gaining project access:
  include up to 8 scratch-relative paths (256 KB total) in{' '}
  <Code>peer_send artifact_paths</Code>. Arco copies them across the
  boundary into the recipient&apos;s{' '}
  <Code>.arco/peer-artifacts/&lt;messageId&gt;/</Code> directory.
  Separate delivery and file folders preserve attachments with matching names.
  </p>
  <Note kind="warn">
  Changing an already-informed worker to ISOLATED in place would retain
  forbidden context, so ISOLATED is deliberately available only when
  creating or replacing a worker. A replacement with history OFF is
  the clean reset.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-plan',
  group: 'Clusters',
  title: 'The cluster plan',
  body: (
  <>
  <p>
  A cluster carries one <strong>shared plan body</strong> up to{' '}
  <strong>32 KB</strong> (soft-warns at 28 KB) that every member sees
  on each turn.
  </p>
  <p>Checkbox saves preserve intervening edits through a plan-version check. A conflict asks for a fresh review before retrying. Member ticks match task text against the version being saved.</p>
  <h4 className="manual-sub">Using the plan</h4>
  <p>During cluster creation, choose no plan, attach an existing project plan, have the director draft after creation, or draft in Genesis first. A director draft needs a director and a detailed description. The draft is shown for review before attachment.</p>
  <p>Genesis returns to the creator with its saved plan selected. The other creator fields stay as entered. Closing Genesis returns without selecting a plan.</p>
  <p>A cluster with no plan also offers DRAFT A PLAN, ATTACH EXISTING and NOT NOW. The last choice is remembered for that cluster in this browser. In the compact hint, DRAFT A PLAN first opens the public-project choice.</p>
  <p>
  The plan is routed as a forced system block with{' '}
  <Code>cache_control: ephemeral</Code> so it lives in the
  provider-side 5-min prompt cache window. Net effect: one cache miss
  per plan edit, no per-turn inflation as members run their work.
  </p>
  <p>
  Edited from the <strong>PLAN</strong> sub-tab of the cluster right
  panel. The tab has two modes:
  </p>
  <ul>
  <li>
  <strong>VIEW</strong> - renders the markdown body using the same
  parser as the per-workflow PLAN tab. H1/H2/H3 headings render styled;{' '}
  <Code>- [ ]</Code> / <Code>- [x]</Code> checkboxes are clickable to
  toggle (optimistic + cluster_plan_set echo). Each H3 heading gets
  three action pills: <Code>▷ REVIEW PHASE PLAN</Code>,{' '}
  <Code>▷ VERIFY PHASE WORK</Code>, and <Code>▷ SPAWN PHASE</Code>.
  </li>
  <li>
  <strong>EDIT</strong> - drops to the textarea with byte counter +
  dirty marker; SAVE flips back to VIEW. Empty body auto-opens in EDIT.
  </li>
  </ul>
  <p>
  When the cluster has a board attached (mode <Code>project</Code> or{' '}
  <Code>cluster</Code>), each unchecked checkbox line in the plan also shows
  a <Code>→ TASK</Code> pill that promotes that line&apos;s text into a
  durable board task - a one-click bridge from the shared plan to the
  kanban board.
  </p>
  <p>
  The header pill bar in VIEW mode mirrors the worker tab:{' '}
  <Code>EDIT</Code>, <Code>CLEAR PLAN</Code>, <Code>REVIEW PLAN</Code>,
  <Code>VERIFY WORK</Code>, <Code>CUSTOM REVIEW</Code>. Cluster-specific
  omissions: no DETACH / PROMOTE / MOVE / DONE (the cluster plan is the
  cluster plan - these do not apply).
  </p>
  <p>
  <strong>REVIEW and VERIFY open the review dialog directly</strong> on
  the shared cluster plan (scope <Code>CLUSTER PLAN</Code> or a phase);
  the first member only names the review&apos;s files. Only{' '}
  <Code>CUSTOM REVIEW</Code> asks for a member first, because it reviews
  that member&apos;s transcript.
  </p>
  <p>
  <strong>SPAWN PHASE</strong> spawns a fresh cluster member off the
  cluster's first-member template, defaults the new member's role to
  BUILDER, and prefills the SpawnDialog with the phase block (heading +
  every line until the next heading).
  </p>
  <p>
    Saving an empty body is rejected (use <Code>CLEAR PLAN</Code> to wipe).
  Edits land on the <em>next</em> turn for each member - in-flight turns
  are not torn down.
  </p>
  <Note>
  Operator edits in the PLAN tab can replace or clear the whole body.
  Model-driven <Code>cluster_plan_write</Code> calls are narrower: once
  a plan exists, they must preserve existing checkbox tasks and their{' '}
  <Code>[ ]</Code> / <Code>[x]</Code> state. Directors can append urgent
  sections or new tasks, but status changes go through{' '}
  <Code>cluster_plan_tick</Code> and destructive rewrites require the
  operator.
  </Note>
  <p>
  <strong>Three ways to fill it:</strong>
  </p>
  <ul>
  <li>Edit directly in the PLAN sub-tab and click <Code>SAVE PLAN</Code>.</li>
  <li>
  From any member's per-workflow PLAN tab, click{' '}
  <Code>PROMOTE TO CLUSTER</Code> to copy the member's attached plan
  body up to cluster level.
  </li>
  <li>
  Use the <Code>ATTACH TO CLUSTER</Code> button on a plan candidate
  banner - see the next section.
  </li>
  </ul>
  </>
  ),
  },
  {
  id: 'cluster-attach-from-banner',
  group: 'Clusters',
  title: 'ATTACH TO CLUSTER (plan candidate)',
  body: (
  <>
  <p>
  The plan candidate banner lets the operator save a newly emitted plan,
  ask the agent to revise it, or discard it.
  </p>
  <p>
  When any worker emits a plan via <Code>ExitPlanMode</Code> (Claude /
  Codex / etc.), the <strong>PlanCandidateBanner</strong> appears
  between the chat and the composer with these buttons:
  </p>
  <ul>
  <li>
  <Code>ATTACH TO CLUSTER</Code> - saves the plan as a per-cwd plan
  record and also routes the body up to the cluster's shared PLAN
  via <Code>cluster_plan_set</Code>. The plan now applies to{' '}
  <em>every</em> member's next turn.
  </li>
  <li>
  <Code>REFINE</Code> - opens a short note box. The same agent revises the
  draft, the new draft replaces the old one, and nothing is saved until
  you attach it. Repeat as often as needed.
  </li>
  <li>
  <Code>DISCARD</Code> - drops the candidate without persisting.
  </li>
  </ul>
  <p>
  In a cluster tab <Code>ATTACH TO CLUSTER</Code> is the only save
  button; on standalone tabs <Code>SAVE &amp; ATTACH</Code> takes its
  place. <Code>REFINE</Code> and <Code>DISCARD</Code> appear in both.
  </p>
  <p>
    <strong>Cluster members never auto-attach plans.</strong> All three
  plan-creation paths surface the banner so the operator picks where
  the plan lands:
  </p>
  <ul>
  <li>
  <strong>PLAN composer button → DRAFT → I'LL REVIEW</strong>:
  banner fires on the assistant's reply (unchanged behaviour).
  </li>
  <li>
  <strong>PLAN composer button → DRAFT &amp; AUTO-SAVE</strong>:
  for cluster members the dialog re-routes the autosave path
  through the review-mode flow, so AUTOSAVE behaves like REVIEW.
  An inline note in the dialog says so. Standalone tabs still
  auto-save silently.
  </li>
  <li>
  <strong>Native <Code>EnterPlanMode</Code> tool</strong> - for cluster
  members, the draft is offered for review instead of being attached
  automatically. The plan action remains recorded.
  </li>
  </ul>
  </>
  ),
  },
  {
  id: 'cluster-peer-messaging',
  group: 'Clusters',
  title: 'Peer messaging between members',
  body: (
  <>
  <p>
  Peer messaging is the file-backed mailbox path members use to hand
  notes to each other between operator turns.
  </p>
  <p>
  Every cluster member has three peer tools registered alongside its
  normal tool kit:
  </p>
  <ul>
  <li>
  <Code>peer_list</Code> - list other members by wfid prefix +
  display name + role.
  </li>
  <li>
  <Code>peer_send</Code> - drop a message in another member's
  mailbox. Targets can be a workflow id/prefix, a display-name prefix, or a
  unique role word like <Code>Director</Code> /{' '}
  <Code>Coordinator</Code>.
  </li>
  <li>
  <Code>peer_read</Code> - drain the caller's mailbox into the
  current turn. Delivered messages leave the mailbox and remain in both
  members&apos; conversation records.
  </li>
  </ul>
  <p>
  Temporary mailbox read or attachment-write failures leave pending messages
  untouched for retry. Each attachment gets a separate file, even when names
  match. Existing delivered files are preserved.
  </p>
  <p>
  Malformed messages or attachment metadata are preserved aside with a <Code>.bad-</Code> suffix,
  so valid messages can still arrive. A warning records the preserved filename.
  </p>
  <p>
  When a message is sent, the recipient sees an inbox counter on the
  MAILBOX sub-tab and can read it on the next turn.
  You can read the full mailbox contents in the MAILBOX sub-tab of the
  cluster right panel.
  </p>
  <Note kind="tip">
  Peer messaging is for handing notes <em>between</em> operator turns,
  not for real-time agent-to-agent chat. Members read their mailbox
  when they next take a turn; nothing pushes a peer message into a
  member that's busy with operator work.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-efficiency',
  group: 'Clusters',
  title: 'Coordination style and message guard',
  body: (
  <>
  <p>
  Coordination style guides how members write and hand off work.
  Message guard separately limits peer messages.
  </p>
  <h4 className="manual-sub">Coordination and message limits</h4>
  <p>
  New clusters start Balanced: complete outcomes, exact placement and
  affected surfaces, builder-owned routine compatible decisions, and
  one actionable blocker or final evidence packet. Thorough permits
  useful explanation; Lean reduces optional narration and handoffs.
  All styles preserve required tests, safety checks, operator-requested
  review and landing review.
  </p>
  <p>
  Message guard is independent:
  </p>
  <ul>
  <li>
  Warn only (new default, threshold 15) - accepts further sends with
  one warning per primary turn.
  </li>
  <li>
  Hard limit - refuses mail at the cap.
  </li>
  <li>
  No limit - removes only the peer-send quota.
  </li>
  </ul>
  <p>
  Thresholds are whole numbers from 1 to 1000. Successful send results
  report counts and remaining allowance where applicable. Rejected mail
  was not delivered.
  </p>
  <p>
  Counts span all recipients, reset when that sender starts a primary
  turn, and are not persisted across server restart. Failed sends refund
  their reservation. Consolidate related same-recipient information; do
  not start turns to evade a cap. Automatic-execution and provider limits
  remain independent.
  </p>
  <p>
  NOTE appends an operator instruction, not a mode or budget. Style and
  NOTE apply next turn; guard edits apply on the next send without
  resetting the count. Existing clusters without guard fields keep their
  legacy hard cap, pinned before a style change.
  </p>
  <h4 className="manual-sub">KEEP CURRENT</h4>
  <p>PLAN keeps shared plan checkboxes current. BOARD keeps task statuses current. BOTH, the default, keeps the two in step. Instructions apply only to records attached to the cluster and reach members on their next turn.</p>
  <p>With PLAN or BOTH and an attached plan, the director adds uncovered approved work in the same turn, before assigning it. Related work gets one item per feature or batch of fixes, never one per bug.</p>
  <p>The director's reply names the plan item added or changed with its id and a one-line description. Existing checkbox ticking rules still apply.</p>
  <p>
  New clusters use a cluster-local board and progress tracking set to Both. Saved
  choices and old-format snapshot fallbacks are preserved; existing
  boards are not moved or merged. Manual NUDGE requires explicit
  recipients, MAIL ALERTS only alerts the operator, and AUTO-PICKUP
  remains separately opt-in with its existing limits.
  </p>
  </>
  ),
  },
  {
  id: 'cluster-nudger',
  group: 'Clusters',
  title: 'MAIL ALERTS',
  body: (
  <>
  <p>
  MAIL ALERTS is an operator-armed (default <strong>OFF</strong>)
  per-cluster toggle that toasts when idle members have pending peer
  mail.{' '}The chip at the top of the cluster right panel shows the armed state
  at all times - there is no invisible configuration.
  </p>
  <p>
  When <Code>ENABLED</Code>, the server polls every member every few
  seconds. If a member has been <strong>idle ≥ 10 seconds</strong>{' '}
  with <strong>≥ 1 pending peer message</strong> in its mailbox, it
  emits a <Code>cluster_member_nudged</Code> toast - capped at{' '}
  <strong>3 nudges per operator turn per member</strong>.
  </p>
  <Note kind="warn">
  The nudger is <strong>toast-only</strong>. It does not send prompts
  to workers, mutate any worker state, or compose anything on the
  operator's behalf. To drain a mailbox, send that member a prompt (or
  pick it up via the next manual turn).
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-auto-pickup',
  group: 'Clusters',
  title: 'AUTO-PICKUP and Smart pickup',
  body: (
  <>
  <p>Pickup messages appear as a folded mailbox line in chat, pending PREVIEW and HISTORY. Use + to read the full text; the member receives it in full.</p>
  <p>
  AUTO-PICKUP sits next to MAIL ALERTS on the cluster right-panel header.
  Unlike MAIL ALERTS (toast only) and NUDGE (hand-picked recipients), it
  can start worker turns without a click when a waking mode is armed.
  </p>
  <h4 className="manual-sub">Pickup modes</h4>
  <p>
  The chip shows the mode (OFF / RULE / OBSERVE / SMART); click it to
  open the dialog. <Code>TURN OFF</Code> sets the mode to Off at once.
  Default is Off.
  </p>
  <p><strong>Modes</strong></p>
  <ul>
  <li>
  <strong>Off</strong> - no automatic worker turns. MAIL ALERTS and
  NUDGE stay available.
  </li>
  <li>
  <strong>Rule-based (recommended)</strong> - wakes idle members on
  waiting mail without a model, including mail that arrived during a
  member&apos;s turn, once that turn ends. Acknowledgement-only batches
  remain in the mailbox.
  </li>
  <li>
  <strong>Smart: Observe-only</strong> - an operator-chosen evaluator
  reads an idle member&apos;s waiting mail and answers wake, wait or
  ask. Answers are only logged; no turn starts. Arm with{' '}
  <Code>ARM OBSERVE-ONLY</Code>.
  </li>
  <li>
  <strong>Smart: Automatic</strong> - the same evaluator, but a wake
  answer starts the member&apos;s normal auto-pickup turn only after
  server code re-checks session, membership, exact waiting mail, STOP
  hold, busy state, wake limits and the Rule-based guards. Arm with{' '}
  <Code>ARM AUTOMATIC</Code>.
  </li>
  </ul>
  <p><strong>Also remind busy members</strong> is off by default and saved for this cluster. Under Rule-based or Smart: Automatic, it sends the busy NUDGE for new actionable unread mail, once per batch and at most once every five minutes per member. Plain acknowledgements do not trigger it. Off and Observe-only send none; idle pickup follows the same rules as before.</p>
  <h4 className="manual-sub">Rule-based limits</h4>
  <p>
    Adjustable limits pause
  alternating two-member wakes (default 4), cap each member at 6 wakes
  per hour and pause after 40 wakes per arming. RESUME starts a fresh
  arming budget; the hourly limit remains.
  </p>
  <p>
  Operator messages, NUDGE, re-arming or mail from a third member clear a
  pair pause. The existing 20-second cooldown and 10-per-minute cluster
  ceiling remain. Chain depth defaults to 8 and can be adjusted; the
  environment override remains. Saved clusters with the older boolean
  retain Rule-based mode.
  </p>
  <p>
  Mail stopped by the chain-depth limit stays in the mailbox and does
  not wake the member later; the member&apos;s next turn reads it.
  </p>
  <h4 className="manual-sub">What the evaluator sees and may propose</h4>
  <p>
    The
  evaluator instructions include examples from the synthetic v2 training
  corpus.
  </p>
  <p>
  Smart modes send a snapshot of one idle member&apos;s waiting mail
  (bodies and sender role labels), up to five of that member&apos;s open
  tasks, and, for each sender, the member&apos;s own last earlier message
  to that sender (clipped, kept in server memory only), so a reply to the
  member&apos;s own request is recognized.
  </p>
  <p>
  Instructions frame the mail as untrusted data. The evaluator only
  proposes wake, wait or ask for that recipient. A small, fast, low-cost
  model suits this job; a large or high-effort model adds cost without
  benefit. Off and Rule-based send nothing to any evaluator.
  </p>
  <p>
  <strong>Server code decides every wake.</strong> Arco never lets the
  evaluator start a turn or change mail. Observe-only records each
  decision. Automatic runs a wake through the deterministic gate (same
  path as Rule-based for the actual turn).
  </p>
  <p>
  An error, timeout, tool attempt, or malformed or oversized answer
  records no decision and never wakes a member. Each request reserves a
  budget slot before it is sent; a request still in flight when the
  server stops counts as spent.
  </p>
  <h4 className="manual-sub">Choosing an evaluator</h4>
  <p>
    The dialog offers providers
  that are enabled, connected and able to answer without tools here:
  Claude with Native sign-in, Cursor, Codex, Ollama, LM Studio, llama.cpp, Strata, and DeepSeek through Xolotl. Codex runs as a
  one-shot read-only session with no MCP servers or web search; any tool
  use or approval request ends it with no decision.
  </p>
  <p>LM Studio, llama.cpp,
  Strata and DeepSeek require the selected model to be loaded first; these
  requests do not load or switch models.
  </p>
  <p>
    Arming is
  refused when no suitable evaluator is available. Details of what each
  adapter sends are in <Code>SECURITY.md</Code>.
  </p>
  <p>
  <strong>Adjustable Smart limits</strong> (defaults; range in
  parentheses):
  </p>
  <ul>
  <li>Evaluator requests at once in this cluster - 1 (1 to 4)</li>
  <li>Evaluator requests per hour, whole cluster - 12 (1 to 120)</li>
  <li>Evaluator requests per hour, each member - 3 (1 to 60)</li>
  <li>Automatic wakes per hour, each member - 3 (1 to 60)</li>
  <li>Automatic wakes per armed session - 12 (1 to 200)</li>
  <li>Armed session length - 30 minutes (5 to 480)</li>
  <li>Evaluator time limit - 30 seconds (5 to 120)</li>
  <li>Most mail and context sent per request - 12288 bytes (2048 to 65536)</li>
  <li>Longest evaluator answer - 64 tokens (16 to 512)</li>
  </ul>
  <p>
  Limits are counted durably, so a restart never resets them. The
  Rule-based cooldown, per-minute ceiling and chain limit still apply in
  Automatic mode.
  </p>
  <h4 className="manual-sub">Session expiry and re-arm</h4>
  <p>
    Each Smart arming starts a
  new session with its own expiry from the session-length limit. When the
  session ends, or after a restart whose budget ledger cannot be read,
  Smart turns itself Off and must be armed again.
  </p>
  <p>
    The evaluator choice and adjusted limits are kept for the next arming.
  The saved evaluator is offered only while its provider is available.
  </p>
  <h4 className="manual-sub">TURN OFF, STOP, wait and ask</h4>
  <p>
    <Code>TURN OFF</Code>{' '}
  ends the Smart session at once; an evaluator answer still in progress
  is discarded and starts nothing. A worker turn that already started is
  not cancelled; use STOP on that member.
  </p>
  <p>
  STOP on an armed Smart cluster holds the member&apos;s then-pending
  mail until new mail arrives or the mailbox empties. A wait (defer)
  answer is reconsidered after about 10 minutes or when the mail
  changes. An ask answer raises one operator notice per set of waiting
  mail and starts nothing.
  </p>
  <h4 className="manual-sub">Counters and last decision</h4>
  <p>
    The dialog status shows
  session end time, evaluator requests this session / last hour / in
  progress, automatic wakes against the session limit, and the last
  decision with its reason and outcome.{' '}Arming, turning off and session
  expiry are recorded as decisions too. The chip can show{' '}
  <Code>wakesThisSession / wakesPerSession</Code> while a Smart mode is
  on.
  </p>
  <Note kind="tip">
  AUTO-PICKUP, MAIL ALERTS and NUDGE are independent. Leave MAIL ALERTS
  on during exploration; arm Rule-based or Smart only when the cluster
  is in a known-good peer-handoff flow. Computer mailbox rules and
  scripts require AUTO-PICKUP off.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-nudge-button',
  group: 'Clusters',
  title: 'NUDGE button + modal',
  body: (
  <>
  <p>Nudges appear as a folded mailbox line in chat, pending PREVIEW and HISTORY. Use + to read the full text; the member receives it in full.</p>
  <p>
  NUDGE is a larger button in the message box's bottom row, beside the send area. It is
  highlighted and shows the total pending mail for current members (for example NUDGE 2).
  </p>
  <p>
    Use it when members already
  have work waiting in their mailboxes (e.g. a director
  hand-distributed via <Code>peer_send</Code>) and only need to wake
  and process it - no typed prompt required.
  </p>
  <ol>
  <li>
  Click NUDGE. A modal opens with a per-member checkbox list.{' '}
  <strong>Selection defaults to empty</strong> - recipients must be
  picked explicitly.
  </li>
  <li>
  Review each row: role chip, mailbox depth (<Code>3 MAIL</Code>), and
  a BUSY badge if the member is mid-turn. SEND NUDGE stays disabled
  until ≥1 member is selected.
  </li>
  <li>
  Send. Idle members get the wake-up prompt and start a turn. Active
  members get a gentler reminder: check their mailbox when they reach a
  convenient point in their current work, then continue with their
  assignment.
  </li>
  </ol>
  <p>
  <strong>NUDGE ALL WITH MAIL (n)</strong>, beside SEND NUDGE, skips the
  ticking: it nudges every member with waiting mail, idle or busy, in the
  same way. Members without mail are never nudged. It is unavailable when
  no member has mail, and the reason shows under the list. The command
  palette offers it as <Code>Cluster: nudge all with mail</Code> while a
  cluster tab is open.
  </p>
  <p>
  After SEND NUDGE or NUDGE ALL WITH MAIL, a toast names how many were
  nudged and how many of those were busy reminders.
  </p>
  <p>
  It uses the same steering path as typing into that member&apos;s chat.
  Providers without mid-turn delivery receive the reminder after the
  current turn. The member still reads its mail with{' '}
  <Code>peer_read</Code>. <Code>Esc</Code> or click-outside closes
  without sending.
  </p>
  <Note kind="tip">
  NUDGE is intentionally a <em>separate</em> path from the TO chip
  in the same message box. The TO chip carries a typed message;
  NUDGE fires a canned reminder with an explicit per-fire recipient
  pick. Two surfaces, two intents.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-plan-tick',
  group: 'Clusters',
  title: 'cluster_plan_tick (worker-side)',
  body: (
  <>
  <p>
  <Code>cluster_plan_tick</Code> is a fourth peer tool on every cluster
  member, alongside <Code>peer_list</Code> / <Code>peer_send</Code> /{' '}
  <Code>peer_read</Code>. The <strong>model</strong> calls it mid-turn
  to toggle a single <Code>- [ ]</Code> / <Code>- [x]</Code> checkbox
  in the shared cluster plan.
  </p>
  <p>
    The operator never invokes it directly, but plan-edits appear in the
  cluster ACTIVITY feed without an operator action when a member
  completes or un-completes an item.
  </p>
  <p>
  The tool accepts either <Code>taskText</Code> (preferred - a
  case-insensitive substring of the item's text; stable across
  plan edits) or <Code>lineIndex</Code> (0-based; only valid when
  the model read the plan itself this turn). The dispatcher
  rejects empty or both-set payloads with{' '}
  <Code>invalid_matcher</Code>.
  </p>
  <p>
  On success, the server toggles the checkbox in{' '}
  the attached plan file (<Code>.arco/plans/&lt;id&gt;.md</Code> in the
  project) and
  broadcasts <Code>cluster_plan_changed</Code> cluster-wide - every
  member's PLAN tab + ACTIVITY feed re-renders.{' '}
  <strong>The tool only mutates check state.</strong> Use{' '}
  <Code>cluster_plan_write</Code> (next section) to author or
  rewrite the plan body itself.
  </p>
  </>
  ),
  },
  {
  id: 'cluster-plan-read',
  group: 'Clusters',
  title: 'cluster_plan_read (full plan on demand)',
  body: (
  <>
  <p>
  <Code>cluster_plan_read</Code> is a read-only peer tool that returns
  the full canonical plan body plus title and <Code>updatedAt</Code>.
  </p>
  <h4 className="manual-sub">Reading the plan</h4>
  <p>
  It exists because the plan copy injected into a member&apos;s context
  each turn is no longer guaranteed to be the whole plan on string-form
  transports (CLI Claude / Codex / Cursor).
  </p>
  <p>
    A plan bigger than the
  16&nbsp;KB fold budget is delivered as a deterministic{' '}
  <em>outline</em> - headings and checkbox lines verbatim, prose
  dropped - so the role hint, mailbox notice, and other load-bearing
  blocks are never evicted.
  </p>
  <p>
  Labelled standing / rules / gates / contract / authority / cadence
  sections are kept in the outline too. The outline&apos;s header says
  it is an outline and points at this tool.
  </p>
  <p>
  <strong>Codex app-server members</strong> get a larger, separate
  budget: their cluster context (identity, role, plan, code-mode tool
  names and - for a Director - the operating contract) is provided when
  a thread starts or resumes. Its 48&nbsp;KB cap fits a full 32&nbsp;KB plan.
  </p>
  <p>
    A role or model
  change recycles the app-server child while keeping the same Codex
  thread. Codex exec and the other string-form transports stay at
  16&nbsp;KB.
  </p>
  <p>
  Members should call it before <Code>cluster_plan_write</Code> when
  their injected copy is an outline (rewriting from the outline would
  silently delete the plan&apos;s prose) or when an outline item
  needs its surrounding detail. Native members always receive the
  full plan and rarely need it.
  </p>
  </>
  ),
  },
  {
  id: 'cluster-plan-write',
  group: 'Clusters',
  title: 'cluster_plan_write (director-authored plan)',
  body: (
  <>
  <p>
  <Code>cluster_plan_write</Code> authors or rewrites the shared plan
  body. It is registered on every cluster member alongside{' '}
  <Code>peer_list</Code> / <Code>peer_send</Code> /{' '}
  <Code>peer_read</Code> / <Code>cluster_plan_read</Code> /{' '}
  <Code>cluster_plan_tick</Code>.
  </p>
  <h4 className="manual-sub">Updating the plan</h4>
  <p>
  <strong>By convention, only the cluster director calls it.</strong>{' '}
  Other members propose plan changes via <Code>peer_send</Code> to the
  director rather than writing directly. This convention lives in the{' '}
  <Code>DIRECTOR</Code> role preset text, not in server-side gating:
  every member technically has the tool.
  </p>
  <p>
  The tool takes a single string argument <Code>body</Code> (the
  new markdown plan) and validates non-empty + ≤32768 chars. If no
  plan exists yet, the write creates it. If a plan already exists,
  the server compares checkbox task lines and rejects writes that
  remove existing tasks or change their <Code>[ ]</Code> /{' '}
  <Code>[x]</Code> state.
  </p>
  <p>
  A successful write updates the plan for the whole cluster. Each member
  sees the new plan in the PLAN tab and on the next turn.
  </p>
  <p>
    <strong>Safety:</strong> model writes are additive by default.
  Three rules keep the plan from losing work:
  </p>
  <ul>
  <li>
  Directors may add new sections, prose, and checkbox tasks while
  preserving existing checkbox tasks.
  </li>
  <li>
  Existing task status changes must use{' '}
  <Code>cluster_plan_tick</Code>, which toggles one checkbox at a
  time and broadcasts the before/after state.
  </li>
  <li>
  Removing tasks or clearing/replacing the plan remains an operator
  action from the PLAN tab.
  </li>
  </ul>
  </>
  ),
  },
  {
  id: 'cluster-board',
  group: 'Clusters',
  title: 'Task board + task peer-tools (cluster_task_*)',
  body: (
  <>
  <p>An open task drawer follows the live ledger. Snapshot changes refresh comments, runs and dependencies. Selecting another task clears the previous details while the new read is pending.</p>
  <p>RESET in the task editor also restores RELEASE. A release-only edit no longer remains pending after RESET.</p>
  <p>
  The cluster right panel&apos;s <strong>BOARD</strong> sub-tab is a
  kanban <em>view</em> over this cluster&apos;s project task ledger:
  the same cwd-scoped tasks the per-member <strong>LEDGER</strong> tab
  shows.
  </p>
  <h4 className="manual-sub">Working with tasks</h4>
  <p>
  Columns are <Code>triage</Code> / <Code>todo</Code> /{' '}
  <Code>ready</Code> / <Code>in_progress</Code> /{' '}
  <Code>blocked</Code> / <Code>review</Code> / <Code>done</Code> /{' '}
  <Code>archived</Code>. Each card shows the title, the claimant
  (<Code>@name</Code> chip, or <Code>UNCLAIMED</Code>), and a link
  count. Click a card to open the task drawer. The drawer keeps the
  selected task&apos;s ledger fields visible immediately and reads full
  detail through <Code>cluster_task_show</Code>.
  </p>
  <h4 className="manual-sub">Three board modes</h4>
  <p>
    Set from the <Code>BOARD</Code>{' '}
  chip-row selector in the cluster right-panel header:
  </p>
  <ul>
  <li>
  <Code>none</Code> - disables the board, the{' '}
  <Code>cluster_task_*</Code> tools, and the dispatcher. The BOARD
  sub-tab shows a <Code>BOARD DETACHED</Code> placeholder with{' '}
  <Code>USE PROJECT BOARD</Code> / <Code>CREATE CLUSTER BOARD</Code>{' '}
  buttons.
  </li>
  <li>
  <Code>project</Code> - uses the cwd&apos;s normal project task
  ledger, the same one standalone workflow tabs and the per-member
  LEDGER tab show.
  </li>
  <li>
  <Code>cluster</Code> (new-cluster default) - uses a private fresh
  board scoped to the same cwd, keyed by <Code>taskBoardKey</Code>,
  isolated from the project ledger.
  </li>
  </ul>
  <p>
  Switching mode enables the <Code>cluster_task_*</Code> tools for
  members on their next turn.
  </p>
  <h4 className="manual-sub">Create a task without leaving the board</h4>
  <p>
    A composer
  row at the top of the board - a title field plus an <Code>ADD</Code>{' '}
  button, <Kbd>Enter</Kbd> also commits - creates a new task through the
  operator <Code>task_ledger_create</Code> path.
  </p>
  <p>
  New tasks always land in the <Code>todo</Code> column; the create
  surface is deliberately single-input rather than per-column, since
  every column would still produce a <Code>todo</Code> card. The field is
  disabled (placeholder <Code>Board not ready</Code>) until a
  board-reader member is available.
  </p>
  <p>
  The task drawer shows overview fields (status, assignee, priority,
  worktree-required state, current worktree path, blocked reason,
  review/goal settings, links), dependency parents/children, durable
  comments, recovery controls, and run records.
  </p>
  <p>
  Run rows show owner, status, session/worker ids, last heartbeat, and a
  live heartbeat age; open runs turn <Code>STALE</Code> after five
  minutes without a heartbeat. Failed detail reads do not break the
  board; the drawer shows the error inline and falls back to the task
  fields already present in the ledger snapshot.
  </p>
  <p>
  The drawer&apos;s <strong>title, notes, priority, and dependency-parent
  fields are operator-editable in place</strong> (through{' '}
  <Code>task_ledger_update</Code>), and a delete control removes the task
  entirely (<Code>task_ledger_delete</Code>). Status changes to{' '}
  <Code>done</Code> / <Code>archived</Code> stay routed through the
  dedicated status controls and their confirms, never these field edits.
  </p>
  <p>
  <strong>Columns scroll horizontally; drag to re-status.</strong> Drag a
  card onto another column to change its status. A click opens the drawer;
  on a touch device, press briefly before dragging.
  </p>
  <p>
  Dragging onto <Code>done</Code> or <Code>archived</Code> asks for
  confirmation first (operator acceptance). The <Code>review</Code>{' '}
  column header also carries a bulk action to mark all review tasks done
  at once, also confirmed.
  </p>
  <p>
  Recovery controls are deliberately narrow. <strong>REASSIGN</strong>{' '}
  changes only the task assignee through the normal task ledger update
  path. <strong>RECLAIM</strong> and <strong>TERMINATE</strong> target
  exactly one open run when the server-side recovery handlers are
  wired; terminate asks for confirmation. None of these controls marks
  work <Code>done</Code>.
  </p>
  <p>
  <strong>The automation controls are collapsed behind an{' '}
  <Code>AUTOMATION</Code> disclosure</strong> in the board header (default
  closed) so the board reads as task-grooming, not swarm-running; the task
  count stays visible on the header. Open{' '}
  <Code>AUTOMATION</Code> to reveal <Code>DISPATCH ONCE</Code>,{' '}
  <Code>CREATE SWARM</Code> and the entire{' '}
  <Code>DISPATCHER</Code> row.
  </p>
  <p>
  <strong>DISPATCH ONCE</strong> runs one operator-clicked sweep over
  <Code>ready</Code> tasks. It fires only tasks that already have an
  explicit idle assignee in the cluster, records a run before starting
  the member&apos;s turn, and logs skipped ready tasks with reason codes.
  Assignments, dependencies, membership and worker availability are checked again before the claim is saved. Changed eligibility skips the task. It does not infer routing and never marks work <Code>done</Code>.
  </p>
  <p>
  <strong>DISPATCHER</strong> is the armed daemon surface. It defaults
  OFF. When ARMED, the server repeats the same deterministic sweep on
  an interval. Turning it off prevents a pending sweep from claiming more work. Current run and sweep limits are checked at each claim.
  </p>
  <ul>
  <li><Code>EVERY</Code> - seconds between sweeps.</li>
  <li><Code>SWEEP</Code> - caps tasks fired per pass.</li>
  <li><Code>RUNS</Code> - caps open task runs cluster-wide.</li>
  <li>
  <Code>AUTO WORKTREE</Code> - lets the dispatcher prepare isolated
  checkouts for tasks marked worktree-required before firing them.
  </li>
  </ul>
  <p>
  Changing any control sends an explicit operator message and waits for
  the next <Code>cluster_state</Code> echo.
  </p>
  <p>
    <strong>CREATE SWARM</strong> opens the operator helper for a
  root-plus-parallel-workers graph. The request includes a brief,
  selected worker members, worker task count, verifier member,
  synthesizer member, optional worktrees, and optional dispatch after
  creation.
  </p>
  <p>
    It is still an explicit operator mutation; the helper does
  not draft routing with a model and it does not bypass dispatcher
  rules.
  </p>
  <p>
  Task tools let cluster members read and work on the board alongside
  peer messaging and plan tools:
  </p>
  <ul>
  <li>
  <Code>cluster_task_list</Code> - read the ledger (id, title,
  status, assignee, links). Read-only.
  </li>
  <li>
  <Code>cluster_task_show</Code> - read one task&apos;s parents,
  children, comments, and run records before starting work.
  </li>
  <li>
  <Code>cluster_task_create</Code> - create a new non-terminal{' '}
  <Code>todo</Code> task, optionally with body/notes, assignee,
  priority, dependency parents, links, and review/goal metadata.
  </li>
  <li>
  <Code>cluster_task_claim</Code> - take ownership of a task
  (assignee → the calling member) and move it to{' '}
  <Code>in_progress</Code>. If a different member already owns it, the
  claim is rejected (<Code>already_claimed</Code>) rather than stomping
  their work.
  </li>
  <li>
  <Code>cluster_task_update</Code> - change status
  (<Code>triage</Code> / <Code>todo</Code> /{' '}
  <Code>ready</Code> / <Code>in_progress</Code> /{' '}
  <Code>blocked</Code> / <Code>review</Code>) and/or notes.
  </li>
  <li>
  <Code>cluster_task_heartbeat</Code> - update the member&apos;s
  visible run heartbeat for a task; an optional note is durable and
  appears in the task details.
  </li>
  <li>
  <Code>cluster_task_link</Code> /{' '}
  <Code>cluster_task_unlink</Code> - add or remove dependency edges.
  The server rejects self-links and cycles.
  </li>
  <li>
  <Code>cluster_task_comment</Code> - append durable handoff text to
  the task thread.
  </li>
  <li>
  <Code>cluster_task_block</Code> - move the task to{' '}
  <Code>blocked</Code>, store a reason, and append a BLOCKED comment.
  </li>
  <li>
  <Code>cluster_task_complete</Code> - submit a completion report and
  move the task to <Code>review</Code>. It never marks done.
  </li>
  </ul>
  <Note>
  <strong><Code>done</Code> / <Code>archived</Code> are
  operator-only</strong> at every layer.{' '}
  <Code>cluster_task_update</Code> rejects either terminal status with{' '}
  <Code>operator_gated</Code> - workers move finished work to{' '}
  <Code>review</Code> through <Code>cluster_task_complete</Code> or
  report via <Code>peer_send</Code>, and the operator marks the task done
  from the LEDGER tab, by dragging the card to the <Code>done</Code> column
  (confirmed), or via the drawer status controls. This
  re-enforces the operator-confirmed terminal-status rule at
  the peer layer.
  </Note>
  <p>
  Claims and updates are saved like operator edits. Every member&apos;s
  board updates live. Edits in a project LEDGER refresh every open tab viewing that board.
  </p>
  </>
  ),
  },
  {
  id: 'cluster-plan-or-board',
  group: 'Clusters',
  title: 'Plan or board?',
  body: (
  <>
  <p>
  PLAN describes the work and its rules; BOARD tracks who is doing what.
  Use them together to guide agents and review progress.
  </p>
  <ul>
  <li><strong>PLAN</strong> - agents follow the plan and the operator approves changes.</li>
  <li><strong>BOARD</strong> - agents move tasks along; the operator accepts finished work and answers blocked tasks.</li>
  </ul>
  <ul>
  <li>
  The <Code>NEED YOU</Code> badge above the member cards counts review
  tasks with a director sign-off, tasks blocked on a decision from you,
  and members with a waiting question. Click it to jump to the task on
  the board or to the member.
  </li>
  <li>
  On review cards, <Code>ACCEPT</Code> marks one task done and{' '}
  <Code>ACCEPT ALL MET</Code> accepts every visible task whose sign-off
  reads met. Partial, not-met, and unsigned tasks are left for you.
  </li>
  <li>
  <Code>SHOW DONE</Code> is on by default and lists done and archived
  tasks; turn it off to hide them (the choice is remembered). Review tasks older than 7 days fold into an{' '}
  <Code>N older</Code> row.
  </li>
  <li>
  <Code>RELEASE</Code> labels are optional. Set one in a card&apos;s
  drawer (or let the director set it) and a release filter appears in the
  board header. A chosen release shows how many tasks are in it, how
  many you accepted and how many are left, and reads READY TO RELEASE
  when none are left. CATCH ME UP and BRIEF on a cluster also mention how
  the board moved.
  </li>
  <li>
  Settings &gt; Agents and clusters &gt; Board auto-done can accept met
  tasks for you. It is off by default.
  </li>
  </ul>
  </>
  ),
  },
  {
  id: 'cluster-orchestration-assist',
  group: 'Clusters',
  title: 'Saved orchestration proposals',
  body: (
  <p>
  DRAFT ASSIST is hidden in this version. Saved proposals stay in the project folder.
  Concurrent decisions preserve each other. Retrying after an acceptance-save error
  does not repeat recorded task or comment effects. Parent tasks remain dependencies
  when selections are reversed or applied separately. Unresolved or cyclic parents
  refuse the selection.
  </p>
  ),
  },
  {
  id: 'cluster-promote-detaches',
  group: 'Clusters',
  title: 'PROMOTE TO CLUSTER detaches the worker plan',
  body: (
  <>
  <p>
  The <Code>PROMOTE TO CLUSTER</Code> button on a member tab's
  per-workflow PLAN tab copies the worker's attached plan body up
  to the cluster's shared plan via <Code>cluster_plan_set</Code>.{' '}Promoting <strong>also detaches the worker's local plan
  slot</strong> after the cluster write lands.
  </p>
  <p>
  Without the detach, the worker would inject <em>both</em> plans on
  the next turn - the cluster plan in a forced system block, and the
  still-attached worker plan in the appendSystemPrompt fold. That
  doubles the per-turn plan footprint and surfaces two conflicting
  "the plan" framings to the model.
  </p>
  <p>
  The cluster plan is the single source of truth post-promote; the
  worker plan would only re-attach if the operator explicitly clicked{' '}
  <Code>ATTACH</Code> in the worker's PLAN tab afterwards.
  </p>
  </>
  ),
  },
  {
  id: 'cluster-plan-reviews',
  group: 'Clusters',
  title: 'Reviewing the cluster plan directly',
  body: (
  <>
  <p>
  The cluster PLAN tab's <Code>REVIEW PLAN</Code> /{' '}
  <Code>VERIFY WORK</Code> / per-H3 <Code>▷ REVIEW PHASE PLAN</Code>{' '}
  / <Code>▷ VERIFY PHASE WORK</Code> buttons review the{' '}
  <strong>cluster plan body</strong> directly, rather than a member&apos;s
  separate project plan.
  </p>
  <p>
  REVIEW and VERIFY open the review dialog directly. The review runs
  on the first member&apos;s workflow, which only names the artifact
  and its channel; the cluster plan body is the subject and the code
  is the cluster&apos;s folder.{' '}<Code>CUSTOM REVIEW</Code> asks for a
  member first, because it reviews that member&apos;s transcript (last
  turn, recent turns, full transcript or git diff only) without a plan
  reference.
  </p>
  </>
  ),
  },
  {
  id: 'cluster-plan-candidate-fallback',
  group: 'Clusters',
  title: 'Plan candidate banner - detection fallback',
  body: (
  <>
  <p>
  The <Code>PlanCandidateBanner</Code> appears after the operator
  arms plan-capture via the <Code>PLAN</Code> composer button
  (<Code>DRAFT</Code> / <Code>DRAFT &amp; AUTO-SAVE</Code>).{' '}A detection fallback also surfaces the banner <strong>without the
  pre-arm</strong>: when a primary turn settles with a reply that
  matches an <Code>H1</Code> title on the first non-empty line{' '}
  <em>and</em> ≥3 markdown checkbox lines, the client auto-populates{' '}
  <Code>planCandidate</Code> in review mode.
  </p>
  <p>
  Catches two cases:
  </p>
  <ul>
  <li>
  A free-form prompt requests a plan without using the PLAN button.
  </li>
  <li>
  The pre-arm flag was dropped before <Code>primary_complete</Code>{' '}
  (page reload mid-turn, etc.).
  </li>
  </ul>
  <Note kind="tip">
  The heuristic is conservative - it does not fire on shorter
  structured replies. For a non-plan reply to land without the banner,
  the threshold (1 H1 + 3 checkboxes) is the dial; otherwise click{' '}
  <Code>DISCARD</Code> and the candidate drops without persisting.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-activity',
  group: 'Clusters',
  title: 'The ACTIVITY tab',
  body: (
  <>
  <p>
  The cluster right panel&apos;s <Code>ACTIVITY</Code> sub-tab is the
  one place to watch the whole cluster move without drilling into each
  member&apos;s own <Code>ACTIVITY</Code> tab.
  </p>
  <h4 className="manual-sub">Activity details</h4>
  <p>
  It interleaves cluster-scoped events (peer messages, role edits, plan
  changes, member adds/removes, idle-nudger toasts) with{' '}
  <strong>per-member tool activity</strong> - every <Code>READ</Code>,{' '}
  <Code>BASH</Code>, <Code>TodoWrite</Code>, etc. fired by any member.
  </p>
  <p>
    A pill row at the top - <Code>ALL · MEMBER1 · MEMBER2 · ...</Code>:
  filters the feed:
  </p>
  <ul>
  <li>
  <Code>ALL</Code> (default) - every event from every member, sorted
  oldest-first with the newest at the bottom (chat convention).
  Auto-scroll stays pinned only while already near the bottom; scrolling
  up to inspect older rows means new worker activity will not yank the
  view away.
  </li>
  <li>
  <strong>Single member</strong> - only that member&apos;s tool
  activity plus cluster events that involve them (peer-sent{' '}
  <em>from</em> them, peer-received <em>to</em> them, role-set{' '}
  <em>on</em> them, idle-nudger toasts <em>about</em> them).
  Cluster-wide events like plan changes and member adds/removes
  only appear under <Code>ALL</Code>.
  </li>
  </ul>
  <p>
  Each row carries a leading <strong>member-name chip</strong> in a
  stable per-member colour (hashed from the workflow id, so the same
  member lands on the same colour every session), a <Code>ROLE</Code>{' '}
  chip (preset label like <Code>DIRECTOR</Code> /{' '}
  <Code>BUILDER</Code>, or <Code>CUSTOM</Code> for free-form roles),
  and a kind tag (<Code>READ</Code>, <Code>BASH</Code>,{' '}
  <Code>PEER →</Code>, <Code>NUDGE</Code>, etc.).
  </p>
  <p>
  Cluster-wide rows drop the member chip and use the event label
  directly.
  </p>
  <h4 className="manual-sub">Compact runs</h4>
  <p>
    When the same member fires{' '}
  <strong>≥ 3 of the same tool consecutively within 30 seconds</strong>{' '}
  (e.g. <Code>READ READ READ</Code>), they collapse into one row
  labelled <Code>READ × N</Code>. Click the count chip to expand the
  individual entries. This keeps high-burst worker activity from
  drowning out the cluster-scoped events around them.
  </p>
  <Note kind="tip">
  The feed is a live readout, not a durable log. Tool activity is
  drawn from each member&apos;s recent activity; older entries roll off.
  Events also remain in the member&apos;s saved history.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-cwd-tabs',
  group: 'Clusters',
  title: 'GITHUB / FILES / HISTORY / PREVIEW (cwd-anchored sub-tabs)',
  body: (
  <>
  <p>
  A cluster has exactly one shared <Code>cwd</Code> by construction, so
  the four cwd-anchored tabs from the per-workflow RightPanel
  (<Code>GITHUB</Code>, <Code>FILES</Code>, <Code>HISTORY</Code>,{' '}
  <Code>PREVIEW</Code>) are mirrored onto the cluster panel.{' '}They sit to the right of the cluster-scoped tabs (<Code>MEMBERS</Code>,{' '}
  <Code>MAILBOX</Code>, <Code>PLAN</Code>, <Code>ACTIVITY</Code>,{' '}
  <Code>REVIEWS</Code>); the strip wraps onto a second row when the
  panel is narrow.
  </p>
  <p>
  <strong><Code>GITHUB</Code></strong> and{' '}
  <strong><Code>FILES</Code></strong> are pure cluster-cwd ops - same
  GitHub browser and file explorer as the per-workflow tabs, just
  rooted at <Code>cluster.cwd</Code>. The codebase-memory and
  sandbox sub-tabs from the per-worker FILES tab do not apply (those
  are per-worker config); they still live on each member's own tab.
  </p>
  <p>
  <strong><Code>HISTORY</Code></strong> and{' '}
  <strong><Code>PREVIEW</Code></strong> belong to individual workflows.
  In the cluster panel they show the <strong>member in view</strong>: the
  member whose card or tab you selected, or the director until you select
  one. A line at the top names that member; choosing another there selects
  it in the cluster tab, the same as clicking its card.
  </p>
  <p>
  The member in view is kept when the page reloads, as long as it is still in
  the cluster.
  </p>
  <Note kind="tip">
  Most clusters only need one dev server total - the team is working
  one cwd - so bind PREVIEW on the member that runs it. Empty clusters
  (no members yet) show a placeholder on HISTORY / PREVIEW; GITHUB and
  FILES work regardless because they only need the cwd.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-back-to-cluster',
  group: 'Clusters',
  title: 'BACK TO CLUSTER',
  body: (
  <>
  <p>
  <Code>← BACK TO CLUSTER</Code> returns from a member&apos;s workflow tab
  to the cluster tab. The button sits beside <Code>SKILLS</Code> in the
  composer status row.
  </p>
  <p>
  The button only appears for workflows that are currently members of
  a cluster. Standalone workflows never show it.
  </p>
  </>
  ),
  },
  {
  id: 'cluster-mailbox-modal',
  group: 'Clusters',
  title: 'Mailbox modal - inspect + cancel',
  body: (
  <>
  <p>
  The MAILBOX sub-tab shows one row per member with a pending count. Context is read once per sender through live and sealed history, retaining only a bounded latest delivered-reply fact from history.
  Click a row to open the <strong>mailbox modal</strong> and inspect or
  cancel undrained peer messages.
  </p>
  <p>
  The modal lists every pending peer message addressed to that member,
  with sender + timestamp + full content. Each row has a{' '}
  <Code>CANCEL</Code> button that discards the message before the
  recipient drains it.
  </p>
  <p>
  Malformed messages are preserved aside and logged once rather than listed
  here. Other pending messages remain readable. Temporary read errors keep
  pending mail in place for retry. Attachment-write failures also leave the
  complete pending batch available for another read.
  </p>
  <p>
  Cancelling removes the message from the recipient&apos;s mailbox and
  refreshes the count. The recipient never sees it, and cancellation does
  not add a conversation event.
  </p>
  <p>
  When the cluster has a board attached, each pending message row also
  shows a <Code>→ TASK</Code> button that promotes the peer message into a
  durable board task. The same <Code>→ TASK</Code> affordance appears on
  incoming peer-message rows inside a member&apos;s chat transcript, so the
  operator can turn a delivered note into a tracked task from either
  surface.
  </p>
  <Note kind="tip">
  The modal lists <em>pending</em> messages only. Once a recipient
  calls <Code>peer_read</Code>, the message leaves the mailbox; a record
  remains in both members&apos; conversations and is out of reach of CANCEL. Use the modal to undo a stale or
  mis-routed <Code>peer_send</Code> before the recipient picks it
  up.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-transcript-send',
  group: 'Clusters',
  title: 'Operator transcript-send - → TRANSCRIPT',
  body: (
  <>
  <p>
  <Code>→ TRANSCRIPT</Code> sits in the composer status row on
  every cluster-member tab (the button only appears when the
  workflow is a cluster member with ≥1 peer). Click it to forward
  an arbitrary chunk of the current tab&apos;s chat into a peer&apos;s
  mailbox <em>from</em> the current member.
  </p>
  <h4 className="manual-sub">Choose messages and recipients</h4>
  <p>
  The modal picks:
  </p>
  <ul>
  <li>
  <strong>Recipients</strong> - checkbox list of every other cluster
  member; ticking several delivers the same text once to each.
  </li>
  <li>
  <strong>Note</strong> - an optional covering note placed above the
  transcript.
  </li>
  <li>
  <strong>Include</strong> - <Code>Operator messages</Code>,{' '}
  <Code>Agent replies</Code> and <Code>Mail lines</Code>. The chat keeps
  only a shortened copy of mail this member sent, so those copies stay
  out unless <Code>Shortened copies of mail sent</Code> is ticked.
  </li>
  <li>
  <strong>Scope</strong> - <Code>Last turn</Code> (default) /{' '}
  <Code>Last N turns</Code> (N is editable, 1-50) /{' '}
  <Code>Full transcript</Code>.
  </li>
  </ul>
  <p>
  A live preview shows the formatted slice + byte count against the{' '}
  <strong>32 KB cap</strong> (matches the cluster-plan body cap; twice
  the 16 KB model-driven <Code>peer_send</Code> limit).
  </p>
  <p>
    The slicer drops rendering noise - context dividers, tool-call pills,
  single-line metadata system pills (<Code>[TURN · 1m 49s]</Code>,{' '}
  <Code>[REVIEW] Running review…</Code>) - but <strong>keeps
  substantive multi-line system content</strong> like inlined review
  bodies, so the recipient actually sees work product.
  </p>
  <p>
  Server-side this <strong>bypasses the per-turn budget and the
  60-second dedupe window</strong> that constrain model-issued
  <Code>peer_send</Code> - the operator is in direct control, and
  two clicks on SEND are presumed intentional.{' '}The recipient sees
  no difference between an operator-driven and a model-driven send;
  the message lands in their mailbox the same way and surfaces on
  their next <Code>peer_read</Code> call.
  </p>
  <p>
  <strong>FORWARD</strong> works on a few messages instead of a slice:
  tick the small box beside any message (operator, agent or mail), and a
  bar above the composer shows how many are selected with FORWARD and
  CLEAR.
  </p>
  <p>
    FORWARD opens a dialog with the same recipients, note and 32 KB
  preview; CLEAR drops the selection. It is the operator&apos;s own action,
  outside the model message guard, like the rest of this section.
  </p>
  <Note kind="tip">
  The intended flow: dispatch a cluster-routed review on a reviewer
  peer (next section); when the reviewer&apos;s reply lands in
  their chat, switch to the reviewer&apos;s tab and click{' '}
  <Code>→ TRANSCRIPT</Code> to forward the findings to whichever
  director or builder needs them. Nothing auto-forwards - the
  operator picks who sees what.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-routed-reviews',
  group: 'Clusters',
  title: 'Cluster-routed reviews - sub-worker vs member reviewer',
  body: (
  <>
  <p>
  When the <Code>RUN REVIEW</Code> dialog opens from a
  cluster-member tab, a <strong>STEP 2: WHO DOES THE REVIEW?</strong>{' '}
  pill row appears at the top. Two families:
  </p>
  <h4 className="manual-sub">Review choices</h4>
  <ul>
  <li>
  <Code>SUB-WORKER</Code> (default) - the existing primitive:
  spawns a one-shot disposable subprocess with the
  provider/model/effort picked below. Writes a <Code>.md</Code>{' '}
  artifact, fires <Code>review_started</Code> +{' '}
  <Code>review_artifact_ready</Code>, surfaces in the per-workflow
  and cluster <Code>REVIEWS</Code> tabs.
  </li>
  <li>
  <strong>Cluster peer pills</strong> - one pill per other member,
  labelled with the peer&apos;s display name. Picking a peer{' '}
  <em>hides</em> the provider/model/effort rows (the peer&apos;s
  existing primary config IS the reviewer) and changes the submit
  button to <Code>SEND REVIEW TASK</Code>.
  </li>
  </ul>
  <p>
  Reviewer eligibility:
  </p>
  <ul>
  <li>
  <strong>Plan and saved-history scopes</strong> - cluster plans, worker
  plans, full history, current session, checkpoint slices and Git diff require{' '}
  <Code>SUB-WORKER</Code>. Member choices are disabled with the reason.
  </li>
  <li>
  <strong>Last turn and Last N</strong> - another member can review the selected
  recent content from the retained conversation. The current target is excluded.
  </li>
  <li>
  Choosing an unsupported scope after selecting a member returns the dialog to{' '}
  <Code>SUB-WORKER</Code> before dispatch.
  </li>
  </ul>
  <p>
  Plan modes remain available through SUB-WORKER:
  </p>
  <ul>
  <li>
  <strong>VERIFY WORK</strong> tells the reviewer to read every{' '}
  <Code>[x]</Code> item in the plan and check the claim against
  the actual code - Read / Grep / Glob / Bash allowed. Asked for
  a verdict (PASS / MINOR / BLOCKING) + per-item
  confirmed/partial/missing + file refs.
  </li>
  <li>
  <strong>CRITIQUE PLAN</strong> tells the reviewer to evaluate
  the plan itself - structure, ordering, gaps, missing
  considerations - NOT whether work is done.
  </li>
  </ul>
  <p>
  A member review task includes the selected recent transcript
  and an explicit instruction:{' '}
  <em>"Produce your full review inline in your reply. Do NOT
  send it to any peer - the operator will decide who needs the
  findings."</em> The reviewer&apos;s reply streams into their
  chat + the cluster ACTIVITY feed; no auto-forward, no member-to-
  member routing decisions.
  </p>
  <Note kind="warn">
  Member-routed reviews <strong>do NOT</strong> write a{' '}
  <Code>.md</Code> artifact or land in the cluster REVIEWS tab:
  findings live in the reviewer&apos;s chat. Use{' '}
  <Code>→ TRANSCRIPT</Code> to forward them to a director or
  builder. For a persisted artifact, use SUB-WORKER.
  </Note>
  <Note kind="tip">
  Under the hood the dispatch uses <Code>sendMessage</Code>, not{' '}
  <Code>operator_peer_send</Code> - the reviewer needs to start a
  turn immediately. A peer-mailbox queue with AUTO-PICKUP off
  would leave the task in limbo. Plan reviews use SUB-WORKER and keep their VERIFY or CRITIQUE mode choice.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-peer-read-tool',
  group: 'Clusters',
  title: 'Tool-driven peer mailbox (peer_read)',
  body: (
  <>
  <p>
  A worker receives a notice when peer messages are waiting. The worker
  reads the mailbox to receive their content.
  </p>
  <h4 className="manual-sub">Mailbox notice</h4>
  <p>
  The notice is headed <Code>--- PEER MAILBOX ---</Code> and asks the worker
  to read its pending messages. Its guidance follows the cluster efficiency
  level and the member&apos;s role.
  </p>
  <p>
  The worker must explicitly call <Code>peer_read</Code> to receive
  the content. That call drains the mailbox and fires{' '}
  <Code>peer_message_received</Code> events when the recipient
  actually sees the content.
  </p>
  <h4 className="manual-sub">Nudges and automatic pickup</h4>
  <p>Nudges and automatic pickup messages show as a muted mailbox line in chat, pending PREVIEW and HISTORY. Use + to read the full message and - to fold it. The member still receives the full text. A typed message stays visible.</p>
  <p>In AUTO-PICKUP, <strong>Also remind busy members</strong> adds the busy nudge below to Rule-based and Smart: Automatic. It is off by default, saved per cluster and sends once for new actionable unread mail with a five-minute gap per member. Off and Observe-only never send these reminders.</p>
  <p>Operator nudges and automatic pickup start with a fixed tag and the same guidance line:</p>
  <ul>
    <li>An idle member under NUDGE gets <em>"(nudge) Read pending peer messages and act on their contents. ..."</em></li>
    <li>A busy member gets <em>"(nudge) You are currently working. At a convenient point, check pending peer mail without interrupting current work, then continue your assignment. ..."</em></li>
    <li>A Rule-based or Smart: Automatic wake sends <em>"(auto-pickup) Peer mail arrived while idle. Read your mailbox. ..."</em></li>
  </ul>
  <p>
  The nudge text names the intent rather than the tool, so the model starts
  a real <Code>peer_read</Code> call instead of echoing the instruction back
  as text. Clicking the mail mark on an idle member, or the cluster NUDGE button, is what fires it.
  </p>
  <Note kind="tip">
  From the operator&apos;s perspective: behaviour is unchanged for
  the normal case (the model reads the system-prompt notice and
  calls <Code>peer_read</Code> as instructed). The improvement is
  for the failure modes - workers that previously sat "standing
  by" after a peer-send because the tool&apos;s response was
  misleading now see the notice + the tool returns the actual
  content in a single coherent flow.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-peer-row-role',
  group: 'Clusters',
  title: 'Peer row display - name + role',
  body: (
  <>
  <p>
  Peer chat rows show the other member&apos;s display name and role.
  Sent rows name the recipient; received rows name the sender, with a role
  in parentheses when set:
  </p>
  <ul>
  <li>
  <Code>PEER → sent to Harbor Builder (BUILDER)</Code>
  </li>
  <li>
  <Code>PEER ← from Harbor Director (DIRECTOR)</Code>
  </li>
  </ul>
  <p>
  The lookup is reactive - rename a member via the MEMBERS sub-tab
  pencil affordance, or change their role via SET / EDIT, and every
  existing peer row across all open tabs updates immediately.
  Members without a role set show just the display name.
  </p>
  </>
  ),
  },

  // -------------------------------------------------------------- THE SIX OPERATOR ACTIONS
];

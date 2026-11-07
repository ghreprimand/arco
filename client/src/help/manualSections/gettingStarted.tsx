import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Note, Kbd, Sub } from '../../components/UserManual/components';
export const gettingStarted: Section[] = [
  {
  id: 'welcome',
  group: 'Getting started',
  title: 'Welcome to Arco',
  body: (
  <>
  <p>
  Arco is a multi-provider coding workbench where you, the operator, drive every
  state-changing action. Start here for the big picture.
  </p>
  <Sub>The pieces</Sub>
  <ul>
  <li><strong>Agent tabs</strong> pair a primary agent with a project directory.</li>
  <li><strong>Chat tabs</strong> offer general conversation without a project.</li>
  <li><strong>Clusters</strong> group project agents. Members share one folder and pass notes through peer-message tools between operator turns.</li>
  </ul>
  <p>
  Providers include Claude, Codex, Cursor, Ollama, llama.cpp, LM Studio, Strata
  and DeepSeek via Xolotl, with mode-specific capabilities.
  </p>
  <Sub>What Arco will not do on its own</Sub>
  <p>
  Arco does not give models hidden authority to pick models, route messages, mark
  work done, silently summarize, or keep an opaque memory store. Automatic or
  model-assisted actions must be operator-armed, visible, logged, reversible, and
  applied through explicit approval or bounded tools.
  </p>
  <p>
  Clusters follow the same rule. They are operator-driven by default, and
  model-assisted director workflows are allowed only when they are armed, visible,
  logged, reversible, and routed through task tools or explicit approval.
  </p>
  <Note kind="tip">
  The fastest way to learn Arco is to start a project against a small repo and
  try each of the core operator actions (New / Resume / Review / Handoff / Spawn /
  live config swap) once. Clusters, the task board, DOCS/GIT prompts, Fold, and
  the approval gate layer on top once needed.
  </Note>
  <p>
  Search the manual and contextual help topics using the box on the left. The
  manual covers supported workflows, but not every provider-specific edge case.
  </p>
  </>
  ),
  },
  {
  id: 'philosophy',
  group: 'Getting started',
  title: 'Design philosophy',
  body: (
  <>
  <p>
  Arco's design is defined as much by what it refuses to do as by what it does.
  Read this section to learn what to expect and what never happens behind your
  back.
  </p>
  <Sub>What Arco is</Sub>
  <ul>
  <li>One Agent tab is one project workflow; Chat tabs are projectless conversations.</li>
  <li>
  Three operator-triggered primitives sit on top: <strong>Review</strong> (a
  cross-family second opinion), <strong>Handoff</strong> (rotate within the same
  tab) and <strong>Spawn</strong> (fork to a new tab).
  </li>
  <li>
  Durable conversation replay for saved workflows and chats. Incognito is the
  explicit memory-only exception, and transient telemetry is not a durable event
  log.
  </li>
  <li>
  Native CLI session interop: Claude CLI and Codex sessions can be resumed in a
  terminal or selected from the corresponding provider in Arco.
  </li>
  </ul>
  <Sub>What Arco explicitly does not do</Sub>
  <ul>
  <li>
  <strong>No silent autonomous routing.</strong> Arco never picks a model,
  provider, effort level or task completion on your behalf without an
  operator-armed surface and an inspectable event trail.
  </li>
  <li>
  <strong>No hidden orchestrator authority.</strong> No meta-agent owns the
  workflow. Model-assisted decomposition, assignment, recovery or synthesis is
  eligible only as a visible proposal or through bounded task tools that were
  enabled.
  </li>
  <li>
  <strong>No hidden auto-synthesis.</strong> Review output is a separate artifact
  that you read. Any synthesis is an operator-chosen bounded action or a visible
  proposal inspected before applying.
  </li>
  <li>
  <strong>No LLM-curated project memory.</strong> No <Code>STATE.md</Code>, no
  scratchpads, no build-log. Notes belong in a markdown file you write; Arco will
  not touch it.
  </li>
  </ul>
  </>
  ),
  },
  {
  id: 'first-launch',
  group: 'Getting started',
  title: 'First launch',
  body: (
  <>
  <p>
  Install Node.js 24 or 26 (on Windows also Git for Windows, for shell
  commands and hooks), then install and set up Arco. A new Arco home then
  opens <strong>Welcome to Arco</strong>, which walks through display name,
  folders and provider connection before any model prompt.
  </p>
  <Sub>Install and start</Sub>
  <p>
  <Code>npm install -g arco-workbench</Code>
  <br />
  <Code>arco setup</Code>
  </p>
  <p>
  The Linux source launcher verifies process ownership before stopping a development server. Source systemd service definitions preserve checkout paths containing spaces and retain the Arco home selected during installation. Reinstall a source unit after changing that home.
  </p>
  <p>
  Setup asks before installing the per-user service and creating an application
  shortcut, starts the service, and opens the local URL. The package saves an
  available port and moves if it becomes occupied; shortcuts and{' '}
  <Code>arco open</Code> follow it.
  </p>
  <ul>
  <li><Code>arco open</Code> opens an app window; <Code>arco open --tab</Code> opens a browser tab.</li>
  <li><Code>arco open --browser brave</Code> opens the app window in a chosen browser (see App window browser).</li>
  <li><Code>arco doctor</Code> checks its status.</li>
  <li><Code>arco start</Code> runs in the foreground.</li>
  </ul>
  <p>
  Source builds are a contributor path documented in the repository README.
  </p>
  <Sub>The Welcome steps</Sub>
  <p>
  Optionally enter the name to show for chat messages; leave it blank for
  OPERATOR. Get started saves it, while skipping leaves the existing name
  unchanged. Running setup again pre-fills it, and Settings &gt; Appearance can
  change it later. The remaining steps add folders and connect a provider. No
  model prompt is sent until a model-backed action is started.
  </p>
  <ol>
  <li>
  Choose a provider in Connections and follow its sign-in or API-key
  instructions. The provider list can be searched and grouped by type.
  </li>
  <li>
  For CLI auth (Claude, Codex, Cursor, GitHub) Arco shows the headless login
  command with <Code>RUN IN TERMINAL</Code> / <Code>COPY</Code>. It runs on the
  Arco machine and prints a link or code to complete in a browser or on a device.
  Then return to Connections.
  </li>
  <li>
  Select <Code>Continue to workspace</Code> when ready, or{' '}
  <Code>Skip for now</Code> to continue without connecting one. In the workspace,{' '}
  <Code>CONNECT A PROVIDER</Code> reopens Connections.
  </li>
  </ol>
  <Sub>Adding providers later</Sub>
  <p>
  Authenticate more providers at any time from{' '}
  <Code>⚙ SETTINGS &gt; Providers and models</Code>, under Sign-in, accounts and
  local endpoints. Each provider is independent: Claude can be live while Codex is
  unauthenticated.
  </p>
  <p>
  Appearance, Projects, Agents and clusters, Voice, Notifications, Files and
  media, and Advanced are the other task-based categories. Search finds controls across categories;
  the control-location map is in <Code>docs/SETTINGS.md</Code>.
  </p>
  </>
  ),
  },
  {
  id: 'app-window-browser',
  group: 'Getting started',
  title: 'App window browser',
  body: (
  <>
  <p>
  <Code>arco open</Code> and the Arco shortcut open Arco in its own window of a
  Chromium-family browser: Chrome, Edge, Brave, Vivaldi or Chromium. The window
  uses a separate Arco browser profile, so its microphone and notification
  permissions stay apart from everyday browsing.
  </p>
  <Sub>Which browser</Sub>
  <p>
  Automatic uses the first one found. Windows checks Edge, Chrome, Brave, Vivaldi
  and Chromium, for all users and for the current user. macOS checks Chrome, Edge,
  Brave, Chromium and Vivaldi. Linux checks the same programs on the PATH, then
  Flatpak installs.
  </p>
  <p>
  To pick one, open <Code>⚙ SETTINGS &gt; Advanced &gt; App window browser</Code>.
  Choose a detected browser, or Another program for a program name or full path.
  The line below the list shows what the window opens in now.
  </p>
  <p>
  <Code>arco open --browser &lt;name-or-path&gt;</Code> uses a browser once, for
  example <Code>arco open --browser vivaldi</Code>. When a chosen browser is not
  found, Arco says so and uses Automatic.
  </p>
  <Sub>Other browsers</Sub>
  <p>
  With no Chromium-family browser installed, <Code>arco open</Code> opens a normal
  tab in the default browser. In Firefox, Safari or another non-Chromium browser,
  Arco shows a notice once: Arco runs lighter in Chrome, Edge, Brave, Vivaldi or
  Chromium. CHOOSE BROWSER opens the setting and DISMISS hides the notice for that
  browser.
  </p>
  </>
  ),
  },
  {
  id: 'creating-workflow',
  group: 'Getting started',
  title: 'Creating your first workflow',
  body: (
  <>
  <p>
  Create a project Agent workflow from Home, a project card, or the workflow
  creator.
  </p>
  <Sub>Where to start</Sub>
  <p>
  Start from <Code>HOME</Code>, the project landing page. Add an existing folder
  or create one there, then use its project card's <Code>New session</Code> action
  to open the workflow creator with that folder selected. The <Code>HOME</Code>{' '}
  tab is also available when work is open. The <Code>+</Code> tab or{' '}
  <Kbd>Ctrl/Cmd+K</Kbd> opens the creator directly.
  </p>
  <p>Choose a mode at the top of the creator:</p>
  <ul>
  <li><strong>SINGLE WORKFLOW</strong> for the project form below.</li>
  <li><strong>CHAT</strong> needs no folder and offers saved or Incognito conversation.</li>
  <li><strong>CLUSTER</strong> groups agents.</li>
  <li><strong>GENESIS</strong> starts from an idea.</li>
  </ul>
  <Sub>The project form</Sub>
  <ul>
  <li>
  <strong>Project folder</strong> - the root the agent will operate against.
  Choose <strong>Browse another folder</strong> or paste an absolute path.
  <strong>+ NEW FOLDER</strong> creates and selects a folder in a project
  location. Choose a location and a new name; an existing name is refused.
  Starting from a Home project card pre-fills its folder.
  </li>
  <li>
  <strong>Provider</strong> - Claude, Codex, Cursor, Ollama, llama.cpp, LM Studio,
  Strata or DeepSeek. The picker lists only providers that are enabled in Settings
  and connected. A saved default that is not connected stays selected, marked{' '}
  <Code>(not connected)</Code>. Launch stays disabled, with a plain reason and an{' '}
  <Code>Open Connections</Code> link, until a connected provider is chosen. The
  same gate applies to Chat and Genesis.
  </li>
  <li>
  <strong>Model</strong> - populated from the selected provider's capability
  probe. Defaults to a sensible mid-tier model.
  </li>
  <li>
  <strong>Effort</strong> - the reasoning budget; see the list below.
  </li>
  <li>
  <strong>Tuning</strong> - a collapsible band shown for every provider.
  Claude tabs add <strong>FAST MODE</strong> and a{' '}
  <strong>TOOL-RESULT FILTER</strong> beside an <strong>OUTPUT STYLE</strong>{' '}
  picker (NORMAL, PLAIN or TERSE; PLAIN is the default). The filter (off,
  conservative or aggressive) trims noisy Bash and test output before it enters
  context, and is Native-only. Other providers show OUTPUT STYLE only. See{' '}
  <em>Configuration</em> for detail.
  </li>
  </ul>
  <Sub>Effort levels by provider</Sub>
  <ul>
  <li>Claude supports up to 5 levels: low, medium, high, xhigh, max.</li>
  <li>Codex is model and catalog driven. GPT-6 Astra and Sol offer low, medium, high, xhigh, max and ultra; Luna stops at max; older models can expose fewer.</li>
  <li>Strata offers none, low, medium and high. None disables thinking, and high maps to Qwen xhigh.</li>
  <li>Local models follow each model's advertised reasoning levels.</li>
  </ul>
  <Sub>Resuming an existing session</Sub>
  <p>
  Below the form, the <strong>RESUME</strong> picker lists native CLI sessions
  already on disk for this folder (<Code>~/.claude/projects/&lt;hash&gt;</Code>,{' '}
  <Code>~/.codex/sessions/...</Code>). Pick one to continue an existing
  conversation inside Arco.
  </p>
  <Note kind="tip">
  The creator starts with Claude selected, which may be unauthenticated. Choose a
  provider that is enabled and connected in Settings &gt; Providers and models. If
  the expected provider is unavailable, check its enable and sign-in state.
  </Note>
  </>
  ),
  },
  {
  id: 'create-cluster-from-new',
  group: 'Getting started',
  title: 'Creating a cluster from +NEW',
  body: (
  <>
  <p>
  A <strong>cluster</strong> is a group of workflow tabs pinned to one working
  folder, created from the workflow creator's CLUSTER mode. Members can pass notes
  between operator turns with the peer tool (<Code>peer_list</Code>,{' '}
  <Code>peer_send</Code>, <Code>peer_read</Code>).
  </p>
  <p>
  Open the workflow creator (<Kbd>+</Kbd> tab or <Kbd>Ctrl/Cmd+K</Kbd>), then flip
  the top-of-form toggle to <strong>CLUSTER</strong>. The creator has these parts:
  </p>
  <ul>
  <li><strong>Shared project folder</strong> - the same picker as the single workflow form. All members share this folder.</li>
  <li><strong>Cluster name</strong> - optional, up to 64 characters. Empty falls back to the derived <Code>&lt;folder name&gt; · &lt;short-id&gt;</Code> default.</li>
  <li><strong>Start from a template</strong> - see below.</li>
  <li><strong>MEMBERS list</strong> - at least 2 rows; see below.</li>
  <li><strong>Defaults for new members</strong> (collapsed) - provider, model, effort, permissions, fast mode, tool-result filter and output style. Only <Code>+ ADD MEMBER</Code> uses them; changing them does not change members already listed.</li>
  <li><strong>Coordination settings</strong> (collapsed) - efficiency (thorough, balanced or lean; default balanced), message guard, task board, Keep current and an optional note. The collapsed header summarizes the current choices.</li>
  <li><strong>Saved cluster presets</strong>, existing clusters and saved cluster snapshots come after the required steps.</li>
  <li><strong>CREATE CLUSTER</strong> mints every member as a fresh workflow and creates the cluster atomically, once the shared folder, at least two members each with a model, at most one director, and local runtime capacity all pass. The cluster tab opens immediately.</li>
  </ul>
  <Sub>Templates</Sub>
  <p>
  Choose Pair, Small team, Research, Medium team, Full team, Parallel build, Large
  team, or Build my own. Parallel build and Large team include two builders.
  </p>
  <p>
  A template opens a review listing each member's role and a Recommended model line
  in words (model band and effort with a short reason). Repeated roles offer an
  optional Work size choice. Research starts unset, and the two-builder templates
  recommend Heavy and Standard, both editable.
  </p>
  <p>
  Provider and model are chosen for each member from connected providers, because
  Arco never picks a model. <Code>USE THESE MEMBERS</Code> replaces the list.
  Effort starts at most at HIGH, and a cluster may have at most one director.
  </p>
  <Sub>Editing a member</Sub>
  <p>
  Each row is collapsed with a one-line summary in words. An empty role reads{' '}
  <em>Role not set</em>, and work size appears only when set. Click{' '}
  <Code>↓ EDIT</Code> to expand a row and set:
  </p>
  <ul>
  <li>Display name (optional).</li>
  <li>Provider - only enabled, connected Claude, Codex, Cursor, Ollama or llama.cpp. A saved or preset provider that is no longer connected stays visible, marked <Code>(not connected)</Code>. Creation waits until every member has an enabled, connected provider, with a reason and an Open Connections link.</li>
  <li>Model and effort (per-provider pickers).</li>
  <li>Role - free-form, up to 120 characters (for example "director" or "tester"); at most one director.</li>
  <li>Work size - light, standard, heavy or unset. It is a hint for the director and does not change model or effort.</li>
  <li>Permissions (with the AUTO / SAFE explanation), fast mode and filter where the provider supports them, and output style on every provider.</li>
  </ul>
  <Note kind="tip">
  A cluster can have at most one director (roles beginning with Director or
  Coordinator count). Work size guides which tasks the director gives a member; it
  does not change model or effort. Arco does not auto-route work from role or work
  size beyond that director limit. Local capacity for Ollama and llama.cpp is set
  in Connections as <Code>Cluster members that may use this runtime at once</Code>.
  </Note>
  <Note>
  To add more members later, open the cluster's MEMBERS sub-tab and use{' '}
  <Code>+ ADD FRESH</Code> or <Code>+ ADD EXISTING</Code>. An open tab in the
  same folder can also join from its right-click menu, ADD TO EXISTING.
  </Note>
  </>
  ),
  },
  {
  id: 'cluster-presets',
  group: 'Getting started',
  title: 'Cluster presets - save and re-apply a cluster shape',
  body: (
  <>
  <p>
  A <strong>cluster preset</strong> captures per-member configs so the same shape
  can be rebuilt later against a different working folder.
  </p>
  <p>
  It stores provider, model, effort, role, work size, display name, permissions,
  fast mode, tool-result filter and output style, plus an optional CLUSTER NAME
  template, saved under a chosen name. Saving a preset that would give the cluster
  a second director is refused. The SAVED CLUSTER PRESETS row sits after the
  member list and coordination settings in the creator's CLUSTER mode.
  </p>
  <Sub>Using presets</Sub>
  <ul>
  <li>
  <strong>Apply</strong> - click a pill. The MEMBERS list is overwritten with the
  preset's members (each as a fresh draft row). If the CLUSTER NAME field is blank,
  it is seeded from the preset's name template; an already-typed name is never
  overwritten.
  </li>
  <li>
  <strong>Delete</strong> - click the <Code>×</Code> on a pill and confirm.
  </li>
  <li>
  <strong>Save</strong> - click <Code>+ SAVE AS PRESET</Code>, type a name (up to
  64 characters) and submit. It stays disabled until there are at least 2 members
  each with a model picked, the same gates as CREATE CLUSTER.
  </li>
  </ul>
  <p>
  The <strong>working folder</strong> is not saved. Presets are project-agnostic by
  design: the folder is picked separately each time, so the same "Review Squad" or
  "Heavy Build" shape can be applied to any project without leaking paths from
  where it was first built.
  </p>
  <Note>
  Presets are stored at <Code>~/.arco/cluster-presets.json</Code> (capped at 50).
  Names are unique, ignoring case. Models stored in a preset are not checked
  against the live catalog until you apply and submit, so a since-renamed model
  shows in the picker but only fails at CREATE CLUSTER time.
  </Note>
  </>
  ),
  },
];

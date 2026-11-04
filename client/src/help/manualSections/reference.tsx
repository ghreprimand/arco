import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Pre, Note, Kbd, Table, Sub} from '../../components/UserManual/components';
import { DocRef } from '../../components/help/DocRef';

export const reference: Section[] = [
  {
  id: 'shortcuts',
  group: 'Reference',
  title: 'Keyboard shortcuts',
  body: (
  <>
  <p>
  The most-used keys for the creator, palette, composer and modals.{' '}
  <Kbd>Ctrl/Cmd+?</Kbd> opens the full grouped cheat sheet.
  </p>

  <Sub>Global</Sub>
  <Table
  headers={['Shortcut', 'What it does']}
  rows={[
  [<Kbd key="k">Ctrl/Cmd+K</Kbd>, 'Open the workflow creator in a new tab, when focus is outside a text field. Inside a composer, Ctrl+K deletes to end of line instead.'],
  [<Kbd key="p">Ctrl/Cmd+P</Kbd>, 'Open the command palette to search tabs, files, transcript and commands. Start with > to search file contents. Works from the composer; press again to close.'],
  [<Kbd key="q">Ctrl/Cmd+?</Kbd>, 'Open the keyboard-shortcut cheat sheet. Press again to close.'],
  [<Kbd key="t">t</Kbd>, 'In a GitHub repo CODE view, open Go-to-file (focus outside a text field).'],
  [<Kbd key="esc">Escape</Kbd>, 'Close the active modal (Settings, Manual, cheat sheet, Review dialog and so on). Also exits help mode.'],
  ]}
  />

  <Sub>Composer</Sub>
  <Table
  headers={['Shortcut', 'What it does']}
  rows={[
  [<Kbd key="e">Enter</Kbd>, 'Send. During a running turn, queue the message as a steer. In a Chat tab, send the message.'],
  [<Kbd key="se">Shift+Enter</Kbd>, 'Insert a newline (Agent and Chat).'],
  [<Kbd key="ie">Ctrl/Cmd+Enter</Kbd>, 'Claude/Codex Agent: interrupt the running turn and send the draft next. Other queued messages are kept.'],
  [<Kbd key="ae">Alt+Enter</Kbd>, 'During a running turn only: queue as a follow-up that runs after the current turn.'],
  [<Kbd key="au">Alt+Up</Kbd>, 'Bring the most recently queued message back into the editor.'],
  [<Kbd key="ck">Ctrl+K</Kbd>, 'Delete from the cursor to end of line, without using the clipboard (Agent and Chat).'],
  [<Kbd key="ce">Escape</Kbd>, 'Cancel the running turn. Asks first when messages are queued; Shift+Escape skips the question. With an empty editor and no turn running, clears the last queued message.'],
  [<Kbd key="cv">Ctrl/Cmd+V</Kbd>, 'Paste a clipboard image or file as an attachment. Dropping a file anywhere on the window also attaches it. Not available in Incognito chats.'],
  ]}
  />

  <Sub>Tips</Sub>
  <ul>
  <li>
  The cheat sheet is also available from the <Code>Keyboard shortcuts</Code>{' '}
  palette command. It is read-only: it lists the keys but does not run them.
  </li>
  <li>
  The Manual search box also searches the contextual-help topics behind the{' '}
  <Code>?</Code> help mode. They appear under <strong>HELP TOPICS</strong> in
  the sidebar.
  </li>
  <li>
  Tab moves keyboard focus out of the composer and onto buttons. Typed
  messages only queue while focus is in the composer text box.
  </li>
  </ul>
  </>
  ),
  },
  {
  id: 'env-vars',
  group: 'Reference',
  title: 'Environment variables',
  body: (
  <>
  <p>
  Server environment variables that change ports, local endpoints, limits
  and optional integrations. Most installs need none of them.
  </p>
  <Table
  headers={['Variable', 'Default', 'Purpose']}
  rows={[
  [<Code key="ap">ARCO_PORT</Code>, '3001', 'Server HTTP/WS port.'],
  [<Code key="ah">ARCO_HOST</Code>, '127.0.0.1', 'Address the server binds to; keep loopback unless remote access is deliberate.'],
  [<Code key="ahome">ARCO_HOME</Code>, '~/.arco', 'Arco home (settings, saved work, service files). The package service saves it at first install.'],
  [<Code key="uc">ARCO_UPDATE_CHECK</Code>, '(on)', 'Set to 0 to turn release checks off.'],
  [<Code key="lb">ARCO_LLAMACPP_BIN</Code>, '(PATH lookup)', 'Path to the llama-server executable (llama-server.exe on Windows).'],
  [<Code key="ou">OLLAMA_URL_BASE</Code>, 'http://localhost:11434', 'Ollama daemon endpoint.'],
  [<Code key="lm">LMSTUDIO_URL_BASE</Code>, 'http://localhost:1234/v1', 'LM Studio OpenAI-compatible endpoint (a bare host:port gets /v1 appended).'],
  [<Code key="sx">ARCO_SEARXNG_URL</Code>, 'http://127.0.0.1:8888', 'Local SearXNG used by the WebSearch tool.'],
  [<Code key="cf">ARCO_CAMOUFOX_PYTHON</Code>, '/opt/camoufox/bin/python', 'Camoufox Python for stealth WebFetch.'],
  [<Code key="rk">ARCO_RSS_KILL_BYTES</Code>, '32 GB', 'Memory limit per worker process tree; a worker over it is stopped. Lower it on machines with less than 64 GB RAM.'],
  [<Code key="hub">ARCO_HUB_URL</Code>, '(unset)', 'Tailnet management-hub URL; set to link this instance for remote control. Inert when unset.'],
  [<Code key="ntfy">ARCO_NTFY_URL</Code>, '(unset)', 'ntfy topic URL for phone alerts; used when nothing is saved in Settings, Notifications. Inert when unset.'],
  [<Code key="tm">TERMINAL</Code>, '(auto-detect)', 'Preferred terminal for Codex auth flows.'],
  [<Code key="ak">ANTHROPIC_API_KEY</Code>, '(unset)', 'API-key fallback for Claude (subscription preferred).'],
  [<Code key="ok">OPENAI_API_KEY</Code>, '(unset)', 'API-key fallback for Codex.'],
  ]}
  />
  </>
  ),
  },
  {
  id: 'cli-commands',
  group: 'Reference',
  title: 'CLI commands & launcher',
  body: (
  <>
  <p>
  The <Code>arco</Code> command manages a package install. A source checkout
  uses npm scripts instead, plus an optional Linux launcher.
  </p>

  <Sub>Package install</Sub>
  <Pre>{`arco setup  # configure and start the per-user service
arco setup --repair-native  # rebuild native modules (build tools required)
arco start  # run in the foreground
arco open [--tab]  # app window, or a browser tab
arco shortcuts add|remove  # per-user launcher shortcut
arco service install|uninstall|start|stop|restart|status|logs|refresh
arco update  # update the installed package
arco voice setup  # install local voice components
arco doctor  # check runtime, providers, port and service
arco version`}</Pre>
  <ul>
  <li>
  <Code>arco service logs</Code> prints recent logs. On Windows it also prints
  the raw output files.
  </li>
  <li>
  <Code>arco service refresh</Code> updates an older Arco Windows task
  definition to the current one.
  </li>
  </ul>

  <Sub>Source checkout</Sub>
  <p>From the repo root:</p>
  <Pre>{`npm run dev  # server + client concurrently (most common)
npm run dev:server  # server only - port 3001
npm run dev:client  # client only - port 5173
npm run build  # build shared, server, client`}</Pre>
  <p>
  To update a checkout, run <Code>npm run arco:update</Code>; see{' '}
  <Code>docs/OPERATIONS.md#updating-arco</Code>.
  </p>

  <Sub>Linux launcher (optional)</Sub>
  <p>For a source checkout on a freedesktop Linux desktop:</p>
  <Pre>{`scripts/arco start  # boot Arco + open browser
scripts/arco stop  # graceful API shutdown + cleanup
scripts/arco restart  # stop then start
scripts/arco status  # report running/stopped + log path
scripts/arco logs [N]  # tail -f -n N of the log (default 100)`}</Pre>
  <p>Logs land at <Code>~/.cache/arco/arco.log</Code>.</p>
  </>
  ),
  },
  {
  id: 'glossary',
  group: 'Reference',
  title: 'Glossary',
  body: (
  <>
  <p>
  Short definitions of terms used elsewhere in this manual. A longer list is
  in <DocRef>docs/GLOSSARY.md</DocRef>.
  </p>

  <Sub>Agents and turns</Sub>
  <Table
  headers={['Term', 'Definition']}
  rows={[
  [<strong key="o">Operator</strong>, 'The human user. Distinct from the primary (the AI) and a worker (a subprocess).'],
  [<strong key="p">Primary</strong>, "The single long-lived AI agent that owns a tab's conversation. Sometimes called 'agent.'"],
  [<strong key="w">Worker</strong>, 'A short-lived subprocess started by a primitive, such as a reviewer or summarizer. Distinct from the primary.'],
  [<strong key="pr">Primitive</strong>, 'One of three operator-triggered server flows: Review, Handoff, Spawn. The primary turn is sometimes called a primitive too.'],
  [<strong key="t">Turn</strong>, 'One operator prompt and the round of agent work it starts. Bracketed by primary_turn_started and primary_turn_ended.'],
  [<strong key="i">Interjection</strong>, "A message sent while a turn is running. It is queued and merged into the next turn's prompt."],
  [<strong key="g">Ghost worker</strong>, 'A primary worker that exited without emitting primary_turn_ended. Cancel unsticks the UI.'],
  ]}
  />

  <Sub>Sessions and storage</Sub>
  <Table
  headers={['Term', 'Definition']}
  rows={[
  [<strong key="s">Session</strong>, 'Native CLI conversation state, identified by a UUID (Claude) or thread_id (Codex).'],
  [<strong key="se">Seed</strong>, 'The first user message in a fresh CLI session. Handoff and Spawn use it to pass in context.'],
  [<strong key="cw">cwd</strong>, 'Working directory. Each workflow is pinned to one cwd, and its saved state lives under <cwd>/.arco/.'],
  [<strong key="cl">Calibration</strong>, 'Per-session ratio between estimated token counts and the real /context output.'],
  [<strong key="se2">seq</strong>, 'A per-workflow counter stamped on every saved event, used to replay history without gaps.'],
  [<strong key="rh">Rehydrate</strong>, 'On reconnect, the client reports the last seq it has and the server replays anything missing.'],
  [<strong key="bc">Broadcast</strong>, 'Sending a message to every observer of a workflow. It is saved to events.jsonl first, then sent.'],
  [<strong key="c">Concurrent writer</strong>, 'A separate claude --resume terminal writing to a session Arco has open. Triggers a 60-second lockout.'],
  [<strong key="rs">RSS guard</strong>, 'Memory limit per worker process tree (32 GB default). Stops runaway workers.'],
  [<strong key="cd">CDP</strong>, 'Chrome DevTools Protocol, used for local browser preview capture.'],
  ]}
  />

  <Sub>Clusters</Sub>
  <Table
  headers={['Term', 'Definition']}
  rows={[
  [<strong key="cl1">Cluster</strong>, 'A parent tab holding several member workflows pinned to one cwd. Members talk through peer tools; no member has hidden authority.'],
  [<strong key="cl2">Member</strong>, 'One workflow inside a cluster, addressed in peer tools by the first 8 characters of its workflowId.'],
  [<strong key="cl3">Peer tool</strong>, <span>One of <Code>peer_list</Code> / <Code>peer_send</Code> / <Code>peer_read</Code>. Available to every member for passing notes between operator turns.</span>],
  [<strong key="cl4">Mailbox</strong>, 'Per-recipient inbox at ~/.arco/clusters/<id>/mailbox/<wfid>/. One file per message, size-limited, emptied by peer_read.'],
  [<strong key="cl5">Role hint</strong>, "A free-form tag of up to 120 characters added to a member's instructions each turn. Presets: DIRECTOR, BUILDER, REVIEWER, RESEARCHER, TESTER, DOCUMENTER, plus CUSTOM. A cluster may have at most one director (a role beginning with Director or Coordinator)."],
  [<strong key="dir">Director</strong>, 'A member whose role hint is DIRECTOR or begins with Director or Coordinator. By convention it creates tasks, assigns workers and watches progress. At most one per cluster for new work. It cannot mark tasks done; only the operator can.'],
  [<strong key="cl6">Cluster plan</strong>, "Shared text of up to 32 KB included in every member's instructions each turn. It is cached for about 5 minutes."],
  [<strong key="cl7">Idle nudger</strong>, 'An optional per-cluster toast (off by default) shown when a member has been idle for 10 seconds or more with unread mail. It never prompts workers.'],
  [<strong key="ws">Work size</strong>, 'Optional light / standard / heavy hint on a non-director member. Guides which tasks the director assigns; does not change model or effort. Template review offers it only for repeated roles.'],
  [<strong key="lcap">Local capacity</strong>, 'Connections setting per Ollama or llama.cpp runtime: how many cluster members may use it at once (1-16, default 1). Creating, adding or replacing a member over capacity is refused unless ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL=1.'],
  ]}
  />

  <Sub>Task board</Sub>
  <Table
  headers={['Term', 'Definition']}
  rows={[
  [<strong key="tk">Task kernel</strong>, 'The server-side task system for a cwd: statuses (triage / todo / ready / in_progress / blocked / review / done / archived), dependencies, comments and run history. Only the operator can set done or archived.'],
  [<strong key="rdt">Ready task</strong>, 'A task whose dependencies are all done and that has no open run. The dispatcher only assigns ready tasks.'],
  [<strong key="rvs">Review (task status)</strong>, 'The worker believes the task is complete and asks for verification. Only the operator can move it from review to done. Distinct from the Review primitive.'],
  [<strong key="rn">Run</strong>, 'One attempt at a task, created when it is claimed. Records assignee, claim time, heartbeat and outcome. Several runs can build up after recovery.'],
  [<strong key="cl8">Claim</strong>, 'Reserving a task. Moves it to in_progress and creates a run. Stale claims can be recovered with task_run_recover.'],
  [<strong key="hb">Heartbeat</strong>, <span>A <Code>cluster_task_heartbeat</Code> call a long-running worker makes to show it is alive. A run with a stale heartbeat can be recovered.</span>],
  [<strong key="dp">Dispatcher</strong>, <span>An optional automatic assigner, off by default (<Code>cluster_dispatch_toggle</Code>). Gives <Code>ready</Code> tasks to idle members. <Code>cluster_dispatch_once</Code> runs a single pass.</span>],
  [<strong key="sw">Swarm</strong>, <span>A <Code>cluster_swarm_create</Code> shortcut that creates a root blackboard, N worker tasks, a verifier that waits on all workers, and a synthesizer that waits on the verifier.</span>],
  [<strong key="oa">Orchestration assist</strong>, 'The ASSIST panel on the BOARD tab. The operator picks a mode (task_graph / assignments / recovery / synthesis / swarm) and requests a draft proposal. Nothing changes until the operator accepts selected items.'],
  [<strong key="pp">Proposal</strong>, 'A draft plan from the assist panel: pending, applied or rejected. Accepting applies items through the normal task tools; rejecting changes nothing.'],
  ]}
  />

  <Sub>Claude Native controls</Sub>
  <Table
  headers={['Term', 'Definition']}
  rows={[
  [<strong key="tp">Tool posture</strong>, 'A pill that limits which tools the model gets: full (default), coding, chat or review. Applies to the current session only and is not saved with the workflow settings.'],
  [<strong key="fold">Fold / auto-fold</strong>, <span>An instant trim of the transcript, with no model call. The composer <Code>FOLD</Code> button runs it by hand; the per-tab auto-fold toggle in CONFIG (off by default) runs it at a threshold.</span>],
  [<strong key="rw">Rewind / restore point</strong>, <span>The HISTORY tab <Code>REWIND CONVERSATION</Code> action (not available on CLI or Codex). The next turn continues from the chosen point. A second rewind can undo it.</span>],
  [<strong key="gate">Review-safe mode / gate</strong>, 'A per-tab option, off by default. When on, sensitive tool calls wait for the operator to approve, edit or revoke them before they run.'],
  ]}
  />
  </>
  ),
  },
  {
  id: 'architecture-tldr',
  group: 'Reference',
  title: 'Architecture in a nutshell',
  body: (
  <>
  <p>
  Arco is a Node.js server and a React web client that talk over one
  WebSocket per client. The full map is in <DocRef>docs/ARCHITECTURE.md</DocRef>.
  </p>
  <ul>
  <li>
  <strong>Monorepo</strong> - npm workspaces:{' '}
  <Code>shared/</Code> (protocol types), <Code>server/</Code> and{' '}
  <Code>client/</Code>.
  </li>
  <li>
  <strong>Server</strong> runs providers as CLI subprocesses (Claude, Codex),
  in-process workers (Claude Native), HTTP clients (Ollama, llama.cpp,
  LM Studio) or desktop RPC clients.
  </li>
  <li>
  <strong>History</strong> - every workflow message gets a <Code>seq</Code>{' '}
  number and is saved to <Code>events.jsonl</Code>, so a reconnecting client
  can replay what it missed.
  </li>
  <li>
  <strong>Client</strong> is a single-page app. Chat and composer sit on the
  left, a tabbed panel on the right; the split and active tab are remembered.
  </li>
  <li>
  <strong>Primitives</strong> - the primary turn, Review, and Handoff/Spawn
  are server flows under <Code>server/src/primitives/</Code>.
  </li>
  </ul>
  </>
  ),
  },
  {
  id: 'further-reading',
  group: 'Reference',
  title: 'Further reading',
  body: (
  <>
  <p>
  This manual covers day-to-day use. Deeper reference lives in the tracked
  docs below.
  </p>
  <ul>
  <li><DocRef>docs/ARCHITECTURE.md</DocRef> - full system map (start here for code).</li>
  <li><DocRef>docs/PROTOCOL.md</DocRef> - every WebSocket message.</li>
  <li><DocRef>docs/HTTP_API.md</DocRef> - every HTTP endpoint.</li>
  <li><DocRef>docs/PROVIDERS.md</DocRef> - per-provider deep dive.</li>
  <li><DocRef>docs/PRIMITIVES.md</DocRef> - Review / Handoff / Spawn flows with sequence diagrams.</li>
  <li><DocRef>docs/PERSISTENCE.md</DocRef> - events.jsonl, meta.json, atomic writes, replay.</li>
  <li><DocRef>docs/CLIENT.md</DocRef> - Zustand store, component tree, render pipeline, themes.</li>
  <li><DocRef>docs/OPERATIONS.md</DocRef> - running, stopping, recovering stuck states.</li>
  <li><DocRef>docs/GLOSSARY.md</DocRef> - vocabulary (longer than the one in this manual).</li>
  <li><DocRef>docs/GOTCHAS.md</DocRef> - "don't regress X" invariants.</li>
  <li><DocRef>CONTRIBUTING.md</DocRef> - dev workflow, adding a provider/primitive/theme.</li>
  <li><DocRef>DEVLOG.md</DocRef> - chronological change log.</li>
  </ul>
  </>
  ),
  },
];

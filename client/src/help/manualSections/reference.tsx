import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Pre, Note, Kbd, Table } from '../../components/UserManual/components';
import { DocRef } from '../../components/help/DocRef';

export const reference: Section[] = [
  {
    id: 'shortcuts',
    group: 'Reference',
    title: 'Keyboard shortcuts',
    body: (
      <>
        <Table
          headers={['Shortcut', 'What it does']}
          rows={[
            [<Kbd key="k">Ctrl/Cmd+K</Kbd>, 'Open the workflow creator (new tab) — when focus is outside a text field. Inside a composer, Ctrl+K kills to end of line instead.'],
            [<Kbd key="p">Ctrl/Cmd+P</Kbd>, 'Open the command palette (search tabs, files, transcript, commands; > prefix for ripgrep content search). Works from inside the composer. Press again to close.'],
            [<Kbd key="q">Ctrl/Cmd+?</Kbd>, 'Open the keyboard-shortcut cheat sheet — the full, grouped list of every key that does something. Press again to close.'],
            [<Kbd key="e">Enter</Kbd>, 'Send the composer (or enqueue as a steer mid-turn). In a Chat tab, send the message.'],
            [<Kbd key="se">Shift+Enter</Kbd>, 'Newline in the composer (Agent and Chat).'],
            [<Kbd key="ae">Alt+Enter</Kbd>, 'Mid-turn only: enqueue as a follow-up (lands after the current turn).'],
            [<Kbd key="au">Alt+Up</Kbd>, 'Recall the most recently queued message into the editor.'],
            [<Kbd key="ck">Ctrl+K</Kbd>, 'Kill from the cursor to end of line (readline-style; no clipboard). Agent and Chat composers.'],
            [<Kbd key="ce">Escape (composer)</Kbd>, 'Cancel the in-flight turn — asks first when messages are queued; Shift+Escape skips the prompt. With an empty editor at idle, clears the last queued message.'],
            [<Kbd key="cv">Ctrl/Cmd+V</Kbd>, 'Paste a clipboard image or file into the composer as an attachment. Dropping a file anywhere on the window also attaches it. Not available in Incognito chats.'],
            [<Kbd key="t">t</Kbd>, 'In a GitHub repo CODE view, open Go-to-file (focus outside a text field).'],
            [<Kbd key="esc">Escape</Kbd>, 'Close the active modal (Settings, Manual, cheat sheet, Review dialog, etc.); also exits help mode.'],
          ]}
        />
        <Note kind="tip">
          <Kbd>Ctrl/Cmd+?</Kbd> opens a grouped cheat sheet of every shortcut;
          it's also reachable via the <Code>Keyboard shortcuts</Code> command in
          the palette. The cheat sheet is a read-only documentation surface — it
          mirrors the live handlers but does not drive them.
        </Note>
        <Note kind="tip">
          The Manual's search box now covers <strong>both</strong> manual
          sections and the contextual-help topics (the popovers behind the{' '}
          <Code>?</Code> help mode). Matches surface under a <strong>HELP
          TOPICS</strong> group in the sidebar; clicking one jumps to the linked
          manual section, or renders the topic inline when it has no section.
        </Note>
        <Note kind="tip">
          Tab focus moves keyboard input out of the composer and into UI buttons.
          Your typed-in interjections only land in the queue while focus is in the
          composer's textarea.
        </Note>
      </>
    ),
  },
  {
    id: 'env-vars',
    group: 'Reference',
    title: 'Environment variables',
    body: (
      <>
        <Table
          headers={['Variable', 'Default', 'Purpose']}
          rows={[
            [<Code key="ap">ARCO_PORT</Code>, '3001', 'Server HTTP/WS port.'],
            [<Code key="ou">OLLAMA_URL_BASE</Code>, 'http://localhost:11434', 'Ollama daemon endpoint.'],
            [<Code key="lm">LMSTUDIO_URL_BASE</Code>, 'http://localhost:1234/v1', 'LM Studio OpenAI-compatible endpoint (a bare host:port gets /v1 appended).'],
            [<Code key="sx">ARCO_SEARXNG_URL</Code>, 'http://127.0.0.1:8888', 'Local SearXNG used by the WebSearch tool.'],
            [<Code key="ab">ANTIGRAVITY_BINARY</Code>, '/opt/antigravity/antigravity', 'Antigravity desktop app path.'],
            [<Code key="ad">ANTIGRAVITY_USE_DEFAULT_PROFILE</Code>, '(unset)', 'Set 1 to reuse your normal signed-in Antigravity profile.'],
            [<Code key="aud">ANTIGRAVITY_USER_DATA_DIR</Code>, '~/.arco/antigravity-data', 'Custom Antigravity profile path; default or none omits --user-data-dir.'],
            [<Code key="acp">ANTIGRAVITY_CDP_PORT</Code>, '9222', 'Antigravity desktop debug port used only for liveness probing.'],
            [<Code key="aw">ANTIGRAVITY_WORKSPACE</Code>, '~/Projects', 'Folder opened when Arco lazy-spawns Antigravity.'],
            [<Code key="arm">ANTIGRAVITY_RPC_MODEL</Code>, 'gemini-3-flash-agent', 'Antigravity RPC model id; default is Gemini 3.5 Flash High.'],
            [<Code key="cf">ARCO_CAMOUFOX_PYTHON</Code>, '/opt/camoufox/bin/python', 'Camoufox Python for stealth WebFetch.'],
            [<Code key="rk">ARCO_RSS_KILL_BYTES</Code>, '32 GB', 'Per-worker-tree RSS auto-kill threshold (shrink on <64 GB RAM).'],
            [<Code key="hub">ARCO_HUB_URL</Code>, '(unset)', 'Tailnet management-hub URL; set to link this instance for remote control. Inert when unset.'],
            [<Code key="ntfy">ARCO_NTFY_URL</Code>, '(unset)', 'ntfy topic URL for external push notifications. Inert when unset.'],
            [<Code key="tm">TERMINAL</Code>, '(auto-detect)', 'Preferred terminal for Gemini / Codex auth flows.'],
            [<Code key="ak">ANTHROPIC_API_KEY</Code>, '(unset)', 'API-key fallback for Claude (subscription preferred).'],
            [<Code key="ok">OPENAI_API_KEY</Code>, '(unset)', 'API-key fallback for Codex.'],
            [<Code key="gk">GEMINI_API_KEY</Code>, '(unset)', 'API-key fallback for Gemini.'],
            [<Code key="zk">ZAI_API_KEY</Code>, '(unset)', 'API key for the Z.ai GLM provider (native direct Chat Completions by default; Codex app-server proxy transport optional). Can also live in the secrets file or come from config-value interpolation.'],
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
        <p>From the repo root:</p>
        <Pre>{`npm run dev           # server + client concurrently (most common)
npm run dev:server    # server only — port 3001
npm run dev:client    # client only — port 5173
npm run build         # build shared, server, client`}</Pre>
        <p>The launcher script (Linux freedesktop, optional):</p>
        <Pre>{`scripts/arco start     # boot Arco + open browser
scripts/arco stop      # graceful API shutdown + cleanup
scripts/arco restart   # stop then start
scripts/arco status    # report running/stopped + log path
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
        <Table
          headers={['Term', 'Definition']}
          rows={[
            [<strong key="o">Operator</strong>, "You — the human user. Distinct from the primary (the AI) and a worker (a subprocess)."],
            [<strong key="p">Primary</strong>, "The single long-lived AI agent owning a tab's conversation. Sometimes called 'agent.'"],
            [<strong key="w">Worker</strong>, 'A short-lived subprocess spawned by a primitive (reviewer, summarizer). Distinct from the primary.'],
            [<strong key="pr">Primitive</strong>, 'One of three operator-triggered server flows: Review, Handoff, Spawn. The primary turn is sometimes called a primitive too.'],
            [<strong key="t">Turn</strong>, 'One operator-prompt → one round-of-agent-work cycle. Bracketed by primary_turn_started / primary_turn_ended.'],
            [<strong key="i">Interjection</strong>, "A user message sent during an in-flight turn. Queued and merged into the next turn's prompt."],
            [<strong key="s">Session</strong>, 'Native CLI conversation state, identified by a UUID (Claude) or thread_id (Codex).'],
            [<strong key="se">Seed</strong>, 'The first user message in a fresh CLI session, used by Handoff and Spawn to inject context.'],
            [<strong key="cw">cwd</strong>, "Working directory. Each workflow is pinned to one cwd. All persistence lives under <cwd>/.arco/."],
            [<strong key="cl">Calibration</strong>, "Per-session ratio between byte-count token estimates and ground-truth /context output."],
            [<strong key="se2">seq</strong>, 'Per-workflow monotonic counter stamped on every persisted event. Drives lossless replay.'],
            [<strong key="rh">Rehydrate</strong>, 'On reconnect, the client sends rehydrate_workflows with each persisted lastSeq; the server replays anything missing.'],
            [<strong key="g">Ghost worker</strong>, 'A primary worker that silently exited without emitting primary_turn_ended. Cancel forces the UI unstuck.'],
            [<strong key="c">Concurrent writer</strong>, 'A foreign claude --resume terminal appending to a session Arco has open. Triggers a 60s lockout.'],
            [<strong key="rs">RSS guard</strong>, 'Per-worker-tree memory cap (32 GB default). Kills runaway workers.'],
            [<strong key="cd">CDP</strong>, 'Chrome DevTools Protocol. Antigravity no longer uses this as a transport; Arco only probes the desktop debug port for liveness.'],
            [<strong key="bc">Broadcast</strong>, "Server-side fan-out of a message to every observer of a workflow. Persists to events.jsonl first, then writes to all observers."],
            [<strong key="cl1">Cluster</strong>, 'A parent tab kind hosting N member workflows pinned to one cwd. Members address each other via peer tools; no hidden model authority.'],
            [<strong key="cl2">Member</strong>, 'One workflow inside a cluster. Addressed by 8-char workflowId prefix in peer tools.'],
            [<strong key="cl3">Peer tool</strong>, <span>One of <Code>peer_list</Code> / <Code>peer_send</Code> / <Code>peer_read</Code>. Registered on every member; lets members hand notes between operator turns.</span>],
            [<strong key="cl4">Mailbox</strong>, "Per-recipient inbox at ~/.arco/clusters/<id>/mailbox/<wfid>/. Budgeted file-per-message; drained on peer_read."],
            [<strong key="cl5">Role hint</strong>, "Free-form ≤120 char tag injected as a forced system block during a member's turn. Six canonical presets (DIRECTOR / BUILDER / REVIEWER / RESEARCHER / TESTER / DOCUMENTER) plus Custom…"],
            [<strong key="cl6">Cluster plan</strong>, 'Shared body ≤32 KB injected into every member\'s per-turn system block. Routed with cache_control:ephemeral so it lives in the 5-min prompt cache window.'],
            [<strong key="cl7">Idle nudger</strong>, 'Operator-armed (default OFF) per-cluster toast that fires when a member sits idle ≥10s with pending mail. Toast-only; never prompts workers.'],
            [<strong key="tk">Task kernel</strong>, 'Server-side primitives for durable cwd-scoped task management: status machine (triage / todo / ready / in_progress / blocked / review / done / archived), dependency system, comment threads, run history, and a done/archived operator-only gate.'],
            [<strong key="rdt">Ready task</strong>, 'A task in the ready status: all dependency parents are done and no open run exists. The dispatcher only auto-assigns ready tasks.'],
            [<strong key="rn">Run</strong>, 'One attempt to execute a task. Created when the dispatcher (or a worker) claims the task; records assignee, claimedAt, heartbeat, and outcome. Multiple runs accumulate after recovery.'],
            [<strong key="cl8">Claim</strong>, 'A dispatcher or worker reservation on a task. Moves the task to in_progress and creates a run record. Stale claims are recoverable via task_run_recover.'],
            [<strong key="dp">Dispatcher</strong>, <span>The operator-armed deterministic assignment daemon (<Code>cluster_dispatch_toggle</Code>). Assigns <Code>ready</Code> tasks to idle members; default OFF. <Code>cluster_dispatch_once</Code> runs a single sweep.</span>],
            [<strong key="dir">Director</strong>, 'A cluster member whose role hint is DIRECTOR. By convention, owns the task graph: creates tasks, assigns workers, monitors progress. Cannot set tasks done (operator-only fence).'],
            [<strong key="hb">Heartbeat</strong>, <span>A <Code>cluster_task_heartbeat</Code> call a long-running worker makes to signal liveness. Stored on the open run as lastHeartbeatAt. Stale heartbeats make a run eligible for recovery.</span>],
            [<strong key="sw">Swarm</strong>, <span>A <Code>cluster_swarm_create</Code> shortcut that scaffolds a root blackboard + N worker tasks + verifier (depends on all workers) + synthesizer (depends on verifier). Standard multi-agent dependency chain.</span>],
            [<strong key="oa">Orchestration assist</strong>, 'Operator-armed ASSIST panel on the BOARD tab. Operator picks a mode (task_graph / assignments / recovery / synthesis / swarm) and dispatches a draft proposal. Nothing applies until the operator explicitly accepts selected items.'],
            [<strong key="pp">Proposal</strong>, 'A draft orchestration plan surfaced by the assist panel. Status: pending / applied / rejected. Accept-selected applies through normal task APIs; reject mutates nothing.'],
            [<strong key="rvs">Review (task status)</strong>, 'A task status meaning the worker believes the task is complete and requests operator or reviewer verification. Distinct from the Review primitive. Only the operator can advance a task from review to done.'],
            [<strong key="tp">Tool posture</strong>, 'Operator-set pill (Claude Native) scoping which tools are exposed to the model: full (default), coding, chat, review. Session-local on the WorkflowState — set via set_tool_posture, logged in events.jsonl, not stored in meta.json.'],
            [<strong key="fold">Fold / auto-fold</strong>, <span>Deterministic, instant in-place transcript trim (Claude Native, no model call). Manual composer <Code>FOLD</Code> button; the per-tab auto-fold toggle in CONFIG (default OFF) fires it on a threshold. Emits <Code>context_folded</Code>.</span>],
            [<strong key="rw">Rewind / restore point</strong>, <span>HISTORY-tab <Code>REWIND CONVERSATION</Code> action (Native-first; rejected on CLI / Codex). Emits a <Code>leaf_move</Code> event and sets meta.leafSeq so the next turn forks a child of the chosen point. Reversible — a second <Code>leaf_move</Code> undoes the undo.</span>],
            [<strong key="gate">Review-safe mode / gate</strong>, <span>Per-tab flag (default OFF, Claude Native only). When armed, sensitive proposed tool calls park as a <Code>gate_required</Code> and wait for operator approve / edit / revoke before executing.</span>],
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
        <p>For when you want to know what's underneath:</p>
        <ul>
          <li>
            <strong>Monorepo</strong> — npm workspaces:{' '}
            <Code>shared/</Code> (TS protocol types),{' '}
            <Code>server/</Code> (Node.js + ws),{' '}
            <Code>client/</Code> (Vite + React 19 + Zustand).
          </li>
          <li>
            <strong>Server</strong> spawns provider CLIs as subprocesses
            (Claude/Gemini/Codex), in-process workers (Claude Native), HTTP
            clients (Ollama, llama.cpp, LM Studio), or desktop RPC clients
            (Antigravity) via <Code>server/src/providers/</Code>. One WebSocket
            per client; every workflow-scoped message gets a monotonic{' '}
            <Code>seq</Code> and lands in <Code>events.jsonl</Code> for lossless
            replay.
          </li>
          <li>
            <strong>Client</strong> is a single-page app with a Zustand store
            (~1300 lines). Two-column layout: left chat + composer, right tabbed
            panel. Splitter width and active tab persisted to localStorage.
          </li>
          <li>
            <strong>Shared</strong> protocol types are checked into{' '}
            <DocRef>shared/src/protocol.ts</DocRef>. All WS messages are tagged
            with <Code>workflowId</Code> and stamped with <Code>seq</Code>.
          </li>
          <li>
            <strong>Three operator primitives</strong> live under{' '}
            <Code>server/src/primitives/</Code>:{' '}
            <DocRef path="server/src/primitives/seedWorker.ts">seedWorker</DocRef>{' '}
            (primary turn),{' '}
            <DocRef path="server/src/primitives/runReviewer.ts">runReviewer</DocRef>{' '}
            (Review),{' '}
            <DocRef path="server/src/primitives/exportContext.ts">runExportContext</DocRef>{' '}
            (Handoff + Spawn).
          </li>
        </ul>
        <p>
          Deep architecture map: <DocRef>docs/ARCHITECTURE.md</DocRef> in the
          repo.
        </p>
      </>
    ),
  },
  {
    id: 'further-reading',
    group: 'Reference',
    title: 'Further reading',
    body: (
      <>
        <p>This manual covers operator behavior. For deeper agent-facing reference:</p>
        <ul>
          <li><DocRef>docs/ARCHITECTURE.md</DocRef> — full system map (start here for code).</li>
          <li><DocRef>docs/PROTOCOL.md</DocRef> — every WebSocket message.</li>
          <li><DocRef>docs/HTTP_API.md</DocRef> — every HTTP endpoint.</li>
          <li><DocRef>docs/PROVIDERS.md</DocRef> — per-provider deep dive.</li>
          <li><DocRef>docs/PRIMITIVES.md</DocRef> — Review / Handoff / Spawn flows with sequence diagrams.</li>
          <li><DocRef>docs/PERSISTENCE.md</DocRef> — events.jsonl, meta.json, atomic writes, replay.</li>
          <li><DocRef>docs/CLIENT.md</DocRef> — Zustand store, component tree, render pipeline, themes.</li>
          <li><DocRef>docs/OPERATIONS.md</DocRef> — running, stopping, recovering stuck states.</li>
          <li><DocRef>docs/GLOSSARY.md</DocRef> — vocabulary (longer than the one in this manual).</li>
          <li><DocRef>docs/GOTCHAS.md</DocRef> — "don't regress X" invariants.</li>
          <li><DocRef>CONTRIBUTING.md</DocRef> — dev workflow, adding a provider/primitive/theme.</li>
          <li><DocRef>DEVLOG.md</DocRef> — chronological change log.</li>
        </ul>
      </>
    ),
  },
];

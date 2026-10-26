import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Note, Kbd } from '../../components/UserManual/components';

export const gettingStarted: Section[] = [
  {
    id: 'welcome',
    group: 'Getting started',
    title: 'Welcome to Arco',
    body: (
      <>
        <p>
          Arco is a <strong>multi-provider coding workbench</strong>. Agent tabs
          pair a primary agent with a project directory. <strong>Chat</strong> tabs
          offer general conversation without a project; clusters group project
          agents. Providers include Claude, Codex, Z.ai, Cursor, Gemini, Ollama,
          llama.cpp, LM Studio and Antigravity, with mode-specific capabilities.
        </p>
        <p>
          The whole point is that <em>you</em> drive. Arco does not give models hidden
          authority to pick models, route messages, mark work done, silently summarize, or
          keep an opaque memory store. Automatic or model-assisted actions must be
          operator-armed, visible, logged, reversible, and applied through explicit
          approval or bounded tools.
        </p>
        <p>
          You can also group tabs into a <strong>cluster</strong> — N members sharing
          one cwd, with peer-message tools so they can hand notes between operator
          turns. Clusters are operator-driven by default; model-assisted director
          workflows are allowed only when they are armed, visible, logged, reversible,
          and routed through task tools or explicit approval.
        </p>
        <Note kind="tip">
          The fastest way to learn Arco is to start a project against a small repo and
          try each of the core operator actions (New / Resume / Review / Handoff / Spawn /
          live config swap) once. Clusters, the task board, DOCS/GIT prompts, Fold, and the
          approval gate layer on top once you need them.
        </Note>
        <p>Search the manual and contextual help topics using the box on the left.
          The manual covers supported workflows, but not every provider-specific edge case.</p>
      </>
    ),
  },
  {
    id: 'philosophy',
    group: 'Getting started',
    title: 'Design philosophy',
    body: (
      <>
        <p>Arco's design is defined as much by what it refuses to do as by what it does.</p>
        <p>
          <strong>What Arco is:</strong>
        </p>
        <ul>
          <li>One Agent tab = one project workflow; Chat tabs are projectless conversations.</li>
          <li>
            Three operator-triggered primitives layered on top: <strong>Review</strong>{' '}
            (cross-family second opinion), <strong>Handoff</strong> (rotate within the
            same tab), <strong>Spawn</strong> (fork to a new tab).
          </li>
          <li>Durable conversation replay for saved workflows and chats. Incognito
            is the explicit memory-only exception; transient telemetry is not a durable event log.</li>
          <li>
            Native session interop — Arco's Claude/Codex/Gemini sessions are real CLI
            sessions. You can resume them in a terminal, or pick up a terminal session in
            Arco.
          </li>
        </ul>
        <p>
          <strong>What Arco explicitly does not do:</strong>
        </p>
        <ul>
          <li>
            <strong>No silent autonomous routing.</strong> Arco never picks a model,
            provider, effort level, or task completion on your behalf without an
            operator-armed surface and inspectable event trail.
          </li>
          <li>
            <strong>No hidden orchestrator authority.</strong> No meta-agent owns your
            workflow. Model-assisted decomposition, assignment, recovery, or synthesis is
            eligible only as a visible proposal or through bounded task tools you enabled.
          </li>
          <li>
            <strong>No hidden auto-synthesis.</strong> Review output is a separate
            artifact — you read it. Any synthesis is an operator-chosen bounded action
            or a visible proposal you inspect before applying.
          </li>
          <li>
            <strong>No LLM-curated project memory.</strong> No <Code>STATE.md</Code>, no
            scratchpads, no build-log. If you want notes, write a markdown file. Arco
            won't touch it.
          </li>
        </ul>
        <Note>
          An older autonomous-orchestration version of Arco is preserved at git branch{' '}
          <Code>arco-autonomous</Code> for reference. The current (Lite) architecture
          is the active design.
        </Note>
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
          A new installation without a connected provider opens{' '}
          <strong>Welcome - Connections</strong>. The screen can be skipped, and
          no model prompt is sent until a model-backed action is started.
        </p>
        <ol>
          <li>
            Choose a provider in Connections and follow its sign-in or API-key
            instructions. The provider list can be searched and grouped by type.
          </li>
          <li>
            For CLI auth (Claude, Gemini,
            Codex, Cursor, GitHub) Arco shows the headless login command with{' '}
            <Code>RUN IN TERMINAL</Code> / <Code>COPY</Code>; it runs on the Arco
            machine and prints a link or code to complete in a browser or device. Then
            return to Connections.
          </li>
          <li>
            Select <Code>Continue to workspace</Code> when ready, or{' '}
            <Code>Skip for now</Code> to continue without connecting one. In the
            workspace, <Code>CONNECT A PROVIDER</Code> reopens Connections.
          </li>
        </ol>
        <p>
          You can authenticate additional providers at any time from{' '}
          <Code>⚙ SETTINGS &gt; Providers and models</Code>, under Sign-in, accounts
          and local endpoints. Appearance, Projects, Agents and clusters, Voice,
          Files and media, and Advanced are the other task-based categories. Search
          finds controls across categories; the control-location map is in
          <Code>docs/SETTINGS.md</Code>. Each provider is independent —
          Claude can be live while Codex is unauthenticated, etc.
        </p>
        <Note kind="warn">
          Arco does <em>not</em> manage Antigravity auth. The desktop app uses its own
          Google login, configured in the desktop app itself.
        </Note>
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
          Start from <Code>HOME</Code>, which is the project landing page. Add an
          existing folder or create one there, then use its project card's{' '}
          <Code>New session</Code> action to open the workflow creator with that
          folder selected. The <Code>HOME</Code> tab is also available when work is
          open. The <Code>+</Code> tab or <Kbd>Ctrl/Cmd+K</Kbd> opens the creator
          directly.
        </p>
        <p>Choose <strong>SINGLE WORKFLOW</strong> for the project form below.
          <strong> CHAT</strong> needs no cwd and offers saved or Incognito conversation;
          <strong> CLUSTER</strong> groups agents; <strong>GENESIS</strong> starts from an idea.</p>
        <p>The project creator asks for:</p>
        <ul>
          <li>
            <strong>Project folder</strong> — the root the agent will operate against.
            Choose <strong>BROWSE FOLDERS +</strong> or paste an absolute path. Starting
            from a Home project card pre-fills its folder.
          </li>
          <li>
            <strong>Provider</strong> — Claude / Codex / Z.ai / Gemini / Cursor / Ollama /
            llama.cpp / LM Studio / Strata / Antigravity. Disabled providers (or providers
            without auth) are greyed out.
          </li>
          <li>
            <strong>Model</strong> — populated from the selected provider's capability
            probe. Defaults to a sensible mid-tier model.
          </li>
          <li>
            <strong>Effort</strong> — reasoning budget. Claude supports up to 5 levels
            (low/medium/high/xhigh/max). Codex is model/catalog-driven: GPT-6 Astra
            and Sol offer low/medium/high/xhigh/max/ultra, Luna stops at max; older models can expose fewer. Z.ai has 4
            (honored only on glm-5.2); Strata offers none/low/medium/high (none disables
            thinking, high maps to Qwen xhigh). Other local models expose low/high as a thinking
            toggle, and Gemini has none.
          </li>
          <li>
            <strong>Tuning</strong> — a collapsible band shown for Claude, Codex
            app-server, and Z.ai. Claude tabs add <strong>FAST MODE</strong> and a{' '}
            <strong>TOOL-RESULT FILTER</strong> (off / conservative / aggressive —
            trims noisy Bash/test output before it enters context, Native-only)
            beside an <strong>OUTPUT STYLE</strong> picker (normal / lite / terse);
            the other two show OUTPUT STYLE only. See <em>Configuration</em> for detail.
          </li>
        </ul>
        <p>
          Below the form, the <strong>RESUME</strong> picker lists native CLI sessions
          already on disk for this cwd (
          <Code>~/.claude/projects/&lt;hash&gt;</Code>,{' '}
          <Code>~/.codex/sessions/…</Code>, <Code>~/.gemini/tmp/…</Code>). Pick one to
          continue an existing conversation inside Arco.
        </p>
        <Note kind="tip">
          The creator starts with Claude selected, which may be unauthenticated. Choose
          a provider that is enabled and connected in Settings &gt; Providers and models.
          If the expected provider is unavailable, check its enable and sign-in state.
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
          A <strong>cluster</strong> is a group of N workflow tabs pinned to
          one working directory. Members can pass notes between operator
          turns via the peer tool (<Code>peer_list</Code> /{' '}
          <Code>peer_send</Code> / <Code>peer_read</Code>). Open the workflow
          creator (<Kbd>+</Kbd> tab or <Kbd>Ctrl/Cmd+K</Kbd>), then flip the
          top-of-form toggle to <strong>CLUSTER</strong>.
        </p>
        <p>The cluster creator flow:</p>
        <ul>
          <li>
            <strong>Working directory</strong> — same picker as the single
            workflow form. All cluster members share this cwd.
          </li>
          <li>
            <strong>Cluster name</strong> (optional, ≤64) — empty falls back
            to the derived <Code>&lt;basename(cwd)&gt; · &lt;short-id&gt;</Code>{' '}
            default.
          </li>
          <li>
            <strong>EFFICIENCY</strong> — one cluster-wide level (thorough /
            balanced / lean, default thorough) that dials how hard members
            fight over-review loops. Each level is a deterministic bundle:
            restraint doctrine injected into member system prompts, a smaller
            peer-send budget, and a softer mailbox notice. An optional
            free-text addendum refines the doctrine. Takes effect next turn
            and is reversible from the cluster header chip.
          </li>
          <li>
            <strong>DEFAULT FOR NEW MEMBERS</strong> — provider, model,
            effort, permissions, fast mode, tool-result filter, output style.
            Fast mode and tool-result filtering apply to Claude; output style
            applies to Claude Native, Codex app-server, and Z.ai.
            New member rows are seeded from these values. Changing a default
            after rows exist does not retro-update them.
          </li>
          <li>
            <strong>MEMBERS list</strong> — at least 2 rows. Each row is
            collapsed by default with a one-line summary. Click{' '}
            <Code>↓ EDIT</Code> to expand and override per-row:
            <ul>
              <li>Display name (optional)</li>
              <li>Provider — Claude / Codex / Z.ai / Ollama / llama.cpp / Cursor (cluster fence; Gemini, LM Studio and Antigravity are not cluster members)</li>
              <li>Model + effort (per-provider pickers)</li>
              <li>Role — free-form ≤120 chars (e.g. "director", "tester")</li>
              <li>Tier — light / standard / heavy / unset</li>
              <li>Permissions, fast mode, filter, output style (provider-supported controls only)</li>
            </ul>
          </li>
          <li>
            <strong>CREATE CLUSTER</strong> mints every member as a fresh
            workflow and creates the cluster atomically. The cluster tab
            opens immediately.
          </li>
        </ul>
        <Note kind="tip">
          Roles and tiers are pure <em>metadata</em>. The cluster director
          (an LLM reading <Code>peer_list</Code>) decides how to use them —
          Arco never auto-routes work.
        </Note>
        <Note>
          Want to add more members later? Right-click the cluster tab and
          choose <em>+ ADD WORKER</em>, or open the cluster's MEMBERS sub-tab
          and use the in-panel spawn button.
        </Note>
      </>
    ),
  },

  {
    id: 'cluster-presets',
    group: 'Getting started',
    title: 'Cluster presets — save and re-apply a cluster shape',
    body: (
      <>
        <p>
          A <strong>cluster preset</strong> captures the per-member configs
          (provider, model, effort, role, tier, display name, permissions, fast
          mode, tool-result filter, output style) plus an optional CLUSTER NAME
          template — saved under a name you pick so you can rebuild the same
          shape later against a different working directory.
        </p>
        <p>The PRESETS row sits above DEFAULT FOR NEW MEMBERS in the workflow creator's CLUSTER mode.</p>
        <ul>
          <li>
            <strong>Apply</strong> — click a pill. The MEMBERS list is
            overwritten with the preset's members (each as a fresh draft row).
            If the CLUSTER NAME field is blank, it's seeded from the preset's
            name template; an already-typed name is never clobbered.
          </li>
          <li>
            <strong>Delete</strong> — click the <Code>×</Code> on a pill,
            confirm the prompt.
          </li>
          <li>
            <strong>Save</strong> — click <Code>+ SAVE AS PRESET</Code>, type a
            name (≤64 chars), submit. Disabled until you have at least 2
            members each with a model picked (same gates as CREATE CLUSTER).
          </li>
        </ul>
        <p>
          What's NOT saved: <strong>working directory</strong>. Presets are
          project-agnostic by design — you pick the cwd separately each time,
          so the same "Review Squad" or "Heavy Build" shape can be applied to
          any project without leaking paths from where you first built it.
        </p>
        <Note>
          Presets are stored at <Code>~/.arco/cluster-presets.json</Code>
          (capped at 50). Names are unique case-insensitively. Models stored in
          a preset aren't validated against the live catalog until you apply +
          submit — so a since-renamed model surfaces in the picker but only
          fails at CREATE CLUSTER time.
        </Note>
      </>
    ),
  },

  // -------------------------------------------------------------- THE WORKSPACE
];

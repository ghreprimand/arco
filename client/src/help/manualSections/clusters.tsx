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
          A <strong>cluster</strong> is a parent tab kind that hosts N member
          workflows pinned to one <Code>cwd</Code>. Each member is its own
          long-lived workflow with its own primary, its own session, its own
          <Code>events.jsonl</Code> — clusters do not flatten members into one
          conversation. What clusters add is a peer-message substrate plus a
          shared plan and shared right-panel surfaces.
        </p>
        <p>
          Members address each other by the first 8 characters of their{' '}
          <Code>workflowId</Code>. A budgeted file-per-message{' '}
          <strong>mailbox</strong> at{' '}
          <Code>~/.arco/clusters/&lt;clusterId&gt;/mailbox/&lt;wfid&gt;/</Code>{' '}
          holds undrained messages.
        </p>
        <p>
          <strong>Why use one:</strong>
        </p>
        <ul>
          <li>
            Parallel exploration — three Claudes attacking the same repo from
            different angles, each in its own tab, swapping notes between turns.
          </li>
          <li>
            Divide-and-conquer — a DIRECTOR member tracking the plan, BUILDER
            members executing slices, a REVIEWER member checking diffs.
          </li>
          <li>
            Cross-provider second opinion — a Claude member and a Codex member
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
        <p>
          The cluster parent tab takes over the full main pane: a member-card
          grid on the left, a focused-member detail pane on the right, and a
          cluster-scoped right panel replacing the standard per-workflow right
          panel. Like the workflow panel it is grouped: <strong>WORKSPACE</strong>{' '}
          (MEMBERS / FILES), <strong>AGENT</strong> (ACTIVITY / REVIEWS / HANDOFFS /
          PLAN / BOARD / MAILBOX), <strong>MEMORY</strong> (HISTORY, from the anchor
          member) and <strong>RUNTIME</strong> (PREVIEW / CONFIG / GITHUB). CONFIG is
          the normal per-workflow pane scoped to one member picked from its MEMBER
          dropdown; REVIEWS and HANDOFFS merge every member&apos;s rows into one
          feed. On a narrow panel the tab row collapses to a grouped dropdown. A
          sticky broadcast composer at the bottom fans one prompt out to every
          member.
        </p>
        <p>
          <strong>Creating a cluster.</strong> Right-click any compatible tab
          (Claude or Codex pinned to a cwd that isn't already part of a
          cluster). The context menu offers three modes:
        </p>
        <ul>
          <li>
            <strong>CREATE WITH EXISTING</strong> — multi-pick other same-cwd
            Claude/Codex tabs to gather into a new cluster around the anchor.
          </li>
          <li>
            <strong>CREATE WITH FRESH</strong> — spawn N (1–4) new workflows
            inheriting the anchor's primary config and join them under a new
            cluster.
          </li>
          <li>
            <strong>ADD TO EXISTING</strong> — when one or more same-cwd
            clusters already exist, pick which to join.
          </li>
        </ul>
        <p>
          The cluster's <Code>cwd</Code> is fixed at creation. Every member —
          existing or freshly spawned — must share it. The fence is enforced
          server-side and at the picker; non-compatible tabs are filtered out
          of the candidate list.
        </p>
        <p>
          <strong>Saving and moving a cluster.</strong> MEMBERS →{' '}
          <Code>SAVE STATE</Code> captures the cluster configuration, plan, and
          each member&apos;s conversation history. Save it locally or directly
          to CLOUD. The <Code>+NEW → CLUSTER</Code> creator exposes the same
          LOCAL / CLOUD list plus <Code>IMPORT FILE</Code>; restore selects the
          destination project directory and either the last N turns per member
          or all history.
        </p>
        <p>
          <strong>Reopening an existing live cluster.</strong> If a browser tab
          disappears while its server-side cluster still exists, open{' '}
          <Code>+NEW → CLUSTER</Code> and use{' '}
          <Code>LIVE CLUSTERS ON THIS COMPUTER → REOPEN</Code>. This reconnects
          the original cluster and member IDs; it does not fork from a snapshot.
        </p>
        <ul>
          <li><Code>FILE</Code> exports an integrity-checked <Code>.arcocluster</Code> bundle.</li>
          <li>CLOUD snapshots are AES-256-GCM encrypted before upload to the tailnet management hub. The hub-host vault never receives the key.</li>
          <li>Saving under an existing name asks before replacement. Local replacement is staged completely before the old copy is swapped; SAVE CLOUD also replaces the same-name cloud entry.</li>
          <li>Use <Code>COPY VAULT KEY</Code> on one computer and <Code>SET VAULT KEY</Code> on the other. The project itself and provider credentials are never included.</li>
          <li>Restore mints fresh IDs. Runtime arming (REMOTE, remote gates, auto-pickup, idle nudges, and task dispatcher) remains OFF until explicitly re-enabled.</li>
        </ul>
        <p>
          <strong>FRESH spawn — provider / model / effort picker.</strong>{' '}
          Both fresh-worker surfaces (CREATE WITH FRESH in the right-click
          menu, ADD FRESH in the cluster's MEMBERS sub-tab) expose a
          PROVIDER / MODEL / EFFORT picker above the COUNT input. Defaults
          clone the anchor (or cluster template, for ADD FRESH); the operator
          can override any of the three at spawn time.
        </p>
        <ul>
          <li>
            FRESH workers default to the anchor's provider/model/effort but
            can be overridden at spawn time. Other config (cwd, advanced
            flags, skipPermissions, etc.) still inherits from the anchor.
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
            <strong>Claude / Codex / Ollama / llama.cpp / Cursor</strong>;
            Gemini, LM Studio, and Antigravity are not cluster members. Cursor
            is fresh-spawn membership only, wired via a loopback StreamableHTTP
            MCP server for peer tools.
          </li>
          <li>
            <strong>One local member by default.</strong> A from-scratch cluster
            accepts at most one local-runtime member (Ollama or llama.cpp) — two
            local workers would contend on the same backend/GPU. Override the cap
            with <Code>ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL=1</Code> when you really
            do have the hardware for it.
          </li>
        </ul>
        <p>
          <strong>Right-panel splitter.</strong> A 4 px col-resize divider sits
          between the member trio (grid + detail) and the cluster right panel.
          Drag to resize; position persists per-browser to{' '}
          <Code>arco.clusterRightPanelWidth</Code> in localStorage. Range{' '}
          <Code>0.18 – 0.5</Code>.
        </p>
        <p>
          <strong>Broadcast recipient picker.</strong> The chip row above the
          broadcast textarea picks which members the next submit fans out to.
          Default state is all-selected (the legacy "send to all" path —
          backward compatible: when every chip is on, the wire shape omits the
          recipient list and the server treats it as "all"). Click a chip to
          exclude that member; click again to re-include. Each chip carries the
          member's role badge (preset label or <Code>CUSTOM</Code>) plus a
          status dot (warning while busy, accent while idle), so the operator
          can pick by role + busy state without leaving the composer. The
          placeholder and post-submit toast read <em>X of N members</em> to
          confirm scope before send.
        </p>
        <Note>
          Closing the cluster tab keeps its members alive as plain workflows
          (peer tools stay registered). Tear-down only happens when you click{' '}
          <Code>×</Code> on the cluster tab and confirm.
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
          The left column is a compact{' '}
          <strong>MemberCard grid</strong>. Cards-per-row clamps to{' '}
          <Code>clamp(ceil(sqrt(N)), 1, 4)</Code> — 2 members → 2 columns, 3–4
          → 2×2, 5–6 → 3×2, 7–9 → 3×3, 10+ rolls vertically at 4 columns. A
          4 px splitter separates the grid from the focused-member detail
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
            <strong>Status dot</strong> — solid + pulsing while the member is
            busy; outlined while idle.
          </li>
          <li>
            <strong>Friendly name</strong> in bold (operator-set rename, or
            <Code>wfid</Code> prefix as fallback) plus IDLE/BUSY tag.
          </li>
          <li>
            <strong>Second line</strong> — 8-char workflowId prefix and, if
            set, a role chip (preset label, or <Code>CUSTOM</Code> for
            free-form roles).
          </li>
          <li>
            <strong>Body</strong> — the latest assistant text, or the current
            tool/thinking activity if the member is busy. Auto-scrolls to the
            bottom as tokens arrive.
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
          Each row in the MEMBERS sub-tab of the cluster right panel has a{' '}
          <Code>RENAME</Code> affordance next to the member's name. Click it to
          open an inline editor pre-filled with the current operator-set name
          (empty if none — the placeholder shows the wfid prefix). Press{' '}
          <Kbd>Enter</Kbd> to commit, <Kbd>Esc</Kbd> to cancel.
        </p>
        <ul>
          <li>Capped at 64 characters.</li>
          <li>
            Empty commit clears the override; the member falls back to its
            8-char wfid prefix everywhere — card, sub-tab row, detail pane
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
    id: 'cluster-roles',
    group: 'Clusters',
    title: 'Role presets',
    body: (
      <>
        <p>
          A <strong>role hint</strong> tags one member with a short
          description of its job — e.g. "track the plan and assign slices" or
          "execute one slice end-to-end and report back." The hint is
          injected as a forced system block during that member's turn, so the
          worker reads it before drafting its reply. Empty hint → no block
          injected; the member runs unrolled.
        </p>
        <p>
          Six canonical presets ship in{' '}
          <Code>shared/src/clusterRolePresets.ts</Code>:
        </p>
        <ul>
          <li>
            <strong>DIRECTOR</strong> — adds to the cluster plan, fans work
            out to peers, integrates results, and avoids removing plan items.
          </li>
          <li>
            <strong>BUILDER</strong> — executes one slice end-to-end and
            reports back via <Code>peer_send</Code>.
          </li>
          <li>
            <strong>REVIEWER</strong> — inspects another member's diff /
            output and reports concerns.
          </li>
          <li>
            <strong>RESEARCHER</strong> — reads code / docs / external
            material and answers focused questions.
          </li>
          <li>
            <strong>TESTER</strong> — exercises behavior, writes / runs
            tests, surfaces breakage.
          </li>
          <li>
            <strong>DOCUMENTER</strong> — reads peer work via{' '}
            <Code>peer_read</Code> and writes / updates docs (README, guides,
            comments); modifies docs only.
          </li>
        </ul>
        <p>
          <strong>Setting one.</strong> On each member's row in MEMBERS, click{' '}
          <Code>SET</Code> (or <Code>EDIT</Code> if one is already set). A
          popover anchored to the button lists the six presets plus{' '}
          <Code>CLEAR</Code> and <Code>Custom…</Code>. Picking a preset
          commits the canonical text and closes the popover. <Code>CLEAR</Code>{' '}
          wipes the hint. <Code>Custom…</Code> drops into an inline free-form
          editor (≤120 chars).
        </p>
        <p>
          After commit, the row shows{' '}
          <Code>ROLE &lt;preset.label&gt;</Code> for preset matches, or a
          truncated free-form preview otherwise. The button flips to{' '}
          <Code>EDIT</Code> and the popover highlights the currently active
          preset when reopened.
        </p>
        <Note>
          Role hints are advisory, not gate-keeping. A member with{' '}
          <Code>REVIEWER</Code> set can still edit files; the worker just
          reads the hint and is more likely to behave accordingly. Combine
          with the cluster plan for harder structure.
        </Note>
      </>
    ),
  },
  {
    id: 'cluster-tiers',
    group: 'Clusters',
    title: 'Builder tiers',
    body: (
      <>
        <p>
          A <strong>builder-tier hint</strong> is an operator-set capability
          label on each cluster member. The director (an LLM running on one
          of the members) reads the tier from <Code>peer_list</Code> and
          uses it to match task complexity to builder capability. Three
          values:
        </p>
        <ul>
          <li>
            <strong>LIGHT</strong> — quick edits, renames, simple commands.
            Good fit for cheap / fast workers (codex-mini, local ollama,
            haiku).
          </li>
          <li>
            <strong>STANDARD</strong> — normal feature work. Default-ish
            band — sonnet / gpt-5 / gpt-5.5 tier.
          </li>
          <li>
            <strong>HEAVY</strong> — architectural changes, complex
            refactors, anything where the cost of a re-spin dwarfs the
            cost of a smarter model. Opus / GPT-5.5-pro / etc.
          </li>
        </ul>
        <p>
          <strong>Setting one.</strong> On each member row in MEMBERS, click
          a tier pill (LIGHT / STANDARD / HEAVY). The active pill is
          highlighted; clicking it again clears the tier. <Code>UNSET</Code>{' '}
          on the right also clears. With no tier, the member appears in{' '}
          <Code>peer_list</Code> without a <Code>tier</Code> field — "no
          opinion." The row also shows a small badge next to the IDLE /
          BUSY status when a tier is set.
        </p>
        <p>
          <strong>What the director sees.</strong> Each <Code>peer_list</Code>{' '}
          row carries <Code>workflowId</Code>, <Code>displayName</Code>,{' '}
          <Code>pendingForThem</Code>, and (optionally) <Code>tier</Code>.
          The <Code>peer_list</Code> tool description tells the model what
          each value means. The director is then free to delegate or not —
          there is <em>no</em> server-side routing, no auto-assignment, and
          no quality gating. Tier is pure metadata.
        </p>
        <Note>
          Tier complements <Code>role</Code> rather than replacing it. Role
          describes <em>what</em> a member does (DIRECTOR / BUILDER / etc.);
          tier describes <em>how much horsepower</em> it has. A cluster with
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
          (≤160 chars) describing what THIS specific member specializes in.
          Where <Code>role</Code> describes the canonical category (DIRECTOR /
          BUILDER / REVIEWER / etc.) and <Code>tier</Code> describes capability
          level, <Code>focus</Code> describes flavor — for example{' '}
          <em>"React frontend, Zustand store patterns"</em>,{' '}
          <em>"database performance + sqlc-generated code"</em>, or{' '}
          <em>"docs and changelog writing"</em>.
        </p>
        <p>
          <strong>What the director sees.</strong> The <Code>peer_list</Code>{' '}
          tool returns a <Code>focus</Code> field on each row that has one,
          and the tool description tells the director to prefer a peer whose
          focus matches the task. Pure metadata — no server-side routing.
        </p>
        <p>
          <strong>Setting one.</strong> Two places:
        </p>
        <ul>
          <li>
            On a cluster member row in the MEMBERS sub-tab — click the dashed
            FOCUS field, type your specialty, ↵ commits, Esc cancels.
          </li>
          <li>
            In the <strong>+NEW</strong> cluster builder, each member row's
            full editor has a FOCUS input below ROLE. Saved presets include
            the focus, so loading a preset re-applies focus alongside role and
            tier.
          </li>
        </ul>
        <Note>
          When you have multiple members sharing a role (e.g. two BUILDERs),
          set distinct focus strings so the director can route by specialty
          instead of round-robin. With one Claude builder focused on{' '}
          <em>"UI / React"</em> and one Codex builder focused on{' '}
          <em>"backend / SQL"</em>, "fix the login form" goes to the first,
          "add a new query" goes to the second.
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
        <p>
          Use <Code>REPLACE</Code> on a row in the MEMBERS sub-tab when you
          need a genuinely fresh worker in the same cluster slot. Arco
          creates a new workflow ID and provider session, clones the old
          member&apos;s name, role, tier, focus, and complete tab
          configuration, then atomically swaps the roster entry. You may keep
          the same provider/model/effort/account or choose new values. The old
          workflow remains on disk for audit or later resume, but it is no
          longer a cluster member.
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
            <strong>STANDARD</strong> — normal cluster context and project
            access.
          </li>
          <li>
            <strong>BLIND</strong> — project files remain available, but the
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
            <strong>ISOLATED</strong> — Claude Native only. The worker runs in
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
          <strong>32 KB</strong> (soft-warns at 28 KB). The plan is routed to
          every member as a forced system block on every turn, with{' '}
          <Code>cache_control: ephemeral</Code> so it lives in the
          provider-side 5-min prompt cache window. Net effect: one cache miss
          per plan edit, no per-turn inflation as members run their work.
        </p>
        <p>
          Edited from the <strong>PLAN</strong> sub-tab of the cluster right
          panel. The tab has two modes: <strong>VIEW</strong> renders the
          markdown body using the same parser as the per-workflow PLAN tab —
          H1/H2/H3 headings render styled, <Code>- [ ]</Code> / <Code>- [x]</Code>{' '}
          checkboxes are clickable to toggle (optimistic + cluster_plan_set
          echo), and each H3 heading gets three action pills:{' '}
          <Code>▷ REVIEW PHASE PLAN</Code>, <Code>▷ VERIFY PHASE WORK</Code>,
          and <Code>▷ SPAWN PHASE</Code>. <strong>EDIT</strong> drops to the
          textarea with byte counter + dirty marker; SAVE flips back to VIEW.
          Empty body auto-opens in EDIT.
        </p>
        <p>
          When the cluster has a board attached (mode <Code>project</Code> or{' '}
          <Code>cluster</Code>), each unchecked checkbox line in the plan also shows
          a <Code>→ TASK</Code> pill that promotes that line&apos;s text into a
          durable board task — a one-click bridge from the shared plan to the
          kanban board.
        </p>
        <p>
          The header pill bar in VIEW mode mirrors the worker tab:{' '}
          <Code>EDIT</Code>, <Code>CLEAR PLAN</Code>, <Code>REVIEW PLAN</Code>,
          <Code>VERIFY WORK</Code>, <Code>CUSTOM REVIEW</Code>. Cluster-specific
          omissions: no DETACH / PROMOTE / MOVE / DONE (the cluster plan is the
          cluster plan — these don't apply).
        </p>
        <p>
          <strong>REVIEW / VERIFY surfaces pop a member picker first.</strong>{' '}
          The existing review dialog needs a target workflow + a resolvable{' '}
          <Code>planId</Code>; the cluster plan body lives in members'
          per-turn system blocks, not in a standalone <Code>.md</Code> file.
          So the operator picks "which member's plan + transcript should the
          reviewer cross-check," and the dispatch rides on that member's
          attached plan. <strong>SPAWN PHASE</strong> spawns a fresh cluster
          member off the cluster's first-member template, defaults the new
          member's role to BUILDER, and prefills the SpawnDialog with the
          phase block (heading + every line until the next heading).
        </p>
        <p>
          Saving an empty body is rejected (use <Code>CLEAR PLAN</Code> to wipe).
          Edits land on the <em>next</em> turn for each member — in-flight turns
          aren't torn down.
        </p>
        <Note>
          Operator edits in the PLAN tab can replace or clear the whole body.
          Model-driven <Code>cluster_plan_write</Code> calls are narrower: once
          a plan exists, they must preserve existing checkbox tasks and their{' '}
          <Code>[ ]</Code> / <Code>[x]</Code> state. Directors can append urgent
          sections or new tasks, but status changes go through{' '}
          <Code>cluster_plan_tick</Code> and destructive rewrites require you.
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
            banner — see the next section.
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
          When any worker emits a plan via <Code>ExitPlanMode</Code> (Claude /
          Codex / etc.), the <strong>PlanCandidateBanner</strong> appears
          between the chat and the composer with three buttons:
        </p>
        <ul>
          <li>
            <Code>ATTACH TO WORKER</Code> — saves the plan as a per-cwd plan
            record and attaches it to <em>this</em> worker's per-tab plan
            slot. The original (non-cluster) behavior.
          </li>
          <li>
            <Code>ATTACH TO CLUSTER</Code> — saves the plan as a per-cwd plan
            record and also routes the body up to the cluster's shared PLAN
            via <Code>cluster_plan_set</Code>. The plan now applies to{' '}
            <em>every</em> member's next turn.
          </li>
          <li>
            <Code>DISCARD</Code> — drops the candidate without persisting.
          </li>
        </ul>
        <p>
          <Code>ATTACH TO CLUSTER</Code> only shows when the current workflow
          is itself a cluster member; on standalone tabs only{' '}
          <Code>SAVE &amp; ATTACH</Code> and <Code>DISCARD</Code> appear.
        </p>
        <p>
          <strong>Cluster members never auto-attach plans.</strong> All three
          plan-creation paths surface the banner so the operator picks where
          the plan lands:
        </p>
        <ul>
          <li>
            <strong>PLAN composer button → DRAFT → I'LL REVIEW</strong> —
            banner fires on the assistant's reply (unchanged behaviour).
          </li>
          <li>
            <strong>PLAN composer button → DRAFT &amp; AUTO-SAVE</strong> —
            for cluster members the dialog re-routes the autosave path
            through the review-mode flow, so AUTOSAVE behaves like REVIEW.
            An inline note in the dialog says so. Standalone tabs still
            auto-save silently.
          </li>
          <li>
            <strong>Native <Code>EnterPlanMode</Code> tool</strong> — the
            server skips <Code>handlePlanAttach</Code> for cluster members
            and emits <Code>plan_candidate_ready</Code> instead. The
            <Code> plan_set</Code> audit event still fires either way.
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
          Every cluster member has three peer tools registered alongside its
          normal tool kit:
        </p>
        <ul>
          <li>
            <Code>peer_list</Code> — list other members by wfid prefix +
            display name + role.
          </li>
          <li>
            <Code>peer_send</Code> — drop a message in another member's
            mailbox. Persists as a file under{' '}
            <Code>~/.arco/clusters/&lt;clusterId&gt;/mailbox/&lt;recipientWfid&gt;/</Code>.
            Targets can be a workflow id/prefix, a display-name prefix, or a
            unique role word like <Code>Director</Code> /{' '}
            <Code>Coordinator</Code>.
          </li>
          <li>
            <Code>peer_read</Code> — drain the caller's mailbox into the
            current turn. Drained files are deleted; the durable record lives
            in both members' <Code>events.jsonl</Code>.
          </li>
        </ul>
        <p>
          When a message is sent, the server broadcasts a{' '}
          <Code>peer_message_sent</Code> event. The recipient sees an inbox
          counter on the MAILBOX sub-tab and can choose to drain it next turn.
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
    title: 'Efficiency level',
    body: (
      <>
        <p>
          Clusters can fall into an over-review loop: members ping each other
          constantly, re-verify already-finished work, and chop plans into
          tiny one-step assignments. The <strong>efficiency level</strong> is
          one operator-set knob — a selector in the cluster right-panel header
          (and a picker in the <Code>+ NEW</Code> creator) — that dials how
          thorough vs. lean the whole cluster behaves.
        </p>
        <p>Three levels:</p>
        <ul>
          <li>
            <strong>Thorough</strong> (default) — today's behaviour. Full
            cross-review, generous peer messaging, no extra restraint.
          </li>
          <li>
            <strong>Balanced</strong> — members work in substantial chunks,
            trust completed peer work, and re-review only on the operator's
            request or concrete evidence of breakage. One concise PASS/FAIL
            report per assignment.
          </li>
          <li>
            <strong>Lean</strong> — maximum chunk size, no peer review unless
            the operator explicitly asks, no status pings, and a single
            DONE/BLOCKED line per assignment.
          </li>
        </ul>
        <p>
          Each level is a <strong>deterministic bundle</strong> of three
          effects, all server-side:
        </p>
        <ul>
          <li>
            A restraint <strong>doctrine</strong> injected into every member's
            system prompt (alongside the shared plan + role blocks).
          </li>
          <li>
            A smaller per-turn peer-send <strong>budget</strong> —{' '}
            <Code>15 → 8 → 4</Code> sends/sender/turn — so a chatty cluster
            hits a hard cap, not just advisory text.
          </li>
          <li>
            A softer pre-turn <strong>mailbox notice</strong>: at Balanced/Lean
            the "re-engage on every inbound message" language is dialled back
            so it stops contradicting the "don't over-review" doctrine.
          </li>
        </ul>
        <p>
          The <Code>NOTE</Code> field appends a cluster-specific line to the
          canned doctrine — handy for project-specific restraint rules without
          hand-writing the whole thing into the plan.
        </p>
        <Note>
          The level takes effect on each member's <strong>next</strong> turn;
          in-flight turns are untouched. The presets are static, operator-
          selected text — this is not the cluster editing its own instructions.
          Reversible at any time by flipping back to Thorough.
        </Note>
      </>
    ),
  },
  {
    id: 'cluster-nudger',
    group: 'Clusters',
    title: 'The idle nudger',
    body: (
      <>
        <p>
          An operator-armed (default <strong>OFF</strong>) per-cluster toggle
          in the right panel. The chip at the top of the cluster right panel
          shows the armed state at all times — there is no invisible
          configuration.
        </p>
        <p>
          When <Code>ENABLED</Code>, the server polls every member every few
          seconds. If a member has been <strong>idle ≥ 10 seconds</strong>{' '}
          with <strong>≥ 1 pending peer message</strong> in its mailbox, it
          emits a <Code>cluster_member_nudged</Code> toast — capped at{' '}
          <strong>3 nudges per operator turn per member</strong>.
        </p>
        <Note kind="warn">
          The nudger is <strong>toast-only</strong>. It does not send prompts
          to workers, mutate any worker state, or compose anything on the
          operator's behalf. If you want a member to drain its mailbox, you
          still have to send it a prompt (or pick it up via the next manual
          turn).
        </Note>
      </>
    ),
  },
  {
    id: 'cluster-auto-pickup',
    group: 'Clusters',
    title: 'AUTO-PICKUP (auto-turn on mailbox)',
    body: (
      <>
        <p>
          A second operator-armed (default <strong>OFF</strong>) per-cluster
          toggle in the right panel, next to the NUDGES chip. <strong>Unlike
          the idle nudger</strong>, AUTO-PICKUP actually <em>dispatches
          turns</em>: when ON, a <Code>peer_message_sent</Code> arriving at
          a currently-idle recipient fires a single primary turn on the
          recipient with the synthetic prompt{' '}
          <Code>(auto-pickup) New peer message arrived while you were idle —
          process your mailbox.</Code>
        </p>
        <p>
          Three guards prevent runaway peer→peer cascades:
        </p>
        <ul>
          <li>
            <strong>20s per-recipient cooldown</strong> — after firing for
            member R, no further auto-turn for R until 20s have elapsed.
          </li>
          <li>
            <strong>10 auto-turns per rolling 60s per cluster</strong> — a
            wide cluster (many members each peer-sending) hits this before
            it can saturate.
          </li>
          <li>
            <strong>Chain-depth cap of 3</strong> — peer-sends produced
            during an auto-turn carry an elevated <Code>chainDepth</Code>;
            an incoming send at depth ≥ 3 is refused. Operator-initiated
            sends ride at depth 0, so the first auto-turn lands at depth 1.
          </li>
        </ul>
        <p>
          Every fire <em>and</em> every guard refusal emits a{' '}
          <Code>cluster_auto_turn_fired</Code> event (with{' '}
          <Code>reason</Code> = <Code>mailbox_arrival</Code> /{' '}
          <Code>rate_capped</Code> / <Code>depth_capped</Code> /{' '}
          <Code>cooldown</Code> / <Code>recipient_busy</Code> /{' '}
          <Code>disabled</Code>), persisted to the recipient&apos;s{' '}
          <Code>events.jsonl</Code>. Skips are rate-limited to one per
          reason per minute so a tight loop can&apos;t spam the log.
        </p>
        <p>
          All three caps are env-overridable for smoke harnesses (
          <Code>ARCO_CLUSTER_AUTO_TURN_COOLDOWN_MS</Code>,{' '}
          <Code>ARCO_CLUSTER_AUTO_TURN_RATE_CAP_PER_MINUTE</Code>,{' '}
          <Code>ARCO_CLUSTER_AUTO_TURN_MAX_CHAIN_DEPTH</Code>); the
          production defaults are tuned for "operator can always intervene
          faster than the loop saturates."
        </p>
        <Note kind="tip">
          AUTO-PICKUP and the idle nudger are independent toggles — operator
          can run with both ON (toast + auto-turn), one or the other, or
          neither. Most operators leave nudger ON during exploration and
          arm AUTO-PICKUP only when the cluster is in a known-good
          peer-handoff flow.
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
        <p>
          Sits next to BROADCAST in the cluster composer. Use it when
          members already have work waiting in their mailboxes (e.g. a
          director hand-distributed via <Code>peer_send</Code>) and you
          just want them to wake up and process it — no typed prompt
          required.
        </p>
        <p>
          Click NUDGE → modal opens with a per-member checkbox list.{' '}
          <strong>Selection defaults to empty</strong> — you must pick
          recipients explicitly. Each row shows the member's role chip,
          mailbox depth (<Code>3 MAIL</Code>), and a BUSY badge if the
          member is mid-turn. SEND NUDGE is disabled until ≥1 member is
          selected. Idle members get the wake-up prompt and start a turn.
          Active members get a gentler reminder: check their mailbox when
          they reach a convenient point in their current work, then continue
          with their assignment. It uses the same steering path as typing
          into that member&apos;s chat. Providers without mid-turn delivery
          receive the reminder after the current turn. The member still
          reads its mail with <Code>peer_read</Code>. <Code>Esc</Code> or
          click-outside closes without
          sending.
        </p>
        <Note kind="tip">
          NUDGE is intentionally a <em>separate</em> path from the
          chip-row recipient picker above the broadcast textarea. The
          chip picker narrows a typed broadcast prompt; NUDGE fires a
          canned reminder with an explicit per-fire recipient pick. Two
          surfaces, two intents.
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
          A fourth peer tool, registered on every cluster member alongside{' '}
          <Code>peer_list</Code> / <Code>peer_send</Code> /{' '}
          <Code>peer_read</Code>. The <strong>model</strong> calls it
          mid-turn to toggle a single <Code>- [ ]</Code> / <Code>- [x]</Code>
          checkbox in the shared cluster plan when it completes (or
          un-completes) an item. The operator never invokes it directly —
          but it's worth knowing about because plan-edits appear in the
          cluster ACTIVITY feed without an operator action.
        </p>
        <p>
          The tool accepts either <Code>taskText</Code> (preferred — a
          case-insensitive substring of the item's text; stable across
          plan edits) or <Code>lineIndex</Code> (0-based; only valid when
          the model read the plan itself this turn). The dispatcher
          rejects empty or both-set payloads with{' '}
          <Code>invalid_matcher</Code>.
        </p>
        <p>
          On success, the server toggles the checkbox in{' '}
          <Code>~/.arco/clusters/&lt;id&gt;/plan.md</Code> and
          broadcasts <Code>cluster_plan_changed</Code> cluster-wide — every
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
          Read-only peer tool returning the full canonical plan body plus
          title and <Code>updatedAt</Code>. It exists because the plan copy
          injected into a member&apos;s context each turn is no longer
          guaranteed to be the whole plan on string-form transports (CLI
          Claude / Codex / Cursor): a plan bigger than the 16&nbsp;KB
          fold budget is delivered as a deterministic <em>outline</em> —
          headings and checkbox lines verbatim, prose dropped — so the role
          hint, mailbox notice, and other load-bearing blocks are never
          evicted. Labelled standing / rules / gates / contract / authority /
          cadence sections are kept in the outline too. The outline&apos;s
          header says it is an outline and points at this tool.
        </p>
        <p>
          <strong>Codex app-server members</strong> get a larger, separate
          budget: their cluster context (identity, role, plan, code-mode tool
          names and — for a Director — the operating contract) rides Codex&apos;s{' '}
          <Code>developerInstructions</Code> on thread start/resume with a
          48&nbsp;KB cap, enough for a full 32&nbsp;KB plan. A role or model
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
          Registered on every cluster member alongside{' '}
          <Code>peer_list</Code> / <Code>peer_send</Code> /{' '}
          <Code>peer_read</Code> / <Code>cluster_plan_read</Code> /{' '}
          <Code>cluster_plan_tick</Code>.{' '}
          <strong>By convention, only the cluster director calls
          it.</strong> Other members propose plan changes via{' '}
          <Code>peer_send</Code> to the director rather than writing
          directly. This convention lives in the{' '}
          <Code>DIRECTOR</Code> role preset text, not in server-side
          gating — every member technically has the tool.
        </p>
        <p>
          The tool takes a single string argument <Code>body</Code> (the
          new markdown plan) and validates non-empty + ≤32768 chars. If no
          plan exists yet, the write creates it. If a plan already exists,
          the server compares checkbox task lines and rejects writes that
          remove existing tasks or change their <Code>[ ]</Code> /{' '}
          <Code>[x]</Code> state. On success it writes through the same{' '}
          <Code>clusterPlanStore.writePlan</Code> path and broadcasts{' '}
          <Code>cluster_plan_changed</Code> cluster-wide so every member's
          PLAN tab and next-turn system block reflects the new plan.
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
        <p>
          The cluster right panel&apos;s <strong>BOARD</strong> sub-tab is a
          kanban <em>view</em> over this cluster&apos;s project task ledger —
          the same cwd-scoped tasks the per-member <strong>LEDGER</strong> tab
          shows. Columns are <Code>triage</Code> / <Code>todo</Code> /{' '}
          <Code>ready</Code> / <Code>in_progress</Code> /{' '}
          <Code>blocked</Code> / <Code>review</Code> / <Code>done</Code> /{' '}
          <Code>archived</Code>; each card shows the title, the claimant
          (<Code>@name</Code> chip, or <Code>UNCLAIMED</Code>), and a link
          count. Click a card to open the task drawer. The drawer keeps the
          selected task&apos;s ledger fields visible immediately and reads full
          detail through <Code>cluster_task_show</Code>.
        </p>
        <p>
          <strong>Three board modes.</strong> The board runs in one of three
          operator-selectable modes, set from the <Code>BOARD</Code> chip-row
          selector in the cluster right-panel header: <Code>none</Code> disables
          the board, the{' '}
          <Code>cluster_task_*</Code> tools, and the dispatcher;{' '}
          <Code>project</Code> — the default, since new clusters default-attach a
          project board — uses the cwd&apos;s normal project task ledger, the same
          one standalone workflow tabs and the per-member LEDGER tab show;{' '}
          <Code>cluster</Code> uses a private fresh board scoped to the same cwd,
          keyed by <Code>taskBoardKey</Code>, isolated from the project ledger. In{' '}
          <Code>none</Code> mode the BOARD sub-tab shows a{' '}
          <Code>BOARD DETACHED</Code> placeholder with{' '}
          <Code>USE PROJECT BOARD</Code> / <Code>CREATE CLUSTER BOARD</Code>{' '}
          buttons; switching mode enables the <Code>cluster_task_*</Code> tools for
          members on their next turn.
        </p>
        <p>
          <strong>Create a task without leaving the board.</strong> A composer row
          at the top of the board — a title field plus an <Code>ADD</Code> button,{' '}
          <Kbd>Enter</Kbd> also commits — creates a new task through the operator{' '}
          <Code>task_ledger_create</Code> path. New tasks always land in the{' '}
          <Code>todo</Code> column; the create surface is deliberately single-input
          rather than per-column, since every column would still produce a{' '}
          <Code>todo</Code> card. The field is disabled (placeholder{' '}
          <Code>Board not ready</Code>) until a board-reader member is available.
        </p>
        <p>
          The task drawer shows overview fields (status, assignee, priority,
          worktree-required state, current worktree path, blocked reason,
          review/goal settings, links), dependency parents/children, durable
          comments, recovery controls, and run records. Run rows show owner,
          status, session/worker ids, last heartbeat, and a live heartbeat age;
          open runs turn{' '}
          <Code>STALE</Code> after five minutes without a heartbeat. Failed
          detail reads do not break the board; the drawer shows the error
          inline and falls back to the task fields already present in the
          ledger snapshot.
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
          card onto another column to change its status through the operator
          task-update path (<Code>task_ledger_update</Code>). A 4 px pointer
          activation distance keeps a plain click opening the drawer, and a short
          press-delay <Code>TouchSensor</Code> makes the board draggable on touch
          devices. Dragging onto <Code>done</Code> or <Code>archived</Code> asks
          for confirmation first (operator acceptance). The <Code>review</Code>{' '}
          column header also carries a bulk action to mark all review tasks done at
          once, also confirmed.
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
          count and a pending-proposal count badge stay visible on the header. Open{' '}
          <Code>AUTOMATION</Code> to reveal <Code>DISPATCH ONCE</Code>,{' '}
          <Code>CREATE SWARM</Code>, <Code>DRAFT ASSIST</Code>, and the entire{' '}
          <Code>DISPATCHER</Code> row.
        </p>
        <p>
          <strong>DISPATCH ONCE</strong> runs one operator-clicked sweep over
          <Code>ready</Code> tasks. It fires only tasks that already have an
          explicit idle assignee in the cluster, records a run before starting
          the member&apos;s turn, and logs skipped ready tasks with reason codes.
          It does not infer routing and never marks work <Code>done</Code>.
        </p>
        <p>
          <strong>DISPATCHER</strong> is the armed daemon surface. It defaults
          OFF. When ARMED, the server repeats the same deterministic sweep on
          an interval; <Code>EVERY</Code> sets seconds between sweeps,{' '}
          <Code>SWEEP</Code> caps tasks fired per pass, <Code>RUNS</Code>{' '}
          caps open task runs cluster-wide, and <Code>AUTO WORKTREE</Code>{' '}
          lets the dispatcher prepare isolated checkouts for tasks marked
          worktree-required before firing them. Changing any control sends an
          explicit operator message and waits for the next{' '}
          <Code>cluster_state</Code> echo.
        </p>
        <p>
          <strong>CREATE SWARM</strong> opens the operator helper for a
          root-plus-parallel-workers graph. The request includes a brief,
          selected worker members, worker task count, verifier member,
          synthesizer member, optional worktrees, and optional dispatch after
          creation. It is still an explicit operator mutation; the helper does
          not draft routing with a model and it does not bypass dispatcher
          rules.
        </p>
        <p>
          Task peer-tools let cluster members work the board, registered
          alongside the <Code>peer_*</Code> and <Code>cluster_plan_*</Code>
          tools (and, on CLI Claude / Codex, exposed over the arco-cluster
          MCP child as <Code>mcp__arco-cluster__cluster_task_*</Code>):
        </p>
        <ul>
          <li>
            <Code>cluster_task_list</Code> — read the ledger (id, title,
            status, assignee, links). Read-only.
          </li>
          <li>
            <Code>cluster_task_show</Code> — read one task&apos;s parents,
            children, comments, and run records before starting work.
          </li>
          <li>
            <Code>cluster_task_create</Code> — create a new non-terminal{' '}
            <Code>todo</Code> task, optionally with body/notes, assignee,
            priority, dependency parents, links, and review/goal metadata.
          </li>
          <li>
            <Code>cluster_task_claim</Code> — take ownership of a task
            (assignee → you) and move it to <Code>in_progress</Code>. If a
            different member already owns it, the claim is rejected
            (<Code>already_claimed</Code>) rather than stomping their work.
          </li>
          <li>
            <Code>cluster_task_update</Code> — change status
            (<Code>triage</Code> / <Code>todo</Code> /{' '}
            <Code>ready</Code> / <Code>in_progress</Code> /{' '}
            <Code>blocked</Code> / <Code>review</Code>) and/or notes.
          </li>
          <li>
            <Code>cluster_task_heartbeat</Code> — update your visible run
            heartbeat for a task; an optional note is durable and appears in
            the task details.
          </li>
          <li>
            <Code>cluster_task_link</Code> /{' '}
            <Code>cluster_task_unlink</Code> — add or remove dependency edges.
            The server rejects self-links and cycles.
          </li>
          <li>
            <Code>cluster_task_comment</Code> — append durable handoff text to
            the task thread.
          </li>
          <li>
            <Code>cluster_task_block</Code> — move the task to{' '}
            <Code>blocked</Code>, store a reason, and append a BLOCKED comment.
          </li>
          <li>
            <Code>cluster_task_complete</Code> — submit a completion report and
            move the task to <Code>review</Code>. It never marks done.
          </li>
        </ul>
        <Note>
          <strong><Code>done</Code> / <Code>archived</Code> are
          operator-only</strong> at every layer.{' '}
          <Code>cluster_task_update</Code> rejects either terminal status with{' '}
          <Code>operator_gated</Code> — workers move finished work to{' '}
          <Code>review</Code> through <Code>cluster_task_complete</Code> or
          report via <Code>peer_send</Code>, and the operator marks the task done
          from the LEDGER tab, by dragging the card to the <Code>done</Code> column
          (confirmed), or via the drawer status controls. This
          re-enforces the §D1 operator-confirmed terminal-status invariant at
          the peer layer.
        </Note>
        <p>
          Claims and updates persist through the same durable
          <Code>task_ledger_event</Code> log as operator edits and broadcast a
          fresh <Code>task_ledger_snapshot</Code> cluster-wide, so every
          member&apos;s board follows live.
        </p>
      </>
    ),
  },
  {
    id: 'cluster-orchestration-assist',
    group: 'Clusters',
    title: 'Orchestration assist proposals',
    body: (
      <>
        <p>
          <strong>DRAFT ASSIST</strong> lives inside the BOARD sub-tab&apos;s{' '}
          <Code>AUTOMATION</Code> disclosure (default closed — open it to reveal
          DRAFT ASSIST alongside DISPATCH ONCE / CREATE SWARM / DISPATCHER). It is
          an operator-armed model-assist surface for cluster orchestration. It can
          ask a selected source member/model to draft a task graph, assignment
          set, recovery action, synthesis comment, or swarm layout from the
          current board/plan/transcript context.
        </p>
        <p>
          The output is a <strong>proposal preview</strong>, not a mutation.
          Proposal cards show source member, model/provider/effort metadata,
          status, creation time, rationale, input refs, and proposed item
          count. Opening a card shows each proposed item with kind, title,
          body, assignee/task references, dependencies, rationale, and any
          provider/model/effort suggestions.
        </p>
        <p>
          The operator owns the application step. Each item has a checkbox and
          editable title/body fields. <Code>ACCEPT SELECTED</Code> sends the
          selected item ids plus edits; the backend should translate them into
          ordinary task-kernel mutations such as task creates, assignment
          updates, recovery events, or comments. <Code>SAVE COMMENT</Code> uses
          the same explicit accept path with comment mode. <Code>REJECT</Code>
          keeps the proposal inspectable and mutates no task state.
        </p>
        <Note>
          Suggested provider/model/effort values are metadata until accepted by
          the operator. The proposal surface does not change dispatcher state,
          does not infer assignees, and does not mark tasks done.
        </Note>
      </>
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
          to the cluster's shared plan via <Code>cluster_plan_set</Code>.
          The newer behaviour (2026-05-11) <strong>also detaches the
          worker's local plan slot</strong> after the cluster write
          lands.
        </p>
        <p>
          Why: without the detach, the worker would inject <em>both</em>{' '}
          plans on the next turn — the cluster plan in a forced system
          block, and the still-attached worker plan in the
          appendSystemPrompt fold. That doubles the per-turn plan
          footprint and surfaces two conflicting "the plan" framings to
          the model. The cluster plan is the single source of truth post-
          promote; the worker plan would only re-attach if the operator
          explicitly clicked <Code>ATTACH</Code> in the worker's PLAN tab
          afterwards.
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
          <strong>cluster plan body</strong> directly — not a member's
          per-cwd plan record. New <Code>ContextRef</Code> kinds{' '}
          <Code>cluster-plan-whole</Code> + <Code>cluster-plan-phase</Code>{' '}
          carry the <Code>clusterId</Code>; the server reads the body via{' '}
          <Code>clusterPlanStore.readPlan(clusterId)</Code>.
        </p>
        <p>
          REVIEW / VERIFY surfaces pop a <strong>member picker</strong>{' '}
          first. The reviewer still has to run on <em>some</em> workflow,
          so the operator picks "which member should the reviewer run on
          and lend its transcript + git-diff context to" before the
          ReviewDialog opens. The picked member's{' '}
          <Code>workflowId</Code> rides on the request; the cluster plan
          body is the review subject regardless of which member runs it.
        </p>
        <p>
          <Code>CUSTOM REVIEW</Code> still reuses the existing{' '}
          <Code>PlanReviewPicker</Code>; the picker runs against the picked
          member's promoted plan rather than the cluster body directly
          (the cluster body has no stable per-item IDs the way per-cwd
          plans do — see decision log entry 2026-05-11).
        </p>
      </>
    ),
  },
  {
    id: 'cluster-plan-candidate-fallback',
    group: 'Clusters',
    title: 'Plan candidate banner — detection fallback',
    body: (
      <>
        <p>
          Previously the <Code>PlanCandidateBanner</Code> appeared only
          after the operator armed plan-capture via the{' '}
          <Code>PLAN</Code> composer button (<Code>DRAFT</Code> /{' '}
          <Code>DRAFT &amp; AUTO-SAVE</Code>). The newer (2026-05-11)
          detection fallback surfaces the banner <strong>even without
          the pre-arm</strong>: when a primary turn settles with a reply
          that matches an <Code>H1</Code> title on the first non-empty
          line <em>and</em> ≥3 markdown checkbox lines, the client
          auto-populates <Code>planCandidate</Code> in review mode.
        </p>
        <p>
          Catches two cases: (1) the operator asked for a plan via
          free-form prompt without clicking the PLAN button, (2) the
          pre-arm flag was dropped before <Code>primary_complete</Code>{' '}
          (page reload mid-turn, etc.).
        </p>
        <Note kind="tip">
          The heuristic is conservative — it doesn't fire on shorter
          structured replies. If you want a non-plan reply to land
          without the banner, the threshold (1 H1 + 3 checkboxes) is
          your dial; otherwise click <Code>DISCARD</Code> and the
          candidate drops without persisting.
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
          one place to watch the whole cluster move. It interleaves
          cluster-scoped events (peer messages, role edits, plan changes,
          member adds/removes, idle-nudger toasts) with{' '}
          <strong>per-member tool activity</strong> — every{' '}
          <Code>READ</Code>, <Code>BASH</Code>, <Code>TodoWrite</Code>, etc.
          fired by any member surfaces here, so you don&apos;t have to drill
          into each member&apos;s own <Code>ACTIVITY</Code> tab to see what
          they&apos;re doing.
        </p>
        <p>
          A pill row at the top — <Code>ALL · MEMBER1 · MEMBER2 · …</Code> —
          filters the feed:
        </p>
        <ul>
          <li>
            <Code>ALL</Code> (default) — every event from every member, sorted
            oldest-first with the newest at the bottom (chat convention).
            Auto-scroll stays pinned only while you were already near the
            bottom; if you scroll up to inspect older rows, new worker
            activity will not yank the view away.
          </li>
          <li>
            <strong>Single member</strong> — only that member&apos;s tool
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
          <Code>PEER →</Code>, <Code>NUDGE</Code>, etc.). Cluster-wide rows
          drop the member chip and use the event label directly.
        </p>
        <p>
          <strong>Compact runs.</strong> When the same member fires{' '}
          <strong>≥ 3 of the same tool consecutively within 30 seconds</strong>{' '}
          (e.g. <Code>READ READ READ</Code>), they collapse into one row
          labelled <Code>READ × N</Code>. Click the count chip to expand the
          individual entries. This keeps high-burst worker activity from
          drowning out the cluster-scoped events around them.
        </p>
        <Note kind="tip">
          The feed is a live readout, not a durable log. Tool activity is
          sourced from each member&apos;s in-memory <Code>activity[]</Code>{' '}
          buffer (capped — older entries roll off). Every event is also
          persisted to that member&apos;s <Code>events.jsonl</Code>; this tab
          is the operator&apos;s scrubbable summary.
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
          <Code>PREVIEW</Code>) are mirrored onto the cluster panel. They sit
          to the right of the cluster-scoped tabs (<Code>MEMBERS</Code>,{' '}
          <Code>MAILBOX</Code>, <Code>PLAN</Code>, <Code>ACTIVITY</Code>,{' '}
          <Code>REVIEWS</Code>); the strip wraps onto a second row when the
          panel is narrow.
        </p>
        <p>
          <strong><Code>GITHUB</Code></strong> and{' '}
          <strong><Code>FILES</Code></strong> are pure cluster-cwd ops — same
          GitHub browser and file explorer as the per-workflow tabs, just
          rooted at <Code>cluster.cwd</Code>. The codebase-memory and
          sandbox sub-tabs from the per-worker FILES tab don't apply (those
          are per-worker config); they still live on each member's own tab.
        </p>
        <p>
          <strong><Code>HISTORY</Code></strong> and{' '}
          <strong><Code>PREVIEW</Code></strong> are intrinsically
          per-workflow (events live on each member's <Code>events.jsonl</Code>;
          preview port bindings live in each member's <Code>meta.json</Code>),
          so these sub-tabs are pinned to the cluster's <strong>anchor
          member</strong> — <Code>members[0]</Code>, the same one{' '}
          <Code>SPAWN PHASE</Code> inherits from. To scrub another member's
          history or bind a port on another member, focus that member's tab
          and use its own HISTORY / PREVIEW tab.
        </p>
        <Note kind="tip">
          Most clusters only need one dev server total — the team is working
          one cwd — so anchor-pinned PREVIEW matches the natural workflow.
          Empty clusters (no members yet) show a placeholder on HISTORY /
          PREVIEW; GITHUB and FILES work regardless because they only need
          the cwd.
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
          When you're inside a member tab (rather than the cluster parent
          tab), a small <Code>← BACK TO CLUSTER</Code> button appears in the
          composer status row, left of the toolbox / <Code>/SKILLS</Code>{' '}
          picker. Click it to flip the active tab back to the parent cluster.
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
    title: 'Mailbox modal — inspect + cancel',
    body: (
      <>
        <p>
          The MAILBOX sub-tab shows one row per member with a pending count.
          Click a row to open the <strong>mailbox modal</strong> — a list of
          every pending peer message addressed to that member, sender +
          timestamp + full content. Each row has a <Code>CANCEL</Code> button
          that discards the message before the recipient drains it.
        </p>
        <p>
          Cancelling removes the message file from the recipient&apos;s
          mailbox and refreshes the depth chip; the recipient never sees the
          message. No event lands in <Code>events.jsonl</Code> — the
          cancellation only mutates the transient mailbox layer.
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
          calls <Code>peer_read</Code>, the file is destroyed; the durable
          record lives in both members&apos; <Code>events.jsonl</Code> and is
          out of reach of CANCEL. Use the modal to undo a stale or
          mis-routed <Code>peer_send</Code> before the recipient picks it
          up.
        </Note>
      </>
    ),
  },
  {
    id: 'cluster-transcript-send',
    group: 'Clusters',
    title: 'Operator transcript-send — → TRANSCRIPT',
    body: (
      <>
        <p>
          <Code>→ TRANSCRIPT</Code> sits in the composer status row on
          every cluster-member tab (the button only appears when the
          workflow is a cluster member with ≥1 peer). Click it to forward
          an arbitrary chunk of the current tab&apos;s chat into a peer&apos;s
          mailbox <em>from</em> the current member.
        </p>
        <p>
          The modal lets you pick:
        </p>
        <ul>
          <li>
            <strong>Recipient</strong> — radio list of every other cluster
            member.
          </li>
          <li>
            <strong>Scope</strong> — <Code>Last turn</Code> (default) /{' '}
            <Code>Last N turns</Code> (N is editable, 1–50) /{' '}
            <Code>Full transcript</Code>.
          </li>
        </ul>
        <p>
          A live preview shows the formatted slice + byte count against the{' '}
          <strong>32 KB cap</strong> (matches the cluster-plan body cap; 4×
          the model-driven <Code>peer_send</Code> limit). The slicer drops
          rendering noise — context dividers, tool-call pills, single-line
          metadata system pills (<Code>[TURN · 1m 49s]</Code>,{' '}
          <Code>[REVIEW] Running review…</Code>) — but <strong>keeps
          substantive multi-line system content</strong> like inlined review
          bodies, so the recipient actually sees work product.
        </p>
        <p>
          Server-side this <strong>bypasses the per-turn budget and the
          60-second dedupe window</strong> that constrain model-issued
          <Code>peer_send</Code> — the operator is in direct control, and
          two clicks on SEND are presumed intentional. The recipient sees
          no difference between an operator-driven and a model-driven send;
          the message lands in their mailbox the same way and surfaces on
          their next <Code>peer_read</Code> call.
        </p>
        <Note kind="tip">
          The intended flow: dispatch a cluster-routed review on a reviewer
          peer (next section); when the reviewer&apos;s reply lands in
          their chat, switch to the reviewer&apos;s tab and click{' '}
          <Code>→ TRANSCRIPT</Code> to forward the findings to whichever
          director or builder needs them. Nothing auto-forwards — the
          operator picks who sees what.
        </Note>
      </>
    ),
  },
  {
    id: 'cluster-routed-reviews',
    group: 'Clusters',
    title: 'Cluster-routed reviews — sub-worker vs member reviewer',
    body: (
      <>
        <p>
          When the <Code>RUN REVIEW</Code> dialog opens from a
          cluster-member tab, a new <strong>STEP 2 — WHO DOES THE REVIEW?</strong>{' '}
          pill row appears at the top. Two families:
        </p>
        <ul>
          <li>
            <Code>SUB-WORKER</Code> (default) — the existing primitive:
            spawns a one-shot disposable subprocess with the
            provider/model/effort you pick below. Writes a{' '}
            <Code>.md</Code> artifact, fires <Code>review_started</Code> +{' '}
            <Code>review_artifact_ready</Code>, surfaces in the per-workflow
            and cluster <Code>REVIEWS</Code> tabs.
          </li>
          <li>
            <strong>Cluster peer pills</strong> — one pill per other member,
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
            <strong>Cluster-plan reviews</strong> — the picker{' '}
            <strong>includes the current tab</strong> as a routing anchor.
            The cluster plan body is shared across the cluster; any member
            can review it.
          </li>
          <li>
            <strong>Transcript-scoped reviews</strong> (Last turn / Last N /
            Full / git diff) — the picker <strong>excludes the current
            tab</strong>; the current tab IS the target being reviewed.
          </li>
          <li>
            <Code>GIT DIFF ONLY</Code> scope auto-falls-back to{' '}
            <Code>SUB-WORKER</Code> — the diff lives on the server, not in
            chat, so a peer-routed dispatch would send an empty payload.
          </li>
        </ul>
        <p>
          Two mode-specific prompts under the hood:
        </p>
        <ul>
          <li>
            <strong>VERIFY WORK</strong> tells the reviewer to read every{' '}
            <Code>[x]</Code> item in the plan and check the claim against
            the actual code — Read / Grep / Glob / Bash allowed. Asked for
            a verdict (PASS / MINOR / BLOCKING) + per-item
            confirmed/partial/missing + file refs.
          </li>
          <li>
            <strong>CRITIQUE PLAN</strong> tells the reviewer to evaluate
            the plan itself — structure, ordering, gaps, missing
            considerations — NOT whether work is done.
          </li>
        </ul>
        <p>
          The review task includes the operator-anchored content (plan
          body for plan scopes; transcript slice for transcript scopes)
          and an explicit instruction:{' '}
          <em>&ldquo;Produce your full review inline in your reply. Do NOT
          send it to any peer — the operator will decide who needs the
          findings.&rdquo;</em> The reviewer&apos;s reply streams into their
          chat + the cluster ACTIVITY feed; no auto-forward, no member-to-
          member routing decisions.
        </p>
        <Note kind="warn">
          Cluster-routed reviews <strong>do NOT</strong> write a{' '}
          <Code>.md</Code> artifact or land in the cluster REVIEWS tab —
          findings live in the reviewer&apos;s chat. Use{' '}
          <Code>→ TRANSCRIPT</Code> to forward them to a director or
          builder. If you want a persisted artifact, use SUB-WORKER.
        </Note>
        <Note kind="tip">
          Under the hood the dispatch uses <Code>sendMessage</Code>, not{' '}
          <Code>operator_peer_send</Code> — the reviewer needs to start a
          turn immediately. A peer-mailbox queue with AUTO-PICKUP off
          would leave the task in limbo. The MODE row in the dialog is
          locked (no toggle pill mid-dialog) — the mode is determined by
          which PLAN-tab button you clicked.
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
          Previously, peer messages were auto-injected into a worker&apos;s
          system prompt at turn start, and <Code>peer_read</Code> would
          return empty. That created a false-negative: workers saw &ldquo;no
          new peer messages&rdquo; from the tool and acted as if there was
          nothing to do — even though the operator had clearly fanned out
          work via <Code>peer_send</Code>.
        </p>
        <p>
          The new flow (2026-05-11): pre-turn auto-drain is{' '}
          <strong>gone</strong>. Instead, a short notice lands in the
          worker&apos;s system prompt:{' '}
          <em>&ldquo;You have N pending peer messages. Call the{' '}
          <Code>peer_read</Code> tool to drain and read them. …&rdquo;</em>{' '}
          The worker has to explicitly call <Code>peer_read</Code> to
          receive the content. That call drains the mailbox and fires{' '}
          <Code>peer_message_received</Code> events at the right moment
          (which is when the recipient actually sees the content).
        </p>
        <p>
          The NUDGE prompt drives this by intent rather than by naming the
          tool:{' '}
          <em>&ldquo;(nudge) You have peer mail waiting — read your pending
          peer messages and act on whatever they contain. …&rdquo;</em> It
          deliberately avoids repeating the server notice&apos;s literal
          &ldquo;Call the <Code>peer_read</Code> tool&rdquo; imperative,
          which the model would occasionally echo back as text instead of
          actually invoking. If you click NUDGE on a member with pending
          mail, that&apos;s what fires.
        </p>
        <Note kind="tip">
          From the operator&apos;s perspective: behaviour is unchanged for
          the normal case (the model reads the system-prompt notice and
          calls <Code>peer_read</Code> as instructed). The improvement is
          for the failure modes — workers that previously sat &ldquo;standing
          by&rdquo; after a peer-send because the tool&apos;s response was
          misleading now see the notice + the tool returns the actual
          content in a single coherent flow.
        </Note>
      </>
    ),
  },
  {
    id: 'cluster-peer-row-role',
    group: 'Clusters',
    title: 'Peer row display — name + role',
    body: (
      <>
        <p>
          <Code>PEER →</Code> (sent) and <Code>PEER ←</Code> (received) chat
          rows now show the relevant peer&apos;s <strong>display name +
          role</strong> instead of an 8-char wfid prefix. For a sent row,
          that&apos;s the recipient; for a received row, the sender. Role
          renders in parens after the name when set:
        </p>
        <ul>
          <li>
            <Code>PEER → sent to Seedbank Builder (BUILDER)</Code>
          </li>
          <li>
            <Code>PEER ← from Seedbank Director (DIRECTOR)</Code>
          </li>
        </ul>
        <p>
          The lookup is reactive — rename a member via the MEMBERS sub-tab
          pencil affordance, or change their role via SET / EDIT, and every
          existing peer row across all open tabs updates immediately.
          Members without a role set show just the display name.
        </p>
      </>
    ),
  },

  // -------------------------------------------------------------- THE SIX OPERATOR ACTIONS
];

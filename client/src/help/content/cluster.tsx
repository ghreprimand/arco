import { C } from './shared';
import type { HelpEntry } from './shared';

export const clusterHelp: Record<string, HelpEntry> = {
  // ----------------------------------------------------- CLUSTERS
  'cluster.tab': {
    title: 'Cluster tab',
    body: (
      <>
        <p>
          A parent tab hosting N member workflows pinned to one cwd. Grid of
          MemberCards on the left, focused-member detail on the right, shared
          sub-tabs (members / mailbox / plan / activity / reviews) in the
          right panel.
        </p>
        <p>
          Created via right-click on a tab (<C>CREATE WITH EXISTING</C> /{' '}
          <C>CREATE WITH FRESH</C> / <C>ADD TO EXISTING</C>).
        </p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.remote': {
    title: 'Cluster remote sharing',
    body: (
      <>
        <p>
          One switch shares the <strong>whole cluster</strong> with the
          management hub: every member becomes visible and controllable from
          the phone console (grouped under a cluster card with mailbox, plan,
          and board readers). <strong>Off by default.</strong>
        </p>
        <p>
          While clustered, members&apos; individual <C>◉ REMOTE</C> chips are
          ignored in both directions — the cluster switch is the only gate.
          Flipping it re-pushes the hub snapshot immediately.
        </p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.remote-gates': {
    title: 'Cluster remote gate approvals',
    body: (
      <>
        <p>
          Second arming on top of the cluster&apos;s <C>◉ REMOTE</C> switch:
          allow parked review gates (REVIEW SAFE-MODE) on <strong>any
          member</strong> to be approved or rejected from the phone console.
          One switch covers all members; member-level <C>⛨ GATES</C> chips are
          ignored while clustered. <strong>Off by default.</strong>
        </p>
        <p>
          When off, member gates still show on the console but read-only
          (&quot;resolve at desk&quot;). Remote approvals run the proposed call
          as-is — argument editing stays a desktop action.
        </p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.saved-snapshots': {
    title: 'Saved clusters',
    body: (
      <>
        <p>
          Snapshots capture portable cluster configuration, the plan, and member
          transcript history. Restore always forks fresh workflow and cluster IDs;
          choose the target project directory and how many recent turns to retain.
        </p>
        <p>
          LOCAL snapshots live on this computer. FILE exports produce a verified{' '}
          <C>.arcocluster</C> bundle. CLOUD stores an encrypted copy on the
          configured management hub.
        </p>
        <p>
          Saving another snapshot with the same name asks before replacing it.
          The existing copy remains untouched unless you confirm and the complete
          replacement finishes successfully.
        </p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.existing-live': {
    title: 'Closed clusters',
    body: (
      <>
        <p>
          Clusters still stored on this server that are not open as a tab in any
          browser. Collapsed by default; click the heading to expand.{' '}
          <C>REOPEN</C> restores the original tab with the same cluster and worker
          IDs, histories, plan, and settings.
        </p>
        <p>
          Rows marked <C>FOLDER GONE</C> point at a project folder that no longer
          exists (usually test leftovers) and can't be reopened usefully.{' '}
          <C>CLEAN UP</C> deletes all of those records at once; <C>×</C> deletes one.
          Deleting a cluster record keeps its members' transcripts on disk.
        </p>
        <p>
          This differs from snapshot restore, which deliberately forks a new
          cluster.
        </p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.snapshot-file': {
    title: 'Portable cluster file',
    body: (
      <>
        <p>
          FILE downloads a regular-files-only, integrity-checked{' '}
          <C>.arcocluster</C> bundle. IMPORT FILE verifies the complete bundle
          before adding it to LOCAL snapshots; malformed, truncated, or
          path-traversing bundles are rejected without writing a partial snapshot.
        </p>
        <p>
          The bundle contains conversation history and may therefore contain
          sensitive text. It never contains provider credentials or auth tokens.
        </p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.snapshot-cloud': {
    title: 'Encrypted cluster cloud',
    body: (
      <>
        <p>
          SAVE CLOUD encrypts the portable snapshot on this computer with
          AES-256-GCM, then uploads only the opaque envelope to the tailnet
          management hub on hub-host. Saving and restoring are manual.
        </p>
        <p>
          Every computer needs the same vault key. Use COPY VAULT KEY on the
          source computer and SET VAULT KEY on the destination. The key is stored
          locally at <C>~/.arco/cluster-vault.key</C> and is never uploaded.
        </p>
        <p>
          A same-name cloud save asks for confirmation and updates that cloud
          entry instead of accumulating duplicate copies.
        </p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.grid': {
    title: 'Member grid',
    body: (
      <p>
        One MemberCard per cluster member. Cards-per-row clamps to{' '}
        <C>clamp(ceil(sqrt(N)), 1, 4)</C>. Click any card to focus that
        member — the detail pane on the right swaps to its chat + composer.
      </p>
    ),
    manualSection: 'cluster-grid',
  },
  'cluster.splitter': {
    title: 'Grid / detail splitter',
    body: (
      <p>
        4 px col-resize splitter. Drag to resize between the member grid and
        the focused-member detail pane. Position persists per-browser to{' '}
        <C>clusterGridSplit</C> in localStorage.
      </p>
    ),
    manualSection: 'cluster-grid',
  },
  'cluster.member-card': {
    title: 'Member card',
    body: (
      <>
        <p>
          One cluster member at a glance: status dot, friendly name, IDLE/BUSY
          tag, wfid prefix, optional role chip, and the latest assistant text
          (or live activity while busy). Click to focus.
        </p>
      </>
    ),
    manualSection: 'cluster-grid',
  },
  'cluster.member-card.role-chip': {
    title: 'Role chip',
    body: (
      <p>
        The member's role hint. Preset matches show the preset's UPPERCASE
        label (DIRECTOR / BUILDER / REVIEWER / RESEARCHER / TESTER / DOCUMENTER); free-form
        text shows as <C>CUSTOM</C>. Edit from the MEMBERS sub-tab of the
        cluster right panel.
      </p>
    ),
    manualSection: 'cluster-roles',
  },
  'cluster.broadcast': {
    title: 'Broadcast composer',
    body: (
      <p>
        One submit, fans out to the selected members. Idle members start a
        fresh turn; busy members enqueue as follow-up. The chip row above
        the textarea picks the recipient subset — default is "all", click a
        chip to exclude. The placeholder/toast read <em>X of N members</em>{' '}
        to confirm scope. <C>Enter</C> sends; <C>Shift+Enter</C> for a newline.
      </p>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.broadcast.nudge': {
    title: 'Nudge button',
    body: (
      <>
        <p>
          Opens the NUDGE modal — a per-member checkbox list with each
          member&apos;s role chip, mailbox depth (e.g. <C>3 MAIL</C>),
          and a BUSY badge when applicable. Default selection is{' '}
          <strong>empty</strong>; you pick recipients explicitly. SEND
          NUDGE sends a mailbox reminder through each member&apos;s normal
          chat path. Idle members start a turn. Active members receive a
          gentler reminder to check their mail when they reach a convenient
          point in their current work, using the existing steering path.
          Providers without mid-turn steering receive it after the current
          turn. Members read pending messages with <C>peer_read</C>; sending
          a nudge does not drain the mailbox.{' '}
          <C>Esc</C> closes without sending.
        </p>
        <p>
          Distinct from the chip-row recipient picker above the
          broadcast textarea — that picker narrows a <em>typed</em>{' '}
          prompt; NUDGE fires a canned reminder. Use NUDGE when the
          director has handed out work via <C>peer_send</C> and you just
          want the builders to wake up. Use BROADCAST when you have
          something to type.
        </p>
      </>
    ),
    manualSection: 'cluster-nudge-button',
  },
  'cluster.transcript-send': {
    title: '→ TRANSCRIPT button',
    body: (
      <>
        <p>
          Operator-driven peer-send. Lets you forward a chunk of the
          current tab&apos;s chat into another cluster member&apos;s
          mailbox <em>from</em> the current member. Modal lets you pick
          a recipient (radio list of other members) and a scope:{' '}
          <C>Last turn</C> (default) / <C>Last N turns</C> /{' '}
          <C>Full transcript</C>.
        </p>
        <p>
          <strong>32 KB cap</strong> (4× the model-driven{' '}
          <C>peer_send</C> limit). Slicer drops rendering noise
          (context dividers, tool pills, single-line metadata system
          pills) but keeps substantive multi-line content like inlined
          review bodies. Server bypasses budget + dedupe — operator
          intent is explicit. Recipient sees a normal{' '}
          <C>peer_message_sent</C> on your channel.
        </p>
        <p>
          Typical use: forward reviewer findings to a director after a
          cluster-routed review lands in the reviewer&apos;s chat.
        </p>
      </>
    ),
    manualSection: 'cluster-transcript-send',
  },
  'cluster.mailbox-modal': {
    title: 'Mailbox modal',
    body: (
      <>
        <p>
          Click a row in the MAILBOX sub-tab to open this modal — lists
          every pending peer message addressed to that member with the
          full sender + timestamp + content. Per-row{' '}
          <C>CANCEL</C> discards a message before the recipient drains
          it (the recipient never sees it).
        </p>
        <p>
          Pending messages only. Once a recipient calls{' '}
          <C>peer_read</C>, the file is destroyed and the durable record
          lives in both members&apos; <C>events.jsonl</C> — out of reach
          of CANCEL. Use the modal for stale or mis-routed{' '}
          <C>peer_send</C> calls before they&apos;re picked up.
        </p>
        <p>
          When the cluster board is attached, each row also carries a{' '}
          <C>→ TASK</C> button that promotes the message body into a durable
          <C> todo</C> board task through the operator{' '}
          <C>task_ledger_create</C> path.
        </p>
      </>
    ),
    manualSection: 'cluster-mailbox-modal',
  },
  'cluster.auto-turn': {
    title: 'AUTO-PICKUP toggle',
    body: (
      <>
        <p>
          Operator-armed (default OFF) per-cluster toggle. When ON,{' '}
          <strong>every <C>peer_message_sent</C> to a currently-idle
          recipient fires a single primary turn on that recipient</strong>{' '}
          with the synthetic prompt &ldquo;(auto-pickup) New peer message
          arrived while you were idle — process your mailbox.&rdquo;
        </p>
        <p>
          Three guards: 20s per-recipient cooldown, 10 fires per rolling
          60s per cluster, chain-depth ≤3. Each guard refusal emits a{' '}
          <C>cluster_auto_turn_fired</C> event with a <C>reason</C>{' '}
          (<C>rate_capped</C> / <C>depth_capped</C> / <C>cooldown</C> /{' '}
          <C>recipient_busy</C>); fires emit the same event with{' '}
          <C>reason: mailbox_arrival</C>. All env-overridable via{' '}
          <C>ARCO_CLUSTER_AUTO_TURN_*</C>.
        </p>
        <p>
          <strong>Distinct from the idle nudger.</strong> The nudger is
          toast-only — it alerts the operator and never sends prompts to
          workers. AUTO-PICKUP dispatches real turns. Most operators
          leave the nudger ON during exploration and arm AUTO-PICKUP
          only when the cluster is in a known-good peer-handoff flow.
        </p>
      </>
    ),
    manualSection: 'cluster-auto-pickup',
  },
  'cluster.broadcast.recipient-pill': {
    title: 'Broadcast recipient chip',
    body: (
      <p>
        One chip per cluster member. Click to toggle inclusion in the
        upcoming broadcast; active chips render in the accent colour with a
        filled status dot, inactive chips dim. Each chip carries the
        member's role badge (preset label or <C>CUSTOM</C>) and a status dot
        (warning while busy, accent while idle) so the operator can pick by
        role + busy state at a glance. When every member is selected the
        wire shape omits the recipient list — preserves the legacy "send to
        all" path.
      </p>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.members': {
    title: 'MEMBERS sub-tab',
    body: (
      <p>
        Roster of cluster members. Each row exposes RENAME, DETACH, and the
        role SET/EDIT popover. The cluster's own name + rename live above the
        member list; add-worker affordances (ADD FRESH / ADD EXISTING) sit
        between.
      </p>
    ),
    manualSection: 'cluster-rename',
  },
  'cluster.add-fresh': {
    title: 'ADD FRESH',
    body: (
      <p>
        Spawn one or more brand-new workers into this cluster, pinned to the
        cluster's shared cwd. Opens the provider / model / effort / count picker
        below; fields default to the anchor template and only diverging values
        are forwarded as overrides.
      </p>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.add-existing': {
    title: 'ADD EXISTING',
    body: (
      <p>
        Pull an already-running standalone tab into this cluster — only same-cwd
        tabs whose provider can carry the peer tools are eligible: Claude (both
        transports), Codex (both transports), Z.ai, Ollama, and llama.cpp (the
        count in the label is how many qualify). The tab keeps its session and history;
        it just gains the peer tools and cluster plan/role context. Disabled when
        nothing qualifies.
      </p>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.fresh.count': {
    title: 'FRESH spawn — count',
    body: (
      <p>
        How many identical workers to spawn in one click (<C>1–4</C>). Each gets
        the same provider/model/effort picked above and a distinct workflowId;
        rename or assign roles afterward from the member roster.
      </p>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.fresh.provider': {
    title: 'FRESH spawn — provider',
    body: (
      <p>
        Pick the provider for the freshly spawned workers. CLAUDE, CODEX, ZAI,
        OLLAMA, LLAMA, or CURSOR — the six providers that pass the cluster fence.
        Defaults to the anchor / template's provider; flipping it forces MODEL
        to reset since the anchor's model name doesn't make sense on the new
        provider.
      </p>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.fresh.model': {
    title: 'FRESH spawn — model',
    body: (
      <p>
        Per-provider model dropdown. Sourced from the live catalog (Anthropic
        <C>/v1/models</C> for Claude, <C>codex app-server model/list</C> for
        Codex, the daemon's installed-model list for Ollama / llama.cpp);
        cold-catalog falls back to the inherited template model. Picking a
        different model from the anchor's overrides only this field on the
        spawned workers — cwd and advanced flags still inherit. For Cursor the
        dropdown splits into family + effort (plus optional FAST / THINK), since
        Cursor bakes effort into the model id.
      </p>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.fresh.effort': {
    title: 'FRESH spawn — effort',
    body: (
      <p>
        Effort level for the freshly spawned workers. The available set comes
        from the selected model's catalog entry; flipping model auto-clamps
        effort to the highest supported. Codex's xhigh surfaces here on
        models that advertise it.
      </p>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.fresh.access': {
    title: 'Fresh-worker access',
    body: (
      <>
        <p>
          Choose the information boundary before the worker is created.{' '}
          <C>STANDARD</C> gets normal project and cluster context. <C>BLIND</C>{' '}
          can read the project but receives no plan, board, roster, role,
          focus, efficiency, or progress context; its only cluster tools are{' '}
          <C>peer_send</C> and <C>peer_read</C>.
        </p>
        <p>
          <C>ISOLATED</C> is Claude Native only. It runs in a private durable
          scratch directory outside the project and cannot read the project
          cwd, project instructions, knowledge, attachments, hooks, registry
          MCPs, or shell. It can exchange mail and explicitly export small
          scratch artifacts through <C>peer_send artifact_paths</C>.
        </p>
      </>
    ),
    manualSection: 'cluster-member-replacement',
  },
  'cluster.member-access': {
    title: 'Member access posture',
    body: (
      <p>
        This badge marks a non-standard information boundary. <C>BLIND</C>{' '}
        keeps project-file access but hides cluster coordination context.{' '}
        <C>ISOLATED</C> is a fresh Claude Native worker in a private scratch
        directory with mailbox-only communication and no project access.
      </p>
    ),
    manualSection: 'cluster-member-replacement',
  },
  'cluster.member-replace': {
    title: 'Replace cluster member',
    body: (
      <>
        <p>
          Atomically swap this cluster slot to a brand-new workflow and
          provider session. Name, role, tier, focus, and the complete workflow
          configuration are cloned first; provider, model, effort, account,
          and access posture can then be overridden.
        </p>
        <p>
          This is a fresh worker, not a resumed session. Prior history and
          active task assignments are separate choices. The old workflow
          remains on disk for audit or later resume, but leaves the cluster
          slot.
        </p>
      </>
    ),
    manualSection: 'cluster-member-replacement',
  },
  'cluster.replace.provider': {
    title: 'Replacement provider',
    body: (
      <p>
        Keep the current provider or choose another cluster-capable provider.
        Changing provider requires a compatible model. <C>ISOLATED</C> forces
        Claude because its filesystem boundary is implemented by the Claude
        Native worker.
      </p>
    ),
    manualSection: 'cluster-member-replacement',
  },
  'cluster.replace.model': {
    title: 'Replacement model',
    body: (
      <p>
        Model for the new worker. It defaults to the current worker&apos;s
        model when the provider is unchanged; the list resets to the selected
        provider&apos;s catalog when the provider changes.
      </p>
    ),
    manualSection: 'cluster-member-replacement',
  },
  'cluster.replace.effort': {
    title: 'Replacement effort',
    body: (
      <p>
        Reasoning effort for the new worker. The picker is limited to levels
        advertised for the selected model and automatically clamps an
        unsupported inherited value.
      </p>
    ),
    manualSection: 'cluster-member-replacement',
  },
  'cluster.replace.account': {
    title: 'Replacement account',
    body: (
      <p>
        Codex account profile used to start the replacement. The model catalog
        and provider session are resolved against this account; other
        providers do not show this selector.
      </p>
    ),
    manualSection: 'cluster-member-replacement',
  },
  'cluster.replace.access': {
    title: 'Replacement access posture',
    body: (
      <>
        <p>
          <C>STANDARD</C> restores normal project and cluster access.{' '}
          <C>BLIND</C> keeps the project cwd but hides all normal cluster
          coordination context and exposes only <C>peer_send</C> /{' '}
          <C>peer_read</C>.
        </p>
        <p>
          <C>ISOLATED</C> creates a Claude Native worker in a private scratch
          workspace outside the project. It cannot import history or inherit
          active task assignments.
        </p>
      </>
    ),
    manualSection: 'cluster-member-replacement',
  },
  'cluster.replace.history': {
    title: 'Include prior workflow history',
    body: (
      <>
        <p>
          OFF gives the replacement the same clean start as any fresh cluster
          worker. ON copies a transcript and action digest into one explicit,
          visible seed turn; it spends a model call and still does not reuse
          the old provider session.
        </p>
        <p>
          Leave this OFF for a genuinely context-blind replacement. It is
          unavailable for <C>ISOLATED</C>.
        </p>
      </>
    ),
    manualSection: 'cluster-member-replacement',
  },
  'cluster.replace.tasks': {
    title: 'Transfer active task assignments',
    body: (
      <p>
        Reassign every non-done, non-archived board task currently assigned
        to the old workflow ID to the replacement workflow ID. Turn this OFF
        when the new worker should arrive without inherited work. It is
        unavailable for <C>ISOLATED</C>.
      </p>
    ),
    manualSection: 'cluster-member-replacement',
  },
  'cluster.replace.confirm': {
    title: 'Confirm replacement',
    body: (
      <p>
        Creates the new workflow, atomically swaps it into the same roster
        position, applies the selected history/task options, and retires the
        old in-memory worker. The old workflow&apos;s files remain on disk.
      </p>
    ),
    manualSection: 'cluster-member-replacement',
  },
  'cluster.right-panel.member-focus': {
    title: 'Focus member',
    body: (
      <p>
        Click the member's name to focus that worker in the cluster detail
        pane — its chat, activity, and per-member controls take over the
        right side. The status word (<C>IDLE</C> / <C>BUSY</C>) and tier badge
        sit alongside. Use PROMOTE / BACK TO CLUSTER to pop a member into its
        own top-level tab.
      </p>
    ),
    manualSection: 'cluster-grid',
  },
  'cluster.right-panel.rename': {
    title: 'Rename member',
    body: (
      <p>
        Inline rename. <C>Enter</C> commits; <C>Esc</C> cancels. Empty commit
        clears the override and falls back to the 8-char wfid prefix. Capped
        at 64 chars; persisted to <C>meta.json</C>.
      </p>
    ),
    manualSection: 'cluster-rename',
  },
  'cluster.right-panel.role-set': {
    title: 'Set / edit role',
    body: (
      <p>
        Opens the role popover: six presets (DIRECTOR / BUILDER / REVIEWER /
        RESEARCHER / TESTER / DOCUMENTER) plus CLEAR and Custom… The currently active
        preset is highlighted when you reopen the popover.
      </p>
    ),
    manualSection: 'cluster-roles',
  },
  'cluster.right-panel.role-preset': {
    title: 'Role preset',
    body: (
      <p>
        Click to commit this preset's canonical text as the member's role
        hint. The hint is injected as a forced system block during that
        member's next turn.
      </p>
    ),
    manualSection: 'cluster-roles',
  },
  'cluster.right-panel.role-custom': {
    title: 'Custom role',
    body: (
      <p>
        Drops into an inline free-form editor (≤120 chars) for an
        operator-typed role hint. Commit with <C>Enter</C>; the row shows the
        truncated text and the button flips to EDIT.
      </p>
    ),
    manualSection: 'cluster-roles',
  },
  'cluster.right-panel.role-clear': {
    title: 'Clear role',
    body: (
      <p>
        Wipes the member's role hint. With no hint set, the member's next
        turn carries no role system block; the worker runs unrolled.
      </p>
    ),
    manualSection: 'cluster-roles',
  },
  'cluster.right-panel.role-edit': {
    title: 'Edit role',
    body: (
      <p>
        Same popover as SET, but visible when a role is already attached. The
        active preset (if any) is highlighted; Custom… reopens the inline
        editor pre-filled with the current free-form text.
      </p>
    ),
    manualSection: 'cluster-roles',
  },
  'cluster.right-panel.tier-pill': {
    title: 'Builder tier',
    body: (
      <>
        <p>
          Three-value enum: <C>light</C> (quick edits, renames, simple
          commands), <C>standard</C> (normal feature work), <C>heavy</C>{' '}
          (architectural changes, complex refactors). Click again to unset.
        </p>
        <p>
          Pure metadata — the director sees the tier in <C>peer_list</C> and
          decides routing. No server-side routing.
        </p>
      </>
    ),
    manualSection: 'cluster-tiers',
  },
  'cluster.right-panel.tier-unset': {
    title: 'Clear tier',
    body: (
      <p>
        Wipes the tier hint. With no tier, the member appears in{' '}
        <C>peer_list</C> with no <C>tier</C> field — "no opinion." The
        director falls back to role / name to decide whether to delegate.
      </p>
    ),
    manualSection: 'cluster-tiers',
  },
  'cluster.right-panel.tier-badge': {
    title: 'Tier badge',
    body: (
      <p>
        Mirrors the active tier pill. Visible to peers via <C>peer_list</C>{' '}
        so the cluster director can match task complexity to builder
        capability.
      </p>
    ),
    manualSection: 'cluster-tiers',
  },
  'cluster.right-panel.focus-display': {
    title: 'Member focus (sub-specialty)',
    body: (
      <p>
        Free-form text describing what THIS specific member specializes in
        (e.g. <em>"React frontend, Zustand patterns"</em>). Where <em>role</em>
        and <em>tier</em> describe the kind of work, <em>focus</em> describes
        the per-instance flavor. Surfaces in <C>peer_list</C> so the director
        can disambiguate same-role peers. Click to edit; ↵ commits, Esc
        cancels. Pure metadata — no server-side routing.
      </p>
    ),
    manualSection: 'cluster-focus',
  },
  'cluster.right-panel.focus-input': {
    title: 'Edit member focus',
    body: (
      <p>
        Edit the sub-specialty for this member. ≤160 chars. Enter commits,
        Esc cancels, blur commits. Clear by emptying the field. The director
        sees the trimmed text in <C>peer_list</C> output.
      </p>
    ),
    manualSection: 'cluster-focus',
  },
  'cluster.right-panel.focus-clear': {
    title: 'Clear member focus',
    body: <p>Removes the focus string so the director sees no focus field for this peer (back to "no opinion").</p>,
    manualSection: 'cluster-focus',
  },
  'cluster.plan-tab': {
    title: 'Cluster plan',
    body: (
      <>
        <p>
          Shared plan body up to <strong>32 KB</strong> (soft-warns at 28 KB).
          Routed to every member as a forced system block with{' '}
          <C>cache_control: ephemeral</C> — one cache miss per edit, no
          per-turn inflation.
        </p>
        <p>
          Edits land on the NEXT turn; in-flight turns aren't torn down. Use{' '}
          <C>CLEAR PLAN</C> to wipe — empty saves are rejected.
        </p>
      </>
    ),
    manualSection: 'cluster-plan',
  },
  'cluster.board.mode': {
    title: 'Board mode',
    body: (
      <p>
        Three-way toggle for this cluster&apos;s task board: <C>NONE</C> disables
        board use (members get no <C>cluster_task_*</C> tools), <C>PROJECT</C>{' '}
        uses the cwd&apos;s shared project board (the same tasks normal workflow
        tabs in this cwd see), and <C>CLUSTER</C> gives the cluster its own
        private board for that cwd. New clusters default to <C>PROJECT</C>.
        Takes effect on each member&apos;s next turn; reversible.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.board-automation-toggle': {
    title: 'AUTOMATION header',
    body: (
      <p>
        Collapsed by default so the board reads as &ldquo;groom tasks,&rdquo;
        not &ldquo;run a swarm.&rdquo; Click to reveal the automation controls
        — <C>DISPATCH ONCE</C>, <C>CREATE SWARM</C>, <C>DRAFT ASSIST</C>, and
        the dispatcher daemon row. A <C>· N</C> suffix shows the count of open
        orchestration proposals when any exist. The task count and this toggle
        stay visible whether open or closed.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.board-add-task': {
    title: 'Add task to board',
    body: (
      <p>
        Create a task directly on the board without leaving the board view.
        <C>Enter</C> or <C>ADD</C> authors the task; it always lands as{' '}
        <C>todo</C> (the operator-confirmed-done invariant means a single board
        composer is the honest surface — not a per-column input). Reuses the
        same operator <C>task_ledger_create</C> path as the per-member LEDGER
        tab. Disabled until a cluster member is available to anchor the board
        read.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.board-columns': {
    title: 'Kanban columns',
    body: (
      <p>
        Horizontal columns — <C>triage</C> / <C>todo</C> / <C>ready</C> /{' '}
        <C>in_progress</C> / <C>blocked</C> / <C>review</C> / <C>done</C> /{' '}
        <C>archived</C>. Drag a card onto another column to change its status
        through the operator path; a plain click (under a 4px drag threshold)
        opens the card drawer instead. Touch devices drag after a short press.
        Moving a card to <C>done</C> or <C>archived</C> confirms first — those
        terminal statuses stay operator-only.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.task-edit': {
    title: 'Edit task card',
    body: (
      <p>
        Operator card editing folded into the drawer: change the task title,
        notes, and priority (<C>SAVE</C> / <C>RESET</C>), add or remove
        dependency parents, and <C>DELETE TASK</C>. Reuses the operator{' '}
        <C>task_ledger_update</C> / <C>task_ledger_delete</C> paths. Status
        moves to <C>done</C> / <C>archived</C> stay routed through the dedicated
        operator status controls, never these field edits.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.board-tab': {
    title: 'Cluster task board',
    body: (
      <>
        <p>
          A kanban <strong>view</strong> over this cluster&apos;s project task
          ledger (the same cwd-scoped tasks the per-member LEDGER tab shows).
          Columns: <C>triage</C> / <C>todo</C> / <C>ready</C> /{' '}
          <C>in_progress</C> / <C>blocked</C> / <C>review</C> /{' '}
          <C>done</C> / <C>archived</C>.
        </p>
        <p>
          Members use <C>cluster_task_show</C>, <C>cluster_task_create</C>,{' '}
          <C>cluster_task_claim</C>, <C>cluster_task_update</C>,{' '}
          <C>cluster_task_heartbeat</C>, <C>cluster_task_link</C>,{' '}
          <C>cluster_task_unlink</C>, <C>cluster_task_comment</C>,{' '}
          <C>cluster_task_block</C>, and <C>cluster_task_complete</C> to work
          the board. Mutations broadcast a fresh snapshot cluster-wide so the
          board follows live; dependency links are cycle-checked. Click a card
          to open the task drawer (overview, links, comments, runs, plus an
          operator Edit section for title/notes/priority/dependencies and
          delete). Add tasks with the board composer and drag cards between
          columns to restatus; the per-member LEDGER tab remains an alternative
          surface for the same operator edits.{' '}
          <strong><C>done</C> / <C>archived</C> are
          operator-only</strong> at every layer — workers&apos; lifecycle tools
          can move work to <C>review</C>, never terminal statuses.
        </p>
      </>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.board-column': {
    title: 'Board column',
    body: (
      <p>
        One status bucket (triage / todo / ready / in_progress / blocked /
        review / done / archived) with its task count. Cards show the title,
        the claimant (<C>@name</C> chip, or{' '}
        <C>UNCLAIMED</C>), and a link count when the task has linked plan
        items / reviews / workflows.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.board-dispatch-once': {
    title: 'Dispatch once',
    body: (
      <p>
        Runs one deterministic dispatch sweep. Only <C>ready</C> tasks with an
        explicit idle assignee are claimed, moved to <C>in_progress</C>, given a
        run record, and sent to that member as a normal turn. Skips are logged
        with stable reasons; terminal statuses remain operator-only.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.board-arm-dispatcher': {
    title: 'Task dispatcher daemon',
    body: (
      <>
        <p>
          Operator-armed, default OFF. When ARMED, the server periodically runs
          the same deterministic ready-task sweep as <C>DISPATCH ONCE</C>.
          It does not infer assignees: tasks must already have an explicit idle
          cluster member assigned.
        </p>
        <p>
          <C>EVERY</C> is the sweep interval in seconds. <C>SWEEP</C> caps how
          many tasks can fire per pass. <C>RUNS</C> caps open task runs
          cluster-wide. <C>AUTO WORKTREE</C> optionally prepares isolated
          checkouts for tasks marked worktree-required before dispatch. Settings
          changes are explicit operator sends and are echoed back through
          cluster state.
        </p>
      </>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.board-auto-worktree': {
    title: 'Auto worktree',
    body: (
      <p>
        Dispatcher setting for worktree-aware task runs. When ON, the dispatcher
        may create an isolated task worktree before firing a task marked{' '}
        <C>worktreeRequired</C>. When OFF, dispatch leaves worktree creation to
        the operator&apos;s existing <C>ISOLATE</C> button on the LEDGER tab.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.swarm-create': {
    title: 'Create swarm',
    body: (
      <>
        <p>
          Builds an operator-defined swarm graph from a brief: root blackboard,
          parallel worker tasks, verifier task, and synthesizer task. The
          operator picks worker members, worker task count, verifier,
          synthesizer, optional worktrees, and whether a deterministic dispatch
          sweep should run immediately after creation.
        </p>
        <p>
          The request is explicit state, not model routing. Existing dispatcher
          rules still apply: no hidden assignee inference and no terminal
          status changes by workers.
        </p>
      </>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.orchestration-assist': {
    title: 'Draft assist',
    body: (
      <>
        <p>
          Operator-armed orchestration assist. Click to open the request +
          proposal surface; nothing runs unless you request a draft. The model
          can propose task graph, assignment, recovery, synthesis, or swarm
          items, but it cannot apply them directly.
        </p>
        <p>
          Proposals remain previews until you select items and click{' '}
          <C>ACCEPT SELECTED</C> or <C>SAVE COMMENT</C>. <C>REJECT</C> keeps
          the proposal inspectable and mutates no task state.
        </p>
      </>
    ),
    manualSection: 'cluster-orchestration-assist',
  },
  'cluster.orchestration-proposals': {
    title: 'Proposal list',
    body: (
      <p>
        Shows durable orchestration proposals for this cluster: source member,
        model metadata, status, rationale, and proposed item count. Pick a card
        to inspect or edit individual items before accepting.
      </p>
    ),
    manualSection: 'cluster-orchestration-assist',
  },
  'cluster.orchestration-proposal': {
    title: 'Proposal preview',
    body: (
      <>
        <p>
          Review surface for one model-drafted proposal. Each item has a
          checkbox plus editable title/body fields. Accept sends only the
          selected item ids and edits; the backend applies accepted work through
          ordinary task-kernel mutations.
        </p>
        <p>
          Suggested provider/model/effort values are metadata until selected
          and accepted. Rejecting this preview does not touch the ledger.
        </p>
      </>
    ),
    manualSection: 'cluster-orchestration-assist',
  },
  'cluster.board-card': {
    title: 'Board task card',
    body: (
      <p>
        Click a task card to open the task drawer. The board keeps rendering
        from the ledger snapshot immediately, then reads full details through{' '}
        <C>cluster_task_show</C> so comments, runs, and dependency edges are
        current. A short drag (past a 4px threshold, or a brief press on touch)
        instead picks the card up to move it between columns.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.task-drawer': {
    title: 'Task drawer',
    body: (
      <p>
        Detail panel for the selected board card. Shows overview fields, links,
        dependency parents/children, the durable comment thread, recovery
        controls, and run records with heartbeat age/stale status when workers
        have emitted heartbeats. Terminal statuses remain operator-only, and
        the drawer's status controls use the same ledger update path as the
        standalone LEDGER tab.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.task-status': {
    title: 'Operator task status',
    body: (
      <p>
        Operator-only status controls for the selected board task. Workers and
        directors can complete work into <C>REVIEW</C>, but only this explicit
        operator path can move a task to <C>DONE</C> or <C>ARCHIVED</C>.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.task-recovery': {
    title: 'Task recovery controls',
    body: (
      <p>
        Operator recovery surface for assignment and stale-run handling.
        Reassign changes only the task assignee through the normal ledger
        update path. Reclaim / terminate target one selected open run when the
        server-side callbacks are available; neither action marks the task
        done.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.task-run-row': {
    title: 'Task run row',
    body: (
      <p>
        Each run shows owner, status, session/worker ids, last heartbeat, and a
        live heartbeat age. Open runs turn <C>STALE</C> after five minutes
        without a heartbeat. Reclaim and terminate buttons operate on exactly
        this run id when the recovery handlers are wired.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.plan-tab.attach-from-banner': {
    title: 'ATTACH TO CLUSTER',
    body: (
      <p>
        Saves the worker-drafted plan to disk and routes the body up to the
        cluster's shared PLAN slot (every member sees it on its next turn).
        Only shown when this workflow is a cluster member; standalone tabs
        only see SAVE &amp; ATTACH / DISCARD.
      </p>
    ),
    manualSection: 'cluster-attach-from-banner',
  },
  'cluster.plan-tab.edit': {
    title: 'EDIT cluster plan',
    body: (
      <p>
        Flip to textarea mode to edit the cluster plan body. VIEW renders the
        markdown — H1/H2/H3 headings, checkboxes you can click to toggle
        without entering edit mode, and per-phase action pills. When the board
        is attached, each unchecked plan item also gets a <C>→ TASK</C> pill
        that promotes it into a durable board task. Empty body opens in EDIT
        automatically.
      </p>
    ),
    manualSection: 'cluster-plan',
  },
  'cluster.plan-tab.clear': {
    title: 'CLEAR cluster plan',
    body: (
      <p>
        Wipes the cluster plan. Members lose the plan system block on their
        next turn; in-flight turns aren't torn down. Confirms before firing.
      </p>
    ),
    manualSection: 'cluster-plan',
  },
  'cluster.plan-tab.review-plan': {
    title: 'REVIEW cluster plan',
    body: (
      <p>
        Critique the shared cluster plan body directly. Pops a member picker
        first because a review still needs a workflow to run on; the content
        being reviewed is the cluster plan, not that member&apos;s private
        plan file.
      </p>
    ),
    manualSection: 'cluster-plan-reviews',
  },
  'cluster.plan-tab.verify-work': {
    title: 'VERIFY cluster work',
    body: (
      <p>
        Same target as REVIEW PLAN, but mode = VERIFY and INCLUDE GIT DIFF is
        pre-ticked. Useful after the shared plan claims work is done — the
        reviewer cross-checks checked items against the real tree and diff.
      </p>
    ),
    manualSection: 'cluster-plan-reviews',
  },
  'cluster.plan-tab.custom-review': {
    title: 'CUSTOM REVIEW',
    body: (
      <p>
        Free-form review prompt. Member picker first; the dialog opens
        without a plan ref so you can pick any scope (last turn, current
        session, full transcript, git diff only).
      </p>
    ),
    manualSection: 'cluster-plan',
  },
  'cluster.plan-tab.save-as-plan': {
    title: 'SAVE AS PLAN',
    body: (
      <p>
        Persists the current cluster plan body to a fresh
        <C> .arco/plans/&lt;id&gt;.md</C> file. After saving, the plan shows
        up in other clusters / workflows in the same cwd and can be imported
        via the cluster PLAN tab&apos;s EXISTING PLANS list (or attached
        directly from a worker&apos;s PLAN tab). One-time snapshot — later
        edits to the cluster plan don&apos;t sync into the file.
      </p>
    ),
    manualSection: 'cluster-plan',
  },
  'cluster.plan-tab.import-existing': {
    title: 'Import existing plan',
    body: (
      <p>
        Copies a plan body from <C>.arco/plans/</C> into this cluster&apos;s
        shared plan via <C>cluster_plan_set</C>. One-way copy — subsequent
        cluster edits won&apos;t flow back to the source <C>.md</C> file. Use
        SAVE AS PLAN later if you want to round-trip the result.
      </p>
    ),
    manualSection: 'cluster-plan',
  },
  'cluster.plan-tab.member-picker': {
    title: 'Pick a member to anchor',
    body: (
      <p>
        Cluster-plan reviews and verifies need a target workflow. Pick the
        member whose attached plan + transcript the reviewer should
        cross-check. Esc / backdrop click cancels.
      </p>
    ),
    manualSection: 'cluster-plan',
  },
  'cluster.right-panel-splitter': {
    title: 'Cluster right panel splitter',
    body: (
      <p>
        4 px col-resize splitter between the cluster member trio (grid +
        detail) and the right panel (Members / Mailbox / Plan / Activity /
        Reviews). Position persists per-browser to{' '}
        <C>arco.clusterRightPanelWidth</C> in localStorage; range{' '}
        <C>0.18 – 0.5</C>.
      </p>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.mailbox': {
    title: 'MAILBOX sub-tab',
    body: (
      <p>
        Per-member inbox depth. Backed by a budgeted file-per-message store at{' '}
        <C>~/.arco/clusters/&lt;id&gt;/mailbox/&lt;wfid&gt;/</C>. Drains
        destroy the files; the durable record lives in each member's{' '}
        <C>events.jsonl</C>.
      </p>
    ),
    manualSection: 'cluster-peer-messaging',
  },
  'cluster.right-panel.github': {
    title: 'GITHUB sub-tab (cluster-scoped)',
    body: (
      <p>
        The GitHub browser opened against the cluster's shared{' '}
        <C>cwd</C> — same surface as the workflow-scoped GITHUB tab, but a
        cluster has exactly one cwd by construction so this is naturally
        cluster-wide. Browse the repo, view PRs / issues / Actions, jump to
        files. Auth shared with the header GitHub view (<C>gh auth</C>).
      </p>
    ),
    manualSection: 'cluster-cwd-tabs',
  },
  'cluster.right-panel.files': {
    title: 'FILES sub-tab (cluster-scoped)',
    body: (
      <p>
        File explorer rooted at the cluster's <C>cwd</C>. Honors{' '}
        <C>.gitignore</C>; click to open in the viewer modal. The
        codebase-memory / sandbox sub-tabs from the per-worker FILES tab are
        per-worker configuration and don't apply to clusters — those still
        live on each member's own tab.
      </p>
    ),
    manualSection: 'cluster-cwd-tabs',
  },
  'cluster.right-panel.history': {
    title: 'HISTORY sub-tab (anchor member)',
    body: (
      <>
        <p>
          Read-only timeline of seq-stamped narrative events. HISTORY is
          intrinsically per-workflow (events live on each member's{' '}
          <C>events.jsonl</C>), so this sub-tab is pinned to the cluster's{' '}
          <strong>anchor member</strong> — the first member, same one SPAWN
          PHASE inherits from. To scrub another member's history, focus that
          member's individual tab and use its HISTORY tab.
        </p>
        <p>
          Empty cluster (no members yet) shows a placeholder; add a worker
          from the MEMBERS tab to populate.
        </p>
      </>
    ),
    manualSection: 'cluster-cwd-tabs',
  },
  'cluster.right-panel.preview': {
    title: 'PREVIEW sub-tab (anchor member)',
    body: (
      <>
        <p>
          Live iframe of a dev server. Like HISTORY, PREVIEW is intrinsically
          per-workflow (port bindings live in each member's <C>meta.json</C>),
          so this sub-tab is pinned to the cluster's <strong>anchor
          member</strong>. Binding a port here binds it on the anchor; the
          iframe loads <C>/api/preview/&lt;anchor-wfid&gt;/</C>.
        </p>
        <p>
          Most clusters only need one dev server total — the team is working
          one cwd — so this matches the natural workflow. If multiple members
          run dev servers, use each member's own PREVIEW tab.
        </p>
      </>
    ),
    manualSection: 'cluster-cwd-tabs',
  },
  'cluster.activity': {
    title: 'ACTIVITY sub-tab',
    body: (
      <>
        <p>
          One unified feed for the whole cluster. Interleaves peer messages,
          role/plan/member-set audit events, idle-nudger toasts, and{' '}
          <strong>per-member tool calls</strong> (<C>READ</C>, <C>BASH</C>,{' '}
          <C>TodoWrite</C>, etc.) sourced from each member&apos;s live
          <C>activity[]</C> buffer.
        </p>
        <p>
          Each row leads with a colour-tagged member-name chip + role chip;
          ≥3 identical tools from one member within 30s collapse to a{' '}
          <C>TOOL × N</C> row that click-expands.
        </p>
        <p>
          When you are already near the bottom, new rows keep the feed pinned
          to the latest activity. Scroll up to inspect history and the feed
          stops auto-following until you return to the bottom.
        </p>
      </>
    ),
    manualSection: 'cluster-activity',
  },
  'cluster.activity.pill': {
    title: 'ACTIVITY filter pill',
    body: (
      <>
        <p>
          <C>ALL</C> shows every event from every member. Click a member
          pill to filter to only that member&apos;s tool activity plus
          cluster events involving them (peer-sent <em>from</em>, peer-
          received <em>to</em>, role-set <em>on</em>, nudges{' '}
          <em>about</em>).
        </p>
        <p>
          The coloured dot left of each member name is the same stable
          per-member colour used for that member&apos;s leading chip in the
          feed — pill ↔ row mapping is glanceable.
        </p>
      </>
    ),
    manualSection: 'cluster-activity',
  },
  'cluster.nudger': {
    title: 'Idle nudger',
    body: (
      <>
        <p>
          Operator-armed (default OFF). Toasts when a member has been idle
          ≥10s with ≥1 pending peer message. Capped at 3 toasts per operator
          turn per member.
        </p>
        <p>
          <strong>Toast-only</strong> — never sends prompts to workers, never
          mutates member state.
        </p>
      </>
    ),
    manualSection: 'cluster-nudger',
  },
  'cluster.project-trust': {
    title: 'Project trust (cluster cwd)',
    body: (
      <>
        <p>
          Whether this cluster&apos;s repo may fold its own <C>CLAUDE.md</C>,
          project skills, and <C>.arco/settings.json</C> into member turns.
          Untrusted repos have those suppressed so a cloned repo can&apos;t
          inject instructions into your agents. Every member shares the
          cluster&apos;s cwd, so one click covers all of them.
        </p>
        <p>
          The chip only appears when the repo actually ships one of those
          surfaces. The gate&apos;s one-time prompt lands in whichever
          member&apos;s composer hit it first — this chip is how you grant or
          revoke trust when you never saw it. Takes effect on each member&apos;s
          next turn.
        </p>
      </>
    ),
  },
  'cluster.efficiency': {
    title: 'Efficiency level',
    body: (
      <>
        <p>
          One per-cluster knob that dials how thorough vs. lean the whole
          cluster behaves — how large members chunk work, how much they
          re-review each other, and how chatty the peer mailbox is.
        </p>
        <p>
          <C>THOROUGH</C> (default) = today's behaviour: full cross-review,
          generous peer messaging. <C>BALANCED</C> = substantial chunks,
          review only on signal, trimmed messaging. <C>LEAN</C> = max chunks,
          no unprompted review, terse end-of-task reports.
        </p>
        <p>
          Each level is a deterministic bundle: a restraint <em>doctrine</em>{' '}
          injected into every member's system prompt, a smaller peer-send{' '}
          <em>budget</em> (15 → 8 → 4 sends/turn), and a softer pre-turn
          mailbox notice. <C>NOTE</C> adds a cluster-specific line appended to
          the canned doctrine. Takes effect on each member's next turn;
          reversible by flipping back to THOROUGH.
        </p>
      </>
    ),
    manualSection: 'cluster-efficiency',
  },
  'cluster.progress': {
    title: 'KEEP CURRENT (progress tracking)',
    body: (
      <>
        <p>
          One per-cluster knob picking which standing surface(s) members are
          instructed to keep current as work advances: <C>PLAN</C> (tick the
          shared plan checkboxes via <C>cluster_plan_tick</C>), <C>BOARD</C>{' '}
          (move task-board statuses as work moves), or <C>BOTH</C> (default —
          keep the plan and the board in sync, with a reconciliation clause).
        </p>
        <p>
          Server-owned deterministic doctrine (<C>clusterProgress.ts</C>)
          injected into every member's system prompt, gated on whether the
          surface actually exists (no dangling plan clause on a plan-less
          cluster, no board clause when the board is <C>NONE</C>). Takes effect
          on each member's next turn; reversible by flipping the chip.
        </p>
      </>
    ),
    manualSection: 'cluster-efficiency',
  },
  // ------------------------------------------ CLUSTER RIGHT-PANEL GROUPS + TABS
  // Group row (`cluster.right-panel.group.<id>`) and the three tabs whose wide
  // buttons fall through to `cluster.right-panel.tab.<id>`. The narrow-width
  // <select> uses `cluster.right-panel.tab.<active>` for every tab — aliases for
  // the rest are assembled below the registry.
  'cluster.right-panel.group.workspace': {
    title: 'WORKSPACE group',
    body: <p><C>MEMBERS</C> (roster, roles, add/replace workers) and <C>FILES</C> (explorer + live / changes / source / remote for the shared cwd). Click a group to jump to its first tab.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.group.agent': {
    title: 'AGENT group',
    body: <p>What the members are doing and the coordination surfaces: <C>ACTIVITY</C>, <C>REVIEWS</C>, <C>HANDOFFS</C>, <C>PLAN</C>, <C>BOARD</C>, <C>MAILBOX</C>.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.group.memory': {
    title: 'MEMORY group',
    body: <p><C>HISTORY</C> — the event scrub, sourced from the cluster&apos;s first (anchor) member.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.group.runtime': {
    title: 'RUNTIME group',
    body: <p><C>PREVIEW</C> (dev-server viewport), <C>CONFIG</C> (per-member settings), <C>GITHUB</C>.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.tab.reviews': {
    title: 'REVIEWS',
    body: <p>Every member&apos;s Reviews merged into one feed, newest first — reviewer, verdict (<C>PASS</C> / <C>MINOR</C> / <C>BLOCKING</C>) and the member it ran against. Click a row to expand the full artifact; a running review can be cancelled here. Each member&apos;s own REVIEW tab is unchanged.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.tab.handoffs': {
    title: 'HANDOFFS',
    body: <p>Handoffs from every workflow in the cluster&apos;s cwd (members, plus other same-cwd tabs labelled as such), with cancel and clear-stale-lock actions for the per-cwd handoff lock.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.tab.config': {
    title: 'CONFIG',
    body: <p>The normal per-workflow CONFIG pane, scoped to one member picked from the <C>MEMBER</C> dropdown. Edits apply to that member only (model, effort, transport, output style, north star, …); cluster-wide knobs such as efficiency and board mode live in the cluster header.</p>,
    manualSection: 'cluster-tab',
  },
};

// Narrow-width <select> keys every tab as `cluster.right-panel.tab.<id>`; the
// wide buttons use the bespoke keys above. Alias so both resolve.
for (const [tab, key] of [
  ['members', 'cluster.right-panel.members'],
  ['files', 'cluster.right-panel.files'],
  ['activity', 'cluster.activity'],
  ['plan', 'cluster.plan-tab'],
  ['board', 'cluster.board-tab'],
  ['mailbox', 'cluster.mailbox'],
  ['history', 'cluster.right-panel.history'],
  ['preview', 'cluster.right-panel.preview'],
  ['github', 'cluster.right-panel.github'],
] as const) {
  clusterHelp[`cluster.right-panel.tab.${tab}`] = clusterHelp[key];
}

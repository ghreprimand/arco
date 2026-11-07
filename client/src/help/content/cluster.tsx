import { C } from './shared';
import type { HelpEntry } from './shared';

export const clusterHelp: Record<string, HelpEntry> = {
  // ----------------------------------------------------- CLUSTERS
  'cluster.tab': {
    title: 'Cluster tab',
    body: (
      <>
        <p>A cluster is a team of workers sharing one project folder. Member cards on the left show each worker at a glance, the focused member&apos;s chat sits beside them, and the right panel holds the shared tools: members, files, activity, reviews, handoffs, plan, board, mail, history, preview, settings and GitHub.</p>
        <p>Start a cluster from New work or from a tab&apos;s right-click menu. The same menu offers <C>ADD TO EXISTING</C> to bring an open tab into a cluster that already uses its folder.</p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.remote': {
    title: 'Share cluster remotely',
    body: (
      <>
        <p>Shares the <strong>whole cluster</strong> with the phone console while the management hub is connected. Every member becomes visible and controllable there, grouped under one cluster card with its mail, plan and board. <strong>Off by default.</strong> Console refresh keeps unsent broadcasts, recipient choices and question answers. A completed chat send preserves newer text.</p>
        <p>While the cluster is shared, each member&apos;s own <C>REMOTE</C> chip is ignored: this switch is the only control. Changes reach the phone at once.</p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.remote-gates': {
    title: 'Remote gate approvals',
    body: (
      <>
        <p>A second switch on top of cluster sharing. When on, review gates waiting on <strong>any member</strong> can be approved or rejected from the phone console. One switch covers every member. <strong>Off by default</strong>, so sharing a conversation never grants approval power.</p>
        <p>With it off, waiting gates still appear on the phone as read-only. A remote approval runs the proposed action as it stands; editing its arguments stays a desktop action.</p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.saved-snapshots': {
    title: 'Saved clusters',
    body: (
      <>
        <p>Saved copies of a cluster: its settings, plan and each member&apos;s conversation history. Restoring always creates a new cluster with new ids, and you choose how many recent turns each worker brings back.</p>
        <p><C>LOCAL</C> lists snapshots on this computer, with <C>IMPORT FILE</C> and a <C>FILE</C> download on each row. <C>CLOUD</C> lists encrypted copies on the management hub and appears only while the hub is connected.</p>
        <p>Saving with a name that already exists asks before replacing. The old copy stays untouched unless you confirm and the new one saves completely.</p>
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
        <p><C>FILE</C> downloads the snapshot as one checked <C>.arcocluster</C> bundle. <C>IMPORT FILE</C> checks the whole bundle before adding it to the local list; a damaged or unsafe bundle is refused and nothing partial is saved.</p>
        <p>The bundle holds conversation history, which may include sensitive text. It never holds provider sign-ins or tokens.</p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.snapshot-cloud': {
    title: 'Encrypted cluster cloud',
    body: (
      <>
        <p><C>SAVE CLOUD</C> and the <C>CLOUD</C> button on a local row encrypt the snapshot on this computer, then upload only the sealed copy to the management hub. Cloud controls appear only while the hub is connected. Saving and restoring are always manual. Replacement keeps the previous readable cloud copy until the new entry is published successfully.</p>
        <p>Every computer that restores a cloud snapshot needs the same vault key. The key stays on each computer and is never uploaded; use <C>COPY VAULT KEY</C> and <C>SET VAULT KEY</C> to share it. A cloud save with an existing name asks before replacing that entry instead of adding a duplicate.</p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.snapshot-local': {
    title: 'Local snapshots',
    body: <p>Shows the snapshots saved on this computer. <C>IMPORT FILE</C> adds one from an <C>.arcocluster</C> bundle, and the <C>FILE</C> button on each row downloads one.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.snapshot-vault-key': {
    title: 'Vault key',
    body: (
      <>
        <p>The key that encrypts cloud snapshots. <C>COPY VAULT KEY</C> copies this computer&apos;s key to the clipboard. <C>SET VAULT KEY</C> pastes in a key copied from another computer, after a confirmation, so both computers can open the same cloud snapshots.</p>
        <p>Replacing the key means cloud snapshots sealed with the old key can no longer be opened here. The key is never uploaded.</p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.snapshot-restore': {
    title: 'Restore snapshot',
    body: (
      <>
        <p><C>RESTORE</C> on a row opens its restore options; the same button, now <C>CANCEL</C>, closes them. <C>TURNS / WORKER</C> sets how many recent turns each worker brings back (25 by default), and <C>ALL</C> brings back the full history.</p>
        <p>The second <C>RESTORE</C> creates a new cluster with new ids and opens it as a tab. The cluster the snapshot came from is not changed.</p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.snapshot-delete': {
    title: 'Delete snapshot',
    body: <p>Deletes this saved snapshot after a confirmation. Live clusters, and a local copy of a cloud snapshot, are not affected.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.grid': {
    title: 'Member grid',
    body: <p>One card per member. <C>LAYOUT</C> starts on <C>ROWS</C>; <C>AUTO</C> and <C>GRID</C> use a balanced grid and <C>COLS</C> puts cards side by side. The choice is remembered in this browser. Click a card to focus that member: its chat and message box take over the detail pane.</p>,
    manualSection: 'cluster-grid',
  },
  'cluster.splitter': {
    title: 'Grid and detail divider',
    body: <p>Drag to share the width between the member cards and the focused member&apos;s chat. The position is remembered in this browser.</p>,
    manualSection: 'cluster-grid',
  },
  'cluster.member-card': {
    title: 'Member card',
    body: <p>One member at a glance: status light, name, idle or busy, short id, role, waiting mail, and the latest reply (or live activity while busy). Click to focus that member. In Compact and Narrow layouts the card is one row with a one-line reply and the short id in its tooltip (Settings, Layout).</p>,
    manualSection: 'cluster-grid',
  },
  'cluster.member-mail': {
    title: 'Waiting mail',
    body: (
      <p>
        The number of messages waiting for this member. They are delivered at
        its next turn. While the member is busy the mark is muted. When the
        member is idle with mail it is highlighted like a question, counts the
        tab as Needs you, and clicking it nudges that member. After a nudge the
        mark reads Nudged until the member starts its turn. It makes no
        sound and shows no pop-up.
      </p>
    ),
    manualSection: 'cluster-grid',
  },
  'cluster.member-question': {
    title: 'Waiting question',
    body: <p>This member is waiting for an answer to a structured question. Select the card to open the question. Options containing pipes or backslashes remain one complete answer.</p>,
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
  'cluster.recipients': {
    title: 'TO: recipients',
    body: (
      <p>
        Who your next message goes to. It starts as the member in view. Click
        to choose one or several members (<C>EVERYONE</C> selects all). Idle
        members start a fresh turn; busy members receive it as a follow-up.
        A message to one member preserves picked skills, steering intent and composer actions. Computer opens this chooser with the current selection. For several members, the toast reads <em>X of N members</em> to confirm scope. After a
        successful message the chip returns to the member in view. If disconnected, the draft, attachments and recipient selection remain for retry.
      </p>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.member-new-reply': {
    title: 'New reply',
    body: <p>The director finished a reply you have not looked at. It clears when you open the director. Arco never switches focus for you.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.nudge.all': {
    title: 'NUDGE ALL WITH MAIL',
    body: (
      <>
        <p>Nudges every member that has waiting mail, without ticking them. The number is how many members have mail. It works like SEND NUDGE with exactly those members picked: idle members start a turn with the wake-up prompt; busy members get the gentler reminder to read their mail at a convenient point, or after the current turn on providers without mid-turn steering. Members without mail are never nudged.</p>
        <p>Unavailable when no member has mail; the reason shows under the list. The command palette offers the same action as Cluster: nudge all with mail while a cluster tab is open.</p>
      </>
    ),
    manualSection: 'cluster-nudge-button',
  },
  'cluster.broadcast.nudge': {
    title: 'Nudge button',
    body: (
      <>
        <p>
          NUDGE sits beside the send area of the cluster message box and shows the total of waiting mail (for example <C>NUDGE 2</C>), highlighted while any member has mail. After a nudge it reads <C>NUDGED 1</C> (the number of members nudged) until they start their turn, or for two minutes. It opens the NUDGE modal: a per-member checkbox list with each
          member&apos;s role chip, mailbox depth (e.g. <C>3 MAIL</C>),
          and a BUSY badge when applicable. Default selection is{' '}
          <strong>empty</strong>; you pick recipients explicitly. SEND
          NUDGE sends a mailbox reminder through each member&apos;s normal
          chat path. Idle members start a turn. Active members receive a
          gentler reminder to check their mail when they reach a convenient
          point in their current work, using the existing steering path.
          Providers without mid-turn steering receive it after the current
          turn. Members read pending messages with <C>peer_read</C>; sending
          a nudge does not drain the mailbox. A toast confirms how many were
          nudged and, when any were busy, how many got the busy reminder.{' '}
          <C>Esc</C> closes without sending.
        </p>
        <p>
          <C>NUDGE ALL WITH MAIL (n)</C> in the modal nudges every member
          with waiting mail at once, idle or busy, the same as ticking them
          all and pressing SEND NUDGE (same toast). The command palette has it as
          Cluster: nudge all with mail.
        </p>
        <p>
          Distinct from the <C>TO:</C> chooser in the same message box:
          that sends your typed message to the members you pick;
          NUDGE fires a canned reminder. Use NUDGE when the director has
          handed out work via <C>peer_send</C> and you just want the
          builders to wake up. Use the TO: chooser when you have something
          to type for more than one member.
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
          one or more recipients (checkbox list of other members), an optional
          note placed above the text, and a scope:{' '}
          <C>Last turn</C> (default) / <C>Last N turns</C> /{' '}
          <C>Full transcript</C>.
        </p>
        <p>
          <strong>32 KB cap</strong> (twice the 16 KB model-driven{' '}
          <C>peer_send</C> limit). Slicer drops rendering noise
          (context dividers, tool pills, single-line metadata system
          pills) but keeps substantive multi-line content like inlined
          review bodies. Server bypasses budget + dedupe: operator
          intent is explicit. Recipient sees a normal{' '}
          <C>peer_message_sent</C> on your channel.
        </p>
        <p>
          Include switches choose <C>Operator messages</C>,{' '}
          <C>Agent replies</C> and <C>Mail lines</C>. The chat keeps only a
          shortened copy of mail this member sent, so those copies are left
          out unless you tick <C>Shortened copies of mail sent</C>. With
          several recipients the same text is delivered once to each.
        </p>
        <p>
          Typical use: forward reviewer findings to a director after a
          cluster-routed review lands in the reviewer&apos;s chat.
        </p>
      </>
    ),
    manualSection: 'cluster-transcript-send',
  },
  'chat.message-selection': {
    title: 'Selected messages',
    body: (
      <p>
        Messages ticked with the small box beside them. <C>FORWARD</C> sends
        them to other cluster members (cluster tabs only); <C>CLEAR</C> drops
        the selection. Nothing is sent until you press SEND in the dialog.
      </p>
    ),
    manualSection: 'cluster-transcript-send',
  },
  'chat.forward': {
    title: 'Forward messages',
    body: (
      <p>
        Send the selected messages to one or more cluster members, with an
        optional note above them. The text counts against the 32 KB cap;
        it is delivered once per recipient as a normal peer message from this
        member and is outside the model message guard.
      </p>
    ),
    manualSection: 'cluster-transcript-send',
  },
  'cluster.mailbox-modal': {
    title: 'Pending mail',
    body: (
      <>
        <p>Lists the messages waiting for one member, with sender, time and text. Each row also shows whether that member is mid-turn, its current board task, and its latest reply to the sender. <C>CANCEL</C> on a row discards that message before delivery; the member never sees it.</p>
        <p>Only undelivered mail appears here. Once the member reads its mail, the messages leave this list and stay in both members&apos; history. When a board is attached, the <C>TASK</C> button on a row turns that message into a new to-do task.</p>
        <p>Unreadable mail or failed attachment writes leave the pending batch available for retry. Attachments with matching names remain separate, and existing delivered files are preserved. Malformed records or attachment metadata are preserved aside and logged once, allowing valid mail to continue.</p>
      </>
    ),
    manualSection: 'cluster-mailbox-modal',
  },
  'cluster.auto-turn': {
    title: 'AUTO-PICKUP',
    body: (
      <>
        <p>Chooses whether idle members start a turn on their own when mail arrives. The chip shows the current mode; click it to change it. <strong>Off</strong> is the default, and clusters armed before the modes existed are Rule-based.</p>
        <p><strong>Rule-based (recommended)</strong> wakes an idle member for mail that asks for something and leaves plain acknowledgements waiting. Limits stop two members waking each other back and forth and cap wakes per member and per arming. <C>RESUME</C> starts a fresh allowance.</p>
        <p><strong>Smart</strong> modes ask a model you choose whether to wake the member, wait, or ask you. <strong>Observe-only</strong> only records the answers. <strong>Automatic</strong> may start the member&apos;s normal turn, but only after Arco checks again that the member is idle, the mail is unchanged and every limit allows it. <C>STOP</C> on a member holds its current mail until new mail arrives. A Smart session ends at its time limit, or after a restart when its limit record cannot be read, and must then be armed again.</p>
        <p><strong>Distinct from MAIL ALERTS and NUDGE.</strong> MAIL ALERTS only notify you; NUDGE wakes members you pick by hand.</p>
      </>
    ),
    manualSection: 'cluster-auto-pickup',
  },
  'cluster.right-panel.members': {
    title: 'MEMBERS',
    body: <p>The roster for this cluster. At the top, rename the cluster or save its state. Below that, add fresh or existing workers. Each member row can rename, replace or detach that member and set its role, work size and focus. Saved snapshots are listed at the bottom.</p>,
    manualSection: 'cluster-rename',
  },
  'cluster.rename': {
    title: 'Rename cluster',
    body: <p>Sets the name shown on this cluster&apos;s tab. <C>Enter</C> or <C>SAVE</C> keeps it; <C>Esc</C> or <C>CANCEL</C> discards the edit. Saving an empty name goes back to the default: the project folder name plus a short id. Names are up to 64 characters.</p>,
    manualSection: 'cluster-rename',
  },
  'cluster.save-state': {
    title: 'Save state',
    body: (
      <>
        <p>Saves this whole cluster as a named snapshot: its settings, members and every member&apos;s conversation history. Type a name, then <C>SAVE LOCAL</C> to keep it on this computer or <C>SAVE CLOUD</C> (while the hub is connected) to store an encrypted copy there. <C>Enter</C> saves locally; <C>Esc</C> or <C>CANCEL</C> closes without saving.</p>
        <p>Restore it later from SAVED CLUSTERS at the bottom of this tab. Restoring creates a new cluster and never reopens this one. Saving needs at least one member.</p>
      </>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.add-fresh': {
    title: 'ADD FRESH',
    body: <p>Creates one or more new workers in this cluster&apos;s project folder. Opens choices for access, provider, model, effort, account, name, role, work size, focus, fast mode, tool filter, output style, auto-compaction and count. Provider, model, effort and the tab settings start from the cluster&apos;s first member; name, role, work size, focus and auto-compaction start empty.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.spawn': {
    title: 'SPAWN',
    body: <p>Creates the new workers with the choices above. It is unavailable while a changed provider has no model selected, or when DIRECTOR is picked but the cluster already has a director or more than one worker is being created.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.add-existing': {
    title: 'ADD EXISTING',
    body: <p>Brings an open tab into this cluster. Only tabs in the same project folder that are not already in a cluster and use Claude, Codex, Ollama or llama.cpp are listed; the count shows how many qualify. The tab keeps its session and history and gains cluster mail, plan and role context. Cursor workers can join only as fresh workers. Unavailable when nothing qualifies.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.add-existing-pick': {
    title: 'Choose a tab to add',
    body: <p>Each row is an open tab that can join. Click one to add it to this cluster right away; the list then closes.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.fresh.count': {
    title: 'How many',
    body: <p>How many identical workers to create at once, from 1 to 4. Every choice above applies to all of them.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.fresh.name': {
    title: 'FRESH spawn - name',
    body: (
      <p>
        Optional name for the new worker. One worker uses it exactly as typed;
        several receive numbered suffixes after the highest existing number for that name.
        Left empty, the name
        comes from the chosen role (for example <C>Builder #1</C>) or{' '}
        <C>Worker #1</C> when no role is set. Existing members keep their names.
      </p>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.fresh.role': {
    title: 'FRESH spawn - role',
    body: (
      <p>
        Optional role for the new worker: pick a preset or type a custom role,
        the same choices as SET on a member row. Pick the same preset again to
        clear it. A cluster may have at most one director, so DIRECTOR is
        unavailable when one exists or when more than one worker is spawned; the
        server refuses such a request before spawning anything.
      </p>
    ),
    manualSection: 'cluster-tab',
  },
  'cluster.fresh.provider': {
    title: 'Fresh provider',
    body: <p>Which provider the new workers use: Claude, Codex, Ollama, llama.cpp or Cursor. <C>ISOLATED</C> access needs Claude. The choice starts from the cluster&apos;s first member when that provider is offered, otherwise Claude, and changing it resets the model. CREATE WITH FRESH in the tab menu offers Claude and Codex.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.fresh.model': {
    title: 'Fresh model',
    body: <p>Which model the new workers run. The list is the provider&apos;s current catalog, or the installed models for Ollama and llama.cpp; until the catalog loads it falls back to the first member&apos;s model. Settings the dialog does not show follow the first member. An empty model, a model of another provider or one the catalog does not list is refused. For Cursor the choice splits into model family and effort, with optional FAST and THINK, because Cursor builds effort into the model name.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.fresh.effort': {
    title: 'Fresh effort',
    body: <p>How much reasoning the new workers use. Only levels the chosen model supports are offered, and changing the model moves an unsupported choice to a supported one. ADD FRESH starts no higher than HIGH; higher levels can be picked when the model offers them. The tab menu starts from the first member&apos;s effort when supported.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.fresh.account': {
    title: 'Fresh account',
    body: <p>Which Codex account the new workers use. Shown for Codex when accounts are set up in Settings; the model list follows the chosen account. An account that is no longer set up is refused rather than replaced by another.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.fresh.access': {
    title: 'Fresh access',
    body: (
      <>
        <p>Chooses what the new worker may see, before it is created. <C>STANDARD</C> gets the usual project and cluster context. <C>BLIND</C> can read the project but gets no plan, board, roster, role, focus or coordination settings; it can only send and read mail.</p>
        <p><C>ISOLATED</C> needs Claude. It works in its own private folder outside the project and cannot read project files, project instructions, knowledge or attachments, and has no shell, hooks or extra tool servers. It talks to the cluster only by mail and can attach small files from its folder to a message.</p>
      </>
    ),
    manualSection: 'cluster-member-replacement',
  },
  'cluster.member-access': {
    title: 'Member access',
    body: <p>Shown when a member has limited access. <C>BLIND</C> can read the project but sees no cluster coordination context. <C>ISOLATED</C> is a Claude worker in a private folder with no project access; it talks to the cluster only by mail.</p>,
    manualSection: 'cluster-member-replacement',
  },
  'cluster.member-replace': {
    title: 'Replace member',
    body: (
      <>
        <p>Puts a brand-new worker into this member&apos;s slot in the roster. The dialog starts from this member, and every choice can be changed: provider, model, effort, account, name, role, work size, focus, fast mode, tool filter, output style, auto-compaction and access. Settings the dialog does not show are copied.</p>
        <p>The new worker starts fresh rather than resuming the old session. Bringing over history and open tasks are separate choices. The old worker&apos;s files stay on disk, but it leaves the cluster.</p>
      </>
    ),
    manualSection: 'cluster-member-replacement',
  },
  'cluster.detach': {
    title: 'Detach member',
    body: <p>Removes this member from the cluster after a confirmation. Its conversation history stays on disk. From its next turn it no longer has cluster mail, plan or roster tools.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.replace.name': {
    title: 'Replacement name',
    body: <p>Name of the new worker, starting from the current one. Leave it as it is to keep the name; an empty field also keeps it. Up to 64 characters.</p>,
    manualSection: 'cluster-member-replacement',
  },
  'cluster.replace.role': {
    title: 'Replacement role',
    body: <p>Role of the new worker, starting from the current one: pick a preset, type a custom role, or pick the active preset again to clear it. DIRECTOR is unavailable when another member is the director, and REPLACE is then unavailable while it is chosen.</p>,
    manualSection: 'cluster-member-replacement',
  },
  'cluster.member.tier': {
    title: 'Work size',
    body: <p>A hint for the director about the size of work this member takes: LIGHT for quick edits, STANDARD for normal feature work, HEAVY for large or architectural changes. UNSET gives no hint. It does not change model or effort. REPLACE starts from the current member&apos;s; ADD FRESH starts unset.</p>,
    manualSection: 'cluster-member-replacement',
  },
  'cluster.member.focus': {
    title: 'Focus',
    body: <p>Optional sub-specialty of this member, for example a part of the code it knows best. The director sees it in the member list to tell members with the same role apart. Up to 160 characters; empty clears it.</p>,
    manualSection: 'cluster-member-replacement',
  },
  'cluster.member.fast-mode': {
    title: 'Fast mode',
    body: <p>Runs the Claude worker in fast mode, as the setting of the same name on a tab. Shown for Claude only; other providers start with it off.</p>,
    manualSection: 'cluster-member-replacement',
  },
  'cluster.member.tool-filter': {
    title: 'Tool filter',
    body: <p>Shortens long tool results before the Claude Native worker reads them. OFF keeps them whole; CONSERVATIVE and AGGRESSIVE shorten more. Shown for Claude only; other providers start with it off.</p>,
    manualSection: 'cluster-member-replacement',
  },
  'cluster.member.output-style': {
    title: 'Output style',
    body: <p>How the worker&apos;s replies are written: NORMAL, PLAIN or TERSE. PLAIN is the default and is used when the member has no saved choice. Shown and applied for every provider.</p>,
    manualSection: 'cluster-member-replacement',
  },
  'cluster.member.auto-compaction': {
    title: 'Auto-compaction',
    body: <p>When the worker summarizes older context in place. CLUSTER DEFAULT follows the cluster&apos;s setting, shown in brackets. OFF and ON set the worker&apos;s own policy; ON shows the threshold slider. REPLACE starts from the current member&apos;s policy; ADD FRESH starts with the cluster default. On Claude Native the same threshold (70% under the default) also compacts inside a long turn, which then continues.</p>,
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
        unsupported inherited value. The initial inherited effort is capped at
        HIGH; higher levels can be chosen explicitly when supported.
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
        to the old workflow ID to the replacement workflow ID. This starts ON.
        Turn it OFF
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
    body: <p>Click a member&apos;s name to focus that worker: its chat and controls take over the detail pane. Its status (<C>IDLE</C> or <C>BUSY</C>) and work size sit beside the name. Use PROMOTE or BACK TO CLUSTER to move a member into its own tab and back.</p>,
    manualSection: 'cluster-grid',
  },
  'cluster.right-panel.rename': {
    title: 'Rename member',
    body: <p>Sets this member&apos;s display name. <C>Enter</C> or <C>SAVE</C> keeps it; <C>Esc</C> discards the edit. Saving an empty name goes back to the default short id. Names are up to 64 characters.</p>,
    manualSection: 'cluster-rename',
  },
  'cluster.right-panel.role-set': {
    title: 'Set role',
    body: <p>Opens the role list: DIRECTOR, BUILDER, REVIEWER, RESEARCHER, TESTER and DOCUMENTER, plus CLEAR and CUSTOM. The current role is highlighted. A cluster may have only one director, so director choices are unavailable, with the reason shown, while another member holds that role.</p>,
    manualSection: 'cluster-roles',
  },
  'cluster.right-panel.role-preset': {
    title: 'Role preset',
    body: <p>Makes this preset the member&apos;s role. Other members see it in the roster, and the member follows that role&apos;s instructions from its next turn.</p>,
    manualSection: 'cluster-roles',
  },
  'cluster.right-panel.role-custom': {
    title: 'Custom role',
    body: <p><C>CUSTOM</C> swaps the role for a text box so you can write your own, up to 120 characters. <C>Enter</C> or <C>SAVE</C> keeps it; <C>Esc</C> discards. The row then shows the text and the button changes to EDIT.</p>,
    manualSection: 'cluster-roles',
  },
  'cluster.right-panel.role-clear': {
    title: 'Clear role',
    body: <p>Removes the member&apos;s role. From its next turn the member works without role instructions.</p>,
    manualSection: 'cluster-roles',
  },
  'cluster.right-panel.role-edit': {
    title: 'Edit role',
    body: <p>The same list as SET, shown once a role is set. The current preset is highlighted; CUSTOM reopens the text box with the current wording.</p>,
    manualSection: 'cluster-roles',
  },
  'cluster.right-panel.tier-pill': {
    title: 'Work size for the director',
    body: (
      <>
        <p>A hint for the director about how big a task suits this member: <C>LIGHT</C> for quick edits and simple commands, <C>STANDARD</C> for normal feature work, <C>HEAVY</C> for large or architectural changes. Click the active size again to clear it.</p>
        <p>It guides how the director hands out work, most when several members could take the same task. It does not change the member&apos;s model or effort.</p>
      </>
    ),
    manualSection: 'cluster-tiers',
  },
  'cluster.right-panel.tier-unset': {
    title: 'Clear work size',
    body: <p>Clears the work size, meaning no preference. The director then chooses by role and name.</p>,
    manualSection: 'cluster-tiers',
  },
  'cluster.right-panel.tier-badge': {
    title: 'Work-size badge',
    body: <p>Shows this member&apos;s work size. The director sees it when handing out work.</p>,
    manualSection: 'cluster-tiers',
  },
  'cluster.right-panel.focus-display': {
    title: 'Member focus',
    body: <p>An optional specialty for this member, such as <em>React frontend</em>. Role says what kind of work a member does; focus says what this particular member knows best. The director sees it when choosing between members with the same role. It is only a label and does not route work by itself. Click to edit.</p>,
    manualSection: 'cluster-focus',
  },
  'cluster.right-panel.focus-input': {
    title: 'Edit member focus',
    body: <p>Type the specialty, up to 160 characters. <C>Enter</C> or clicking away saves; <C>Esc</C> discards. Saving an empty box clears it.</p>,
    manualSection: 'cluster-focus',
  },
  'cluster.right-panel.focus-clear': {
    title: 'Clear member focus',
    body: <p>Removes this member&apos;s focus, meaning no preference.</p>,
    manualSection: 'cluster-focus',
  },
  'cluster.plan-tab': {
    title: 'Cluster plan',
    body: (
      <>
        <p>
          The shared plan holds up to <strong>32 KB</strong> and warns at 28 KB.
          Standard members receive it in their turn context; blind and isolated
          members do not. Attach an existing plan or create one here.
         Checkbox changes compare the displayed plan with the saved version; an intervening edit is preserved and a conflict asks for a fresh review. Member ticks match task text against the version being saved.</p>
        <p>
          Edits take effect on the next turn; in-flight turns are not stopped.
          <C>CLEAR PLAN</C> detaches the plan after confirmation and leaves its
          file available in the workspace. Empty saves are rejected.
        </p>
      </>
    ),
    manualSection: 'cluster-plan',
  },
  'cluster.no-plan-hint': {
    title: 'Start a cluster plan',
    body: <p>DRAFT A PLAN asks the idle director for a tool-free draft that you review before attaching. ATTACH EXISTING opens the cluster PLAN tab. NOT NOW hides this hint for this cluster in this browser. Without a director, select Members to set one. Outside the Standard layout the hint is one line; MORE or DRAFT A PLAN opens the public-project choice before drafting, and LESS folds the hint again.</p>,
    manualSection: 'cluster-plan',
  },
  'cluster.board.mode': {
    title: 'Board mode',
    body: (
      <>
        <p>Chooses the task board for this cluster. <C>NONE</C> turns board use off, and members get no board tools. <C>PROJECT</C> uses the project folder&apos;s shared board, the same tasks ordinary tabs in that folder see. <C>CLUSTER</C> gives this cluster its own private board. New clusters start on <C>CLUSTER</C>.</p>
        <p>Changes apply on each member&apos;s next turn and can be switched back. Existing boards are never moved or merged.</p>
      </>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.board-use-project': {
    title: 'Use project board',
    body: <p>Turns the board on using the project folder&apos;s shared board, the same one ordinary tabs in that folder use. Members get board tools on their next turn. Same as <C>PROJECT</C> in the bar at the top of the panel.</p>,
    manualSection: 'cluster-board',
  },
  'cluster.board-create-cluster': {
    title: 'Create cluster board',
    body: <p>Turns the board on with this cluster&apos;s own private board. Members get board tools on their next turn. Same as <C>CLUSTER</C> in the bar at the top of the panel.</p>,
    manualSection: 'cluster-board',
  },
  'cluster.board-automation-toggle': {
    title: 'AUTOMATION header',
    body: (
      <p>
        Collapsed by default so the board reads as &quot;groom tasks,&quot;
        not &quot;run a swarm.&quot; Click to reveal the automation controls:{' '}
        <C>DISPATCH ONCE</C>, <C>CREATE SWARM</C>, and the dispatcher daemon
        row. The task count and this toggle
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
        composer is the honest surface: not a per-column input). Reuses the
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
        Horizontal columns: <C>triage</C> / <C>todo</C> / <C>ready</C> /{' '}
        <C>in_progress</C> / <C>blocked</C> / <C>review</C> / <C>done</C> /{' '}
        <C>archived</C>. Drag a card onto another column to change its status
        through the operator path; a plain click (under a 4px drag threshold)
        opens the card drawer instead. Touch devices drag after a short press.
        Moving a card to <C>done</C> or <C>archived</C> confirms first: those
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
        notes, priority and release (<C>SAVE</C> / <C>RESET</C>), add or remove
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
        <p>A board view of this cluster&apos;s tasks, in columns from triage through to-do, ready, in progress, blocked and review to done and archived. CLUSTER mode uses the cluster&apos;s private board; PROJECT shares the project folder&apos;s board with ordinary tabs, whose LEDGER panel shows the same tasks.</p>
        <p>Members create, claim, update and complete tasks with their board tools, and the board updates live. Click a card to open its details, edit it or delete it; add tasks with the box at the top and drag cards between columns. Workers can move work as far as review. <strong>Only you can mark a task done or archived.</strong></p>
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
  'cluster.needs-you': {
    title: 'Needs you badge',
    body: (
      <>
        <p>
          Counts what only you can move: review tasks with a director sign-off
          (accept them), tasks blocked on a decision from you, and members
          waiting on an answer. It is hidden when the count is zero and sends
          nothing.
        </p>
        <p>
          Click it for the list. Choosing a task opens the BOARD with that task
          selected; choosing a question focuses that member.
        </p>
      </>
    ),
    manualSection: 'cluster-plan-or-board',
  },
  'cluster.board-accept': {
    title: 'ACCEPT',
    body: (
      <p>
        Marks this review task done. It is the same operator action as moving the card
        to the done column, without the drawer, and it is logged like any other
        status change. Workers cannot do this; only you can. <C>RECHECK</C> asks the
        director to verify the task again instead.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.board-accept-all-met': {
    title: 'ACCEPT ALL MET',
    body: (
      <p>
        Accepts every visible review task whose director sign-off reads{' '}
        <C>met</C>, after one confirmation. Tasks with a partial or not-met
        sign-off, or no sign-off yet, stay in review. Older tasks count only while
        the older row is expanded. <C>MARK ALL DONE</C> still accepts everything
        visible in the column.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.board-show-done': {
    title: 'Show done',
    body: (
      <p>
        Done and archived tasks are shown by default so finished work stays in view.
        Turn this off to hide them and show only live work; the choice is remembered.
        The count at the top matches the tasks drawn, and says how many done tasks are hidden.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.board-release-filter': {
    title: 'Release filter',
    body: (
      <p>
        Appears once any task has a release label. Pick a label to show only the
        tasks for that release, NO RELEASE for unlabeled tasks, or ALL RELEASES
        for everything. Labels are set in a card&apos;s drawer or by the director.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.board-release-summary': {
    title: 'Ready to release',
    body: (
      <p>
        For the chosen release: how many tasks are in it, how many you accepted
        (done), and how many are left. It reads READY TO RELEASE when none are
        left. Archived tasks are not counted.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.task-release': {
    title: 'Release label',
    body: (
      <p>
        An optional label such as 0.1.4 that says which release this task
        belongs to. Leave it empty for no label; saving an empty field removes
        the label. RESET restores the saved release and clears that pending edit.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'cluster.board-older-review': {
    title: 'Older review tasks',
    body: (
      <p>
        Review tasks whose director sign-off (or last update, when unsigned) is more
        than 7 days old are folded into this row so recent work stays on top. Click it
        to show or hide them.
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
        cluster's shared PLAN slot (standard members see it on their next turn).
        In a cluster this is the only save choice; standalone tabs see
        SAVE &amp; ATTACH instead. REFINE and DISCARD appear in both.
      </p>
    ),
    manualSection: 'cluster-attach-from-banner',
  },
  'cluster.plan-tab.edit': {
    title: 'EDIT cluster plan',
    body: (
      <p>
        Flip to textarea mode to edit the cluster plan body. VIEW renders the
        markdown: H1/H2/H3 headings, checkboxes you can click to toggle
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
        After confirmation, detaches the cluster plan and leaves its file in
        the workspace. Members lose the plan block on their next turn;
        in-flight turns are not stopped.
      </p>
    ),
    manualSection: 'cluster-plan',
  },
  'cluster.plan-tab.review-plan': {
    title: 'REVIEW cluster plan',
    body: (
      <p>
        Critique the shared cluster plan body directly. The review dialog
        opens against the cluster plan; the first member provides its workflow
        context.
      </p>
    ),
    manualSection: 'cluster-plan-reviews',
  },
  'cluster.plan-tab.verify-work': {
    title: 'VERIFY cluster work',
    body: (
      <p>
        Same target as REVIEW PLAN, but mode = VERIFY and INCLUDE GIT DIFF is
        pre-ticked. Useful after the shared plan claims work is done: the
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
    title: 'DUPLICATE PLAN',
    body: (
      <p>
        Creates a separate copy of the current cluster plan body in
        <C> .arco/plans/&lt;id&gt;.md</C>. The active plan is already stored
        there. Later edits to the active plan do not change the copy.
      </p>
    ),
    manualSection: 'cluster-plan',
  },
  'cluster.plan-tab.import-existing': {
    title: 'Attach existing plan',
    body: (
      <p>
        Attaches an existing plan from <C>.arco/plans/</C> to this cluster.
        The cluster and workflows that attach the same plan use the same file.
      </p>
    ),
    manualSection: 'cluster-plan',
  },
  'cluster.plan-tab.member-picker': {
    title: 'Pick a member to anchor',
    body: (
      <p>
        Choose the member whose transcript a custom review should use, or the
        member receiving a saved plan. The dialog explains the selected action.
        Esc or a click outside cancels.
      </p>
    ),
    manualSection: 'cluster-plan',
  },
  'cluster.right-panel-splitter': {
    title: 'Right panel divider',
    body: <p>Drag to resize the right panel against the member cards and chat. The width is remembered in this browser and stays between about a fifth and a half of the window.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.mailbox': {
    title: 'MAILBOX',
    body: <><p>How many undelivered messages each member has waiting. Click a row with pending mail to read those messages or cancel them before delivery. Delivered mail leaves this count and stays in each member&apos;s history.</p><p>Unreadable mail or failed attachment writes leave the pending batch available for retry. Attachments with matching names remain separate, and existing delivered files are preserved. Malformed records or attachment metadata are preserved aside and logged once, allowing valid mail to continue.</p></>,
    manualSection: 'cluster-peer-messaging',
  },
  'cluster.mailbox-inspect': {
    title: 'Inspect waiting mail',
    body: <><p>Opens the messages waiting for this member so you can read them, or cancel any before the member&apos;s next turn picks them up. Rows with no pending mail are unavailable.</p><p>Unreadable mail or failed attachment writes leave the pending batch available for retry. Attachments with matching names remain separate, and existing delivered files are preserved. Malformed records or attachment metadata are preserved aside and logged once, allowing valid mail to continue.</p></>,
    manualSection: 'cluster-mailbox-modal',
  },
  'cluster.right-panel.github': {
    title: 'GITHUB',
    body: <p>The GitHub browser for this cluster&apos;s project folder, the same view as a tab&apos;s GITHUB panel. Browse the repository, pull requests, issues, Actions runs and files. It uses the same GitHub sign-in as the header GitHub view.</p>,
    manualSection: 'cluster-cwd-tabs',
  },
  'cluster.right-panel.files': {
    title: 'FILES',
    body: <p>Browse this cluster&apos;s project folder, with outputs and the live, changes, source and remote views of its work. Files ignored by git stay hidden; click a file to open it. Codebase memory and sandbox settings belong to each member and stay on that member&apos;s own tab.</p>,
    manualSection: 'cluster-cwd-tabs',
  },
  'cluster.right-panel.history': {
    title: 'HISTORY',
    body: (
      <>
        <p>Past events and checkpoints of the member in view: the member whose card or tab you selected, or the director until you select one. The line at the top names the member; pick another there to switch (the same as clicking its card). The choice is kept when the page reloads, as long as that member is still in the cluster.</p>
        <p>A cluster with no members shows a placeholder until a worker is added from MEMBERS.</p>
      </>
    ),
    manualSection: 'cluster-cwd-tabs',
  },
  'cluster.right-panel.preview': {
    title: 'PREVIEW',
    body: (
      <>
        <p>A live view of a local app, bound through the member in view (named at the top, the director until you select another). Setting a port here sets it on that member. The member in view is kept when the page reloads, as long as it is still in the cluster.</p>
        <p>Most clusters need one app view because members share one project folder. If several members run their own servers, use each member&apos;s own PREVIEW panel.</p>
      </>
    ),
    manualSection: 'cluster-cwd-tabs',
  },
  'cluster.activity': {
    title: 'ACTIVITY',
    body: (
      <>
        <p>One live feed for the whole cluster: messages between members, role, plan and roster changes, mail alerts, and each member&apos;s tool use, such as reading files or running commands.</p>
        <p>Each row starts with the member&apos;s name and role in that member&apos;s colour. Three or more identical tool uses from one member within 30 seconds fold into one row; click it to expand.</p>
        <p>Near the bottom, new rows keep the feed following the latest activity. Scroll up to read back; following pauses until you return to the bottom.</p>
      </>
    ),
    manualSection: 'cluster-activity',
  },
  'cluster.activity.pill': {
    title: 'Filter activity',
    body: <p><C>ALL</C> shows every event from every member. A member pill shows that member&apos;s tool use plus cluster events that involve it: mail it sent or received, role changes on it, and nudges about it. The dot beside each name matches that member&apos;s colour in the feed.</p>,
    manualSection: 'cluster-activity',
  },
  'cluster.nudger': {
    title: 'MAIL ALERTS',
    body: (
      <>
        <p>When on, Arco alerts you if a member has been idle for 10 seconds or more with unread mail, at most three alerts per member between your own messages. <strong>Off by default.</strong></p>
        <p><strong>Alerts only</strong>: it never starts a worker turn or changes a member. Use NUDGE to wake chosen members, or AUTO-PICKUP to let mail start turns automatically.</p>
      </>
    ),
    manualSection: 'cluster-nudger',
  },
  'cluster.project-trust': {
    title: 'Project trust',
    body: (
      <>
        <p>Whether this project&apos;s own instruction files, project skills and Arco project settings may shape member turns. For an untrusted project they are left out, so a cloned repository cannot quietly steer your workers. All members share the project folder, so one choice covers them all.</p>
        <p>The chip appears only when the project actually has such files. Arco asks once, in whichever member&apos;s message box meets them first; this chip grants or withdraws trust later. Changes apply on each member&apos;s next turn.</p>
      </>
    ),
  },
  'cluster.efficiency': {
    title: 'Coordination style',
    body: (
      <>
        <p><C>EFFICIENCY</C> sets how members talk and hand off work. New clusters start on Balanced: clear outcomes, where changes landed and what they affect, routine decisions left to builders, and one actionable blocker or final summary. Thorough allows more explanation; Lean cuts optional narration and handoffs. Every style keeps required tests, safety checks, and the reviews you asked for.</p>
        <p><C>NOTE</C> adds a standing instruction of your own for the whole cluster. Style and note apply on each member&apos;s next turn. The message guard beside it is a separate setting.</p>
      </>
    ),
    manualSection: 'cluster-efficiency',
  },
  'cluster.efficiency-note': {
    title: 'Coordination note',
    body: <p>Adds a short instruction of your own to the cluster&apos;s coordination guidance, such as a reporting preference. It is not a mode or a budget. <C>Enter</C> or clicking away saves; <C>Esc</C> discards. <C>NOTE</C> shows a dot while a note is set; save an empty box to remove it. Applies on each member&apos;s next turn.</p>,
    manualSection: 'cluster-efficiency',
  },
  'cluster.message-guard': {
    title: 'Message guard',
    body: (
      <>
        <p>Limits how many messages one worker may send to other members in a single turn, counted across all recipients. <C>Warn only</C>, the default for new clusters at 15 messages, lets later messages through and gives the worker one warning. <C>Hard limit</C> refuses messages past the number. <C>No limit</C> removes this count. The number can be 1 to 1000.</p>
        <p>Counts start over when the worker begins a turn and after a restart, and a failed send does not count. Changes apply from the next message without resetting the count. Clusters created before the guard existed keep their earlier hard limit until it is changed. Automatic-execution and provider limits still apply.</p>
      </>
    ),
    manualSection: 'cluster-efficiency',
  },
  'cluster.progress': {
    title: 'KEEP CURRENT',
    body: (
      <>
        <p>Chooses which shared record members keep up to date as work moves: <C>PLAN</C> (tick items in the shared plan), <C>BOARD</C> (move task statuses), or <C>BOTH</C>, the default, which keeps the two in step.</p>
        <p>Members get this as part of their standing instructions, but only for records that exist: a cluster with no plan, or with the board set to <C>NONE</C>, skips that part. Applies on each member&apos;s next turn and can be changed back at any time.</p>
      </>
    ),
    manualSection: 'cluster-efficiency',
  },
  // ------------------------------------------ CLUSTER RIGHT-PANEL GROUPS + TABS
  // Group row (`cluster.right-panel.group.<id>`) and the three tabs whose wide
  // buttons fall through to `cluster.right-panel.tab.<id>`. The narrow-width
  // <select> uses `cluster.right-panel.tab.<active>` for every tab: aliases for
  // the rest are assembled below the registry.
  'cluster.right-panel.group.workspace': {
    title: 'WORKSPACE group',
    body: <p><C>MEMBERS</C> (roster, roles, adding and replacing workers, saved snapshots) and <C>FILES</C> (the shared project folder and its changes). Click a group to open its first tab.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.group.agent': {
    title: 'AGENT group',
    body: <p>What the members are doing and how they coordinate: <C>ACTIVITY</C>, <C>REVIEWS</C>, <C>HANDOFFS</C>, <C>PLAN</C>, <C>BOARD</C> and <C>MAILBOX</C>.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.group.memory': {
    title: 'MEMORY group',
    body: <p><C>HISTORY</C>: past events and checkpoints of the member in view. <C>USAGE</C>: token usage for every conversation in the cluster&apos;s project folder, all members included, with MEASURE STORAGE and MEASURE ARCO FOLDER.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.tab.usage': {
    title: 'USAGE',
    body: <p>Token usage per provider and day for every conversation saved in the cluster&apos;s project folder, so all members are included. MEASURE STORAGE measures that folder&apos;s saved state and MEASURE ARCO FOLDER measures Arco&apos;s own folder; neither changes anything. Failed or invalid usage reads show an error; reopen USAGE to retry. Computer can also open this panel.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.member-in-view': {
    title: 'Member shown',
    body: <p>Which member HISTORY or PREVIEW shows. It follows the member card or tab you selected and starts at the director. Choosing a member here selects it in the cluster tab too. Missing member rehydrate requests are retried on a new connection.</p>,
    manualSection: 'cluster-cwd-tabs',
  },
  'cluster.right-panel.group.runtime': {
    title: 'RUNTIME group',
    body: <p><C>PREVIEW</C> (a live view of a local app), <C>CONFIG</C> (settings for one member at a time) and <C>GITHUB</C>. Cluster-wide switches stay in the bar at the top of the panel.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.tab.reviews': {
    title: 'REVIEWS',
    body: <p>Reviews from every member in one list, newest first, with the member reviewed, the reviewer and the verdict: <C>PASS</C>, <C>MINOR</C> or <C>BLOCKING</C>. Click a row to read the full review. A running review can be cancelled here. Each member&apos;s own REVIEW panel is unchanged.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.reviews-cancel': {
    title: 'Cancel review',
    body: <p>Stops this review while it is still running. Shown only on running reviews; finished and failed reviews stay in the list.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.tab.handoffs': {
    title: 'HANDOFFS',
    body: <p>Handoffs for every tab working in this project folder: cluster members, plus other tabs in the same folder, which are labelled. Cancel a running handoff, or clear a handoff lock left behind by one that stopped.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.tab.config': {
    title: 'CONFIG',
    body: <p>The usual settings panel for one member, chosen with <C>MEMBER</C>: model, effort, connection type, reply style and the rest. Changes apply to that member only. Cluster-wide switches such as efficiency and board mode stay in the bar at the top of the panel.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.right-panel.config-member': {
    title: 'Config member',
    body: <p>Chooses which member the settings below change. Only members whose details have loaded are listed, each with its provider.</p>,
    manualSection: 'cluster-tab',
  },
  'cluster.auto-pickup-rule-limits': {
    title: 'Rule-based limits',
    body: <p>Set the alternating wake limit, hourly wakes per member, total wakes per arming and chain depth. Acknowledgement-only mail and mail stopped by the chain-depth limit stay in the mailbox. The hourly cap rolls over; reaching the arming total pauses automatic pickup until RESUME.</p>,
    manualSection: 'cluster-auto-pickup',
  },
  'cluster.auto-pickup-rule-reset': {
    title: 'Reset Rule-based limits',
    body: <p>Restore the Rule-based default limits in the dialog. APPLY saves the choices.</p>,
    manualSection: 'cluster-auto-pickup',
  },
  'cluster.auto-pickup-rule-resume': {
    title: 'Resume Rule-based pickup',
    body: <p>Start a fresh arming budget after the total wake limit pauses pickup. The rolling hourly member limit still applies.</p>,
    manualSection: 'cluster-auto-pickup',
  },
  'cluster.auto-pickup-off': {
    title: 'Turn AUTO-PICKUP off',
    body: <p>One click sets AUTO-PICKUP to Off. A Smart session ends at once, so an evaluator answer still in progress is discarded and starts nothing. A worker turn that already started is not cancelled; use STOP for that. The evaluator choice and limits are kept for the next arming.</p>,
    manualSection: 'cluster-auto-pickup',
  },
  'cluster.auto-pickup-dialog': {
    title: 'AUTO-PICKUP mode',
    body: <p>Choose a mode and press APPLY, or ARM OBSERVE-ONLY or ARM AUTOMATIC for a Smart mode; CANCEL keeps the current mode. The status lines show when a Smart session ends, evaluator requests this session and in the last hour, automatic wakes against the session limit, and the last decision.</p>,
    manualSection: 'cluster-auto-pickup',
  },
  'cluster.member-brief': {
    title: 'BRIEF on a member card',
    body: <p>A short synopsis of this one member from facts Arco can see, with the facts listed under it. It is read-only and sends nothing to the member.</p>,
    manualSection: 'utility-agent',
  },
  'cluster.auto-pickup-evaluator': {
    title: 'Smart evaluator',
    body: <p>Choose the provider and model that judge waiting mail. A provider is offered only while it is enabled, connected and able to answer without tools here: Claude with Native sign-in, Cursor, Codex, Ollama, LM Studio, llama.cpp, Strata, and DeepSeek through Xolotl. LM Studio, llama.cpp, Strata and DeepSeek require the selected model to be loaded first; these requests never load or switch models. Codex runs as a one-shot read-only session with no MCP servers or web search, and any tool use ends the request with no decision. Nothing is chosen in advance, and the last choice is offered again only while it is still offered. The evaluator receives only the waiting mail and short member and task facts and answers wake, wait or ask, so a fast, low-cost model suits it. The mail goes to the chosen provider and any cost depends on that provider. USE UTILITY AGENT, shown when a utility agent is saved and usable, only fills in the provider and model from Settings; nothing is armed until you press ARM.</p>,
    manualSection: 'cluster-auto-pickup',
  },
  'cluster.auto-pickup-limits': {
    title: 'Smart limits',
    body: <p>Each limit has a default and a range: evaluator requests at once (1), per hour for the cluster (12) and per member (3), automatic wakes per member per hour (3) and per armed session (12), session length (30 minutes), evaluator time limit (30 seconds), mail and context sent per request (12 KiB) and answer length (64 tokens). Limits are counted durably, so a restart never resets them; a request whose result is unknown counts as spent. The Rule-based cooldown, per-minute ceiling and chain limit still apply.</p>,
    manualSection: 'cluster-auto-pickup',
  },
  'cluster.auto-pickup-status': {
    title: 'AUTO-PICKUP status',
    body: <p>Shows the Smart session end time, evaluator requests this session, in the last hour and in progress, automatic wakes against the session limit, and the last decision with its reason. Arming, turning off and session expiry are recorded as decisions too.</p>,
    manualSection: 'cluster-auto-pickup',
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

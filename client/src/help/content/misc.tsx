import { C } from './shared';
import type { HelpEntry } from './shared';

export const miscHelp: Record<string, HelpEntry> = {
  'palette.results': {
    title: 'Command palette results',
    body: <p>Choose a file or content result to open the file viewer. Content search omits files protected from the file browser. The palette is hidden while viewing the file. Closing the viewer returns to the same query and selection.</p>,
    manualSection: 'command-palette',
  },

  'layout.member-rail': {
    title: 'Member rail',
    body: <p>In the Narrow layout the member list folds into this rail of initials. The dot shows waiting mail (warning color) or a busy member. Click an initial to put that member in view; the hover text gives its name, role and state.</p>,
    manualSection: 'window-layout',
  },
  'layout.member-list-open': {
    title: 'Show the member list',
    body: <p>Opens the full member list over the chat, with the same cards and LAYOUT choices as on a wider window. Clicking a card puts that member in view and closes the list; Esc, CLOSE or a click beside it also closes it.</p>,
    manualSection: 'window-layout',
  },
  'layout.right-strip': {
    title: 'Side panel strip',
    body: <p>In the narrow layout the right panel folds into this strip. Each button opens the panel over the chat at that tab (BOARD, PLAN or FILES in a cluster; FILES, PLAN or MEMORY in a single tab); MORE opens it at the tab used last. Nothing is removed: every tab is still there.</p>,
    manualSection: 'window-layout',
  },
  'layout.slide-out-close': {
    title: 'Close the panel',
    body: <p>Closes a panel that opened over the chat in the narrow layout. Esc or a click beside the panel does the same. What you changed in the panel stays.</p>,
    manualSection: 'window-layout',
  },
  'layout.cluster-settings': {
    title: 'Cluster settings summary',
    body: <p>Outside the Standard layout the cluster settings above the right panel tabs fold into this line: mail alerts, AUTO-PICKUP, efficiency, the task board and remote sharing when it is on. <C>SETTINGS</C> opens the full controls; click it again to fold them.</p>,
    manualSection: 'window-layout',
  },
  'layout.composer-more': {
    title: 'More composer tools',
    body: <p>Outside the Standard layout the composer tools stay on one line. Tools that do not fit move into <C>MORE</C>, from the end of the line, and come back when the window grows. FILE, PLAN and BRIEF always stay on the line. Choosing a tool in the list does the same as its button.</p>,
    manualSection: 'window-layout',
  },
  'layout.plan-hint-more': {
    title: 'More plan choices',
    body: <p>Shows the rest of the no-plan hint: the public-project choice, ATTACH EXISTING and NOT NOW. LESS folds them back into one line.</p>,
    manualSection: 'window-layout',
  },
  'terminal-sessions': {
    title: 'Continue a terminal session',
    body: <p>Lists up to 50 recent Claude Code and 50 Codex sessions for this project, read from their configured local history folders, marked A (Claude) and C (Codex). On Home, discovery starts when the project menu opens. Scans are bounded, so older records may not appear. OPEN starts a tab with the matching provider and session. Claude sessions use the CLI transport; connect Claude CLI first. Codex uses the terminal account even when other profiles are configured. Close the terminal session before continuing to avoid concurrent writers. Nothing is copied or uploaded by discovery. The list is hidden when no matching sessions are available, including in Docker without mounted history.</p>,
    manualSection: 'home',
  },
  'chat.turn-changes': {
    title: 'Changes during this turn',
    body: <p>Shadow checkpoints omit nested repositories, name those exclusions in the preview and result, and leave them unchanged. Older checkpoints also preserve unrecorded folders; if restoring a file would overwrite one, preview and undo refuse without changing files. Open the changed-files line to view the captured checkpoint diff. UNDO THIS TURN uses the checkpoint restore and asks for confirmation; it restores included files to the earlier checkpoint, including changes made after the turn. A safety checkpoint is taken first. Once it has run the line reads Undone, UNDO THIS TURN is disabled, and the diff is labelled as the undone change. Oversized files skipped by the shadow checkpoint are identified in the line. If another managed writer was active in the folder, the line says so and offers VIEW DIFF without undo. External writers are not detected. Additional directories outside the working tree are outside the checkpoint. Git-backed checkpoints honor Git ignore rules; shadow checkpoints use their stated size, traversal and nested-repository scope. Isolated scratch members do not produce a project-checkpoint line.</p>,
    manualSection: 'chat-panel',
  },
  'utility.catch-up': {
    title: 'Catch me up',
    body: <p>Summarizes bounded workflow or cluster activity from the earlier of the last visit or last operator message. Without a previous visit, SUMMARIZE covers the tab from its start or the last 24 hours. When a range has no activity, no model is called; SINCE LAST TURN, LAST HOUR and TODAY offer another range. A failed summary stays in the dialog and is not written into chat. The dialog shows the range, facts and omissions. Choose a utility agent first. Fable/Mythos 5.2 uses low effort and extra reasoning headroom for this summary. Running can be cancelled. Switching tabs closes this dialog and cancels its request; the new tab is ready for a new summary.</p>,
    manualSection: 'utility-agent',
  },
  'home.start': {
    title: 'Start from Home',
    body: (
      <p>
        Start a chat opens the normal creator without a project. New session and New cluster open their creators; More ways to start offers New idea (Genesis). These actions do not send a prompt.
      </p>
    ),
  },

  'home.open-work': {
    title: 'Continue work',
    body: (
      <p>
        Shows currently open work that can be resumed from Home. Incognito
        chats, cluster members and hidden task children are omitted. Open
        returns to that item in one click. Visiting Home does not stop a running turn.
        Waiting questions come first, followed by most recent activity; running cards show their current step. Cards show at most two rows;
        Show all opens the rest in a bounded scrolling list.
      </p>
    ),
  },

  'home.projects': {
    title: 'Projects',
    body: (
      <p>
        The project grid lists available location folders and bookmarks alphabetically. Recently used is a separate choice, ordered by activity. Temporary folders are excluded. Search by name or path, or filter by location. Cards show their location when several locations are configured. The grid shows two rows of cards at first; Show all opens the rest in a bounded scrolling list, and a search shows every match. New session opens the creator with the folder prefilled. The project menu contains New cluster, Saved sessions, Pin and Manage. Add project location adds a named parent; Open another folder opens a one-off folder browser.
      </p>
    ),
    manualSection: 'home',
  },

  'home.getting-started': {
    title: 'Getting started',
    body: <p>Connect a provider, add a project folder and start a conversation. Any chat, session or cluster counts, including saved ones. Each step checks itself when completed. The card disappears once all three are complete, or sooner with HIDE. Open another folder is available for a one-off session.</p>,
    manualSection: 'home',
  },
  'home.getting-started-hide': {
    title: 'Hide the getting started guide',
    body: <p>Hides this card on this browser. If browser storage is unavailable, it stays hidden until this view reloads.</p>,
    manualSection: 'home',
  },
  'home.locations': {
    title: 'Project location filter',
    body: <p>Choose All folders, Recently used, Pinned or a named location to filter the project grid. The folder browser starts at a selected location. An unavailable location is marked in the list.</p>,
    manualSection: 'home',
  },
  'home.project-actions': {
    title: 'Project actions',
    body: <p>The menu offers New cluster, Saved sessions, Pin or Unpin, and Manage. Manage contains rename, archive and bookmark removal when available. Settings &gt; Projects offers relocation for missing folders. These controls do not move or delete project files.</p>,
    manualSection: 'home',
  },

  'home.manage-project': {
    title: 'Manage a project',
    body: (
      <p>
        Rename changes the secondary display name; the folder name remains the card title. Leave it empty to clear the display name. Archive keeps a project out of the main lists without
        touching its folder or sessions. Remove bookmark forgets an individual folder bookmark; files and saved chats are not touched. Relocate in Settings &gt; Projects points a missing folder at its new location and keeps its name, pin and the
        sessions listed under the old location. Nothing here moves or deletes
        files.
      </p>
    ),
  },

  'home.create-folder': {
    title: 'Create a project folder',
    body: (
      <p>
        Under Open another folder, expand Bookmark a folder, then Create a new project folder to create one empty folder at an absolute path, or use a plain
        name inside the displayed default browsing location. The parent must exist. An existing
        folder with that name is never reused; bookmark it instead.
      </p>
    ),
  },

  'home.add-folder': {
    title: 'Bookmark a folder',
    body: (
      <p>
        Under Open another folder, expand Bookmark a folder for Bookmark folder or Create and bookmark. Bookmarks are optional and keep individual folders listed independently of project locations. Folders inside locations already appear automatically. Bookmarking an existing path does not create a folder or control saved chats and files. In Docker, mount the folder before bookmarking it.
      </p>
    ),
  },

  'creator.projects': {
    title: 'Projects',
    body: (
      <p>
        Filter All folders, Recently used, Pinned, or a project location, then search by folder name or path. All folders combines location folders and bookmarks in alphabetical order; Recently used lists existing folders by activity and excludes temporary folders. Choosing a group never selects a folder. Browse this location opens navigation without changing the session folder. Browse another folder offers editable paths, Up and location shortcuts. + NEW FOLDER creates and selects a new folder in a location. Use for this session selects a working folder without bookmarking it; Bookmark folder keeps it listed independently of locations. Settings / Projects manages project locations and bookmarked folders.
      </p>
    ),
  },
  'creator.new-folder': { title: 'New folder', body: <p>Create a folder in a project location and select it for this session. Existing folders are not reused.</p>, manualSection: 'creating-workflow' },
  'creator.new-folder-form': { title: 'Create a project folder', body: <p>Choose a reachable project location and enter a new folder name. Creating the folder does not bookmark it.</p>, manualSection: 'creating-workflow' },
  'creator.new-folder-location': { title: 'Project location', body: <p>Choose the project location that will contain the new folder.</p>, manualSection: 'creating-workflow' },
  'creator.new-folder-name': { title: 'Folder name', body: <p>Enter one non-hidden folder name without path separators or reserved characters.</p>, manualSection: 'creating-workflow' },
  'creator.new-folder-create': { title: 'Create folder', body: <p>Create the folder and select it. A name that already exists is refused.</p>, manualSection: 'creating-workflow' },
  'creator.new-folder-cancel': { title: 'Cancel folder creation', body: <p>Close the form without creating a folder.</p>, manualSection: 'creating-workflow' },

  'auth.connections': {
    title: 'Connections', manualSection: 'settings-providers',
    body: <p>Choose a provider to review account requirements, sign in, save an endpoint, or check its current status. A successful explicit connection check enables that provider for new work. Claude Native credentials and CLI sign-in are separate sign-ins with separate status and recovery controls. Saved Native login tokens use Anthropic unless claudeNative.baseUrl is explicitly set in the global settings file; an inherited ANTHROPIC_BASE_URL alone cannot redirect them. Saved-login requests do not forward an unrelated environment API key. A custom endpoint receives the saved token. Native is the default transport, so Claude shows Native: sign-in needed until SIGN IN FOR NATIVE completes; Use Claude CLI instead switches the transport when the CLI is signed in; local credential presence does not verify execution or usage limits access. Cursor signs in from here and shows the link to open; when Cursor has rejected the saved sign-in, its status reads Sign-in rejected and the button reads Sign in again. Advanced settings retain the provider controls. Skip keeps the workspace available without starting a workflow.</p>,
  },
  'auth.endpoint': { title: 'Model server address', manualSection: 'settings-providers', body: <p>Set an http or https service address, then Save endpoint. Clear the field and save to restore the runtime default. Other Ollama options stay saved. Test connection checks the resulting address.</p> },
  'auth.login-flow': {
    title: 'Provider sign-in', manualSection: 'settings-providers',
    body: <p>Open the provider sign-in link and follow its instructions. Enter a returned code only when requested. The provider CLI stores credentials in the server home. Cancel stops this login; the terminal command remains available as a fallback. If the sign-in process closes its input early, Arco stays running and reports the process exit.</p>,
  },
  'auth.provider-outage': {
    title: 'Provider connection status', manualSection: 'settings-providers',
    body: <p>Saved work remains available while providers are disconnected. Retry checks status, Connect a provider opens Connections, and Provider settings opens the existing controls. A connection check does not send a model turn.</p>,
  },
  // -------------------------------------------------------------- CHAT PANEL
  'chat.panel': {
    title: 'Chat panel',
    body: (
      <>
        <p>
          The conversation with this tab's primary agent. Renders tail-first
          (last 200 entries): use the <C>↑ LOAD EARLIER MESSAGES</C> pill at the top to
          page back further. Scroll position is preserved.
         Selecting a HISTORY message inside PRIOR SESSIONS expands that group and highlights the target.</p>
        <p>
          Streams tokens during a turn. Tool calls the provider reports render
          as inline pills between assistant bubbles. Computer selecting this worker,
          or sending it a voice message/nudge while selected, resumes following
          the latest output. Scroll up to pause; background recipients leave
          your reading position alone.
        </p>
        <p>Cursor Chat uses only message text and attachments. It cannot open
          computer files by path or link and has no web access. Abandoned turn folders
          are removed at server startup. Documents arrive as text and images
          use Cursor&apos;s image input; unsupported image inputs are refused.
          A Cursor version missing the required Chat controls cannot run Chat.</p>
      </>
    ),
    manualSection: 'chat-panel',
  },
  'chat.ask-question': {
    title: 'Agent question',
    body: <p>Choose one complete option or type an answer. Pipes and backslashes inside an option are kept as part of that answer. Submitting resumes the waiting agent.</p>,
    manualSection: 'chat-panel',
  },
  'chat.automatic-message': {
    title: 'Automatic mailbox message',
    body: <p>Automatic nudges and pickup reminders start folded. Use + to read the full message and - to fold it again. The member receives the full text. Typed messages stay visible.</p>,
    manualSection: 'cluster-peer-read-tool',
  },
  'chat.message.user': {
    title: 'Operator message',
    body: <p>Your prompt. Long messages collapse to a preview with an expand toggle. In Chat, EDIT replaces the draft text and attachments, clearing staged files when the message has none.</p>,
  },
  'chat.message.agent': {
    title: 'Agent reply',
    body: <p>The primary's reply. Streams token-by-token while the turn is in flight. Status updates for an existing tool call keep the reply together and the tool in its original position, including after reload. New tools, Cursor reasoning and operator steering still separate reply segments. Ordinary JSON with application keys stays visible. Valid legacy envelopes and arco-artifact fences use compact summaries. Drive-qualified Windows and UNC filenames can be opened as file references.</p>,
  },
  'chat.message.thinking': {
    title: 'Reasoning trace',
    body: (
      <p>
        Reasoning output from Claude / Codex / Ollama (when the model exposes
        it), streamed into the ACTIVITY feed rather than the main chat.
        Consecutive deltas coalesce into one block. Counts toward context but
        isn't part of the visible reply.
      </p>
    ),
  },
  'chat.tool-pill': {
    title: 'Tool call',
    body: (
      <>
      <p>
        The agent invoked a tool (Bash / Read / Edit / etc.). Expand the pill
        to see its JSON input. When a file path is shown as a button, select it
        to open the viewer. A filtered-output chip can copy the raw output path.
      </p>
      <p>Claude Native Read shows fitted images and document ranges, including in Task helpers. The card names the file, type, dimensions or pages. After reload, Native retains MCP media receipts with the original tool name and input for requesting the result again. Use <C>pages</C> for PDF pages, sheets, slides, notebook cells or Word sections. Notebook SVG outputs include source and a fitted image; unsupported rich outputs leave a cell-numbered receipt. Office files become text, scanned pages become images, and unsupported binaries receive a note. No converter installation is needed. UTF-8 and byte-order-marked UTF-16 text are recognized. Non-UTF-8 text without NUL bytes and with fewer than 1% unexpected control bytes per 16 KiB chunk is decoded as Windows-1252 and marked. Line ranges apply to the decoded text. A selected text range containing NUL bytes receives a binary-file note, including when those bytes occur after the initial header.</p><p>AVIF is fitted like other images. ICO uses its largest image. SVG supplies source text and a fitted preview without scripts, external resources or system fonts. Text requiring a font may be absent from the preview.</p>
      <p>Native <C>read_url</C>, local <C>WebFetch</C> and the CLI file server&apos;s read-only <C>fetch_file</C>
      read public HTTP(S) images and documents through Arco. Images are fitted;
      PDFs provide selected text or scanned-page images. Use <C>pdf_mode=visual</C> with <C>pages</C> for PDF layout or figures. Use <C>pages</C> for a
      range. Private addresses, unsafe redirects, oversized sources and expired
      requests produce a note.</p>
      <p>Attachments and MCP file results use the same decoder. Local providers restore up to two recent fitted images and 8 KiB of decoded text on later turns and reload. Older receipts name saved files or the original tool and input. Use Read or re-run the tool for detail; missing files produce a notice. Saved events keep references rather than encoded media.</p>

      <p>Claude Native and local-model Glob can return a directory alias for a directory-only pattern such as <C>src-link/</C>. The alias must resolve within the project and pass the path checks. Glob does not walk through directory aliases.</p>
      <p>JavaScript Grep searches UTF-8, UTF-16 and Windows-1252 text, skipping binary and control-heavy data. Native ripgrep omits output lines that cannot be decoded safely.</p>
      </>
    ),
    manualSection: 'tool-pills',
  },
  'chat.compacting': {
    title: 'Compacting…',
    body: (
      <p>
        This Claude-native tab is running a compaction: summarizing the
        conversation in place so the next turn starts against a smaller prompt.
        The whole chat area is taken over and the composer is disabled while it
        runs (one summarization round, between turns). It clears on success, on
        failure, or when the next turn starts. The folded transcript stays in{' '}
        <C>events.jsonl</C>; a <C>COMPACTED: CONTINUE</C> button in the composer resumes the work
        afterward.
      </p>
    ),
  },
  'chat.task-card': {
    title: 'Task sub-agent (Native)',
    body: (
      <p>
        The Native worker called the <C>Task</C> tool: this card represents a
        first-class child workflow scoped to its parent. Status:{' '}
        <C>running</C> / <C>done</C> / <C>error</C> / <C>cancelled</C>; the{' '}
        <C>PROMOTE</C> button surfaces the child into the top tab strip.
        Depth-1 only (children can't call <C>Task</C> themselves). Parallel{' '}
        <C>Task</C> calls within one turn dispatch concurrently.
      </p>
    ),
    manualSection: 'tasks-tab',
  },
  'creator.tool-filter': {
    title: 'Tool-result filter',
    body: (
      <p>
        Claude Native efficiency control. Conservative filters trim noisy tool
        output before it enters the next model call. Shell exit, timeout and cancellation status selects failure handling; compiler, configuration and test-collection diagnostics remain visible. Reductions are logged so
        transcript review can see what changed. A new home starts at{' '}
        <C>conservative</C>; a saved default, including <C>off</C>, is kept.
      </p>
    ),
    manualSection: 'config-tab',
  },
  'creator.output-style': {
    title: 'Output style default',
    body: (
      <p>
        Default reply style for new tabs, on every provider: <C>NORMAL</C>,{' '}
        <C>PLAIN</C> or <C>TERSE</C>. Without a saved default, new tabs use
        Plain. Applies to the tab&apos;s own turns; Review, Handoff, DOCS and
        GIT stay Normal. A default saved as Lite before 0.1.5 loads as Plain.
      </p>
    ),
    manualSection: 'config-tab',
  },
  'preview.port': {
    title: 'PREVIEW · PORT',
    body: <p>Type the dev-server port and press Enter or click <C>BIND</C>. The app opens on a separate preview address shown in the panel. Each open preview takes one port from PREVIEW PORTS in Settings, normally 4300-4309. Remote access needs that range forwarded and allowed through the firewall. Vite defaults to 5173, Next 3000, Astro 4321.</p>,
    manualSection: 'preview-tab',
  },
  // ------------------------------------------------- RUNTIME RECOVERY (§C2)
  'runtime.cancel-turn': {
    title: 'RUNTIME · CANCEL TURN',
    body: (
      <p>
        The worker has emitted no output for a while and may be hung. There's no
        safe way to poke a stuck provider awake, so the honest recovery is to{' '}
        <C>CANCEL TURN</C> (kills this workflow's in-flight turn) and re-send your
        prompt. The silence clock advances while this worker is busy and online, even without new events.
      </p>
    ),
    manualSection: 'offline',
  },
  'runtime.dismiss-recovered': {
    title: 'RUNTIME · DISMISS',
    body: (
      <p>
        Acknowledge the replay-recovered notice: this tab's context was
        rehydrated from disk after a reconnect/restart. <C>DISMISS</C> clears the
        badge immediately; it also auto-clears once its window elapses or on your
        next interaction.
      </p>
    ),
    manualSection: 'offline',
  },
  'preview.reprobe': {
    title: 'PREVIEW · RE-PROBE',
    body: (
      <p>
        Re-check whether the currently-bound dev-server port is still listening.
        If it's gone, the dead-service picker opens so you can bind a
        currently-listening service instead of hunting for the port.
      </p>
    ),
    manualSection: 'preview-tab',
  },
  'preview.bind': {
    title: 'PREVIEW · BIND',
    body: <p>Binds the typed port to this tab and remembers it. A port bound by hand is never replaced by automatic detection.</p>,
    manualSection: 'preview-tab',
  },
  'preview.reload': {
    title: 'PREVIEW · RELOAD',
    body: <p>Reloads the live view from scratch, which also works when the app would otherwise show a cached page.</p>,
    manualSection: 'preview-tab',
  },
  'preview.open': {
    title: 'PREVIEW · OPEN',
    body: <p>Open the separate preview address in a new browser tab for full-window viewing. Keep PREVIEW open in Arco to retain its port. Previews cannot use Arco controls. App responses cannot clear cookies across ports or set host-wide transport, persistent routing or reporting policies. Arco and Domain cookies are discarded; host-only application cookies still work. If no port is free, close another preview or change PREVIEW PORTS in Settings.</p>,
    manualSection: 'preview-tab',
  },
  'preview.unbind': {
    title: 'PREVIEW · UNBIND',
    body: <p>Removes the port binding, hides the live view and releases the preview listener when its last view closes. Automatic detection can bind again the next time the agent starts a dev server.</p>,
    manualSection: 'preview-tab',
  },
  'preview.verify': {
    title: 'PREVIEW · VERIFY',
    body: (
      <p>
        Operator-triggered capture of the running preview via a headless system
        Chrome/Chromium. <C>CAPTURE SCREENSHOT</C> grabs the rendered page;{' '}
        <C>CHECK CONSOLE</C> collects console errors + warnings; <C>CHECK NETWORK</C>{' '}
        lists failed and 4xx/5xx requests. Each writes a report (and screenshot)
        artifact under the workflow's <C>artifacts/</C> dir: inspectable evidence,
        not autonomous browsing. Needs a system browser installed (or{' '}
        <C>ARCO_CHROME_BINARY</C> set); none bundled.
       In a cluster, captures target the member in view. Controls are disabled when no sender is available.</p>
    ),
    manualSection: 'preview-tab',
  },
  'preview.captures': {
    title: 'PREVIEW · capture result',
    body: <p>The latest capture: page title, console-error / failed-request counts, a screenshot thumbnail (click to open full size), and <C>VIEW REPORT</C> for the full markdown report. Artifacts persist on disk.</p>,
    manualSection: 'preview-tab',
  },
  'preview.viewport': {
    title: 'PREVIEW · capture viewport',
    body: <p>The device size a <C>VERIFY</C> capture uses: <C>DESKTOP</C> (1280 by 800), <C>TABLET</C> (834 by 1112) or <C>MOBILE</C> (390 by 844). Tablet and mobile also act like touch screens with the matching pixel density, so the app&apos;s mobile layouts appear as on a real device. Every capture also notes basic layout and accessibility issues, such as sideways scrolling, missing image text or labels, page language and headings. This is separate from the live view&apos;s aspect ratio and is remembered in this browser.</p>,
    manualSection: 'preview-tab',
  },
  'preview.captureActions': {
    title: 'PREVIEW · send capture to an agent',
    body: (
      <p>
        <C>SEND TO AGENT</C> seeds this tab's composer with an <C>@file</C> ref to
        the capture report plus a framing line: the current agent reads the
        actual report when you send. <C>ATTACH TO REVIEW</C> fires a Review over
        the report (reusing this tab's primary provider/model/effort): a
        read-only reviewer receives the report and screenshot, if available,
        and files a verdict in the REVIEW tab. A model with image support can
        inspect the screenshot; other models use the report.
      </p>
    ),
    manualSection: 'preview-tab',
  },
  'preview.aspect': {
    title: 'PREVIEW · aspect ratio',
    body: <p>The shape of the live view: <C>4:3</C>, <C>16:10</C> or <C>16:9</C>, always drawn at a desktop width of 1920 and scaled down to fit the panel. The choice is remembered in this browser and applies to every tab&apos;s PREVIEW. Fitting uses the available panel space at the current interface text size.</p>,
    manualSection: 'preview-tab',
  },
  // ----------------------------------------- WORKFLOW CREATOR / RESUME
  'creator.cluster-plan-goal': {
    title: 'Cluster plan',
    body: <p>Choose no plan, attach a project plan, ask the director to draft after creation, or draft in Genesis first. A director draft needs a director and a detailed project description.</p>,
    manualSection: 'cluster-plan',
  },
  'creator.plan-none': { title: 'No plan', body: <p>Create the cluster without an attached plan.</p>, manualSection: 'cluster-plan' },
  'creator.plan-existing': { title: 'Attach an existing plan', body: <p>Choose a plan from this project to attach when the cluster is created.</p>, manualSection: 'cluster-plan' },
  'creator.plan-director': { title: 'Director draft', body: <p>Ask the director to draft a plan after creation. Review it before attaching it.</p>, manualSection: 'cluster-plan' },
  'creator.plan-genesis': { title: 'Draft in Genesis first', body: <p>Draft a plan for this folder in Genesis. The creator keeps its fields and selects the saved plan on return.</p>, manualSection: 'cluster-plan' },
  'creator.plan-description': { title: 'Project description', body: <p>Describe the goal, completion, constraints, and what must not change so the director can draft a useful plan.</p>, manualSection: 'cluster-plan' },
  'creator.cluster-mode': {
    title: 'Mode: Agent, Chat, Cluster or Genesis',
    body: (
      <>
        <p>
          Top-of-form toggle. <strong>SINGLE WORKFLOW</strong> creates one tab
          with one project agent. <strong>CHAT</strong> is a conversation with no
          project; <strong>GENESIS</strong> starts from an idea before scaffolding
          a project. <strong>CLUSTER</strong>{' '}
          creates several member tabs that share one project folder, each
          configured per member (provider, model, effort, role, work size,
          permissions and tuning).
        </p>
        <p>
          In CLUSTER mode the order is: shared project folder, members, then the
          collapsed <strong>Defaults for new members</strong> (used only by{' '}
          <C>+ ADD MEMBER</C>; existing members do not change) and{' '}
          <strong>Coordination settings</strong>. Saved cluster presets and
          cluster restore come last. Ultracode, Resume and Advanced options are
          single-workflow only and are not shown here. Clusters need at least 2
          members; members can use enabled, connected Claude, Codex, Cursor,
          Ollama or llama.cpp. A cluster may have at most one director.
        </p>
        <p>
          Members can exchange notes between turns via the peer tool
          (peer_list / peer_send / peer_read). Set a per-member <em>role</em>{' '}
          for human-readable framing ("director", "tester") and a per-member{' '}
          <em>work size</em> (light / standard / heavy) so the director can
          match task size. Work size does not change model or effort. Arco does
          not auto-route work from role or work size beyond the director limit.
        </p>
      </>
    ),
    manualSection: 'create-cluster-from-new',
  },
  'creator.cluster-presets': {
    title: 'Cluster presets',
    body: (
      <>
        <p>
          A <strong>preset</strong> is an operator-saved snapshot of the
          per-member configs (provider / model / effort / role / tier /
          display name / permissions / fast-mode / filter / output style) plus
          the optional CLUSTER NAME, captured under a name you pick. Cwd is
          intentionally <em>not</em> saved: presets are project-agnostic so
          the same shape can be applied to any working directory.
        </p>
        <p>
          Click a pill to apply that preset: it overwrites the MEMBERS list,
          and (only if the CLUSTER NAME field is blank) seeds it from the
          preset's name template. Click <C>×</C> to delete after a confirm.
          Click <C>+ SAVE AS PRESET</C> to save the current cluster shape
          under a new name: the button is disabled until you have ≥2 members
          each with a model.
        </p>
      </>
    ),
    manualSection: 'cluster-presets',
  },

  'creator.templates': {
    title: 'Templates (recipes)',
    body: (
      <>
        <p>
          A <strong>template</strong> is the single-tab analogue of a cluster
          preset: an operator-saved snapshot of this tab's config (provider /
          model / effort / permissions / fast-mode / tool-filter / output
          style) plus an <em>optional</em> working directory, captured under a
          name you pick. Bake the cwd in for a project-pinned recipe ("new
          Ledger tab"), or omit it for a portable one that applies to whatever
          directory you pick next.
        </p>
        <p>
          Click a pill to apply that template: it pre-fills the form fields
          (and the cwd only if the recipe saved one). Click <C>×</C> to delete
          after a confirm. Click <C>+ SAVE AS TEMPLATE</C> to save the current
          config under a new name. If a template carries a seed prompt or plan,
          applying it <em>pre-fills</em> the new tab's composer and PLAN tab:
          it is never auto-sent.
        </p>
      </>
    ),
    manualSection: 'creating-workflow',
  },
  'creator.cluster-members': {
    title: 'Cluster members',
    body: (
      <>
        <p>
          One row per member. Rows are collapsed by default and show a
          one-line summary in words (display name, provider, model, effort,
          role and any selected work size); an empty role reads <em>Role not set</em>.
          The editor lists only enabled, connected
          providers, keeps a saved provider that is no longer connected marked
          as such, explains AUTO and SAFE permissions, and holds this member's
          own tuning.
          Click <C>↓ EDIT</C> to expand into the full editor; <C>↑ COLLAPSE</C>{' '}
          to fold back. <C>× REMOVE</C> drops the row.
        </p>
        <p>
          <C>+ ADD MEMBER</C> appends a fresh row seeded from{' '}
          <strong>Defaults for new members</strong>. Cluster requires at least 2
          members. A cluster may have at most one director, including roles beginning with Director or Coordinator. Work size guides the director's task assignments without changing model or effort; it matters most when several members can take the same work.
        </p>
      </>
    ),
  },
  'creator.cluster-templates': {
    title: 'Start from a template',
    body: (
      <>
        <p>
          Built-in cluster shapes: <strong>Pair</strong> (builder and
          reviewer), <strong>Small team</strong> (director, builder, tester),{' '}
          <strong>Research</strong> (director and two researchers),{' '}
          <strong>Medium team</strong> (director, builder, tester, documenter),{' '}
          <strong>Full team</strong> (Medium team plus researcher),{' '}
          <strong>Parallel build</strong> (director, two builders, tester, documenter)
          and <strong>Large team</strong> (Full team plus a second builder).{' '}
          <strong>Build my own</strong> keeps the member list as it is.
        </p>
        <p>
          Choosing a shape opens a review. Each member shows its role, a
          <strong>Recommended model:</strong> line in words (for example
          &quot;Heavy or Standard model, MEDIUM or HIGH effort&quot;) with a
          short reason. When a role appears more than once, each such member has
          an editable work-size choice. Research starts unset; two-builder
          templates recommend Heavy and Standard. Arco does not choose models: you pick a provider
          and model for each member from enabled, connected providers (a single
          connected provider is filled in). Effort starts at the role's level,
          never above HIGH. The member list is replaced only by{' '}
          <C>USE THESE MEMBERS</C>; <C>CANCEL</C> leaves it unchanged. Members
          get the role and the page's current permissions and tuning; repeated
          roles get a work-size hint only when one is selected.
        </p>
      </>
    ),
  },
  'creator.member-defaults': {
    title: 'Defaults for new members',
    body: (
      <p>
        Cluster mode only. The agent, model, effort, permissions and tuning here
        seed members added later with <C>+ ADD MEMBER</C>. Changing them does
        not change members already in the list; open a member to edit it.{' '}
        <C>SAVE AS DEFAULTS</C> stores them for future workflows.
      </p>
    ),
  },
  'creator.cwd': {
    title: 'Working directory',
    body: (
      <p>
        The working folder the agent operates against. Type an absolute path, choose a project, or browse any readable folder. Location selection filters choices; directory navigation does not change the working folder until confirmed. Loading never selects the first discovered child.
        All persistence (<C>events.jsonl</C>, <C>meta.json</C>, artifacts)
        lives under <C>&lt;cwd&gt;/.arco/</C>.
      </p>
    ),
  },
  'creator.name': {
    title: 'Workflow name',
    body: (
      <p>
        Short label for the new tab, shown in the tab bar. In cluster mode it
        names the cluster; in Genesis it is the working name and is required
        to start. Otherwise it is optional and the folder name is used when
        blank. Workflows are keyed by id, not name, so renaming later is
        harmless.
      </p>
    ),
  },
  'creator.genesis-spark': {
    title: 'Your idea',
    body: (
      <p>
        Genesis mode starts a project from a raw idea instead of a folder.
        Describe the idea in your own words: what it might do, why it matters,
        what is still unclear. No working directory yet: Genesis ideates in a
        scratch space, and <C>CREATE &amp; SCAFFOLD</C> (in the GENESIS tab) later
        creates the real project folder and binds it.
      </p>
    ),
  },
  'creator.permissions': {
    title: 'Permissions: AUTO vs SAFE',
    body: (
      <>
        <p>
          Controls how the primary's tool calls are gated.
        </p>
        <ul style={{ margin: '4px 0', paddingLeft: '18px' }}>
          <li>
            <strong>AUTO</strong>: passes <C>--dangerously-skip-permissions</C>
            {' '}(Claude) / danger-full-access sandbox to the primary unless a
            Codex sandbox is set explicitly. Tools execute without per-call
            approval. The agent can write files and run Bash autonomously.
            Reach depends on the provider and enabled tools; shell commands may
            access files outside the workflow folder.
          </li>
          <li>
            <strong>SAFE</strong>: does not enable AUTO. Arco-managed local
            tool loops return a denial for calls instead of running them;
            Claude and Codex use their own normal permission or sandbox rules.
            Built-in file tools have workflow-folder checks, and Native has a
            separate limited write prompt. These checks do not sandbox Bash.
          </li>
        </ul>
        <p>
          Reviewers always run with restrictive permissions regardless of this
          setting (Read/Grep/Glob only for Claude; <C>read-only</C> sandbox for
          Codex).
        </p>
        <p>Browser file views use an allowed-root policy that refuses private folders. Built-in file tools stay inside the project folder but can read project content such as <C>.claude</C> or <C>.codex</C>. Claude Native has a separate prompt for writes to a small set of sensitive targets. These rules do not constrain Bash or replace provider CLI sandbox settings.</p>
      </>
    ),
    manualSection: 'safety-rails',
  },
  'creator.fast-mode': {
    title: 'Fast mode',
    body: (
      <>
        <p>
          Claude only. A per-tab toggle that biases the primary toward faster,
          lower-latency replies on simple tasks: at some cost to depth.
        </p>
        <p>
          Useful when you want chat-like back-and-forth on simple tasks.
          Leave OFF for complex / multi-step work where reasoning quality
          matters more than time-to-first-token.
        </p>
      </>
    ),
  },
  'creator.ultracode': {
    title: 'Ultracode',
    body: (
      <>
        <p>
          Claude only, single workflow only (clusters and Genesis do not carry
          it). Starts the tab in <strong>sticky ultracode</strong>: the
          same deep multi-agent mode as <C>ultracode</C> in the Claude CLI. Each
          turn, Claude authors a <C>Workflow</C> that fans out a fleet of
          subagents (find → verify → synthesize) and the harness runs it in the
          background. Enabling it pins effort to <C>XHIGH</C> and forces the{' '}
          <C>cli</C> transport (the WorkflowTool lives only in the{' '}
          <C>claude</C> binary: Native can't host it).
        </p>
        <p>
          Stays on every turn until you turn it off (in CONFIG → TRANSPORT);
          your base transport is remembered and restored when you do. It runs a
          fleet of agents <strong>unattended with full system access</strong> and
          spends heavily: a per-turn cost, not a one-off. Per-subagent actions
          live in the harness workflow journal; the full Workflow script is shown
          inline in the Activity tab.
        </p>
      </>
    ),
    manualSection: 'config-tab',
  },
  'creator.advanced': {
    title: 'Advanced options',
    body: (
      <p>
        Single workflow only, for Claude and Codex. Additional directories
        (cross-project tool access, used by the Claude CLI and Codex) and, for
        Claude, a fallback model that the CLI transport uses when the primary is
        overloaded; Claude Native ignores it.
      </p>
    ),
  },
  'creator.additional-dirs': {
    title: 'Additional directories',
    body: (
      <>
        <p>
          Extra paths the primary's tools can read/write: passed via{' '}
          <C>--add-dir</C>. One per line or comma-separated.
        </p>
        <p>
          Useful when this workflow needs to reference a sibling repo, a
          shared library directory, or your home dotfiles. Without entries
          here, tools are scoped to the cwd.
        </p>
      </>
    ),
  },
  'creator.fallback-model': {
    title: 'Fallback model',
    body: (
      <>
        <p>
          Claude only. When the primary model returns an overload error, the
          CLI automatically retries with this model. Passed via{' '}
          <C>--fallback-model</C>.
        </p>
        <p>
          Common pattern: primary <C>opus</C>, fallback <C>sonnet</C>: keeps
          work flowing during peak hours when Opus is throttled.
        </p>
      </>
    ),
  },
  'creator.save-defaults': {
    title: 'Save as defaults',
    body: (
      <p>A refused or incomplete reply leaves the previous defaults active and reports a save error.
        Persists the current picker state: provider, model, effort,
        permissions, fast mode, fallback: to{' '}
        <C>~/.arco/settings.json</C> so the next workflow pre-selects the
        same. The cwd is <em>not</em> saved (each workflow has its own).
        Effort is saved as at most HIGH.
      </p>
    ),
  },
  'creator.launch': {
    title: 'Launch workflow',
    body: (
      <p>
        Creates the tab and starts the workflow with the picker state above.
        Requires a connection, a model and an enabled, connected provider; when
        the provider is not connected, the reason and an Open Connections link
        appear above the button. A project workflow also needs a working
        directory; Chat does not. Chat launches a saved or Incognito conversation
        according to the checkbox. Cluster requires every member provider to be enabled and connected; Genesis and Cluster have their own form gates. CREATE CLUSTER sends immediately, then shows Starting... until creation succeeds or fails. A failed send unlocks CREATE CLUSTER. If no response arrives, the wait ends with a notice; check saved clusters before retrying. A director plan draft refreshes the public-project choice after creation, before its model turn. A failed refresh leaves the cluster available; use DRAFT A PLAN to retry.
      </p>
    ),
    manualSection: 'creating-workflow',
  },
  'creator.provider': {
    title: 'Provider',
    body: (
      <p>
        Pick which AI back-end runs this tab. Providers (Claude / Codex /
        Cursor / Ollama / llama.cpp / LM Studio / Strata / DeepSeek); the picker
        lists only providers enabled in Settings and connected. Without a saved
        default the creator starts on the first of those. A saved default that is
        not connected stays selected, marked not connected, and launch waits until
        you pick a connected provider. Local providers (Ollama, llama.cpp) require
        installed models - empty catalogs hide the option. In cluster creation,
        only providers with peer-tool wiring are eligible. Incognito additionally
        excludes Cursor, llama.cpp, Strata and DeepSeek.
      </p>
    ),
    manualSection: 'providers-overview',
  },
  'creator.model': {
    manualSection: 'live-config-swap',
    title: 'Model',
    body: (
      <p>
        Specific model within the provider. Populated from the capability
        probe. Agent tabs can change it later from CONFIG; Chat tabs swap it
        from the header model picker (same provider). Strata adds its prepared
        local profiles; the next message loads the chosen profile
        and retains history, with only one model resident. For <b>Cursor</b>, this is a two-part picker: choose the model
        <i>family</i> (Opus, Grok, GPT-5.x Sol and others) then its <i>effort</i>, with
        optional <b>FAST</b> / <b>THINK</b> toggles: Cursor bakes effort into
        the model id, so the picker only offers combinations Cursor actually
        advertises (no invalid selections). <b>Auto</b> lets Cursor's router
        pick model and effort itself.
      </p>
    ),
  },
  'creator.local-capacity': {
    title: 'Local capacity',
    body: (
      <p>
        Shows how many members use Ollama or llama.cpp against the limit set in
        Connections (default 1 per runtime). Each different local model loads
        its own copy into memory; members on the same model share it. Local
        turns run one at a time per runtime unless the server sets{' '}
        <C>ARCO_LOCAL_PROVIDER_SERIAL_QUEUE=0</C>. CREATE CLUSTER stays disabled
        while a runtime is over its limit.
      </p>
    ),
  },
  'connections.command-shell': {
    title: 'Shell commands and hooks',
    body: (
      <p>
        Shown on Windows when Git Bash was not found. The Bash tool and Claude
        Native hooks run in Git Bash, as in Claude Code, and in PowerShell
        without it: the model then gets a PowerShell tool instead of Bash.
        Only when PowerShell is missing too does the Bash tool return this
        message and a configured hook is skipped with a notice, so the action
        goes ahead. To use Git Bash, install Git for Windows, or set{' '}
        <C>CLAUDE_CODE_GIT_BASH_PATH</C> to its <C>bash.exe</C>, then restart
        Arco.
      </p>
    ),
  },
  'connections.local-capacity': {
    title: 'Cluster members that may use this runtime at once',
    body: (
      <p>
        How many members of one cluster may use this local runtime. Default 1,
        range 1 to 16. More members on different models need memory for each
        model; members on the same model share it. Ollama decides what it
        accepts through <C>OLLAMA_MAX_LOADED_MODELS</C> and{' '}
        <C>OLLAMA_NUM_PARALLEL</C>; llama.cpp through how its server was
        started. Ollama and llama.cpp members together are limited by the
        larger setting. The server enforces this on create, add and replace;
        <C>ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL=1</C> lifts it.
      </p>
    ),
  },
  'creator.effort': {
    manualSection: 'live-config-swap',
    title: 'Effort',
    body: (
      <p>
        Reasoning budget. Claude has 5 levels (low/medium/high/xhigh/max),
        Codex follows the selected model's catalog (Astra and Sol: low through ultra; Luna stops at max;
        older models may stop at xhigh), Strata offers none/low/medium/high (none
        disables reasoning; high maps to Qwen xhigh), and other local models expose low/high as a thinking toggle.
        Higher effort = more thinking tokens = more cost /
        more time. <b>Cursor</b> has no separate effort here: it's baked into
        the model id, so set it in the MODEL picker above. New work starts at
        <C>high</C> at most: saved defaults, templates, presets, new members and
        replacements are capped there. XHIGH and MAX apply only when clicked
        (or by Ultracode), and reset to HIGH with a note when the model or
        provider changes. Resumed and restored work keeps its effort.
      </p>
    ),
  },
  'creator.resume': {
    title: 'Resume native session',
    body: (
      <p>
        Single workflow only. Lists CLI sessions already on disk for this cwd (
        <C>~/.claude/projects</C>, <C>~/.codex/sessions</C>). Pick one to continue inside Arco: the session
        remains a real native CLI session you can also resume from a terminal.
       The index follows the selected project; replies from earlier selections are ignored. Summaries and automatic titles belong to the current provider session, leaving older session titles intact. Changing the folder clears the session choice. RESUME stays blocked until a session from that folder is selected and its list has finished loading.</p>
    ),
    manualSection: 'sessions-and-resume',
  },
  // ----------------------------------------------------- ACTION BUTTONS
  'actions.review': {
    title: 'Review',
    body: (
      <p>
        Spawns an ephemeral reviewer (any provider/model) over a slice of the
        conversation. Output is a read-only artifact in the REVIEW tab.
        Reviewer permissions are restrictive (read-only / sandbox).
        Cursor reviewers receive read-only file and plan tools through a private temporary plugin folder.
      </p>
    ),
    manualSection: 'review-action',
  },
  'actions.handoff': {
    title: 'Handoff',
    body: (
      <>
        <p>HANDOFF starts a fresh session with a seed. Choose it for an unrelated task, a worker on a wrong track, a provider or model switch, or a provider without compaction. Compaction is lossy but has no fixed limit; the plan, board, goal, artifacts and Git remain outside the conversation.</p>
        <p>QUICK builds a deterministic seed. ORIGINAL WORKER writes a reflection. FRESH SUMMARIZER uses a separate worker to write the seed. STOP during preparation prevents that worker from starting; cancellation never publishes a successful handoff.</p>
      <p>Cancelled preparation and pre-warm cannot later seed or complete into a newer turn, or dispose its provider worker.</p>
      </>
    ),
    manualSection: 'handoff-action',
  },
  'actions.spawn': {
    title: 'Spawn from here',
    body: (
      <><p>
        Forks the conversation to a new tab with configurable model/effort and
        an optional new direction. The original tab continues in parallel:
        useful for "what if?" branches. HISTORY cutoffs retain the selected earlier conversation, including points outside the recent replay tail.
      </p><p>The child remains reserved through preparation and pre-warm. Revoked work cannot seed or finish into a newer child turn.</p></>
    ),
    manualSection: 'spawn-action',
  },
  // ------------------------------------------------------ REVIEW DIALOG
  'review.provider': {
    title: 'Reviewer provider',
    body: (
      <p>
        Which back-end runs the review. Pick a different family from the
        primary for genuine cross-checking: the whole value of Review is
        getting a second opinion that doesn't share the primary's blind spots.
      </p>
    ),
    manualSection: 'review-action',
  },
  'review.account': {
    title: 'Reviewer account',
    body: (
      <p>
        Which Codex profile (CODEX_HOME) runs the review. Only shown when the
        reviewer provider is Codex and you have more than one profile configured
        in Settings. Lets you bill the review to a separate account from the
        primary.
      </p>
    ),
    manualSection: 'review-action',
  },
  'review.model': {
    title: 'Reviewer model',
    body: (
      <p>
        Specific model within the chosen provider. Lower-tier reviewers are
        often fine: review is a read + critique task, lighter than the
        primary's work.
      </p>
    ),
  },
  'review.effort': {
    title: 'Reviewer effort',
    body: (
      <p>
        Reasoning budget for the reviewer. <C>medium</C>+ is recommended for
        substantive reviews; <C>low</C> tends to produce surface-level checks
        that miss subtle issues.
      </p>
    ),
  },
  'review.scope': {
    title: 'Review scope',
    body: (
      <>
        <p>Plan, full-history, current-session, checkpoint and Git-diff scopes require SUB-WORKER; member routing is disabled because it cannot resolve those selections accurately. What slice of the conversation to review:</p>
        <ul style={{ margin: '4px 0', paddingLeft: '18px' }}>
          <li><strong>LAST TURN</strong>: just the most recent agent reply.</li>
          <li><strong>LAST N TURNS</strong>: last N turns (you set N).</li>
          <li><strong>CURRENT SESSION</strong>: everything since the most recent handoff seed.</li>
          <li><strong>FULL TRANSCRIPT</strong>: the entire <C>events.jsonl</C>.</li>
          <li><strong>GIT DIFF ONLY</strong>: just <C>git diff HEAD</C>; no chat context.</li>
        </ul>
        <p>
          Optional <strong>INCLUDE GIT DIFF</strong> appends{' '}
          <C>git diff HEAD</C> to the chat slice (skipped when scope already
          implies it).
        </p>
        <p>
          When the dialog is opened from the Plan tab (REVIEW PLAN, ▷ REVIEW phase
          pill, CUSTOM REVIEW), this row is replaced with a locked plan reference
          and a MODE row (VERIFY / CRITIQUE).
        </p>
      </>
    ),
  },
  'review.dispatch': {
    title: 'Who does the review?',
    body: (
      <>
        <p>Member routing supports recent-turn scopes only. Plan, full-history, current-session, checkpoint and Git-diff scopes require SUB-WORKER.
          In a cluster, choose <C>SUB-WORKER</C> for a disposable reviewer that
          writes a markdown artifact, or choose a cluster member to send the
          review task as a real turn in that member&apos;s chat.
        </p>
        <p>
          Member-routed reviews do not auto-forward findings. Use{' '}
          <C>→ TRANSCRIPT</C> from the reviewer member when another member needs
          the result.
        </p>
      </>
    ),
    manualSection: 'cluster-routed-reviews',
  },
  'review.mode': {
    title: 'Review mode',
    body: (
      <p>
        Plan reviews can run as <C>CRITIQUE</C> (audit plan structure and
        ordering) or <C>VERIFY</C> (audit claimed-done work against the tree and
        diff). Some cluster-plan buttons lock the mode by intent.
      </p>
    ),
    manualSection: 'plan-review',
  },
  'review.cancel': {
    title: 'Cancel',
    body: <p>Closes the dialog without running a review.</p>,
  },
  'review.run': {
    title: 'Run review',
    body: (
      <p>If Ollama rejects structured synthesis after completing a review, the free-text result remains available with a fallback notice.
        Spawns the reviewer worker with the chosen scope + model. Output is
        a markdown artifact in the REVIEW tab; verdict (PASS / MINOR /
        BLOCKING) is parsed from the tail and surfaced as a chip on the
        artifact row.
      </p>
    ),
  },
  // ----------------------------------------------------- HANDOFF DIALOG
  'handoff.mode': {
    title: 'Handoff mode',
    body: (
      <>
        <p>How the handoff document is generated:</p>
        <ul style={{ margin: '4px 0', paddingLeft: '18px' }}>
          <li><strong>QUICK</strong> (default) - Arco builds the seed from recent conversation, the action digest and Git state without a writer model. The seed is bounded to 20% of the new model&apos;s context, using 4,096 tokens if its window is unknown.</li>
          <li>
            <strong>ORIGINAL WORKER</strong> - Claude and Codex resume the live
            session so the primary can write the handoff itself. For local
            providers without a resumable session, the same model re-reads the
            transcript, and falls back to the configured summarizer when that
            transcript is too large. Arco saves the reply; the writer has no project tools. Claude CLI hooks are disabled where permitted; administrator-managed hooks can still run.
          </li>
          <li>
            <strong>FRESH SUMMARIZER</strong> - an ephemeral worker reads the
            rendered transcript and writes the doc. Choose this when you want a
            different model to write the handoff.
          </li>
        </ul>
      </>
    ),
    manualSection: 'handoff-action',
  },
  'handoff.provider': {
    title: 'Post-handoff provider',
    body: (
      <p>
        Optionally swap to a different provider after the handoff. Leave
        unchanged to keep the current primary. Useful when the current
        provider is throttled or you want to try a different family on the
        rotated session. Local providers appear when enabled and when their
        model catalog is non-empty.
      </p>
    ),
  },
  'handoff.summarizer.provider': {
    title: 'Summarizer provider',
    body: (
      <p>
        Provider for the temporary worker that writes the handoff document in
        fresh-summarizer mode. This does not change the provider used by the
        rotated session.
      </p>
    ),
    manualSection: 'handoff-action',
  },
  'handoff.summarizer.model': {
    title: 'Summarizer model',
    body: (
      <p>
        Model for the temporary handoff-writer worker. Use a model that can read
        the transcript reliably; the new session&apos;s model is configured
        separately below.
      </p>
    ),
    manualSection: 'handoff-action',
  },
  'handoff.summarizer.effort': {
    title: 'Summarizer effort',
    body: (
      <p>
        Effort level for the handoff writer. The default is MEDIUM unless a saved choice or an explicit selection says otherwise. Higher effort can
        produce a more careful handoff document, but it does not affect the
        rotated session&apos;s effort.
      </p>
    ),
    manualSection: 'handoff-action',
  },
  'handoff.account': {
    title: 'Post-handoff account',
    body: (
      <p>
        Which Codex profile (CODEX_HOME) the rotated session runs under. Only
        shown when the post-handoff provider is Codex and you have more than one
        profile configured in Settings.
      </p>
    ),
    manualSection: 'handoff-action',
  },
  'handoff.model': {
    title: 'Post-handoff model',
    body: <p>Model for the new session. Defaults to the current model.</p>,
  },
  'handoff.effort': {
    title: 'Post-handoff effort',
    body: <p>Effort level for the new session. Defaults to the current effort.</p>,
  },
  'handoff.cancel': {
    title: 'Cancel',
    body: <p>Closes without rotating the session.</p>,
  },
  'handoff.confirm': {
    title: 'Rotate (or Rotate & Swap)',
    body: (
      <p>
        Generates the handoff document and rotates the tab to a fresh
        session. If you changed the provider/model/effort, the button reads{' '}
        <C>ROTATE & SWAP</C>: both happen atomically.
      </p>
    ),
  },
  // ------------------------------------------------------- SPAWN DIALOG
  'spawn.name': {
    title: 'New workflow name',
    body: <p>Label for the new tab. Defaults to a derivative of the parent's name.</p>,
  },
  'spawn.provider': {
    title: 'Spawned-tab provider',
    body: (
      <p>
        Provider for the forked tab: different from the parent if you want
        to try a different family on the side path. The original tab continues
        unchanged.
      </p>
    ),
    manualSection: 'spawn-action',
  },
  'spawn.account': {
    title: 'Spawned-tab account',
    body: (
      <p>
        Which Codex profile (CODEX_HOME) the forked tab runs under. Only shown
        when the spawned-tab provider is Codex and you have more than one
        profile configured in Settings.
      </p>
    ),
    manualSection: 'spawn-action',
  },
  'spawn.model': {
    title: 'Spawned-tab model',
    body: (
      <p>
        Model for the forked tab. For Cursor, pick the family then its effort
        (with optional FAST / THINK): effort is baked into the model id.
      </p>
    ),
  },
  'spawn.effort': {
    title: 'Spawned-tab effort',
    body: <p>Effort level for the forked tab. Cursor has none here: it's baked into the model id (set it in the MODEL picker).</p>,
  },
  'spawn.direction': {
    title: 'New direction (optional)',
    body: (
      <p>
        Free-form text appended after the handoff doc in the new tab's seed.
        Use it to redirect the forked agent: <em>"focus on the migration
        path; ignore the test refactor"</em>. Leave blank to let it pick up
        where the parent left off.
      </p>
    ),
  },
  'spawn.plan': {
    title: 'Include attached plan',
    body: (
      <p>
        Whether the parent's attached plan (if any) carries over to the new
        tab. Toggle off when the side branch shouldn't be bound by the
        parent's plan.
      </p>
    ),
  },
  'spawn.cluster': {
    title: 'Cluster target',
    body: (
      <p>
        For cluster phase spawns, the spawned workflow stays tied to the same
        cwd and starts from the selected phase block. Use this when a phase
        should become its own focused worker. Checked, it joins the cluster as a
        member and the role, tier, focus and access fields appear.
      </p>
    ),
    manualSection: 'cluster-plan',
  },
  'spawn.member': {
    title: 'Spawn as a cluster member',
    body: (
      <p>
        With "Spawn into cluster" checked, set the new member's identity here: ROLE,
        TIER, FOCUS and ACCESS, the same as ADD WORKER. They start empty; the source's
        role is not copied. DIRECTOR is unavailable when the cluster already has one.
        FOCUS starts as the first line of NEW DIRECTION until you edit it, and the name
        defaults to the role plus the next free number. Spawning into a cluster is
        available when the new tab uses Claude or Codex.
      </p>
    ),
    manualSection: 'cluster-plan',
  },
  'spawn.cancel': {
    title: 'Cancel',
    body: <p>Closes without spawning a new tab.</p>,
  },
  'spawn.confirm': {
    title: 'Spawn',
    body: (
      <p>
        The current primary self-reflects with full session context, writes a
        handoff doc, and a new tab opens with that doc + your new direction
        as its seed. The parent tab is untouched.
      </p>
    ),
  },
  // ------------------------------------------------ PLAN COMPOSER + TAB
  'plan.draft-review': {
    title: 'Draft → I\'ll review',
    body: (
      <p>
        The agent's next reply will be its draft of the plan. A banner
        appears offering <C>SAVE & ATTACH</C> and <C>REFINE</C>: read first,
        ask for changes, save only if happy. Slower but inspection-friendly.
      </p>
    ),
    manualSection: 'plan-creation',
  },
  'plan.public-project': {
    title: 'This project is public (or will be)',
    body: (
      <p>
        When ticked, the plan draft also asks for a "Privacy and public safety"
        section of standing rules. Unticked, the request is unchanged. The choice
        is saved for this project and can be changed in plan controls. Starting or saving a plan refreshes the saved choice without reposting an older browser value. After a failed checkbox save, select RETRY SAVE below it before starting the plan. Agent-created plans use the saved choice, or the confirmed-public remote suggestion when no choice is saved; a missing section offers INSERT GUARDRAILS for review. It is pre-ticked
        only when the Git remote is confirmed public on GitHub, with the reason
        shown. A remote on another host, or a GitHub repository whose visibility is unknown, shows only a hint naming the host. Your own choice always wins. A newer choice received from another tab is kept when an older read finishes.
      </p>
    ),
    manualSection: 'public-project',
  },
  'plan.public-project-retry': {
    title: 'Retry the public-project choice',
    body: <p>Resend the displayed choice after its save failed. Plan startup stays blocked until the save succeeds. The checkbox does not need to be toggled again.</p>,
    manualSection: 'public-project',
  },
  'plan.insert-guardrails': {
    title: 'Insert guardrails',
    body: (
      <p>
        <C>INSERT GUARDRAILS</C> adds a "Privacy and public safety" section before
        the first phase as an unsaved edit. Review it, then save. Disabled when
        the plan already has that section.
       Plan fields and changes to the draft wait while its save is pending.</p>
    ),
    manualSection: 'public-project',
  },
  'project-state.notice': {
    title: 'Project state in Git',
    body: (
      <p>
        Git is tracking Arco's <C>.arco</C> folder, or the folder is not ignored.{' '}
        <C>RESTORE IGNORE FILE</C> writes the default ignore file (an edited one
        is kept as a backup). <C>STOP TRACKING</C> removes the folder from Git's
        index and keeps the files; commit afterwards, and note that anything
        already pushed stays in the remote's history. Files of a skill shared
        with <C>SHARE WITH REPOSITORY</C> do not count: <C>STOP TRACKING</C>{' '}
        leaves them tracked and <C>RESTORE IGNORE FILE</C> keeps the share
        lines. Both act only on projects
        in the PROJECTS list, and refuse when <C>.arco</C> or its ignore file is
        a link. <C>DISMISS</C> hides this for the project.
      </p>
    ),
    manualSection: 'public-project',
  },
  'plan.draft-autosave': {
    title: 'Draft & auto-save',
    body: (
      <p>
        The agent's reply is saved and attached as this tab's plan with no
        review step. Faster, but there is no chance to change the draft
        first. <strong>Cluster members:</strong> auto-save is not used; the
        draft opens in the review banner, where <C>ATTACH TO CLUSTER</C> sets
        it as the cluster's shared PLAN, or <C>REFINE</C> and{' '}
        <C>DISCARD</C> apply.
      </p>
    ),
  },
  'plan.checkbox': {
    title: 'Plan checkbox',
    body: <><p>Marks this task done or not done. The save checks the plan version you saw. If another edit arrived first, it is kept and a conflict asks for a fresh review before retrying.</p><p>Plan files and reference documents must be ordinary files inside their storage folders. Linked files or folders are refused; replace the link before retrying.</p></>,
    manualSection: 'plan-checklists',
  },
  'plan.new': {
    title: 'New plan',
    body: (
      <><p>
        Open the inline plan editor: type a title and body, then click{' '}
        <C>CREATE & ATTACH</C> to save and attach in one step. Bypasses the
        agent draft flow.
       Plan fields and changes to the draft wait while its save is pending.</p><p>Plan files and reference documents must be ordinary files inside their storage folders. Linked files or folders are refused; replace the link before retrying.</p><p>Claude Native and local-provider Agent tabs with a workflow folder can also create and attach plans through their plan tools. Local tools require AUTO mode.</p></>
    ),
  },
  'plan.edit': {
    title: 'Edit plan',
    body: (
      <><p>
        Opens the title + body editor for the active plan. Save commits to{' '}
        <C>.arco/plans/&lt;id&gt;.md</C>; the body re-injects on the next
        turn so the agent sees the edits. HTTP replacement uses the operator browser session; cookie-free agent plan tools cannot replace the body.
       Plan fields and changes to the draft wait while its save is pending.</p><p>Plan files and reference documents must be ordinary files inside their storage folders. Linked files or folders are refused; replace the link before retrying.</p></>
    ),
  },
  'plan.detach': {
    title: 'Detach plan',
    body: (
      <p>
        Removes the plan from this workflow. The plan stays on disk and can
        be reattached later: detach just stops it from being injected into
        the next turn's prompt.
      </p>
    ),
  },
  'plan.review-plan': {
    title: 'Review plan (critique)',
    body: (
      <p>
        Spawns a reviewer over the entire plan in <C>CRITIQUE</C> mode:
        every item is shown with check state preserved, and the reviewer
        evaluates the <em>plan itself</em>: gaps, ordering, missing
        considerations. Use <C>VERIFY WORK</C> for the audit-the-claims
        flow. The dialog's MODE row lets you flip to VERIFY before running.
      </p>
    ),
    manualSection: 'plan-review',
  },
  'plan.verify-work': {
    title: 'Verify work',
    body: (
      <p>
        Spawns a reviewer over the plan in <C>VERIFY</C> mode with
        <C>INCLUDE GIT DIFF</C> pre-ticked. Only <C>[x]</C> items are
        shown, framed as the worker's claimed-completed work; the reviewer
        cross-checks each claim against the actual <C>git diff HEAD</C>
        and the code in the tree using its tools. Partial-completion
        signals (a <C>[x]</C> parent with <C>[ ]</C> subtasks) get flagged.
      </p>
    ),
    manualSection: 'plan-review',
  },
  'plan.custom-review': {
    title: 'Custom review',
    body: (
      <p>
        Opens a picker that lets you choose any subset of plan items
        (across phases) to send to the reviewer. Useful when only a few
        scattered items are relevant: e.g., reviewing one cross-cutting
        feature spread across multiple phases. Mode (VERIFY / CRITIQUE) is
        chosen on the resulting dialog.
      </p>
    ),
    manualSection: 'plan-review',
  },
  'plan.refs': {
    title: 'Reference docs',
    body: (
      <><p>
        Long-form docs attached to this plan (<C>.arco/plans/&lt;id&gt;.refs/</C>).
        Keep the plan a checklist and link detail from a task as{' '}
        <C>[label](ref:slug)</C>: the link renders as a chip that opens the doc.
        <C> + REF</C> adds one; the viewer edits or deletes it. Agents write refs
        with <C>plan_ref_write</C>, and are told to read the refs a task links
        before working it. Reference deletion through HTTP requires the operator browser session; agent reference reads and writes remain available.
       Lists follow the selected plan. Opening a link checks the saved document before offering creation; creating a ref never replaces an existing one. Fields and Cancel wait while a save is pending.</p><p>Plan files and reference documents must be ordinary files inside their storage folders. Linked files or folders are refused; replace the link before retrying.</p><p>Claude Native and local-provider Agent tabs can list, read and write references through the same plan tools. Local tools require AUTO mode.</p><p>Cursor read-only reviewers with a workflow folder can list plans and list or read references. They cannot write plans or references through these tools.</p></>
    ),
    manualSection: 'plan-refs',
  },
  'plans.project-group': {
    title: 'Project plans',
    body: <p>Expand or collapse this project's plans. The choice is remembered in this browser. Search opens matching projects.</p>,
    manualSection: 'plans-library',
  },
  'plans.attach-target': {
    title: 'Attach this plan',
    body: <p>Attach this plan to the tab or cluster that opened ALL PLANS. Only plans from the same project can be attached.</p>,
    manualSection: 'plans-library',
  },
  'plan.chooser-preview': {
    title: 'Preview a plan',
    body: <p>Load and show this plan before attaching it. Other plan bodies stay unloaded. Preview does not change the plan.</p>,
    manualSection: 'plans-library',
  },
  'plan.choose': {
    title: 'Choose a plan',
    body: <p>Open the project plan chooser to preview or attach another plan. The current plan stays in the project when detached.</p>,
    manualSection: 'plans-library',
  },
  'plan.chooser-attach': {
    title: 'Attach a plan',
    body: <p>The list includes task counts and scrolls within half the window height. Switching window focus keeps it in place. In an existing tab or cluster, attach this plan now. In the cluster creator, select it for attachment when CREATE CLUSTER is submitted.</p>,
    manualSection: 'plans-library',
  },
  'plan.chooser-finished': {
    title: 'Show finished plans',
    body: <p>Show or hide completed plans from this folder.</p>,
    manualSection: 'plans-library',
  },
  'plan.chooser-genesis': {
    title: 'Draft a plan in Genesis',
    body: <p>Open Genesis for this project, then return to the plan choice when the plan is saved.</p>,
    manualSection: 'plans-library',
  },
  'plan.chooser-create': {
    title: 'Create and attach',
    body: <p>Save the new plan in this project and choose it for the current target. Later edits or a reopened form stay available while saving. If the form changed, choose the saved plan separately to attach it.</p>,
    manualSection: 'plans-library',
  },
  'plan.chooser-reopen': {
    title: 'Reopen a finished plan',
    body: <p>Move this plan back to the open list. Reopening does not attach it.</p>,
    manualSection: 'plans-library',
  },
  'plan.chooser-title': {
    title: 'Plan title',
    body: <p>Name the plan before saving it in this project.</p>,
    manualSection: 'plans-library',
  },
  'plan.chooser-body': {
    title: 'Plan body',
    body: <p>Write the plan and its checklist. Reference documents can hold longer details.</p>,
    manualSection: 'plans-library',
  },
  'plan.chooser-cancel': {
    title: 'Cancel plan creation',
    body: <p>Close the new-plan form without saving it.</p>,
    manualSection: 'plans-library',
  },
  'plan.chooser-dismiss': {
    title: 'Dismiss the saved-plan offer',
    body: <p>Hide this offer. The saved plan remains available in the project.</p>,
    manualSection: 'plans-library',
  },
  'plans.probably-finished': {
    title: 'Probably finished',
    body: <p>Unattached plans with all boxes checked or no edits for 30 days appear here. MARK DONE moves a plan to Completed; nothing changes until clicked.</p>,
    manualSection: 'plans-library',
  },
  'storage.lens': {
    title: 'STORAGE',
    body: <p>Where disk space goes: every project Arco knows about and Arco's own folder, largest first, with each one's headings (conversation logs, artifacts, worktrees, caches and more). Nothing is changed without a click, and plans are never touched.</p>,
    manualSection: 'storage-view',
  },
  'storage.measure': {
    title: 'MEASURE AGAIN',
    body: <p>Measures every project and Arco's folder again, read-only. Large folders take a while. Totals shown after an action stay as measured until you measure again.</p>,
    manualSection: 'storage-view',
  },
  'storage.budget-notice': {
    title: 'Disk budget notice',
    body: <p>Shown when Arco's storage passes the disk budget in STORAGE SETTINGS. Archive or delete closed conversations, or raise the budget. The notice only reports; it removes nothing.</p>,
    manualSection: 'storage-view',
  },
  'storage.project': {
    title: 'Project row',
    body: <p>A project's saved state and its size. Open it to list its conversations and archives with ARCHIVE, RESTORE, DELETE and EMPTY SCRATCH. Worktrees and caches are shown but have no clean-up action here. Local-model file snapshots count as conversation files. Repeated reads reuse identical saved content; older snapshots remain readable.</p>,
    manualSection: 'storage-view',
  },
  'storage.home': {
    title: "Arco's folder",
    body: <p>Arco's own folder: voice and media models, caches and browser profiles, provider account data, shared checkpoints, task worktrees, saved clusters and logs. Shown for information; it has no clean-up action here.</p>,
    manualSection: 'storage-view',
  },
  'storage.compress-logs': {
    title: 'COMPRESS OLD LOGS',
    body: <p>Seals the conversation logs of this project's closed conversations into compressed pieces, after a confirmation. Nothing is deleted and every view still shows the whole history. Open or working conversations and logs under 1 MiB are skipped. A log that another program holds open (Windows) keeps its full plain copy and finishes on the next use.</p>,
    manualSection: 'storage-view',
  },
  'storage.keep': {
    title: 'KEEP',
    body: <p>KEEP protects the whole conversation after confirmation. Kept items are skipped by ARCHIVE, DELETE, EMPTY SCRATCH and size warnings. "Kept" means the whole conversation is kept, so ARCHIVE and DELETE are off. If the KEEP list cannot be read, those actions stop instead of acting. UNKEEP undoes it.</p>,
    manualSection: 'storage-view',
  },
  'storage.unkeep': {
    title: 'UNKEEP',
    body: <p>Removes KEEP after confirmation; no file is changed. In STORAGE it removes every KEEP mark of the conversation. In OUTPUTS, where a kept artifact shows "Kept", it removes the mark that covers that file: its own, the kept folder above it, or the whole conversation, as the question says. Archive, delete, EMPTY SCRATCH and size warnings then include those items again.</p>,
    manualSection: 'storage-view',
  },
  'storage.archive': {
    title: 'ARCHIVE',
    body: <p>Packs a closed conversation into one compressed file in the project, after a confirmation, and checks it before removing anything. Kept items stay in place. RESTORE brings it back. Off while the conversation is open or working. Reopening or writing to the conversation during archiving cancels source removal; close it and retry.</p>,
    manualSection: 'storage-view',
  },
  'storage.restore': {
    title: 'RESTORE',
    body: <p>Unpacks an archived conversation back into the project after checking the whole archive. A file that already exists is never overwritten; the restore then stops without writing anything.</p>,
    manualSection: 'storage-view',
  },
  'storage.delete': {
    title: 'DELETE',
    body: <p>Permanently removes a closed conversation, after a confirmation: its log, artifacts, checkpoints, search entry and archive. Kept items stay. There is no undo; ARCHIVE is the restorable choice.</p>,
    manualSection: 'storage-view',
  },
  'storage.empty-scratch': {
    title: 'EMPTY SCRATCH',
    body: <p>Deletes the conversation's scratch folder, where agents put large temporary files, after a confirmation. Kept items stay. Off while the conversation is working.</p>,
    manualSection: 'storage-view',
  },
  'storage.auto-archive': {
    title: 'Auto-archive',
    body: <p>Off by default. When on, a daily run archives conversations closed for more than the chosen number of days, except kept ones. It never deletes. Activity is checked again before source removal; a reopened or changed conversation stays live.</p>,
    manualSection: 'storage-view',
  },
  'storage.budget': {
    title: 'Disk budget',
    body: <p>Shows the disk budget notice when Arco's storage passes this many GiB (100 by default). A daily read-only measurement keeps it current; untick to turn the notice off.</p>,
    manualSection: 'storage-view',
  },
  'plans.mark-done': {
    title: 'Mark plan done',
    body: <p>Moves this plan to Completed. Reopen it from the plan details if work resumes. HTTP completion requires the operator browser session.</p>,
    manualSection: 'plans-library',
  },
  'plans.versions': {
    title: 'Plan versions',
    body: <p>Expand repeated titles to see each version and its date. A group with an attached version stays in the normal list; its unattached versions offer MARK DONE. The plans stay separate.</p>,
    manualSection: 'plans-library',
  },
  'plans.in-use': {
    title: 'Plan in use',
    body: <p>Names the tabs or clusters attached to this plan.</p>,
    manualSection: 'plans-library',
  },
  'plan.library': {
    title: 'All plans',
    body: (
      <p>
        Opens the plans library in ARTIFACTS. A plan from this project can be
        attached to the tab or cluster that opened the library. Checkbox saves
        refuse a changed plan instead of replacing later edits.
      </p>
    ),
    manualSection: 'plans-library',
  },
  'plan.move': {
    title: 'Move plan to another project',
    body: (
      <><p>
        Relocates the plan's <C>.md</C> file from the current tab's project
        directory to a different one. Pick from the list of other open
        tabs, or paste an absolute path. Plan id is preserved; attachments
        in the source cwd are dropped (they refer to a workflow that won't
        exist at the destination). The source tab's PLAN tab clears once
        the move completes.
       A refused move keeps every source attachment unchanged.</p><p>Plan files and reference documents must be ordinary files inside their storage folders. Linked files or folders are refused; replace the link before retrying.</p></>
    ),
  },
  'plan.mark-complete': {
    title: 'Mark complete',
    body: (
      <><p>
        Archives the plan and auto-detaches it from any attached workflows.
        Lives in the completed list (toggle to view); reopenable if needed.
      </p><p>Plan files and reference documents must be ordinary files inside their storage folders. Linked files or folders are refused; replace the link before retrying.</p></>
    ),
  },
  'plan.delete': {
    title: 'Delete plan',
    body: (
      <><p>
        Permanently deletes the plan file from disk. Confirmation required. HTTP deletion also requires the operator browser session; cookie-free plan tools cannot delete it.
        Use <C>MARK COMPLETE</C> instead if you want to keep the history.
      </p><p>Plan files and reference documents must be ordinary files inside their storage folders. Linked files or folders are refused; replace the link before retrying.</p></>
    ),
  },
  // -------------------------------------------------------- CHAT SURFACES
  'chat.message.system': {
    title: 'System notice',
    body: (
      <p>
        Out-of-band status from the server: rate-limit warnings, retry
        backoffs, calibration completion, threshold crossings, the
        concurrent-writer guard, etc. Italic, dimmer than chat messages.
      </p>
    ),
  },
  'chat.seed-pill.source': {
    title: 'Earlier conversation',
    body: <p>From on the latest seed opens the saved source in HISTORY through the handoff boundary. Earlier sources follow a chain of handoffs. Closing a tab keeps its history; deleting or archiving it makes the link unavailable. Show full history removes the display filter. Source links are absent in Chat, incognito, BLIND and ISOLATED conversations.</p>,
    manualSection: 'handoff-action',
  },
  'chat.seed-pill.handoff': {
    title: 'Handoff seed',
    body: (
      <p>
        The first user message in a handoff-rotated session, carrying the
        handoff document. Collapsed to a one-line pill so a 300-line
        document doesn't fill the chat. Click to expand the full body.
      </p>
    ),
    manualSection: 'handoff-action',
  },
  'chat.seed-pill.spawn': {
    title: 'Spawn seed',
    body: (
      <p>
        The first user message in a spawned tab, carrying the parent's
        reflection + your "new direction" if you supplied one. Same one-line
        pill as Handoff seeds.
      </p>
    ),
    manualSection: 'spawn-action',
  },
  'chat.load-earlier': {
    title: 'Load earlier messages',
    body: (
      <p>
        Chat hydrates tail-first: the last 200 messages are visible on
        first open. Click here to page further back. Scroll position is
        preserved across loads.
      </p>
    ),
  },
  'chat.jump-to-bottom': {
    title: 'Jump to latest',
    body: (
      <p>
        Appears when you've scrolled up. Click to snap back to the most
        recent message. Auto-hides once you're already at the bottom.
      </p>
    ),
  },
  'chat.prior-sessions': {
    title: 'Prior sessions',
    body: (
      <p>
        Collapsed history of earlier sessions in this tab: every Handoff
        creates a new session, and the old ones live behind this toggle.
        Click to expand and see the chat from those sessions inline.
      </p>
    ),
  },
  // -------------------------------------------------------- GIT DIALOG
  'gitdialog.diff-preview': {
    title: 'Working-tree diff preview',
    body: (
      <p>
        Expands the exact <C>git diff</C> vs <C>HEAD</C> for this repo so you
        can confirm what's about to be committed before dispatching the GIT
        prompt. Collapsed by default; per-file with a <C>UNIFIED</C> /{' '}
        <C>SPLIT</C> toggle. Same renderer as the Files <C>CHANGES</C> sub-tab.
      </p>
    ),
    manualSection: 'changes-diff',
  },
  'gitdialog.other-work': {
    title: 'Other work',
    body: (
      <>
        <p>
          A read-only list of this repository&apos;s other worktrees and local
          branches, read when you press <C>SHOW OTHER WORK</C>. Each row shows the
          branch, the tab working there if any, how many commits it is ahead of
          and behind the default branch, the number of uncommitted files in a
          checked-out worktree, and its open pull request when the GitHub CLI is
          available. Without it, or offline, pull requests are simply not shown.
        </p>
        <p>
          <C>VIEW CHANGES</C> closes this dialog and opens the FILES tab&apos;s
          CHANGES view on that worktree through the existing worktree picker.
          Reopen GIT afterwards and your choices, notes and this section are
          still there. Nothing here merges, deletes or switches anything.
        </p>
      </>
    ),
    manualSection: 'composer-git',
  },
  // -------------------------------------------------------- FILES VIEW
  'files.refresh': {
    title: 'Refresh file tree',
    body: (
      <p>
        Re-reads the cwd from disk. Useful after the agent ran a command
        that created or moved files outside Arco's view (e.g. shell-out
        `git checkout`).
      </p>
    ),
  },
  'files.open-terminal': {
    title: 'Open terminal here',
    body: (
      <p>
        Opens the floating terminal in this folder (the Files root). You can
        also <strong>right-click any directory</strong> in the tree to root a
        terminal there. The shell outlives the window: closing detaches,
        reopening re-attaches. Operator-only; never an agent surface. See "The
        integrated terminal".
      </p>
    ),
    manualSection: 'integrated-terminal',
  },
  'terminal.kill': {
    title: 'Kill the shell',
    body: (
      <p>
        Ends the PTY session: the process tree, not just the window. This is
        the <em>only</em> action that stops a session (closing the window just
        detaches; the shell keeps running). A shell that does not respond to
        the hangup is forcibly stopped. The terminal's <em>commands'</em>{' '}
        effects are yours, as in any shell: Arco does not sandbox the operator.
      </p>
    ),
    manualSection: 'integrated-terminal',
  },
  'terminal.new': {
    title: 'New shell session',
    body: (
      <p>
        Opens a <strong>fresh</strong> shell session in a new floating window
        (§K2: several sessions per workflow: a dev server in one, commands in
        another). Unlike the header / Files launchers, this always spawns a new
        session rather than re-attaching the existing one. Each session outlives
        its window; only <em>Kill</em> ends it.
      </p>
    ),
    manualSection: 'integrated-terminal',
  },
  'terminal.popout': {
    title: 'Pop out',
    body: (
      <p>
        Detaches this shell into its own OS-level browser window (drag it to a
        second monitor / tile it). The pop-out attaches to the{' '}
        <em>same live session</em>: typing in either window drives the same
        shell (§K2 multi-listener). It never spawns a new session, and closing
        the pop-out just detaches that view; the shell keeps running until you{' '}
        <em>Kill</em> it. This in-app window stays open too. The session is gone
        if the server restarts (PTYs don't survive one).
      </p>
    ),
    manualSection: 'integrated-terminal',
  },
  'terminal.switcher': {
    title: 'Session switcher',
    body: (
      <><p>
        Picks which shell session this window views. Sessions are
        workflow-scoped, long-lived resources; two windows may point at the same
        session (both render the same live output). The list survives a client
        reconnect: the server re-sends it on rehydrate.
       Refreshing this workflow does not detach other workflows' terminal windows.</p><p>A restarted server sends an empty live-session list, clearing old selector entries.</p></>
    ),
    manualSection: 'integrated-terminal',
  },
  'terminal.send-to-composer': {
    title: 'Send to composer',
    body: (
      <p>
        Inserts the <em>selected</em> terminal output into this workflow's
        composer as a quoted block (a fenced dump under a{' '}
        <C>Terminal output:</C> header). Enabled only when text is selected. It{' '}
        <em>appends</em> to whatever you were already typing: it never clobbers
        the draft: and it is <em>inserted, not sent</em>: you still press send.
        This is the operator-only bridge for "here's the stack trace I just got"
        without giving the agent terminal control or auto-feeding it output.
      </p>
    ),
    manualSection: 'integrated-terminal',
  },
  'chat.run-in-terminal': {
    title: 'Run in terminal',
    body: (
      <p>
        Appears on shell code blocks (<C>bash</C> / <C>sh</C> /{' '}
        <C>shell</C> / <C>console</C> / <C>zsh</C>) in an
        agent's reply. Clicking it opens the floating terminal for this workflow
        and <strong>pre-fills the command on the prompt: it does NOT run it</strong>.
        You review and edit it, then press Enter yourself. The agent only{' '}
        <em>suggested</em> the command; nothing executes without your keystroke.
        Operator-in-the-loop by design.
      </p>
    ),
    manualSection: 'integrated-terminal',
  },
  'fileviewer.toggle-raw': {
    title: 'Raw / Formatted toggle',
    body: (
      <p>
        Switches between syntax-highlighted view and the raw file bytes.
        Formatted is the default for code/markdown; raw is useful when
        you suspect the file's actual content differs from what the
        renderer shows (encoding issues, BOM markers, etc.).
      </p>
    ),
    manualSection: 'help-system',
  },
  'fileviewer.toggle-edit': {
    title: 'Edit / Lock toggle',
    body: (
      <><p>
        Files open <strong>Locked</strong> (read-only) by default so you can't
        modify one by accident. Click <strong>EDIT</strong> to make the buffer
        writable in a CodeMirror editor; a <strong>SAVE</strong> button appears
        and an <strong>● UNSAVED</strong> marker shows once you've typed. Save
        writes the file (path-escape guarded server-side) and flips back to
        Locked if no newer edits were typed while saving. Newer edits stay visible and unsaved; <strong>LOCK</strong> discards edits and returns to the viewer.
        Closing with unsaved edits asks first. Only shown for text files opened
        from the FILES explorer.
      </p><p>File previews, downloads and file/image saves verify the opened file and its parent folder before reading or changing content. If validation detects a changed file or parent folder when opening the file, select the file again and retry. These checks are not an operating-system sandbox.</p><p>On Windows, file paths with trailing dots or spaces in a component, or alternate data stream separators, are refused. Use ordinary file and folder names. Drive-letter paths and network shares remain supported.</p></>
    ),
    manualSection: 'editing-a-file',
  },
  // -------------------------------------------------------- AI-EDIT (A7)
  'aiedit.ask': {
    title: 'Ask AI (scoped edit)',
    body: (
      <p>
        Select a region in the editor (or use <strong>SELECT ALL</strong> for a
        whole-doc edit), then click this to ask an AI agent to rewrite{' '}
        <em>just that selection</em>. You type an instruction and pick the agent
        with the RUN AS picker; the agent proposes a replacement you preview as a
        diff. The agent has no write access: Accept changes the buffer only, and
        the existing SAVE is the only thing that writes to disk.
      </p>
    ),
    manualSection: 'ai-edit',
  },
  'aiedit.selectall': {
    title: 'Select all (whole-doc edit)',
    body: (
      <p>
        Selects the entire document so an <strong>✦ ASK AI</strong> request
        rewrites the whole file (e.g. "fix all formatting/spelling"). Otherwise
        the edit is scoped to whatever you highlighted.
      </p>
    ),
    manualSection: 'ai-edit',
  },
  'aiedit.instruction': {
    title: 'Edit instruction',
    body: (
      <p>
        What you want the agent to do to the selection: "tighten this
        paragraph", "fix the formatting", "rewrite in my voice". One bounded turn
        per proposal; no back-and-forth loop. The agent returns text only.
       The proposal stays attached to this editor request. Unsent or disconnected pending requests show an error; retry PROPOSE EDIT when connected.</p>
    ),
    manualSection: 'ai-edit',
  },
  'aiedit.accept': {
    title: 'Accept proposal',
    body: (
      <p>
        Splices the agent's proposed replacement into the editor{' '}
        <strong>buffer</strong> at exactly the selected range: nothing on disk
        yet. The existing <strong>SAVE</strong> button persists it through the
        path-guarded write endpoint. Reversible: Reject before Accept, and the
        save itself is checkpoint-covered.
      </p>
    ),
    manualSection: 'ai-edit',
  },
  'aiedit.reject': {
    title: 'Reject proposal',
    body: (
      <p>
        Discards the proposed replacement and leaves the buffer untouched. Select
        a different region or revise the instruction and try again.
      </p>
    ),
    manualSection: 'ai-edit',
  },
  // -------------------------------------------------------- ACTIVITY VIEW
  'activity.worker-card': {
    title: 'Worker card',
    body: (
      <p>
        One short-lived worker process spawned by a primitive (reviewer,
        handoff summarizer, primary turn). Shows status, last tool, model.
        A worker on another provider than Claude shows its letter: C Codex,
        X Cursor, O Ollama, L llama.cpp. Click to open the detailed view with
        full output and event log. The token badge shows output usage. Claude worker
        usage totals are not context readings, so the context badge shows -.
      </p>
    ),
  },
  // -------------------------------------------------- SHORTCUT CHEAT SHEET
  'shortcuts.cheatsheet.close': {
    title: 'Close the cheat sheet',
    body: (
      <p>
        Dismisses the keyboard-shortcut cheat sheet. Open it any time with{' '}
        <C>Ctrl/Cmd+?</C> (or the <C>Keyboard shortcuts</C> command in the
        palette); <C>Esc</C> also closes it. The list is read-only: a
        documentation surface, not the handlers themselves.
      </p>
    ),
    manualSection: 'shortcuts',
  },
  // ------------------------------------------------- SYSTEM MODAL / DIAGNOSTICS
  'system.tab.actions': {
    title: 'System · Actions',
    body: (
      <p>
        Lifecycle controls for the Arco server: <C>RESTART</C> (stop + come
        back up; this tab reconnects automatically) and <C>QUIT</C> (stop the
        server and close the tab). Both confirm first, and warn if workflows are
        running.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'system.tab.diagnostics': {
    title: 'System · Diagnostics',
    body: (
      <p>
        Grouped, read-only status checks answering "what's actually working on
        this machine?": Core, Providers, Local Tools, Workbench, Storage, and Security &amp; Exposure. Each
        row expands to a detail line + remediation hint. Operator-triggered: the
        report runs on open and on <C>↻ REFRESH</C>, never on a timer. Tool detection honors Windows executable suffixes.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'diagnostics.refresh': {
    title: 'Refresh diagnostics',
    body: (
      <p>
        Re-runs every diagnostic probe and replaces the report. Each probe is a
        deterministic, read-only check (a version flag, a directory round-trip, a
        daemon ping); nothing here mutates state. Probes run concurrently and are
        individually time-bounded, so one slow binary can't hang the panel.
       Failed or invalid reads show an error. <C>↻ REFRESH</C> retries.</p>
    ),
    manualSection: 'diagnostics',
  },
  'diagnostics.check-row': {
    title: 'Diagnostic check',
    body: (
      <p>
        One probe result. The glyph + status colour is the verdict -{' '}
        <strong>OK</strong> (green) the thing works, <strong>WARN</strong>{' '}
        (amber) degraded or an optional dependency is absent,{' '}
        <strong>ERROR</strong> (red) something that should work doesn't,{' '}
        <strong>SKIPPED</strong> (grey) not probed on this platform/config. Click
        to expand the detail line, any remediation hint, and the check id.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'diagnostics.support-bundle': {
    title: 'Copy support bundle',
    body: (
      <p>
        Copies a paste-ready, <strong>redacted</strong> snapshot of this machine
        (the diagnostics report, Arco version, git rev, platform and runtime)
        to the clipboard, ready to drop in an issue or hand to another agent.
        Built from a safe-field <em>allowlist</em>: home paths collapse to{' '}
        <C>~</C>, other absolute paths (including Windows drive and UNC paths) use basename placeholders, and a secret-scrub strips any token-shaped string. It contains{' '}
        <strong>no</strong> tokens, env secrets, or private paths. If the
        clipboard is blocked, the text appears in a selectable box to copy by
        hand.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'system.tab.model-health': {
    title: 'System · Model Health',
    body: (
      <p>
        A model-operator readout answering "what can I run now / what's running /
        what failed last time / is my config stale?". Three subsystems:{' '}
        <strong>Ollama</strong>, <strong>llama.cpp</strong>, and{' '}
        <strong>model files</strong>, each with a roll-up status and concrete
        fields. Read-only and operator-triggered: it fetches on open and on{' '}
        <C>↻ REFRESH</C>, never on a timer, and never spawns a model.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'model-health.refresh': {
    title: 'Refresh model health',
    body: (
      <p>
        Re-runs the three subsystem probes (Ollama daemon ping + tags, the
        llama.cpp lifecycle-manager snapshot + catalog + log tail, the hardware
        probe + fit scoring). All read-only; one failing subsystem
        degrades to a <strong>WARN</strong> sub-report rather than blanking the
        panel.
       Failed or invalid reads show an error. <C>↻ REFRESH</C> retries.</p>
    ),
    manualSection: 'diagnostics',
  },
  'model-health.ollama': {
    title: 'Ollama health',
    body: (
      <p>
        The Ollama daemon: resolved base URL, whether it's reachable, the
        installed-model count + names (with tools/vision/thinking capability
        hints), and the server version when cheaply available. A daemon that
        isn't running is a <strong>WARN</strong>, not an error: you may simply
        not use Ollama.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'model-health.llamacpp': {
    title: 'llama.cpp health',
    body: (
      <p>
        The llama.cpp lifecycle manager: the <C>llama-server</C> binary path (uses <C>ARCO_LLAMACPP_BIN</C> when configured; otherwise searches PATH),
        registered loadouts (from <C>~/.arco/llamacpp.json</C>), the manager
        state (idle/loading/ready/failed), the currently-loaded alias + port +
        pid, the <strong>last launch args</strong>, and a tail of the last
        <C> ~/.arco/llamacpp.log</C> stderr. A dead server clears ready state and can be loaded again on the next request. A failed last launch is the one
        <strong> ERROR</strong> case; the stderr tail is where to look.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'model-health.model-files': {
    title: 'Model files health',
    body: (
      <p>
        The detected hardware profile (backend / VRAM / RAM / cores / GPUs), the
        GGUFs downloaded under <C>~/.arco/models</C>, and{' '}
        <strong>fit-score mismatch warnings</strong>: registered llama.cpp
        loadouts that won't fit this hardware on GPU at a useful context (scored
        with the Arco fit engine). A mismatch is an
        actionable <strong>WARN</strong> with a hint, never an error.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'model-health.llamacpp-diagnosis': {
    title: 'llama.cpp serve-failure diagnosis',
    body: (
      <p>
        Appears when the last <C>llama-server</C> launch failed. Arco
        classifies the stderr against an ordered registry of known causes
        (port-in-use, OOM, ctx-too-large, gguf-missing, unsupported-arch and others) and
        shows the matched <strong>cause</strong>, a plain-language explanation,
        and concrete <em>suggestions</em>. Read-only diagnosis; only the
        one-click <strong>fix</strong> buttons below it mutate config.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'model-health.llamacpp-fix': {
    title: 'Apply one-click fix',
    body: (
      <p>
        A concrete remediation derived from the diagnosed cause: e.g. halve the
        context size, offload fewer GPU layers, or add an{' '}
        <C>--port</C>/<C>extraArgs</C> flag. Each button writes that change to
        the loaded loadout's catalog entry and reloads <C>llama-server</C>.
        Disabled when no alias is currently loaded: apply it by hand in
        Settings &gt; Providers and models &gt; llama.cpp model registry instead. A port fix uses the same endpoint for launch, conflict checks, health polling and inference.
       A catalog change while the fix is being saved refuses the save; the model is not reloaded. Refresh and review the fix again.</p>
    ),
    manualSection: 'diagnostics',
  },
  // ----------------------------------------------------- SYSTEM · SERVICES
  'system.tab.services': {
    title: 'System · Services',
    body: (
      <>
        <p>
          Machine-wide browser of the local web/dev services running right now:
          every listening TCP socket mapped to its process / cwd / framework.
          Compact rows: framework emoji, friendly name, <C>:port</C>, process,
          pid. Hover a row for its working directory; click to expand the full
          cmdline / cwd / pid / host and the action set. Backed by the read-only{' '}
          <C>GET /api/services</C>; refreshed on open + a bounded ~5s auto-poll
          while the tab is open. Each automatic poll waits for the previous scan to settle; closing the view aborts its read.
        </p>
        <p>
          It lives here (not the right panel) because it's project-agnostic:
          the same list regardless of which workflow is focused. Pinned services
          float to the top and survive restarts (global settings, keyed by{' '}
          <C>cwd + port</C>); a pinned-but-stopped service shows as a dimmed{' '}
          <C>OFFLINE</C> row.
        </p>
      </>
    ),
    manualSection: 'diagnostics',
  },
  'services.refresh': {
    title: 'REFRESH',
    body: <p>Re-scan listening sockets now: pick up services that started or stopped since the last poll.</p>,
  },
  'services.webonly': {
    title: 'Web-only filter',
    body: <p>Toggle between web/dev services only (<C>WEB</C>, the default) and every local listener (<C>ALL</C>). Local UI state, not persisted.</p>,
  },
  'services.health': {
    title: 'Health probe',
    body: (
      <p>
        Toggle per-service liveness dots: <C>OFF</C> by default because probing
        spawns a network request to each listed port. When armed, each row's port
        is probed via <C>GET /api/preview/probe</C> on every poll tick: a green dot
        means responding, red means not responding, dim means probing. Local UI
        state, not persisted.
      </p>
    ),
  },
  'services.preview': {
    title: 'Open in Live Preview',
    body: (
      <p>
        Bind this service's port to the <em>focused</em> workflow's preview proxy
        (<C>set_preview_port</C>) and switch that workflow's right panel to{' '}
        <C>PREVIEW</C>. Disabled for an offline (pinned-not-running) service or when
        no workflow tab is focused: focus a workflow tab to preview there.
      </p>
    ),
  },
  'services.open': {
    title: 'OPEN',
    body: <p>Open the service's URL (<C>http://localhost:&lt;port&gt;/</C>) in a new browser tab.</p>,
  },
  'services.copy': {
    title: 'COPY URL',
    body: <p>Copy the service's <C>http://localhost:&lt;port&gt;/</C> URL to the clipboard.</p>,
  },
  'services.pin': {
    title: 'PIN / UNPIN',
    body: <p>Rapid PIN and UNPIN clicks save in order and preserve changes to other services. Pin a service to the machine-level inventory (global settings, keyed by <C>cwd + port</C>) so it stays listed across restarts: a pinned-but-stopped service shows as an offline row. UNPIN removes it.</p>,
  },
  'services.kill': {
    title: 'KILL',
    body: (
      <p>
        Send <C>SIGTERM</C>: a graceful terminate: to the service's process via{' '}
        <C>DELETE /api/services/:pid</C>. Two-step: the first click arms a{' '}
        <C>CONFIRM?</C> button. The server re-scans and only signals a pid that
        currently owns a listening socket (and never the Arco server itself).
        SIGTERM only: there is <em>no</em> SIGKILL escalation; a process that
        ignores SIGTERM keeps running.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  // ----------------------------------------------------- HELP SYSTEM SELF
  'help.toggle': {
    title: 'Contextual help mode',
    body: (
      <>
        <p>
          <C>POINT AT THINGS</C> in the header HELP menu turns contextual help
          on or off. When active, click any highlighted
          element to read what it does. Each popover may link into the full
          Manual for deeper coverage.
        </p>
        <p>
          Press <C>Esc</C> or choose <C>EXIT POINT AT THINGS</C> to exit.
        </p>
      </>
    ),
    manualSection: 'help-system',
  },
  'home.status': {
    title: 'Workbench status',
    body: <p>The provider count shows how many enabled providers are connected; select it to open Connections. The status line also counts running work and work waiting for an answer. The Arco version button opens Settings at CLI and runtime versions and reads Update available when the update check has found a newer release.</p>,
    manualSection: 'home',
  },
  'creator.cluster-policy': {
    title: 'Coordination settings',
    body: <p>Collapsed by default; the summary line shows the current communication style, message guard, task board and Keep current choices. Expand it to change them for this cluster. The defaults suit most clusters.</p>,
    manualSection: 'create-cluster-from-new',
  },
  'worker.detail-close': {
    title: 'Close worker detail',
    body: <p>Closes the worker detail view. Escape or a click on the backdrop does the same. The worker keeps running; nothing is cancelled.</p>,
  },
  'browser-notice': {
    title: 'Browser notice',
    body: <p>Shown once in Firefox, Safari and other browsers outside the Chromium family. Arco runs lighter in Chrome, Edge, Brave, Vivaldi or Chromium, and <code>arco open</code> and the Arco shortcut open it there as an app window. CHOOSE BROWSER opens Settings &gt; Advanced &gt; App window browser. DISMISS hides the notice in this browser for good.</p>,
    manualSection: 'app-window-browser',
  },
  'update.reload-page': {
    title: 'Reload Arco',
    body: <p>Reload this page after a restart when the session cannot recover or the running page is older than the server. Arco reloads automatically when no unsaved work is detected. Review and save any drafts or edits before selecting RELOAD.</p>,
    manualSection: 'arco-updates',
  },
  'dialog.size': {
    title: 'Dialog size',
    body: <><p>Maximize fills the window and Restore returns to the previous size. Drag the bottom-right corner grip or focus it and use arrow keys to resize. Reset size or Home on the grip restores the default. Resizable dialogs reserve a right-side gutter so footer actions stay clear of the grip.</p><p>Rendered Markdown and plain text fit their reading column; RAW, code, overflowing tables and media use the larger viewer. Arco remembers the size for this kind of dialog in this browser, without saving project details.</p></>,
  },
  'dialog.save-destination': {
    title: 'Destination folder and filename',
    body: <><p>Navigate to the destination with Go or Enter in the path field. SAVE HERE and Enter in the filename field choose only the loaded folder. Both wait while loading and refuse an edited path or a failed listing.</p><p>File previews, downloads and file/image saves verify the opened file and its parent folder before reading or changing content. If validation detects a changed file or parent folder when opening the file, select the file again and retry. These checks are not an operating-system sandbox.</p><p>On Windows, file paths with trailing dots or spaces in a component, or alternate data stream separators, are refused. Use ordinary file and folder names. Drive-letter paths and network shares remain supported.</p></>,
    manualSection: 'archive-explorer',
  },
  'dialog.create-folder': {
    title: 'Create folder',
    body: <p>Show or hide the fields for creating a folder in the current location. Enter a name and select + FOLDER to create it.</p>,
    manualSection: 'archive-explorer',
  },
  'help.modal-button': {
    title: 'Tool help',
    body: <p>Opens the help card for this tool without leaving it. The full user manual is available from the header.</p>,
    manualSection: 'help-system',
  },
  'welcome.operator-name': {
    title: 'Name in chat',
    body: <p>Optionally enter the name Arco uses for your messages in chat, up to 32 characters. Get started saves the name; Skip this step leaves the saved name unchanged. Leave it blank to use OPERATOR. Change it later in Settings &gt; Appearance &gt; Operator name.</p>,
    manualSection: 'first-launch',
  },
  'welcome.utility-agent': {
    title: 'Utility agent (optional)',
    body: <p>On the last Welcome screen you may choose one provider and model for short side jobs such as summaries. Only connected providers that can answer without tools are offered, a fast low-cost model is suggested but never chosen for you, and skipping leaves it unset. The same choice lives in Settings &gt; Agents and clusters &gt; Utility agent.</p>,
    manualSection: 'utility-agent',
  },
  'welcome.steps': {
    title: 'Welcome setup',
    body: <p>Get started walks through three steps: project locations, a provider connection, and a completion screen. Skip this step moves on without saving that step, and Skip setup closes the welcome and goes to Home. On the locations step, add a location or switch to Add a single project folder, use Add another for more, Remove to drop one before continuing, and Continue for the provider step. The completion screen offers Go to Home and Start a chat. Run setup again from Settings &gt; Projects at any time; existing folders and saved work stay in place.</p>,
    manualSection: 'first-launch',
  },
  'projects.location-form': {
    title: 'Project location',
    body: <p>A project location is a named folder that contains projects, such as Work or Personal. Enter a Location name (optional) and an absolute Location folder path, or use Browse folders to pick one, then Add location (Save location when editing). Cancel closes the form without changes. Adding a location does not move or copy any files.</p>,
    manualSection: 'home',
  },
  'plan.composer-cancel': {
    title: 'Cancel plan draft',
    body: <p>Closes the plan dialog without sending anything to the agent. No plan is drafted or saved.</p>,
  },
};

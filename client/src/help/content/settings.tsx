import { C } from './shared';
import type { HelpEntry } from './shared';

export const settingsHelp: Record<string, HelpEntry> = {
  'settings.first-run': {
    title: 'Run setup again',
    body: <p>Reopens welcome, multi-folder setup, Connections and completion. Existing project locations and bookmarked folders appear in the summary and remain unless explicitly removed. Add several choices with Add another, then Continue. The final screen summarizes folders and provider, with Go to Home and Start a chat in the normal creator. Either saves completion without launching work. Existing chats and settings remain intact.</p>,
  },
  'settings.projects': {
    title: 'Projects',
    body: (
      <p>
        Project locations are named parent folders, such as Work or Personal. Add location and Edit open their forms only when requested. Adding an existing path or alias keeps the typed name and offers explicit rename; an edit collision changes neither location. Removing a location never deletes files or saved work. Bookmarked folders holds optional individual-folder controls: Bookmark folder and Remove bookmark. Folders inside project locations already appear automatically; bookmarks keep individual folders listed independently of locations and do not control saved chats or files. Advanced folder options contains the independent Default browsing location. Setup uses the same locations and allows a secondary single-folder choice. Home shows folder counts and useful first choices without requiring setup to run again.
      </p>
    ),
  },

  'settings.deepseek': {
    title: 'Xolotl · DeepSeek profiles', manualSection: 'deepseek',
    body: <p>Load Exact or Light through the guarded launcher at port 8150.
      Exact preserves routing; Light uses 0.25 / 0.15 biases and changes expert selection.
      Both use a 262144-token context. Prepared vision profiles accept screenshots
      through an on-demand CPU image encoder; text-only profiles reject images. Unload stops the service
      and releases model memory. Other GPU workloads and competing loaded models cause a refusal;
      Arco never stops external GPU workloads. See HELP for memory limits, cancellation and recovery.</p>,
  },
  'settings.strata-endpoint': {
    title: 'Strata endpoint', manualSection: 'provider-strata',
    body: <p>Standalone Strata's OpenAI-compatible base URL, default
      <C>http://127.0.0.1:8081/v1</C>. A missing /v1 is added automatically.
      This setting overrides STRATA_URL_BASE. Prepared local profiles can load
      for the next message; changing the address does not prepare models or
      increase memory limits. Live image/context capabilities come from the
      service, and inactive profiles from their checked configuration.</p>,
  },
  // -------------------------------------------------------- SETTINGS PANEL
  'settings.phosphor-effects': {
    title: 'Phosphor effects', manualSection: 'settings-themes',
    body: <p>Phosphor only. Off removes ambient rendering, glass/raster, decorative
      glow and frost without deleting your saved frost preference. Reduced motion
      instead stops animation while retaining static glow and glass.</p>,
  },
  'settings.phosphor-softness': {
    title: 'Glow softness', manualSection: 'settings-themes',
    body: <p>Adjust the text halo, not the foreground ink: 0 removes glow, 50 is
      the sharper default, 100 is the reference look. Crisp text and effects-off
      override glow and disable this slider. Font, text brightness and background
      brightness are independent controls.</p>,
  },
  'settings.themes': {
    title: 'Theme picker',
    body: (
      <p>
        Choose a family first: Arco Classic retains all 43 existing selections,
        including <C>provider-auto</C>; Arco Phosphor offers 68 Phosphor palettes
        sharing one CRT treatment. Search by name/ID or filter Phosphor categories.
        Switching updates CSS vars on <C>:root</C>, without rearranging the
        workbench. Phosphor glow softness defaults to 50%; effects, crisp text,
        font overrides and background/text brightness are separate controls.
      </p>
    ),
    manualSection: 'settings-themes',
  },
  'settings.project-trust': {
    title: 'Project trust',
    body: (
      <>
        <p>
          Every repo Arco opens is checked for three project-local surfaces -{' '}
          <C>CLAUDE.md</C>, <C>.arco/skills</C>, <C>.arco/settings.json</C>:
          that would otherwise enter the model&apos;s system prompt unread. Until
          you vouch for a repo they stay suppressed from every turn.
        </p>
        <p>
          Decisions are keyed by directory, nearest ancestor wins, and cover
          every tab and cluster member pointed at that path. <C>FLIP</C> swaps
          trusted ↔ blocked; <C>FORGET</C> drops the decision so the next turn in
          that repo prompts again. The <C>DEFAULT</C> row is the fallback for
          repos with no decision: <C>ALWAYS</C> effectively disables the gate.
          Stored in <C>~/.arco/trust.json</C>; effective next turn, no restart.
        </p>
      </>
    ),
  },
  'settings.font-pack-override': {
    title: 'Font pack override',
    body: (
      <p>
        Substitutes display/body/code typography on top of the active theme
        (29 font packs). New homes default to Victor Mono
        (<C>victor-mono-uniform</C>); a saved pack is left alone. Use the
        override when you want one theme's palette with another theme's type.
      </p>
    ),
    manualSection: 'settings-themes',
  },
  'settings.frosted-glass': {
    title: 'Frosted glass',
    body: (
      <p>
        Operator override for the translucent-blur backdrop through panel
        surfaces. <C>ON</C> / <C>OFF</C> overrides the active theme's own
        default; <C>reset to theme default</C> clears the override so each
        theme reverts to its built-in setting. The opacity slider defaults to
        80%; a saved value is kept. Purely cosmetic.
      </p>
    ),
    manualSection: 'settings-themes',
  },
  'settings.interface-text-size': {
    title: 'Interface text size',
    body: <p>Scale the interface from 90% to 150%. The default is 100%; the choice applies immediately and is cached for the next startup before the interface appears.</p>,
    manualSection: 'settings-themes',
  },
  'settings.message-box-size': {
    title: 'Message box size',
    body: <p>How tall every message box is before anything is typed: <C>SMALL</C> (default, one line), <C>MEDIUM</C> or <C>LARGE</C>. The box still grows with the text. Kept in this browser only; nothing is sent anywhere.</p>,
    manualSection: 'settings-themes',
  },
  'settings.theme-brightness': {
    title: 'Theme brightness',
    body: (
      <p>
        Per-theme brightness offsets. <C>TEXT</C> shifts foreground and accent
        tokens; <C>BACKGROUND</C> shifts panel surfaces. <C>0</C> means the
        theme&apos;s stock colors. The default text shift is <C>+25</C>.
      </p>
    ),
    manualSection: 'settings-themes',
  },
  'settings.crisp-text': {
    title: 'Crisp text',
    body: (
      <p>
        Removes the soft phosphor text glow from small UI text on glow-heavy
        themes. Structural border glow stays intact. Classic retains its wordmark
        glow; Phosphor makes the wordmark crisp too, retaining static glass/raster.
      </p>
    ),
    manualSection: 'settings-themes',
  },
  'settings.operator-name': {
    title: 'Operator name',
    body: (
      <p>
        Replaces the generic <C>&gt; OPERATOR</C> prefix in chat with your
        chosen label. Applies to rendered transcripts that get fed back into
        handoff seeds. Leave blank to keep <C>OPERATOR</C>. Max 32 chars.
      </p>
    ),
    manualSection: 'settings-operator',
  },
  'settings.default-working-dir': {
    title: 'Default browsing location',
    body: <p>The starting location for folder navigation. Type an absolute path or Browse location, then Save browsing location. This does not add project locations or bookmark folders. Project locations are managed separately. Leave blank to use the server default, then the home folder if unavailable.</p>,
  },
  'settings.media-unconfined': {
    title: 'Media access',
    body: (
      <p>
        Media Studio starts confined to the workflow folder, browser uploads and
        Arco's import scratch. To use an outside folder, turn on outside-folder
        access and add that folder to the explicit list. Both are required.
        Provider accounts, credentials and system folders stay blocked. Remove a
        folder, turn access off or choose Revoke all to end extra access on the
        next request. Media conversion operations write a new file. The image
        editor can overwrite an existing image after confirmation.
      </p>
    ),
    manualSection: 'settings-operator',
  },
  'settings.navigation': {
    title: 'Finding a setting',
    body: (
      <p>
        Settings are grouped by task: Appearance, Projects, Providers and
        models, Agents and clusters, Voice, Files and media, and Advanced.
        The category buttons on the left open one group.
        Search looks through every category at once, including each
        control's help text. Every section shows where it applies and can be
        opened directly with an address such as #settings/voice/voice-setup.
      </p>
    ),
    manualSection: 'settings-operator',
  },
  'settings.scope': {
    title: 'Where a setting applies',
    body: (
      <p>
        Global settings apply across this Arco server. Project settings apply
        to one project folder. Workflow settings are in each workflow's
        CONFIG tab and override the global default for that workflow only.
        A default for new workflows does not change workflows that already
        exist.
      </p>
    ),
    manualSection: 'settings-operator',
  },
  'settings.voice-setup': {
    title: 'Voice setup',
    body: (
      <p>
        Shows what local speech has installed under the voice home: uv, the
        voice Python environment, the speech packages and each model. Install
        runs the same step as npm run voice:setup and shows its log; it
        downloads about 1 GB from the upstream sources the first time. Test
        microphone shows a level bar and records nothing. Say a phrase records
        up to five seconds once and shows what the local recognizer heard.
        Model notices lists every downloaded component and its license. On
        Docker, voice needs the native run.
      </p>
    ),
    manualSection: 'hands-free-voice',
  },
  'settings.enabled-providers': {
    manualSection: 'settings-providers',
    title: 'Enabled providers',
    body: (
      <p>
        Per-provider on/off toggle. Disabled providers are hidden from the
        workflow creator and Handoff/Spawn dialogs entirely: useful if you
        prefer to keep a provider out of the picker. New homes enable detected
        sign-ins and local runtimes; Strata and DeepSeek through Xolotl start
        off. Existing saved choices are kept. A successful explicit check in
        Connections enables that provider.
      </p>
    ),
  },
  'settings.authentication': {
    manualSection: 'settings-providers',
    title: 'Authentication',
    body: (
      <>
        <p>Native sign-in in Settings and inline recovery tracks a specific flow, even while rejected credentials remain present. Local callbacks complete automatically when reachable; another device can paste the redirected localhost URL. CANCEL SIGN-IN cancels that flow. After matching recovery, review the original workflow and send explicitly. Drafts are retained and work is never replayed automatically.</p>
        <p>
          The sign-in rows show provider status and sign-in controls. Claude
          Native, Claude CLI, Codex profiles and Cursor use separate sign-ins.
          GitHub sign-in is also available in Connections.
        </p>
        <p>
          Ollama, llama.cpp, LM Studio and Strata have no sign-in. When the
          server is unreachable the button reads <C>CHECK SERVER</C> and shows
          how to reconnect: start the local server and check the endpoint
          address above. DeepSeek through Xolotl is the same kind of local
          service (enable it under Enabled providers, start Xolotl, then check
          its endpoint). Strata lists configured profiles; LIVE does not mean
          their weights are resident in VRAM. After FREE VRAM, models remain
          available on demand.
        </p>
      </>
    ),
  },
  'settings.endpoint-discovery': {
    title: 'Discover endpoints',
    body: (
      <>
        <p>
          Probes your tailscale peers and <C>localhost</C> for a reachable
          Ollama (<C>/api/tags</C>) or OpenAI-compatible (<C>/v1/models</C>)
          endpoint on a small fixed port list (<C>11434</C> + <C>8000–8010</C>),
          so your workstation's Ollama over Tailscale shows up without typing a
          base URL. Select a result to fill the Ollama endpoint field, then focus
          and leave the field or press Enter to save it. Discovery never changes
          the endpoint automatically.
        </p>
        <p>
          Operator-triggered only (no background scanning), private IP ranges
          only, with a 60s result cache. If <C>tailscale</C> isn't installed it
          still probes localhost.
        </p>
      </>
    ),
  },
  'settings.claude-signin': {
    manualSection: 'settings-providers',
    title: 'Claude sign-in (Native and CLI)',
    body: (
      <>
        <p>
          Claude has two separate sign-ins. <C>CLAUDE NATIVE (OAUTH)</C> is first because Native is the default
          transport for new work; its LOGIN button signs in inside Arco and the status line says whether Native
          credentials are stored. <C>Credentials present; execution unverified</C>
          means stored credentials were detected, not that a model request succeeded.
          <C>CLAUDE CLI (ANTHROPIC)</C> is the sign-in of the installed Claude CLI. Signing in to
          one does not sign in to the other. The transport used for new work is chosen under Transport defaults.
        </p>
        <p>Connections opens here from its Claude panel, with this group highlighted.</p>
      </>
    ),
  },
  'settings.codex-profiles': {
    title: 'Codex profiles',
    body: (
      <>
        <p>
          Multiple Codex identities, each pinned to its own{' '}
          <C>CODEX_HOME</C> directory so they authenticate independently. Add{' '}
          <C>Work</C> / <C>Home</C> (or arbitrary) profiles to route different
          tabs through separate ChatGPT accounts and rate limits.
        </p>
        <p>
          Each row carries an id, label, short label (the 4-char chip shown in
          the dialogs' ACCOUNT picker), and live-auth status. The profile a tab
          uses is chosen at New / Spawn / Handoff / Review time via the ACCOUNT
          field, which only appears when more than one profile is configured.
        </p>
      </>
    ),
    manualSection: 'provider-codex',
  },
  'settings.board-auto-done': {
    title: 'Board auto-done',
    body: (
      <p>
        When checked, a task in review is marked done as soon as the director&apos;s
        sign-off reads <C>met</C>, the same as pressing ACCEPT on the Board. Partial and
        not-met sign-offs are left for you. Off by default, so you accept finished work
        yourself.
      </p>
    ),
    manualSection: 'cluster-board',
  },
  'settings.llamacpp-catalog': {
    title: 'llama.cpp catalog',
    body: (
      <>
        <p>
          Operator-managed list of GGUF loadouts at <C>~/.arco/llamacpp.json</C>.
          One row per alias: <C>ggufPath</C>, <C>mmprojPath</C> (vision projector,
          optional), <C>ctxSize</C>, <C>ngl</C> (GPU layers: 999 = all on GPU),
          plus capability flags (tools / vision / thinking).
        </p>
        <p>
          Per-row <C>Load now</C> pre-warms the singleton <C>llama-server</C> so
          the next workflow turn doesn't pay the 20-30s cold-start. <C>Unload</C>{' '}
          frees VRAM immediately. <C>chatTemplate</C> and <C>extraArgs</C> are
          preserved across edits even if not exposed in the form.
        </p>
      </>
    ),
    manualSection: 'provider-llamacpp',
  },
  'settings.skills': {
    title: 'Skills',
    body: (
      <p>
        CRUD UI for project and global <C>SKILL.md</C> files. Arco injects a
        compact manifest each turn; the agent reads full skill bodies only when
        needed.
      </p>
    ),
    manualSection: 'settings-operator',
  },
  'settings.handoff-prompts': {
    title: 'Handoff prompts',
    body: (
      <p>
        Edit the seed prompt used by Handoff / Spawn context export. Project
        overrides live under <C>{'<cwd>/.arco/'}</C>; validation warns if a
        template drops required handoff sentinels.
      </p>
    ),
    manualSection: 'settings-operator',
  },
  'settings.transport-defaults': {
    title: 'Transport defaults',
    body: (
      <>
        <p>
          Cascade defaults for per-tab transport toggles. Two independent
          knobs (Codex defaults to app-server; Claude defaults to native):
        </p>
        <ul>
          <li>
            <strong>Claude</strong>: <C>cli</C> per-turn <C>claude</C> spawn
            (full Claude Code feature surface, MCP / hooks / agents) vs{' '}
            <C>native</C> long-lived in-process worker via{' '}
            <C>@anthropic-ai/sdk</C> (operator-armed plan-mode, parallel{' '}
            <C>Task</C> sub-agents, server-side compaction + auto-handoff).
          </li>
          <li>
            <strong>Codex</strong>: <C>exec</C> per-turn spawn vs{' '}
            <C>app-server</C> long-lived per-tab process (structured{' '}
            <C>turn/interrupt</C> cancel and non-destructive{' '}
            <C>turn/steer</C> mid-turn input).
          </li>
        </ul>
        <p>
          Per-tab CONFIG settings override these. Reviewers and handoff seeds
          for Claude and Codex always use CLI or exec regardless of the tab transport. Project-level{' '}
          <C>{'<cwd>/.arco/settings.json'}</C> overrides this global value
          for tabs in that cwd.
        </p>
      </>
    ),
    manualSection: 'config-tab',
  },
  'settings.utility-agent': {
    title: 'Utility agent',
    body: (
      <>
        <p>
          One provider and model for short side jobs outside your workflows, such as summaries. A utility job is
          started by a button you click, has no tools, reads only facts Arco collects, can be cancelled, and shows
          which model answered and the facts it was given. Failed requests explain the cause when available and name the model tried. Nothing is chosen until you save a choice; a fast,
          low-cost model is suggested but never selected for you.
        </p>
        <p>
          Claude (with Native sign-in), Cursor, Codex and Ollama can serve. Codex runs as a one-shot read-only session with no MCP servers or web search, and any tool use ends the request.
          <strong> TEST</strong> sends one fixed request to confirm the choice answers. The facts of every job are
          sent to the chosen provider, and any cost depends on that provider.
        </p>
        <p>
          Where a feature offers <strong>USE UTILITY AGENT</strong> next to its own agent choice, the button only fills
          that choice in; saved choices are never changed for you.
        </p>
      </>
    ),
    manualSection: 'utility-agent',
  },
  'settings.notification-channels': {
    title: 'Notifications',
    body: (
      <>
        <p>
          Choose which events notify you and where; everything is off until you tick it. Events: a turn finished
          (after at least 15 seconds), a turn failed, and waiting for you (a question or an approval). <strong>This computer</strong> shows
          a system notification only while Arco is not the window you are looking at, once per event; clicking it opens
          that tab. Your browser asks for permission the first time you tick a box.
        </p>
        <p>
          <strong>Phone</strong> sends a message through an ntfy server and needs no hub. Enter the server, a topic
          (GENERATE makes a private-looking random one) and, for a protected topic, an access token, then press TEST. Anyone
          who knows the topic can read its messages. Message text is left out unless you turn it on. In a cluster,
          "finished" comes from the director only unless you choose every member. The tab count in the window title,
          such as "(2) ARCO", always shows how many tabs are waiting on you.
        </p>
      </>
    ),
    manualSection: 'notifications',
  },
  'settings.auto-handoff-defaults': {
    title: 'Auto-handoff defaults',
    body: (
      <>
        <p>
          Starting auto-handoff state for newly-created tabs; off by default. When enabled, Arco
          auto-rotates to a fresh session at the <C>AUTO</C> token threshold
          (and warns at <C>WARN</C>) when the provider has a trusted context-fill
          signal. Disabling it leans on provider compact or manual Handoff instead.
          QUICK is the default mode; a saved per-tab or global written mode remains in effect.
        </p>
        <p>
          The per-tab <strong>AUTO-HANDOFF</strong> control in the CONFIG tab
          always wins: this only seeds tabs that have never been touched.
          Project-level <C>{'<cwd>/.arco/settings.json'}</C> overrides this
          global value for tabs in that cwd.
        </p>
      </>
    ),
    manualSection: 'config-tab',
  },
  'settings.catalog': {
    title: 'Model catalog',
    body: (
      <p>
        Free-form markdown file (<C>~/.arco/models.md</C>) for documenting
        common conventions, preferred models per task type, project notes:
        whatever you want available across workflows. Click <C>EDIT</C> to
        modify; saved to disk on commit.
      </p>
    ),
  },
  'settings.update-action': {
    title: 'Update Arco',
    manualSection: 'arco-updates',
    body: <p>In a packaged user service on Linux, macOS or Windows, or a Linux source user service, confirm UPDATE AND RESTART to install the newest release and stop running turns. On Windows, an update stops only the matching service command and home configuration, and refuses to proceed if the stop cannot be verified. Other run modes show a command to copy and run in a terminal.</p>,
  },
  'settings.update-result': {
    title: 'Update result',
    manualSection: 'arco-updates',
    body: <p>Reports the completed update or rollback after the server reconnects. DISMISS hides this result.</p>,
  },
  'settings.app-updates': {
    title: 'Arco releases',
    manualSection: 'arco-updates',
    body: <p>Shows the running version and latest release. CHECK NOW refreshes release information. Check for new releases controls the automatic check; ARCO_UPDATE_CHECK=0 overrides it. UPDATE AND RESTART is available in packaged user services on Linux, macOS and Windows and in Linux source user services after confirmation; other run modes show a copyable command. No update runs automatically.</p>,
  },
  'settings.cli-versions': {
    title: 'CLI versions',
    manualSection: 'provider-updates',
    body: (
      <p>
        Shows detected Claude and Codex CLI versions and the Ollama daemon
        version or running state. Provider version checks and update controls
        are available from the Providers menu in the header.
      </p>
    ),
  },
  'settings-panel.close': {
    title: 'Close Settings',
    body: <p>Closes Settings. Changes are saved as they are made, so closing discards nothing. Escape also closes Settings when no field has focus. When Settings was opened from Connections, closing returns there.</p>,
    manualSection: 'settings-operator',
  },
};

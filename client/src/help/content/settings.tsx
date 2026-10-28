import { C } from './shared';
import type { HelpEntry } from './shared';

export const settingsHelp: Record<string, HelpEntry> = {
  'settings.first-run': {
    title: 'Run setup again',
    body: <p>Reopens the welcome, folder, Connections and completion steps. Earlier steps can be skipped. Setup complete summarizes the chosen folder and provider, then offers Go to Home or Start a chat in the normal creator. Either choice saves completion. Setup completion is remembered in the Arco home so a provider outage never reopens it automatically.</p>,
  },
  'settings.projects': {
    title: 'Projects',
    body: (
      <p>
        The flat list of project folders offered by the new-workflow creator and
        the ARCHIVE window. Add any absolute path the server can read; nothing
        has to live under one parent. <C>KEEP</C> promotes a scanned or recent
        folder into the registered list; <C>Remove</C> forgets a registered one.
        No scan folder is assumed. Setup offers a typed absolute project path or a scrolling folder browser with common-root shortcuts, UP, and new-folder creation. Choosing a folder adds that project; optional scanning is configured separately in Settings &gt; Projects. Discovery does not register projects or count as saved work. Home collapses more than 12 scanned folders; search includes them. In Docker, a folder must be bind-mounted into the container first.
      </p>
    ),
  },

  'settings.deepseek': {
    title: 'Xolotl · DeepSeek profiles', manualSection: 'deepseek',
    body: <p>Load Exact or Light through the guarded launcher at port 8150.
      Exact preserves routing; Light uses 0.25 / 0.15 biases and changes expert selection.
      Both use a 262144-token context. Prepared vision profiles accept screenshots
      through an on-demand CPU image encoder; text-only profiles reject images. Unload stops the service
      and releases model memory. Mining and competing loaded models cause a refusal;
      Arco never stops your miner. See HELP for memory limits, cancellation and recovery.</p>,
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
          Every repo Arco opens is checked for three project-local surfaces —{' '}
          <C>CLAUDE.md</C>, <C>.arco/skills</C>, <C>.arco/settings.json</C> —
          that would otherwise enter the model&apos;s system prompt unread. Until
          you vouch for a repo they stay suppressed from every turn.
        </p>
        <p>
          Decisions are keyed by directory, nearest ancestor wins, and cover
          every tab and cluster member pointed at that path. <C>FLIP</C> swaps
          trusted ↔ blocked; <C>FORGET</C> drops the decision so the next turn in
          that repo prompts again. The <C>DEFAULT</C> row is the fallback for
          repos with no decision — <C>ALWAYS</C> effectively disables the gate.
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
        (29 font packs). Use it when you want one theme's palette with another
        theme's type.
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
        theme reverts to its built-in setting. Purely cosmetic.
      </p>
    ),
    manualSection: 'settings-themes',
  },
  'settings.interface-text-size': {
    title: 'Interface text size',
    body: <p>Scale the interface from 90% to 150%. The default is 110%; the choice applies immediately and is cached for the next startup before the interface appears.</p>,
    manualSection: 'settings-themes',
  },
  'settings.theme-brightness': {
    title: 'Theme brightness',
    body: (
      <p>
        Per-theme brightness offsets. <C>TEXT</C> shifts foreground and accent
        tokens; <C>BACKGROUND</C> shifts panel surfaces. <C>0</C> means the
        theme&apos;s stock colors. The default text shift is <C>+30</C>.
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
    title: 'Default working directory',
    body: (
      <p>
        The folder the new-workflow <C>WORKING DIRECTORY</C> picker opens at (and
        the value its placeholder reflects). Type an absolute path or <C>BROWSE</C>
        the folder tree and pick a root with <C>✓ USE THIS</C>. Set it per machine
        — useful when your projects don't live under <C>~/Projects</C> (e.g. a Mac).
        Leave blank to fall back to <C>~/Projects</C>, then your home folder.
      </p>
    ),
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
        next request. Output uses a new filename and never overwrites the source.
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
        workflow creator and Handoff/Spawn dialogs entirely — useful if you
        don't want, say, Gemini cluttering the picker.
      </p>
    ),
  },
  'settings.authentication': {
    manualSection: 'settings-providers',
    title: 'Authentication',
    body: (
      <>
        <p>
          Per-provider auth state + login button. Each provider authenticates
          independently. <C>LIVE</C> chip = authed; <C>LOG IN</C> button
          starts the auth flow (browser OAuth for Claude/Gemini; ChatGPT
          OAuth for Codex; gh-cli flow for GitHub).
        </p>
        <p>
          Ollama, llama.cpp, LM Studio and Strata are auth-less; the button reads <C>HELP</C> and
          opens troubleshooting tips. Strata lists configured profiles; LIVE does not
          mean their weights are resident in VRAM. After FREE VRAM, models remain
          available on demand. Antigravity isn't listed — its auth lives
          inside the desktop app. For Antigravity, unavailable usually means the
          app is not launched, <C>ANTIGRAVITY_BINARY</C> is wrong, the isolated
          profile is not signed in, <C>ANTIGRAVITY_USE_DEFAULT_PROFILE=1</C> is
          needed, or the server was restarted in-app without picking up external
          env changes.
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
          base URL. Click a result to fill the endpoint field — you still hit
          the field to Save. It never auto-switches.
        </p>
        <p>
          Operator-triggered only (no background scanning), private IP ranges
          only, with a 60s result cache. If <C>tailscale</C> isn't installed it
          still probes localhost.
        </p>
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
  'settings.claude-native-compact-default': {
    title: 'Claude Native compaction default',
    body: (
      <p>
        Starting state for Anthropic server-side compaction on new Claude Native
        tabs (default <C>OFF</C>). The server-side beta fires mid-turn at a fixed
        token threshold regardless of window size and can evict the working set
        on large-window or Read-heavy coding tabs, so leaving it off uses
        Arco&apos;s between-turn compaction instead. The per-tab CONFIG toggle
        always wins.
      </p>
    ),
    manualSection: 'config-tab',
  },
  'settings.llamacpp-catalog': {
    title: 'llama.cpp catalog',
    body: (
      <>
        <p>
          Operator-managed list of GGUF loadouts at <C>~/.arco/llamacpp.json</C>.
          One row per alias: <C>ggufPath</C>, <C>mmprojPath</C> (vision projector,
          optional), <C>ctxSize</C>, <C>ngl</C> (GPU layers — 999 = all on GPU),
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
            <strong>Claude</strong> — <C>cli</C> per-turn <C>claude</C> spawn
            (full Claude Code feature surface, MCP / hooks / agents) vs{' '}
            <C>native</C> long-lived in-process worker via{' '}
            <C>@anthropic-ai/sdk</C> (operator-armed plan-mode, parallel{' '}
            <C>Task</C> sub-agents, server-side compaction + auto-handoff).
          </li>
          <li>
            <strong>Codex</strong> — <C>exec</C> per-turn spawn vs{' '}
            <C>app-server</C> long-lived per-tab process (structured{' '}
            <C>turn/interrupt</C> cancel and non-destructive{' '}
            <C>turn/steer</C> mid-turn input).
          </li>
        </ul>
        <p>
          Per-tab CONFIG settings override these. Reviewers and handoff seeds
          always run on the default transport regardless. Project-level{' '}
          <C>{'<cwd>/.arco/settings.json'}</C> overrides this global value
          for tabs in that cwd.
        </p>
      </>
    ),
    manualSection: 'config-tab',
  },
  'settings.auto-handoff-defaults': {
    title: 'Auto-handoff defaults',
    body: (
      <>
        <p>
          Starting auto-handoff state for newly-created tabs. Arco
          auto-rotates to a fresh session at the <C>AUTO</C> token threshold
          (and warns at <C>WARN</C>) when the provider has a trusted context-fill
          signal. Disabling it leans on provider compact or manual Handoff instead.
        </p>
        <p>
          The per-tab <strong>AUTO-HANDOFF</strong> control in the CONFIG tab
          always wins — this only seeds tabs that have never been touched.
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
        common conventions, preferred models per task type, project notes —
        whatever you want available across workflows. Click <C>EDIT</C> to
        modify; saved to disk on commit.
      </p>
    ),
  },
  'settings.app-updates': {
    title: 'Arco releases',
    manualSection: 'provider-updates',
    body: (
      <p>Shows the running Arco version and the latest known numbered release.
        CHECK NOW asks the server to refresh GitHub release information. Check for new releases
        controls the automatic check, which starts 30 seconds after boot and repeats every six hours.
        ARCO_UPDATE_CHECK=0 overrides this preference. OPEN RELEASE opens the release notes;
        DISMISS remembers that version across reloads. A newer version can notify again.
        Updating Arco opens the service, foreground and Docker update instructions.
        Nothing is downloaded or installed automatically.</p>
    ),
  },
  'settings.cli-versions': {
    title: 'Provider versions',
    manualSection: 'provider-updates',
    body: (
      <p>
        Detected versions of the provider CLIs (Claude / Gemini / Codex) and
        Ollama and Strata engines, alongside the upstream latest (npm registry / GitHub
        Releases). Re-probed every 4 hours; the header chips paint warning-color
        when outdated, and clicking them runs the installer (CLIs) or opens the
        themed releases modal (Ollama), or upstream release notes (Strata). Strata updates are manual and do not change Arco's build.
      </p>
    ),
  },
};

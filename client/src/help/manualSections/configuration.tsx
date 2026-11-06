import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Note, Table, Sub} from '../../components/UserManual/components';

export const configuration: Section[] = [
  {
  id: 'settings-providers',
  group: 'Configuration',
  title: 'Settings - providers',
  body: (
  <>
  <p>
  The <Code>⚙ SETTINGS</Code> modal is the operator-global config surface;
  use its provider list to enable providers and sign in. Per-workflow config
  lives in the CONFIG tab on the right pane.
  </p>
  <Sub>Claude sign-ins</Sub>
  <p>
  <strong>Claude</strong> has two separate sign-ins, grouped at the top of the
  provider list with Codex and Cursor. Signing in to one does not sign in to
  the other.
  </p>
  <ol>
  <li>
  <strong>CLAUDE NATIVE (OAUTH)</strong> comes first, because Native is the
  default transport for new work.
  </li>
  <li><strong>CLAUDE CLI (ANTHROPIC)</strong> comes second.</li>
  </ol>
  <p>
  Welcome and Connections report Claude as connected only when the selected
  transport can be used. With Native selected and no Native credentials, they
  show Native: sign-in needed.
  </p>
  <ul>
  <li>SIGN IN FOR NATIVE is the main action.</li>
  <li>Use Claude CLI instead is offered when the CLI is signed in.</li>
  </ul>
  <Sub>Which providers start enabled</Sub>
  <p>
  On a new home, detected Claude, Codex and Cursor sign-ins and detected
  Ollama, LM Studio and llama.cpp runtimes are enabled. Strata and DeepSeek
  through Xolotl start off. Detection does not guarantee a model is ready.
  </p>
  <p>
  A successful explicit check in Connections enables that provider. Existing
  settings and choices are preserved; each provider can be toggled here.
  </p>
  <Sub>Per-provider rows</Sub>
  <ul>
  <li>
  <strong>Toggle</strong> - disable a provider entirely. Disabled providers
  don&apos;t appear in workflow creators or Handoff/Spawn dialogs.
  </li>
  <li>
  <strong>Auth state</strong> - green LIVE chip when authed.{' '}
  <Code>LOG IN</Code> for account providers when not;{' '}
  <Code>CHECK SERVER</Code> for local runtimes when the server is unreachable.
  </li>
  <li>
  <strong>Sub-line</strong> - for normal providers: email / org / plan. For
  Ollama: daemon up + N models installed. Strata shows configured models
  available on demand; LIVE does not prove weights are currently in VRAM.
  </li>
  </ul>
  <p>
  Claude has two auth surfaces: CLI auth and Claude Native OAuth. Ollama,
  llama.cpp, LM Studio, Strata and DeepSeek through Xolotl have no sign-in;{' '}
  <Code>CHECK SERVER</Code> explains starting the local service and checking
  its endpoint address.
  </p>
  <Sub>Settings layers</Sub>
  <p>Settings cascade in this order, later layers overriding earlier ones:</p>
  <ol>
  <li>Defaults.</li>
  <li><Code>~/.arco/settings.json</Code>.</li>
  <li><Code>&lt;cwd&gt;/.arco/settings.json</Code>.</li>
  <li>Per-workflow CONFIG.</li>
  </ol>
  <p>
  Project settings deep-merge nested objects and replace arrays; edits are
  watched live. State lives under <Code>.arco/</Code> and environment
  variables use the <Code>ARCO_</Code> prefix.
  </p>
  </>
  ),
  },
  {
  id: 'settings-themes',
  group: 'Configuration',
  title: 'Settings - themes',
  body: (
  <>
  <p>
  Themes change the workbench colors, fonts and background effects. Switching
  is instant; no reload is needed, and all components re-render with the new
  tokens.
  </p>
  <p>
  Themes swap CSS vars on <Code>:root</Code>. The active theme is persisted
  to localStorage and applied <em>synchronously</em> at boot to avoid a flash
  of default colors.
  </p>
  <Sub>Panel render styles</Sub>
  <ul>
  <li>
  <strong>CSS hairlines</strong> - most themes. Crisp 1px borders, classic
  cyberpunk look.
  </li>
  <li>
  <strong>Rough.js excalidraw</strong> - wobbly hand-drawn-style borders
  using lazy-loaded roughjs. Bundle only grows when a rough theme is picked.
  </li>
  </ul>
  <Sub>Families and defaults</Sub>
  <p>
  New homes ship Phosphor <strong>Electric Blue</strong> and the{' '}
  <strong>Victor Mono</strong> font pack at 100% interface scale; a saved
  theme or font pack is left alone. An upstream theme-id alias is accepted
  so a copied home keeps its Classic theme.
  </p>
  <ul>
  <li>Arco Classic retains 43 selections, including provider-auto.</li>
  <li>
  Arco Phosphor adds 68 namespaced Phosphor palettes under a separate family,
  with category/search navigation.
  </li>
  <li>
  The separate <strong>font-pack override</strong> (29 packs) keeps one
  theme&apos;s color/shader palette while substituting display, body, and
  code typography from another pack.
  </li>
  </ul>
  <Sub>Phosphor options</Sub>
  <p>
  Phosphor is styling only: the workbench layout and contents stay in place.
  </p>
  <ul>
  <li>Glow softness defaults to 50% (0 removes glow; 100 is the Arco reference).</li>
  <li>Effects off removes decoration.</li>
  <li>Crisp text disables glyph emission, including the wordmark.</li>
  <li>Reduced motion retains static glow, glass and raster.</li>
  <li>Text/background brightness and frosted-surface overrides remain available.</li>
  <li>Phosphor effects off overrides frost without deleting its saved preference.</li>
  </ul>
  <Sub>Layout</Sub>
  <p>
  <strong>Layout</strong> (Appearance) is Automatic (default), Standard or
  Compact. Automatic fits the workspace to the window width; Standard keeps the
  original layout; Compact uses the medium layout at every width, with the
  narrow layout still under 1100 px. Kept in this browser only. See Window size
  and layout.
  </p>
  <Sub>Message box size</Sub>
  <p>
  <strong>Message box size</strong> (Appearance) sets how tall every message
  box starts: Small (default, one line), Medium or Large. The box still grows
  with the text. The choice is kept in this browser only.
  </p>
  </>
  ),
  },
  {
  id: 'theme-inspirations',
  group: 'Configuration',
  title: 'Theme inspirations',
  body: (
  <>
  <p>
  Each Classic theme is a deliberate reference, not just a color swap. This
  list explains what each one evokes, to help pick a theme for the work at
  hand.
  </p>
  <p>
  Tokens, fonts, glyphs, and the background shader together evoke a register
  the operator can step into. Phosphor palettes share one presentation and
  change colors only.
  </p>
  <p>
  The list covers the original design-led themes in the order they appear in
  Settings. A handful of later additions (Cute, Forest, Ocean, Lavender, Ume,
  Copper, Everforest, Arco Jungle, Arco Default, Unfinished Works) ship in the
  registry but aren&apos;t catalogued here.
  </p>
  <dl style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
  <div>
  <dt><strong>Matrix</strong> - phosphor terminal</dt>
  <dd>
  The Wachowskis&apos; falling-glyph cascade reframed as a working register.
  Green CRT phosphor on pitch black, scanlines, tube vignette, a per-column
  glitch-flash to keep the field alive. A Classic theme that still says
  &quot;the machine is doing something&quot; without being ambient.
  </dd>
  </div>
  <div>
  <dt><strong>Sentinel</strong> - operator on shift</dt>
  <dd>
  Built on a night-shift console idiom: a quiet console with corner
  status diamonds that pulse faster as tension rises. Steel-blue calm
  tinting toward red under load, heavy vignette, amber corner markers.
  For long uptimes when the work should feel <em>watched over</em> rather
  than only typed into.
  </dd>
  </div>
  <div>
  <dt><strong>Cherenkov</strong> - through the cooling pool</dt>
  <dd>
  Cherenkov radiation: the blue glow charged particles emit when they
  exceed the speed of light in water. The shader is what staring down into
  a reactor&apos;s spent-fuel pool would show - domain-warped caustic ribbons
  and slow rising bubbles, viewed from above the surface.
  </dd>
  </div>
  <div>
  <dt><strong>Infrared</strong> - false-color thermogram</dt>
  <dd>
  The matplotlib <em>turbo</em> colormap (black, indigo, magenta, amber,
  near-white) piped over a slow noise field. Heat bleeding through
  chrome. Comes out of FLIR / surveillance imagery and the 1980s
  military-tech publication aesthetic.
  </dd>
  </div>
  <div>
  <dt><strong>Aurora</strong> - arctic night sky</dt>
  <dd>
  The polar starfield. An earlier pass painted ribbons across the upper
  third; those are gone now because they read as a glowing wash over
  chat. What remains is the part that still feels <em>north</em> - a dense
  field of twinkling pinpricks, a small fraction tinted aurora-green or
  magenta.
  </dd>
  </div>
  <div>
  <dt><strong>Nebula</strong> - Hubble deep field</dt>
  <dd>
  The diffuse nebular cloud was removed for the same reason as Aurora&apos;s
  ribbons. What&apos;s left is the part that gives the deep field its weight:
  dense pinpricks shimmering on near-black, with a small fraction tinted
  violet/cyan to carry the palette.
  </dd>
  </div>
  <div>
  <dt><strong>Sonar</strong> - WWII ASDIC display</dt>
  <dd>
  The U-boat hunt period: a polar grid with a rotating sweep wedge and
  persistent contact returns. The sweep period shortens with workflow
  tension. Tight, slow, deliberate - built for the register where listening
  matters more than acting.
  </dd>
  </div>
  <div>
  <dt><strong>Seismograph</strong> - pen-and-paper trace</dt>
  <dd>
  Long-form continuous monitoring: the kind of slow line a drum recorder
  draws across a roll of paper for hours, occasionally jagged. For work
  where the signal is what was missed during the calm.
  </dd>
  </div>
  <div>
  <dt><strong>Kintsugi</strong> - gold-vein lacquer</dt>
  <dd>
  The Japanese craft of repairing broken pottery with gold seams - the
  breakage becomes the most beautiful part. Worley feature-point edges
  produce slowly breathing crack lines on dark urushi lacquer. A theme
  about working through what&apos;s already cracked.
  </dd>
  </div>
  <div>
  <dt><strong>Cicada</strong> - cryptic data stream</dt>
  <dd>
  Named after Cicada 3301 - the unsolved internet ARG that ran 2012-2014
  with cryptographic puzzles posted to imageboards. The shader is an
  LCD-style cell grid that reads like a hex dump without being characters;
  rare flash-white cells stand in for anomalies.
  </dd>
  </div>
  <div>
  <dt><strong>Tarkovsky</strong> - Stalker / Mirror register</dt>
  <dd>
  35mm projection of the Zone. Slow vertical scan bands drifting down the
  frame, heavy luminance-aware grain, sepia pulled up in shadows. For
  contemplative work where the room should feel like a film held up to the
  light.
  </dd>
  </div>
  <div>
  <dt><strong>Night City</strong> - aerial sleeping grid</dt>
  <dd>
  An overhead view of a city at night, abstracted. Lit windows inside
  block tiles, faint streets between them, traffic dots scrolling on a
  few specific thoroughfares. Cyberpunk-adjacent but geographic rather
  than neon - the city as map, not signage.
  </dd>
  </div>
  <div>
  <dt><strong>Abyssal</strong> - marine snow</dt>
  <dd>
  &quot;Marine snow&quot; is the continuous shower of organic detritus that falls
  through the deep ocean below the photic zone. The shader is bioluminescent
  particles drifting downward under a faint horizontal current. Quiet
  register for thinking time.
  </dd>
  </div>
  <div>
  <dt><strong>Voyager</strong> - engineering schematic</dt>
  <dd>
  The NASA Voyager probe and what surrounded it: sparse parallax stars
  with engineering-blueprint ghosts drifting through. References both the
  probe&apos;s plaque and the technical-drawing register of late-70s JPL.
  </dd>
  </div>
  <div>
  <dt><strong>Noir</strong> - film noir</dt>
  <dd>
  Pure black-and-white luminance, with crimson reserved as the only
  chromatic accent - used for danger states. The shader is just film
  grain and a static corner vignette. The theme where the red <em>means
  something</em> because nothing else is colored.
  </dd>
  </div>
  <div>
  <dt><strong>Midnight Tokyo</strong> - rain on glass</dt>
  <dd>
  Originally rain over a neon bokeh field; the bokeh was removed for the
  blob-cleanup pass. What&apos;s left is what carries the city anyway - wide
  translucent streaks tinted into the cold magenta/cyan palette, with the
  tokens doing the heavy lifting.
  </dd>
  </div>
  <div>
  <dt><strong>Arrakis</strong> - Dune / heat haze</dt>
  <dd>
  Slow horizontal shimmer plus fine sand grain. Sietch register: the
  register for writing in a desert at noon, where the act of looking
  costs something. Warm sand palette, no cool tones.
  </dd>
  </div>
  <div>
  <dt><strong>Oscilloscope</strong> - the tube itself</dt>
  <dd>
  Not a Lissajous figure or a beam trace - the <em>physical CRT tube</em>:
  barrel-distorted glass, fine scanline texture, bezel vignette. What the
  old test equipment looks like before it is turned on. Glow on UI text
  comes from CSS text-shadow, gated by data-attribute.
  </dd>
  </div>
  <div>
  <dt><strong>Concrete</strong> - brutalist surface</dt>
  <dd>
  Static aggregate speckle plus a slow vertical cast-shadow drift.
  Architectural register: Béton Brut, raw fairface concrete, the buildings
  that meant something specific in 1965 and were supposed to age into
  meaning more.
  </dd>
  </div>
  <div>
  <dt><strong>Cassette Futurism</strong> - 1970s Moog studio</dt>
  <dd>
  Tape decks, patch bays, walnut. A warm bottom gradient (tube-amp filament
  glow reflecting off the deck) plus fine horizontal tape grain drifting
  right-to-left, like magnetic tape passing a head. The VU-meter glow that
  earlier sat in the corner has been removed.
  </dd>
  </div>
  <div>
  <dt><strong>Bloodmoon</strong> - atmospheric dread</dt>
  <dd>
  Slow corner haze plus a rare film-leader wash that bursts maybe once
  every 30 seconds. The &quot;blood-moon&quot; reference is total-lunar-eclipse
  red - the moon stays in the sky but the color shifts toward something
  wrong. Reads as ambient dread without actively moving the eye.
  </dd>
  </div>
  <div>
  <dt><strong>Stealth</strong> - carbon-fiber weave</dt>
  <dd>
  Anisotropic carbon-fiber texture, dark and technical. Military-aerospace
  finish - F-117, Stealth bomber spec sheets. Quiet, weighty, no
  animation that competes with the work.
  </dd>
  </div>
  <div>
  <dt><strong>DSKY</strong> - Apollo Guidance Computer</dt>
  <dd>
  The DSKY (Display &amp; Keyboard) inside the Apollo command module:
  electroluminescent green segments, heavy bezel, supply-ripple flicker.
  The earlier giant central EL bloom has been replaced with structural
  raster bands so the panel reads as lit without painting an orb.
  </dd>
  </div>
  <div>
  <dt><strong>Amber CRT</strong> - the other phosphor</dt>
  <dd>
  Counterpart to Matrix: instead of P1 green, the older P3 amber/orange
  phosphor used in 1980s monochrome terminals (IBM 3279, Apple Monitor
  ///). The accountant console, the payroll mainframe, the register where
  terminal text was a profession.
  </dd>
  </div>
  <div>
  <dt><strong>Braun</strong> - Dieter Rams</dt>
  <dd>
  Industrial-design minimalism - Rams&apos; &quot;Less, but better.&quot; White paper,
  orange accent, no shader effects fighting the typography. The theme for
  when the application should disappear and leave only the words.
  </dd>
  </div>
  <div>
  <dt><strong>Blueprint</strong> - drafting paper</dt>
  <dd>
  Cyan/white architectural drafting register. Gridlines, paper-fiber
  texture, pen-and-ink. For early-stage design where the work is &quot;what
  should this be&quot; more than &quot;what is it doing right now.&quot;
  </dd>
  </div>
  <div>
  <dt><strong>Dark Academia</strong> - old library ink</dt>
  <dd>
  Cream paper, sepia darks, deep amber accents, fine pen-and-ink texture.
  The aesthetic of being deep in a stack at the back of a research library
  - long-form, slow, deliberate.
  </dd>
  </div>
  <div>
  <dt><strong>Solar Paper</strong> - watercolor on cream</dt>
  <dd>
  Hand-drawn register on warm paper. Soft watercolor wash, no hard
  boundaries. The lightest theme - for moments when the work is more
  imaginative than technical.
  </dd>
  </div>
  <div>
  <dt><strong>Holographic</strong> - iridescent foil</dt>
  <dd>
  The color shift on holographic foil and oil slicks: the same surface
  reads pink, cyan, gold depending on viewpoint. Chromatic plays in the
  tokens; the shader is restrained so the color identity carries the theme.
  </dd>
  </div>
  <div>
  <dt><strong>Frutiger Aero</strong> - mid-2000s optimism</dt>
  <dd>
  The aesthetic that runs from Windows Vista&apos;s glassy chrome through Web
  2.0 product launch pages: glossy, glowing, faintly aquatic, hopeful.
  Names after the typeface that was everywhere in that era.
  </dd>
  </div>
  </dl>
  </>
  ),
  },
  {
  id: 'settings-operator',
  group: 'Configuration',
  title: 'Settings - operator name & catalog',
  body: (
  <>
  <p>
  Operator name, catalog, skills and handoff prompts are global operator
  surfaces edited from Settings. Use them for context that should apply
  across workflows.
  </p>
  <Sub>Operator name and catalog</Sub>
  <p>
  <strong>Operator name</strong> is the label that replaces the generic{' '}
  <Code>&gt; OPERATOR</Code> prefix in chat. Useful when a name or project
  codename should appear in the rendered transcript that feeds handoff seeds.
  </p>
  <p>
  The <strong>catalog</strong> is a free-form markdown file that surfaces in
  the workflow creator and certain prompts as a place for common context,
  abbreviations, or commands across workflows. Edit it from Settings (saved
  to disk; the editor is a plain textarea).
  </p>
  <Sub>Skills</Sub>
  <p>
  <strong>Skills</strong> are managed in Settings &gt; SKILLS and stored as
  folders with a <Code>SKILL.md</Code> under project <Code>.arco/skills/</Code>{' '}
  or global <Code>~/.arco/skills/</Code>. The primary sees a compact manifest
  each turn; it reads the full skill body on demand with normal file tools.
  </p>
  <p>From the composer:</p>
  <ul>
  <li><strong>APPLY ONCE</strong> inlines one body into the next turn.</li>
  <li>
  <strong>PIN TO TAB</strong> keeps reapplying the current body every turn
  until its visible chip is removed.
  </li>
  <li>
  Under <strong>BUILT-IN</strong>, skills shipped with Arco offer{' '}
  <strong>RUN</strong> and <strong>EDITABLE COPY</strong>; see Architecture
  review.
  </li>
  </ul>
  <p>Importing, updating, turning off, moving and sharing skills: see Skills.</p>
  <Sub>Handoff prompts</Sub>
  <p>
  <strong>Handoff prompts</strong> are editable from Settings. Project-level
  overrides live under <Code>&lt;cwd&gt;/.arco/</Code> and can customize the
  original-worker and fresh-summarizer handoff seed prompts without changing
  code. Quick handoff does not use a writer prompt.
  </p>
  </>
  ),
  },
  {
  id: 'skills',
  group: 'Configuration',
  title: 'Skills - import, update, on/off, move and share',
  body: (
  <>
  <p>
  A skill is a folder with a <Code>SKILL.md</Code> (name and description at the
  top, then the instructions) and any files it refers to. Settings &gt; SKILLS
  lists project and global skills. Each row shows the extra files, where an
  imported skill came from, and skill names its text mentions that are not
  installed, such as "Refers to grilling, not installed".
  </p>
  <Sub>IMPORT</Sub>
  <p>
  <strong>IMPORT</strong> (also in the composer SKILLS menu) takes a public
  GitHub link to a skill folder or its <Code>SKILL.md</Code>, a folder on this
  computer, or a zip file. <strong>REVIEW</strong> lists every file with its
  size and runs the security check on each text file. Nothing is fetched before
  REVIEW and nothing is saved before <strong>IMPORT</strong>.
  </p>
  <p>
  Imported files keep their folders but never executable bits; hidden files are
  left out. Limits: 64 files, 512 KB per file, 2 MB in total. The source, with
  the GitHub commit, is recorded next to the skill.
  </p>
  <Sub>UPDATE, TURN OFF, MOVE, DUPLICATE</Sub>
  <p>
  <strong>UPDATE</strong> fetches an imported skill's source again and shows a
  diff per file, with the security check, before <strong>APPLY UPDATE</strong>.{' '}
  <strong>TURN OFF</strong> keeps a skill but leaves it out of the agent's list,
  tab pins and the SKILLS menu. <strong>MOVE TO GLOBAL</strong> or{' '}
  <strong>MOVE TO PROJECT</strong> moves the folder; <strong>DUPLICATE</strong>{' '}
  copies it under a new name.
  </p>
  <Sub>SHARE WITH REPOSITORY</Sub>
  <p>
  Project skills live in <Code>.arco/skills/</Code>, and Git ignores{' '}
  <Code>.arco</Code>. <strong>SHARE WITH REPOSITORY</strong> lists the files that
  would become visible to Git, then adds an exception for that one skill to{' '}
  <Code>.arco/.gitignore</Code>. Arco does not stage or commit. A public project
  gets a warning first.
  </p>
  <p>
  If Git still ignores the files after that (a project <Code>.gitignore</Code>{' '}
  line, or a global ignore file on this computer), SHARE refuses, names the
  rule and leaves <Code>.arco/.gitignore</Code> unchanged. Arco ships no
  third-party skills.
  </p>
  <p>
  A shared skill that is committed raises no project-state notice. STOP
  TRACKING leaves its files tracked, and RESTORE IGNORE FILE keeps its
  exception lines.
  </p>
  </>
  ),
  },
  {
  id: 'config-tab',
  group: 'Configuration',
  title: 'Per-workflow CONFIG tab',
  body: (
  <>
  <p>
  The CONFIG tab in the right pane holds settings for one workflow. Use it to
  change model, effort, transport and safety controls without rotating the
  session.
  </p>
  <Sub>Model and effort</Sub>
  <p>
  <strong>MODEL</strong> - same provider, different model. Affects the next
  turn.
  </p>
  <ul>
  <li>
  Claude tabs read from the live Anthropic <Code>/v1/models</Code> catalog
  (hourly cache) and gate per-model effort options on the catalog&apos;s
  reported support.
  </li>
  <li>
  Codex tabs read from the live <Code>codex app-server model/list</Code>{' '}
  catalog (hourly cache); the picker shows each model&apos;s one-line
  description as a tooltip.
  </li>
  <li>
  Strata lists prepared Original/SC117 profiles and loads the selection for
  the next message while keeping the conversation; one profile is resident at
  a time.
  </li>
  </ul>
  <p>
  <strong>EFFORT</strong> - same model, different reasoning budget. The levels
  are provider-specific:
  </p>
  <Table
  headers={['Provider', 'Effort levels']}
  rows={[
  ['Claude', <Code key="c">low/medium/high/xhigh/max</Code>],
  ['Codex', <>Follows the selected model&apos;s live catalog. GPT-6 Astra and Sol offer <Code>low/medium/high/xhigh/max/ultra</Code>; Luna stops at <Code>max</Code>; older GPT-5.x models expose fewer levels.</>],
  ['Ollama', <><Code>low</Code> (thinking off) plus whatever thinking levels the model advertises, for example <Code>low/medium/xhigh</Code> on qwen3.8. Falls back to <Code>low/high</Code> for models without levels.</>],
  ['Strata', <><Code>none/low/medium/high</Code>. None disables reasoning; high maps to Qwen xhigh.</>],
  ['llama.cpp, LM Studio', <><Code>low/high</Code> as a thinking toggle.</>],
  ]}
  />
  <p>
  Codex efforts map 1:1; a level the model doesn&apos;t support is clamped
  down to its highest supported one.
  </p>
  <Sub>Transport and modes</Sub>
  <p>
  <strong>TRANSPORT</strong> (Claude) - <Code>cli</Code> per-turn{' '}
  <Code>claude</Code> spawn vs <Code>native</Code> long-lived in-process worker
  via <Code>@anthropic-ai/sdk</Code>. New homes default to{' '}
  <Code>native</Code>; project and per-tab settings can select either.
  </p>
  <ul>
  <li>
  Native unlocks operator-armed plan-mode, parallel <Code>Task</Code>{' '}
  subagents, server-side compaction, and auto-handoff.
  </li>
  <li>
  Reviewers and handoff seeds always run on <Code>cli</Code> regardless of
  this toggle.
  </li>
  </ul>
  <p>
  <strong>ULTRACODE</strong> (Claude, sticky toggle below TRANSPORT) - the same
  deep multi-agent mode as <Code>ultracode</Code> in the Claude CLI. While on,
  every turn Claude authors a <Code>Workflow</Code> that fans out a fleet of
  subagents (find, verify, synthesize) which the harness runs in the
  background.
  </p>
  <ul>
  <li>
  The WorkflowTool lives only in the <Code>claude</Code> binary, so ultracode
  forces the <Code>cli</Code> transport and pins <Code>xhigh</Code>. The
  selected base transport is preserved and restored when turned off.
  </li>
  <li>
  Stays on across turns (and restart) until flipped off; takes effect next
  turn; reversible.
  </li>
  <li>
  A background workflow reports an early &quot;launched&quot; checkpoint, then
  the real synthesis. Arco coalesces to the synthesis and surfaces checkpoints
  as progress notices.
  </li>
  <li>
  The full Workflow script shows inline in the Activity tab; per-subagent
  detail lives in the harness workflow journal.
  </li>
  <li>
  Can also be armed at tab creation (the <Code>⚡ ULTRACODE</Code> box).
  </li>
  </ul>
  <Note kind="warn">
  Ultracode runs a fleet of agents <strong>unattended with full system access
  and spends heavily</strong> - a per-turn cost.
  </Note>
  <p>
  <strong>TRANSPORT</strong> (Codex) - <Code>exec</Code> per-turn spawn vs{' '}
  <Code>app-server</Code> long-lived per-tab process.
  </p>
  <ul>
  <li>
  App-server unlocks structured <Code>turn/interrupt</Code> cancel and
  non-destructive <Code>turn/steer</Code> mid-turn input.
  </li>
  <li>
  Reviewers and handoff seeds always run on <Code>exec</Code> regardless.
  </li>
  <li>
  A one-shot warning fires the first time a tab flips to app-server.
  </li>
  </ul>
  <p>
  <strong>CONTEXT WINDOW</strong> (Codex) - <Code>MAX</Code> (default) vs{' '}
  <Code>STANDARD</Code>. MAX asks Codex for the largest window the selected
  model + account accepts, read live from that account&apos;s model cache
  rather than a pinned number. STANDARD leaves Codex at its conservative
  default.
  </p>
  <ul>
  <li>Each button shows the effective size.</li>
  <li>
  Takes effect next turn on exec and app-server (an app-server child recycles
  and resumes the same thread).
  </li>
  <li>
  The CTX readout in the worker header prefers Codex&apos;s own reported
  window; missing catalog metadata falls back to Codex defaults.
  </li>
  </ul>
  <Sub>Output and thinking</Sub>
  <p>
  <strong>OUTPUT STYLE</strong> (Claude Native / Codex app-server) - appends a
  small stable prompt addendum telling the model how terse to be:
  </p>
  <ul>
  <li><Code>normal</Code> - no addendum.</li>
  <li><Code>lite</Code> - drops fillers/hedging.</li>
  <li><Code>terse</Code> - also drops articles (fragments OK).</li>
  </ul>
  <p>
  Code blocks, error strings, and file paths are preserved verbatim. Expect
  ~10-25% output reduction on Opus 4.7; the Codex effect is model-dependent.
  Review / Handoff / DOCS / GIT always run as <Code>normal</Code> regardless
  of source tab.
  </p>
  <p>
  <strong>THINKING VISIBILITY</strong> (Claude Native) - adaptive-thinking
  models only; takes effect next turn.
  </p>
  <Table
  headers={['Option', 'Behavior']}
  rows={[
  [<Code key="o">omitted</Code>, 'Default, Claude Code parity. No thinking streamed; quieter transcript.'],
  [<Code key="s">summarized</Code>, "Streams the model's summarized thinking into Activity during long reasoning stretches, so a multi-minute Fable/Opus think isn't total silence."],
  [<Code key="u">updates</Code>, 'Fable 5 / 5.1 and Opus 5.5 only. Requests short progress notes with hidden reasoning. Not guaranteed: the September 1 Fable 5.1 acceptance run emitted no notes. Other models treat it as omitted.'],
  ]}
  />
  <p>
  On Opus 5.5 pick <Code>summarized</Code> if Activity goes quiet between tool
  calls. Its progress notes arrive as thinking, which <Code>omitted</Code>{' '}
  hides.
  </p>
  <p>
  <strong>INTERLEAVED THINKING BETA</strong> (Claude Native debug) -
  default-off A/B toggle. Adaptive Claude models already reason between tool
  calls without the legacy interleaved-thinking beta. This forces the beta
  anyway on the next turn when comparing behavior on a suspicious workflow.
  </p>
  <Sub>Objective and goal runs</Sub>
  <p>
  <strong>NORTH STAR</strong> - a per-tab free-text objective (operator-only
  write; the model sees it read-only). It is pinned into the system prompt
  every turn on every transport that folds the cluster plan.
  </p>
  <ul>
  <li>Capped at 2048 bytes.</li>
  <li>Null-when-empty (zero-token default).</li>
  <li>
  Also settable via the <Code>/goal</Code> composer command and surfaced in
  the always-visible NorthStarBar chip above the composer.
  </li>
  <li>Primitives (Review / Handoff / DOCS / GIT / Spawn) inherit it.</li>
  </ul>
  <p>
  <strong>GOAL RUN</strong> (default off) - keeps the tab working toward its
  NORTH STAR without retyping &quot;continue&quot;. Set an iteration count (and
  optionally a token cap in millions) and press <Code>ARM</Code>. One
  automatic continuation turn fires after each settled turn until the budget
  is spent.
  </p>
  <ul>
  <li>
  Composer equivalents: <Code>/goal run 10</Code>, <Code>/goal run</Code> for
  status, <Code>/goal run stop</Code>.
  </li>
  <li>
  While armed, a <Code>RUN n/N</Code> chip with live token spend sits on the
  NorthStarBar above the composer. Click it to stop.
  </li>
  <li>
  Every iteration is an ordinary visible turn in the transcript.
  </li>
  <li>
  Counters aren&apos;t persisted: a server restart ends any armed run rather
  than silently resuming it.
  </li>
  </ul>
  <p>A run stops on its own, announcing the reason, when:</p>
  <ul>
  <li>A turn errors.</li>
  <li>The provider is rate-limited.</li>
  <li>Context passes 92%.</li>
  <li>The north star is cleared.</li>
  </ul>
  <p>
  A busy tab or queued messages just skip a beat without spending an
  iteration. Operator messages do <em>not</em> stop a run, so mid-flight
  steering remains available.
  </p>
  <p>
  Goal run requires a north star (the loop continues <em>toward</em> it). It
  continues purely because budget remains: it never asks the model whether
  the work is finished.
  </p>
  <Sub>Context, handoff and compaction</Sub>
  <p>
  <strong>AUTO-HANDOFF</strong> - <strong>Hand off after</strong> N
  compactions, off by default. When ticked, a tab starts a fresh session at the
  end of a turn once its conversation has been compacted N times (default 5,
  1 to 20). The line below the control says what Arco counts for the provider,
  or why it cannot count.
  </p>
  <p>
  Quick is the default auto-handoff mode; saved written-mode choices are
  preserved. Tabs saved with the earlier WARN and AUTO percentages keep their
  on or off state with 5 compactions.
  </p>
  <p>
  <strong>AUTO-COMPACTION</strong> - Provider uses Arco compaction near 90% for
  Claude Native and Ollama, leaving room for a summary. Claude CLI and Codex
  compact themselves.
  </p>
  <ul>
  <li>Choose Off or On with a threshold to override the default.</li>
  <li>A worker can inherit its cluster.</li>
  <li>Fold is deterministic and Handoff starts a fresh session.</li>
  </ul>
  <p>
  <strong>ADVANCED: Claude API compaction (beta)</strong> - optional per-tab
  Claude server compaction. COMPACT and the automatic default use Arco
  compaction and do not need it. New tabs start off; saved tab choices
  remain.
  </p>
  <p>
  <strong>AUTO-FOLD</strong> (Claude Native, default <Code>off</Code>) - a
  checkbox plus a <Code>FOLD AT</Code> percentage slider. It deterministically
  folds older history into a digest and keeps a verbatim recent tail in the
  same session: instant, no model round. A Fold does not count toward
  auto-handoff.
  </p>
  <p>
  The raw transcript stays in <Code>events.jsonl</Code>. Pair the manual
  composer <Code>FOLD</Code> button with this for on-demand trims.
  </p>
  <Sub>Safety and efficiency</Sub>
  <p>
  <strong>SANDBOX</strong> (Codex) - read-only / workspace-write /
  danger-full-access. Sticky across the workflow.
  </p>
  <p>
  <strong>REVIEW SAFE-MODE</strong> (Claude Native, default <Code>off</Code>) -
  when <Code>on</Code>, the worker pauses the turn on a sensitive tool call
  and surfaces an editable proposal to approve, edit, or reject before it
  runs. Sensitive calls are <Code>Bash</Code>, <Code>KillShell</Code>, writes
  outside the project, and <Code>git push</Code> / <Code>reset --hard</Code> /{' '}
  <Code>clean</Code>.
  </p>
  <p>
  Standing &quot;approve all like this&quot; approvals are listed beneath the
  toggle with a REVOKE button.
  </p>
  <p>
  <strong>EFFICIENCY</strong> (Claude Native) - per-tab knobs that trim context
  and guard edits:
  </p>
  <ul>
  <li>
  <strong>TOOL-RESULT FILTER</strong> (<Code>off</Code> /{' '}
  <Code>conservative</Code> / <Code>aggressive</Code>) - trims noisy tool
  output. Raw bytes are kept gzipped in the workflow artifacts for recovery.
  </li>
  <li>
  <strong>FACT-FORCE FIRST EDIT</strong> (default <Code>off</Code>) - when
  opted in, the first <Code>Edit</Code>/<Code>Write</Code>/
  <Code>MultiEdit</Code> per turn must cite importers + API surface first.
  </li>
  <li>
  <strong>CONFIG-PROTECTION GATE</strong> (default <Code>on</Code>) - blocks
  edits to lint/format/type-check config so the model fixes the code instead
  of weakening the gate.
  </li>
  <li><strong>SANDBOX TOOLS</strong> - opt-in.</li>
  </ul>
  <p>
  <strong>RSS GUARD</strong> - opt-out per workflow; the global default is 32
  GB tree-RSS auto-kill (override via <Code>ARCO_RSS_KILL_BYTES</Code>).
  </p>
  <Sub>Tools and integrations</Sub>
  <p>
  <strong>TOOLS</strong> (Claude) - comma-separated allowlist or empty for
  default.
  </p>
  <p>
  <strong>WEB LOOKUPS / TURN</strong> (Claude Native) - per-tab cap on the{' '}
  <Code>web_search</Code> + <Code>web_fetch</Code> server tools (the Anthropic{' '}
  <Code>max_uses</Code> parameter). Default <Code>15</Code> (presets 10 / 15 /
  25 / 50); raise it for research-heavy tabs.
  </p>
  <ul>
  <li>
  It is an Arco-set per-turn ceiling, not an Anthropic account limit. It
  resets every turn, and when a turn exhausts it the model reports web access
  ran out.
  </li>
  <li>
  CLI Claude ignores it; that transport routes web tooling through the{' '}
  <Code>claude</Code> binary, which budgets itself.
  </li>
  <li>Deep Research overrides it with the run&apos;s <Code>maxRounds</Code>.</li>
  </ul>
  <p>
  <strong>CODEBASE MEMORY</strong> - per-tab attach/detach of the
  operator-installed <Code>codebase-memory-mcp</Code> (RAG over the indexed
  tree). Distinct from the operator-curated KNOWLEDGE tab.
  </p>
  <ul>
  <li>Attach points it at an index path; RE-INDEX rebuilds it.</li>
  <li>
  A <Code>BLAST RADIUS</Code> sub-tab appears under FILES while it&apos;s
  attached.
  </li>
  <li>
  Arco always invokes the binary with <Code>--skip-config</Code> so it never
  auto-edits other agents&apos; configs.
  </li>
  </ul>
  <p>
  <strong>MCP REGISTRY</strong> - two layers. A global REGISTER list holds
  machine-wide MCP server defs by command/args/env with a master enable, and a
  per-tab toggle enables each globally-enabled server.
  </p>
  <ul>
  <li>
  Non-dangerous tools expose automatically; dangerous tools (name denylist)
  stay off until ticked per tab.
  </li>
  <li>
  On CLI Claude the denylist is real: unticked tools become{' '}
  <Code>--disallowedTools</Code>.
  </li>
  <li>
  On Codex there is no per-tool gate, so enabling a server exposes all its
  tools. This is surfaced as a warning.
  </li>
  </ul>
  <Sub>Status</Sub>
  <p>
  <strong>CLI STATUS</strong> - the version snapshot the workflow saw at
  start. Red dot if it changed since.
  </p>
  </>
  ),
  },

  {
  id: 'notifications',
  group: 'Configuration',
  title: 'Notifications',
  body: (
  <>
  <p>
  Settings &gt; Notifications chooses which events notify you, as a grid of
  events and places. Desktop and phone alerts are off until you tick a box.
  </p>
  <ul>
  <li><strong>Events</strong> - a turn finished (one that ran at least 15 seconds; in a cluster only the director's unless you choose every member), a turn failed, and waiting for you (a question or an approval is open). Incognito tabs never notify.</li>
  <li><strong>This computer</strong> - a system notification, shown only while Arco is not the window you are looking at, once per event. Clicking it opens that tab. The permission state is shown here. REQUEST PERMISSION asks the browser. TEST DESKTOP asks first if the browser has not been asked, then sends a test and shows Sent, Blocked, Not allowed, Not supported or Failed beside the button, with what to do. If blocked, allow notifications in the browser's site settings; an app window with its own browser profile has its own setting.</li>
  <li><strong>BELL</strong> - a quiet notice for a different tab that finishes, fails or needs you. In a cluster tab, every member other than the one in view counts as a different tab. It is on by default; use SHOW IN BELL to choose categories.</li>
  <li><strong>Phone</strong> - a message through an ntfy server, with no hub and no REMOTE switch needed. See Phone setup below.</li>
  <li><strong>Message text</strong> - left out of phone messages unless you tick it; then they include the question, the error or the start of the reply. The tab name is always included.</li>
  </ul>
  <Sub>Phone setup</Sub>
  <ol>
  <li>Enter the server (https://ntfy.sh or your own).</li>
  <li>Enter a topic; GENERATE makes a random one.</li>
  <li>For a protected topic, enter an access token. It is kept on the Arco computer and never shown again.</li>
  <li>Press TEST.</li>
  </ol>
  <ul>
  <li>Anyone who knows the topic can read its messages.</li>
  <li>Existing <Code>ARCO_NTFY_URL</Code> and <Code>ARCO_NTFY_TOKEN</Code> settings keep working until you save an address here.</li>
  <li>An instance whose Arco home folder is inside the system temporary folder, such as a test server, ignores <Code>ARCO_NTFY_URL</Code> and says so here. An address saved here still works. <Code>ARCO_ALLOW_TEMP_HOME=1</Code> uses the variable anyway.</li>
  </ul>
  <p>The window title shows how many tabs are waiting on you, for example "(2) ARCO". It needs no setting.</p>
  </>
  ),
  },

  {
  id: 'utility-agent',
  group: 'Configuration',
  title: 'Utility agent',
  body: (
  <>
  <p>
  The <strong>utility agent</strong> is one provider and model for short side
  jobs outside your workflows: CATCH ME UP, TIDY and BRIEF. Choose it once,
  then those buttons use it.
  </p>
  <Sub>Choosing the utility agent</Sub>
  <p>
  Set it under Settings &gt; Agents and clusters &gt; Utility agent and,
  optionally, under <strong>Utility agent (optional)</strong> on the last
  Welcome screen. Only providers that can answer without tools are offered,
  and only while enabled and connected:
  </p>
  <ul>
  <li><strong>Claude</strong> - needs Claude Native sign-in. The Claude CLI transport cannot make a single request without tools.</li>
  <li><strong>Cursor</strong> - needs Cursor Agent installed and signed in. The request runs in Ask mode with no file or terminal capability.</li>
  <li><strong>Ollama</strong> - always able to serve once connected; pick an installed model.</li>
  <li><strong>LM Studio, llama.cpp, Strata and DeepSeek through Xolotl</strong> - load the selected model first. These requests do not load or switch models.</li>
  <li><strong>Codex</strong> - needs Codex enabled in Settings and signed in. It runs as a one-shot read-only session in an empty folder with no MCP servers or web search, and any tool use ends the request with no decision.</li>
  </ul>
  <p>Models for each provider are chosen as buttons under MODEL; SAVE keeps the choice.</p>
  <ul>
  <li>Nothing is chosen for you. Arco only suggests a fast, low-cost model; it is used after you save it. CLEAR removes the choice.</li>
  <li>A utility job starts from a button you click, has no tools, reads only facts Arco collects, stops after 60 seconds and can be cancelled. The answer shows which model gave it and the facts it was given. A failed request explains the cause when available and names the model tried. A reply that is too long or cut off is reported instead of used.</li>
  <li>TEST sends one fixed request to confirm the choice answers. It shows a still-working note while a cold agent starts.</li>
  <li>Where a feature has its own agent choice, USE UTILITY AGENT fills that choice in with your utility agent. It never changes a choice you saved earlier, and the feature still works with its own agent.</li>
  <li>The facts of each job are sent to the chosen provider. Any cost depends on that provider.</li>
  </ul>
  <Sub>CATCH ME UP</Sub>
  <p>
  Use CATCH ME UP to summarize workflow or cluster activity from the earlier
  of the last visit or last operator message. The visit marker is stored in
  this browser.
  </p>
  <ul>
  <li>
  When no previous visit is recorded, SUMMARIZE covers the tab from its
  start, or the last 24 hours if older, and shows that range.
  </li>
  <li>When the range has no activity, no model is called. SINCE LAST TURN, LAST HOUR and TODAY offer another range.</li>
  <li>A failed summary stays in the dialog and is not written into chat.</li>
  <li>
  The dialog shows the requested time range, answering model, facts used and
  any omissions.
  </li>
  <li>SUMMARIZE starts the read-only job and CANCEL stops it.</li>
  <li>Incognito workflows are not summarized.</li>
  <li>
  For a cluster, a member whose activity is not available (not loaded, or
  incognito) is skipped and listed as a fact such as &quot;activity not
  available&quot;. When no member is available the request is refused.
  </li>
  </ul>
  <Sub>TIDY</Sub>
  <p>
  TIDY in a workflow or Chat composer asks the utility agent to propose a
  clearer instruction. The original stays in the composer until ACCEPT, and
  no message is sent automatically.
  </p>
  <ul>
  <li>Edit the proposal, REFINE with additional directions, or use BACK to revisit earlier revisions.</li>
  <li>KEEP ORIGINAL, the close button in the dialog header and Escape leave the draft untouched.</li>
  <li>UNDO TIDY restores the original until the composer changes.</li>
  <li>The original and refinement directions go to the selected provider.</li>
  </ul>
  <Sub>BRIEF</Sub>
  <p>
  <strong>BRIEF</strong> (on each member card and in the composer toolbar) is
  the first job. In a cluster tab the composer&apos;s BRIEF offers THIS WORKER
  or WHOLE CLUSTER.
  </p>
  <ul>
  <li>THIS WORKER writes two or three plain sentences about one worker.</li>
  <li>WHOLE CLUSTER writes one line per member and names who is waiting on you.</li>
  </ul>
  <p>The facts come straight from what Arco can see:</p>
  <ul>
  <li>Turn state and duration.</li>
  <li>
  The current step with its elapsed time. A step running over a minute is
  marked long-running; a worker that is thinking with no actions is described
  that way.
  </li>
  <li>Your last message and whether it is queued, delivered or answered.</li>
  <li>Recent events, a pending question and unread peer mail.</li>
  <li>The assigned board task.</li>
  <li>The uncommitted file count when a live view is open.</li>
  </ul>
  <p>
  Anything not visible is shown as not visible, and the facts are listed under
  the answer. A brief sends nothing to a worker and keeps nothing.
  </p>
  </>
  ),
  },
];

import type { Section } from '../../components/UserManual/manualTypes';
import { Code } from '../../components/UserManual/components';

export const configuration: Section[] = [
  {
    id: 'settings-providers',
    group: 'Configuration',
    title: 'Settings — providers',
    body: (
      <>
        <p>
          The <Code>⚙ SETTINGS</Code> modal is the operator-global config surface
          (per-workflow config lives in the CONFIG tab on the right pane).
        </p>
        <p><strong>Per-provider rows:</strong></p>
        <ul>
          <li><strong>Toggle</strong> — disable a provider entirely. Disabled providers don't appear in workflow creators or Handoff/Spawn dialogs.</li>
          <li><strong>Auth state</strong> — green LIVE chip when authed. <Code>LOG IN</Code> button when not.</li>
          <li><strong>Sub-line</strong> — for normal providers: email / org / plan. For Ollama: daemon up + N models installed. Strata shows configured models available on demand; LIVE does not prove weights are currently in VRAM.</li>
        </ul>
        <p>
          Claude has two auth surfaces: CLI auth and Claude Native OAuth. Ollama,
          llama.cpp, LM Studio and Strata are auth-less; their buttons read <Code>HELP</Code> and
          open troubleshooting tips.
        </p>
        <p>
          Settings cascade as defaults → <Code>~/.arco/settings.json</Code> →
          <Code>&lt;cwd&gt;/.arco/settings.json</Code> → per-workflow CONFIG. Project
          settings deep-merge nested objects and replace arrays; edits are watched
          live. State lives under <Code>.arco/</Code> and environment variables use
          the <Code>ARCO_</Code> prefix.
        </p>
      </>
    ),
  },
  {
    id: 'settings-themes',
    group: 'Configuration',
    title: 'Settings — themes',
    body: (
      <>
        <p>
          Arco ships a registry of themes that swap CSS vars on{' '}
          <Code>:root</Code>. The active theme is persisted to localStorage and
          applied <em>synchronously</em> at boot to avoid a flash of default colors.
        </p>
        <p>Two render styles for panels:</p>
        <ul>
          <li>
            <strong>CSS hairlines</strong> — most themes. Crisp 1px borders, classic
            cyberpunk look.
          </li>
          <li>
            <strong>Rough.js excalidraw</strong> — wobbly hand-drawn-style borders
            using lazy-loaded roughjs. Bundle only grows when you actually pick a
            rough theme.
          </li>
        </ul>
        <p>Switching themes is instant; no reload needed. All components re-render with the new tokens.</p>
        <p>
          Arco Classic retains 43 selections, including provider-auto. Arco
          Phosphor adds 68 namespaced Phosphor palettes under a separate family,
          with category/search navigation. The separate <strong>font-pack override</strong> (29 packs) lets you
          keep one theme's color/shader palette while substituting display, body,
          and code typography from another pack.
        </p>
        <p>Phosphor is styling only: the workbench layout and contents stay in place.
          Glow softness defaults to 50% (0 removes glow; 100 is the Arco
          reference). Effects off removes decoration. Crisp text disables glyph
          emission, including the wordmark, while reduced motion retains static
          glow, glass and raster. Text/background brightness and frosted-surface
          overrides remain available; Phosphor effects off overrides frost without
          deleting its saved preference.</p>
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
          Each Classic theme is a deliberate reference, not just a color swap. Phosphor palettes share one presentation and change colors only. Tokens, fonts,
          glyphs, and the background shader together evoke a register the operator can
          step into. The list below covers the original design-led themes in the
          order they appear in Settings; a handful of later additions (Cute, Forest,
          Ocean, Lavender, Ume, Copper, Everforest, Arco Jungle, Arco Default, Unfinished Works) ship in the
          registry but aren't catalogued here.
        </p>
        <dl style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <dt><strong>Matrix</strong> — phosphor terminal</dt>
            <dd>
              The Wachowskis' falling-glyph cascade reframed as a working register.
              Green CRT phosphor on pitch black, scanlines, tube vignette, a per-column
              glitch-flash to keep the field alive. The default theme because it's the
              one that still says "the machine is doing something" without being
              ambient.
            </dd>
          </div>
          <div>
            <dt><strong>Sentinel</strong> — operator on shift</dt>
            <dd>
              Built on the DARKN0DE / nightshift-SOC idiom: a quiet console with corner
              status diamonds that pulse faster as tension rises. Steel-blue calm
              tinting toward red under load, heavy vignette, amber corner markers.
              For long uptimes when you want to feel <em>watched over</em> something
              instead of just typing into it.
            </dd>
          </div>
          <div>
            <dt><strong>Cherenkov</strong> — through the cooling pool</dt>
            <dd>
              Cherenkov radiation: the blue glow charged particles emit when they
              exceed the speed of light in water. The shader is what you'd see staring
              down into a reactor's spent-fuel pool — domain-warped caustic ribbons
              and slow rising bubbles, viewed from above the surface.
            </dd>
          </div>
          <div>
            <dt><strong>Infrared</strong> — false-color thermogram</dt>
            <dd>
              The matplotlib <em>turbo</em> colormap (black → indigo → magenta →
              amber → near-white) piped over a slow noise field. Heat bleeding through
              chrome. Comes out of FLIR / surveillance imagery and the 1980s
              military-tech publication aesthetic.
            </dd>
          </div>
          <div>
            <dt><strong>Aurora</strong> — arctic night sky</dt>
            <dd>
              The polar starfield. An earlier pass painted ribbons across the upper
              third; those are gone now because they read as a glowing wash over
              chat. What remains is the part that still feels <em>north</em> — a dense
              field of twinkling pinpricks, a small fraction tinted aurora-green or
              magenta.
            </dd>
          </div>
          <div>
            <dt><strong>Nebula</strong> — Hubble deep field</dt>
            <dd>
              The diffuse nebular cloud was removed for the same reason as Aurora's
              ribbons. What's left is the part that gives the deep field its weight:
              dense pinpricks shimmering on near-black, with a small fraction tinted
              violet/cyan to carry the palette.
            </dd>
          </div>
          <div>
            <dt><strong>Sonar</strong> — WWII ASDIC display</dt>
            <dd>
              The U-boat hunt period: a polar grid with a rotating sweep wedge and
              persistent contact returns. The sweep period shortens with workflow
              tension. Tight, slow, deliberate — built for the register where you're
              listening more than you're acting.
            </dd>
          </div>
          <div>
            <dt><strong>Seismograph</strong> — pen-and-paper trace</dt>
            <dd>
              Long-form continuous monitoring: the kind of slow line a drum recorder
              draws across a roll of paper for hours, occasionally jagged. For work
              where the signal is what you missed during the calm.
            </dd>
          </div>
          <div>
            <dt><strong>Kintsugi</strong> — gold-vein lacquer</dt>
            <dd>
              The Japanese craft of repairing broken pottery with gold seams — the
              breakage becomes the most beautiful part. Worley feature-point edges
              produce slowly breathing crack lines on dark urushi lacquer. A theme
              about working through what's already cracked.
            </dd>
          </div>
          <div>
            <dt><strong>Cicada</strong> — cryptic data stream</dt>
            <dd>
              Named after Cicada 3301 — the unsolved internet ARG that ran 2012–2014
              with cryptographic puzzles posted to imageboards. The shader is an
              LCD-style cell grid that reads like a hex dump without being characters;
              rare flash-white cells stand in for anomalies.
            </dd>
          </div>
          <div>
            <dt><strong>Tarkovsky</strong> — Stalker / Mirror register</dt>
            <dd>
              35mm projection of the Zone. Slow vertical scan bands drifting down the
              frame, heavy luminance-aware grain, sepia pulled up in shadows. For
              contemplative work where you want the room to feel like a film being
              held up to the light.
            </dd>
          </div>
          <div>
            <dt><strong>Night City</strong> — aerial sleeping grid</dt>
            <dd>
              An overhead view of a city at night, abstracted. Lit windows inside
              block tiles, faint streets between them, traffic dots scrolling on a
              few specific thoroughfares. Cyberpunk-adjacent but geographic rather
              than neon — the city as map, not signage.
            </dd>
          </div>
          <div>
            <dt><strong>Abyssal</strong> — marine snow</dt>
            <dd>
              "Marine snow" is the continuous shower of organic detritus that falls
              through the deep ocean below the photic zone. The shader is bioluminescent
              particles drifting downward under a faint horizontal current. Quiet
              register for thinking time.
            </dd>
          </div>
          <div>
            <dt><strong>Voyager</strong> — engineering schematic</dt>
            <dd>
              The NASA Voyager probe and what surrounded it: sparse parallax stars
              with engineering-blueprint ghosts drifting through. References both the
              probe's plaque and the technical-drawing register of late-70s JPL.
            </dd>
          </div>
          <div>
            <dt><strong>Noir</strong> — film noir</dt>
            <dd>
              Pure black-and-white luminance, with crimson reserved as the only
              chromatic accent — used for danger states. The shader is just film
              grain and a static corner vignette. The theme where the red <em>means
              something</em> because nothing else is colored.
            </dd>
          </div>
          <div>
            <dt><strong>Midnight Tokyo</strong> — rain on glass</dt>
            <dd>
              Originally rain over a neon bokeh field; the bokeh was removed for the
              blob-cleanup pass. What's left is what carries the city anyway — wide
              translucent streaks tinted into the cold magenta/cyan palette, with the
              tokens doing the heavy lifting.
            </dd>
          </div>
          <div>
            <dt><strong>Arrakis</strong> — Dune / heat haze</dt>
            <dd>
              Slow horizontal shimmer plus fine sand grain. Sietch register: the
              register you'd use writing in a desert at noon, where the act of looking
              costs something. Warm sand palette, no cool tones.
            </dd>
          </div>
          <div>
            <dt><strong>Oscilloscope</strong> — the tube itself</dt>
            <dd>
              Not a Lissajous figure or a beam trace — the <em>physical CRT tube</em>:
              barrel-distorted glass, fine scanline texture, bezel vignette. What the
              old test equipment looks like before you turn it on. Glow on UI text
              comes from CSS text-shadow, gated by data-attribute.
            </dd>
          </div>
          <div>
            <dt><strong>Concrete</strong> — brutalist surface</dt>
            <dd>
              Static aggregate speckle plus a slow vertical cast-shadow drift.
              Architectural register: Béton Brut, raw fairface concrete, the buildings
              that meant something specific in 1965 and were supposed to age into
              meaning more.
            </dd>
          </div>
          <div>
            <dt><strong>Cassette Futurism</strong> — 1970s Moog studio</dt>
            <dd>
              Tape decks, patch bays, walnut. A warm bottom gradient (tube-amp filament
              glow reflecting off the deck) plus fine horizontal tape grain drifting
              right-to-left, like magnetic tape passing a head. The VU-meter glow that
              earlier sat in the corner has been removed.
            </dd>
          </div>
          <div>
            <dt><strong>Bloodmoon</strong> — atmospheric dread</dt>
            <dd>
              Slow corner haze plus a rare film-leader wash that bursts maybe once
              every 30 seconds. The "blood-moon" reference is total-lunar-eclipse
              red — the moon stays in the sky but the color shifts toward something
              wrong. Reads as ambient dread without actively moving the eye.
            </dd>
          </div>
          <div>
            <dt><strong>Stealth</strong> — carbon-fiber weave</dt>
            <dd>
              Anisotropic carbon-fiber texture, dark and technical. Military-aerospace
              finish — F-117, Stealth bomber spec sheets. Quiet, weighty, no
              animation that competes with the work.
            </dd>
          </div>
          <div>
            <dt><strong>DSKY</strong> — Apollo Guidance Computer</dt>
            <dd>
              The DSKY (Display &amp; Keyboard) inside the Apollo command module:
              electroluminescent green segments, heavy bezel, supply-ripple flicker.
              The earlier giant central EL bloom has been replaced with structural
              raster bands so the panel reads as lit without painting an orb.
            </dd>
          </div>
          <div>
            <dt><strong>Amber CRT</strong> — the other phosphor</dt>
            <dd>
              Counterpart to Matrix: instead of P1 green, the older P3 amber/orange
              phosphor used in 1980s monochrome terminals (IBM 3279, Apple Monitor
              ///). The accountant console, the payroll mainframe, the register where
              terminal text was a profession.
            </dd>
          </div>
          <div>
            <dt><strong>Braun</strong> — Dieter Rams</dt>
            <dd>
              Industrial-design minimalism — Rams' "Less, but better." White paper,
              orange accent, no shader effects fighting the typography. The theme for
              when you want the application to disappear and leave only the words.
            </dd>
          </div>
          <div>
            <dt><strong>Blueprint</strong> — drafting paper</dt>
            <dd>
              Cyan/white architectural drafting register. Gridlines, paper-fiber
              texture, pen-and-ink. For early-stage design where the work is "what
              should this be" more than "what is it doing right now."
            </dd>
          </div>
          <div>
            <dt><strong>Dark Academia</strong> — old library ink</dt>
            <dd>
              Cream paper, sepia darks, deep amber accents, fine pen-and-ink texture.
              The aesthetic of being deep in a stack at the back of a research library
              — long-form, slow, deliberate.
            </dd>
          </div>
          <div>
            <dt><strong>Solar Paper</strong> — watercolor on cream</dt>
            <dd>
              Hand-drawn register on warm paper. Soft watercolor wash, no hard
              boundaries. The lightest theme — for moments when the work is more
              imaginative than technical.
            </dd>
          </div>
          <div>
            <dt><strong>Holographic</strong> — iridescent foil</dt>
            <dd>
              The color shift you get on holographic foil and oil slicks: the same
              surface reads pink, cyan, gold depending on where you stand. Chromatic
              plays in the tokens; the shader is restrained so the color identity
              carries the theme.
            </dd>
          </div>
          <div>
            <dt><strong>Frutiger Aero</strong> — mid-2000s optimism</dt>
            <dd>
              The aesthetic that runs from Windows Vista's glassy chrome through Web
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
    title: 'Settings — operator name & catalog',
    body: (
      <>
        <p>
          <strong>Operator name</strong> is the label that replaces the generic{' '}
          <Code>&gt; OPERATOR</Code> prefix in chat. Useful when you want your name
          (or a project codename) in the rendered transcript that gets fed back into
          handoff seeds.
        </p>
        <p>
          The <strong>catalog</strong> is a free-form markdown file that surfaces in
          the workflow creator and certain prompts as a place to drop common
          context, conventions, or commands you want available across workflows. Edit
          it from Settings (saved to disk; the editor is a plain textarea).
        </p>
        <p>
          <strong>Skills</strong> are CRUD-managed from Settings and stored as
          <Code>SKILL.md</Code> files under project <Code>.arco/skills/</Code> or
          global <Code>~/.arco/skills/</Code>. The primary sees a compact manifest
          each turn; it reads the full skill body on demand with normal file tools.
          From the composer, <strong>APPLY ONCE</strong> inlines one body into the
          next turn, while <strong>PIN TO TAB</strong> keeps reapplying the current
          body every turn until you remove its visible chip.
        </p>
        <p>
          <strong>Handoff prompts</strong> are editable from Settings. Project-level
          overrides live under <Code>&lt;cwd&gt;/.arco/</Code> and can customize the
          original-worker and fresh-summarizer handoff seed prompts without changing
          code.
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
          The CONFIG tab in the right pane is per-workflow. Everything here can change
          without rotating the session:
        </p>
        <ul>
          <li><strong>MODEL</strong> — same provider, different model. Affects next turn. Claude tabs read from the live Anthropic <Code>/v1/models</Code> catalog (hourly cache) and gate per-model effort options on the catalog's reported support. Strata lists prepared Original/SC117 profiles and loads the selection for the next message while keeping the conversation; one profile is resident at a time. Codex tabs read from the live <Code>codex app-server model/list</Code> catalog (hourly cache); the picker shows each model's one-line description as a tooltip.</li>
          <li><strong>EFFORT</strong> — same model, different reasoning budget. Provider-specific (Claude has <Code>low/medium/high/xhigh/max</Code>; Codex follows the selected model's live catalog — GPT-6 Astra and Sol offer <Code>low/medium/high/xhigh/max/ultra</Code>, Luna stops at <Code>max</Code>, older GPT-5.x models expose fewer levels; Ollama offers <Code>low</Code> (thinking off) plus whatever thinking levels the model advertises — e.g. qwen3.8 gives <Code>low/medium/xhigh</Code> — and falls back to <Code>low/high</Code> for models without levels; Strata exposes <Code>none/low/medium/high</Code> (none disables reasoning, high maps to Qwen xhigh); llama.cpp and LM Studio expose <Code>low/high</Code> as a thinking toggle). Codex efforts map 1:1; a level the model doesn't support is clamped down to its highest supported one.</li>
          <li><strong>TRANSPORT</strong> (Claude) — <Code>cli</Code> per-turn <Code>claude</Code> spawn vs <Code>native</Code> long-lived in-process worker via <Code>@anthropic-ai/sdk</Code>. New homes default to <Code>native</Code>; project and per-tab settings can select either. Native unlocks operator-armed plan-mode, parallel <Code>Task</Code> subagents, server-side compaction, and auto-handoff. Reviewers and handoff seeds always run on <Code>cli</Code> regardless of this toggle.</li>
          <li><strong>ULTRACODE</strong> (Claude, sticky toggle below TRANSPORT) — the same deep multi-agent mode as <Code>ultracode</Code> in the Claude CLI. While on, every turn Claude authors a <Code>Workflow</Code> that fans out a fleet of subagents (find → verify → synthesize) which the harness runs in the background. The WorkflowTool lives only in the <Code>claude</Code> binary, so ultracode forces the <Code>cli</Code> transport + pins <Code>xhigh</Code>; your selected base transport is preserved and restored when you turn it off. Stays on across turns (and restart) until you flip it off; takes effect next turn; reversible. It runs a fleet of agents <strong>unattended with full system access and spends heavily</strong> — a per-turn cost. A background workflow reports an early "launched" checkpoint then the real synthesis; Arco coalesces to the synthesis and surfaces checkpoints as progress notices. The full Workflow script shows inline in the Activity tab; per-subagent detail lives in the harness workflow journal. Can also be armed at tab creation (the <Code>⚡ ULTRACODE</Code> box).</li>
          <li><strong>TRANSPORT</strong> (Codex) — <Code>exec</Code> per-turn spawn vs <Code>app-server</Code> long-lived per-tab process. App-server unlocks structured <Code>turn/interrupt</Code> cancel and non-destructive <Code>turn/steer</Code> mid-turn input. Reviewers and handoff seeds always run on <Code>exec</Code> regardless. One-shot warning gate (<Code>appserverWarningSeen</Code>) fires the first time you flip a tab to app-server.</li>
          <li><strong>CONTEXT WINDOW</strong> (Codex) — <Code>MAX</Code> (default) vs <Code>STANDARD</Code>. MAX asks Codex for the largest window the selected model + account accepts, read live from that account's <Code>models_cache.json</Code> rather than a pinned number; STANDARD leaves Codex at its conservative default. Each button shows the effective size. Takes effect next turn on exec and app-server (an app-server child recycles and resumes the same thread). The CTX footer prefers Codex's own reported window; missing catalog metadata falls back to Codex defaults.</li>
          <li><strong>OUTPUT STYLE</strong> (Claude Native / Codex app-server) — <Code>normal</Code> / <Code>lite</Code> / <Code>terse</Code>. Appends a small stable prompt addendum telling the model how terse to be: <Code>lite</Code> drops fillers/hedging; <Code>terse</Code> also drops articles (fragments OK). Code blocks, error strings, and file paths are preserved verbatim. ~10–25% output reduction on Opus 4.7; Codex effect is model-dependent. Review / Handoff / DOCS / GIT always run as <Code>normal</Code> regardless of source tab.</li>
          <li><strong>SERVER-SIDE COMPACTION</strong> (Claude Native) — opt-in toggle that pins <Code>compact_20260112</Code> on <Code>messages.create</Code> when enabled. Only renders when the active model's catalog entry advertises <Code>compact</Code> support. <Code>clear_thinking</Code> + <Code>clear_tool_uses</Code> are intentionally not default-on because they can clear live research evidence; compaction sits beneath operator Handoff.</li>
          <li><strong>INTERLEAVED THINKING BETA</strong> (Claude Native debug) — default-off A/B toggle. Adaptive Claude models already reason between tool calls without the legacy <Code>interleaved-thinking-2025-05-14</Code> beta; this forces the beta anyway on the next turn if you need to compare behavior on a suspicious workflow.</li>
          <li><strong>THINKING VISIBILITY</strong> (Claude Native) — <Code>omitted</Code> (default, Claude Code parity — no thinking streamed, quieter transcript) vs <Code>summarized</Code> (streams the model's summarized thinking into Activity during long reasoning stretches, so a multi-minute Fable/Opus think isn't total silence) vs <Code>updates</Code> (Fable 5 / 5.1 and Opus 5.5 only — requests short progress notes with hidden reasoning; this is not guaranteed, and the September 1 Fable 5.1 acceptance run emitted no notes; other models treat it as omitted). On Opus 5.5 pick <Code>summarized</Code> if Activity goes quiet between tool calls — its progress notes arrive as thinking, which <Code>omitted</Code> hides. Adaptive-thinking models only; takes effect next turn.</li>
          <li><strong>SANDBOX</strong> (Codex) — read-only / workspace-write / danger-full-access. Sticky across the workflow.</li>
          <li><strong>TOOLS</strong> (Claude) — comma-separated allowlist or empty for default.</li>
          <li><strong>NORTH STAR</strong> — a per-tab free-text objective (operator-only write; the model sees it read-only). Pinned into the system prompt every turn on every transport that folds the cluster plan; capped at 2048 bytes. Null-when-empty (zero-token default). Also settable via the <Code>/goal</Code> composer command and surfaced in the always-visible NorthStarBar chip above the composer. Primitives (Review / Handoff / DOCS / GIT / Spawn) inherit it.</li>
          <li><strong>GOAL RUN</strong> (default off) — keeps the tab working toward its NORTH STAR without you retyping "continue". Set an iteration count (and optionally a token cap in millions), press <Code>ARM</Code>, and one automatic continuation turn fires after each settled turn until the budget is spent. Composer equivalents: <Code>/goal run 10</Code>, <Code>/goal run</Code> for status, <Code>/goal run stop</Code>. While armed, a <Code>RUN n/N</Code> chip with live token spend sits on the NorthStarBar above the composer — click it to stop. A run also stops on its own if a turn errors, the provider is rate-limited, context passes 92%, or the north star is cleared, each announced with its reason; a busy tab or queued messages just skip a beat without spending an iteration. Your own messages do <em>not</em> stop a run, so you can steer mid-flight. Every iteration is an ordinary visible turn in the transcript, and counters aren't persisted — a server restart ends any armed run rather than silently resuming it. Requires a north star (the loop continues <em>toward</em> it) and continues purely because budget remains: it never asks the model whether the work is finished.</li>
          <li><strong>WARNING THRESHOLD</strong> + <strong>AUTO-HANDOFF CEILING</strong> — context-fill percentages. Defaults: <Code>warnAt: 75</Code>, <Code>autoAt: 90</Code>. Arco honors them only when the provider has a trusted context-fill signal. Claude uses session/Native counts; Codex app-server use the latest rollout token snapshot; Ollama uses the daemon prompt count. Disable auto-handoff to rely on compact/manual Handoff instead.</li>
          <li><strong>AUTO-COMPACTION</strong> - choose an explicit worker override or inherit the cluster default, with a 30-95% threshold. Claude Native and Codex app-server use current turn context and compact in place; Codex needs an existing thread. Ollama summarizes verified completed executions before the next turn and reuses saved summaries. Legacy or partial history defers safely; raw events remain available. An enabled Ollama policy defers automatic handoff; manual handoff remains available. With no policy, the existing Ollama global settings apply. Other transports cannot use this policy. Explicit Off stops automatic compaction; an absent policy preserves existing provider behavior. Fold is a deterministic digest and Handoff starts a fresh session. A cluster evaluates each member separately.</li>
          <li><strong>AUTO-FOLD</strong> (Claude Native, default <Code>off</Code>) — a checkbox plus a <Code>FOLD AT</Code> percentage slider held below the warning threshold. Before a handoff is recommended, deterministically folds older history into a digest and keeps a verbatim recent tail in the same session — instant, no model round. The raw transcript stays in <Code>events.jsonl</Code>. Pair the manual composer <Code>FOLD</Code> button with this for on-demand trims.</li>
          <li><strong>REVIEW SAFE-MODE</strong> (Claude Native, default <Code>off</Code>) — when <Code>on</Code>, the worker pauses the turn on a sensitive tool call (<Code>Bash</Code>, <Code>KillShell</Code>, writes outside the project, <Code>git push</Code> / <Code>reset --hard</Code> / <Code>clean</Code>) and surfaces an editable proposal you approve, edit, or reject before it runs. Standing "approve all like this" approvals are listed beneath the toggle with a REVOKE button.</li>
          <li><strong>EFFICIENCY</strong> (Claude Native) — per-tab knobs that trim context and guard edits: TOOL-RESULT FILTER (<Code>off</Code> / <Code>conservative</Code> / <Code>aggressive</Code> — trims noisy tool output, raw bytes gzipped under <Code>artifacts/raw-tools/</Code> for recovery), FACT-FORCE FIRST EDIT (default <Code>off</Code>; when opted in, the first <Code>Edit</Code>/<Code>Write</Code>/<Code>MultiEdit</Code> per turn must cite importers + API surface first), CONFIG-PROTECTION GATE (default <Code>on</Code> — blocks edits to lint/format/type-check config so the model fixes the code instead of weakening the gate), and opt-in SANDBOX TOOLS.</li>
          <li><strong>WEB LOOKUPS / TURN</strong> (Claude Native) — per-tab cap on the <Code>web_search</Code> + <Code>web_fetch</Code> server tools (the Anthropic <Code>max_uses</Code> parameter). An Arco-set per-turn ceiling, not an Anthropic account limit: it resets every turn, and when a turn exhausts it the model reports web access ran out. Default <Code>15</Code> (presets 10 / 15 / 25 / 50); raise it for research-heavy tabs. CLI Claude ignores it — that transport routes web tooling through the <Code>claude</Code> binary, which budgets itself. Deep Research overrides it with the run's <Code>maxRounds</Code>.</li>
          <li><strong>RSS GUARD</strong> — opt-out per workflow; the global default is 32 GB tree-RSS auto-kill (override via <Code>ARCO_RSS_KILL_BYTES</Code>).</li>
          <li><strong>CODEBASE MEMORY</strong> — per-tab attach/detach of the operator-installed <Code>codebase-memory-mcp</Code> (RAG over the indexed tree). Attach points it at an index path, RE-INDEX rebuilds it, and a <Code>BLAST RADIUS</Code> sub-tab appears under FILES while it's attached. Arco always invokes the binary with <Code>--skip-config</Code> so it never auto-edits other agents' configs. Distinct from the operator-curated KNOWLEDGE tab.</li>
          <li><strong>MCP REGISTRY</strong> — two layers: a global REGISTER list (machine-wide MCP server defs by command/args/env, master enable) and a per-tab enable toggle for each globally-enabled server. Non-dangerous tools expose automatically; dangerous tools (name denylist) stay off until ticked per tab. On CLI Claude the denylist is real (unticked tools become <Code>--disallowedTools</Code>); on Codex there is no per-tool gate, so enabling a server exposes all its tools — surfaced as a warning.</li>
          <li><strong>CLI STATUS</strong> — the version snapshot the workflow saw at start. Red dot if it changed since.</li>
        </ul>
      </>
    ),
  },

];

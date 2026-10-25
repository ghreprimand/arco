# Arco Phosphor — isolated design preview

The approved treatment is now integrated in production source as the Phosphor
theme family. This demo remains isolated. Shared palette/adapter/emission/renderer
modules live in `client/src/themes/phosphor/`; demo paths re-export them.

Review URL: **http://127.0.0.1:5178/phosphor-demo.html**

This is a separate Vite entry, with synthetic data and local operation adapters.
It does not replace the Arco entry, deploy a build, restart `archon.service`,
or change production theme contracts. All preview choices reset on reload.

**Review boundary (operator feedback):** approval is for the visual treatment,
not this rearranged fixture shell. A rollout must preserve Arco's existing
layout, content, operational controls and full settings, including fonts and
independent background/text brightness. The styling-only integration was deployed on September 7; this fixture layout was not.

```bash
npm run dev:phosphor-demo -w client
npm run build:phosphor-demo -w client
npm run test:phosphor
python3 scripts/smoke/phosphor-demo-browser.py
```

The development server binds loopback on port 5178, with strict port selection.
Build output goes to ignored `client/dist-phosphor-demo/`, never `client/dist/`.
The production service was left running throughout this work.

## Inspecting the preview

- Starts in **Arco Phosphor → Arco CRT**, compact, effects on. Compare
  **Arco Classic** using the same transcript, viewport and panel state.
- **GLOW SOFTNESS** defaults to 50% after review of the softer-looking transcript.
  It tightens the luminous core and reduces halo/chromatic spread without changing
  foreground ink, fonts or layout. 100% retains the original reference emission
  stack; 0 removes text glow only. Crisp text/effects-off override and disable
  the slider without forgetting its value. Reduced motion retains the setting.
- **FONTS / BRIGHTNESS** opens the display settings, including all existing font
  packs, separate text brightness (−30…+80) and background brightness (−30…+30).
  The background dimmer uses Arco's existing token adjustment and feeds the
  adjusted base into the ambient renderer; static fallback uses the same tokens.
- **BROWSE / SETTINGS** searches all palettes by readable name or full ID, with
  category filtering. Family, palette, density, effects, crisp text and font
  override are distinct controls. Effects and accessibility controls are shared
  preview preferences, not properties stored in an imported palette.
- The transcript contains 36 initial messages, including 14 earlier exchanges,
  Markdown tables, code, timestamps, tool arguments, an error, pending approval
  and input. Scroll into history or use **SEARCH** to search complete messages
  and tool arguments, including rows currently outside the virtualizer.
- **PLAY STREAM** emits a bounded synthetic response. Stop it, edit the
  composer, add local attachment metadata, queue a follow-up with Alt+Enter,
  approve/reject the proposed command, or answer the native question control.
  Nothing launches a provider or process. The terminal records typed commands
  and displays a simulated response.
- Right panel: plans/checklists, artifact bodies, files, unified/split diffs,
  review findings, activity, usage graph with equivalent numeric table, and a
  selectable architecture-style preview map. The splitter supports dragging,
  ArrowLeft/ArrowRight and Home/End. Narrow views stack the panels.
- Settings, workflow actions and notifications open native modal dialogs.
  The palette browser hint is available on hover and keyboard focus. Native
  controls, application text and code remain DOM content, not canvas pixels.

## Inventory and coverage

Inventory was reconciled against `docs/CLIENT.md`, `main.tsx`, the theme
implementation, ChatPanel/ChatMessage and the current component directory.
This preview exercises representative working states, not the whole application.

| Existing screen family | Preview coverage | Still outside this review |
| --- | --- | --- |
| Agent workbench, project/workflow tabs, status, north star | Fixture shell, real transcript; same data across family changes | Rehydrate, disconnected/auth/shutdown overlays, actual workflow lifecycle |
| Projectless Chat | Chat presentation toggle with the same synthetic conversation | Full Chat layout, incognito persistence/provider restrictions |
| Conversation, streaming, tools, approvals, questions | Real virtualized ChatPanel, ChatMessage, ToolCallPill, GateApprovalNotice, AskUserQuestionNotice, code copy and file viewer | Live transport events, context fold/handoff replay, multimodal streaming |
| Composer, attachments, provider/model/effort, queue, primitives | Fixture composer and local controls; distinct steer/follow-up states | Full TerminalInput slash commands, skill/context refs, provider-specific catalogs, real uploads, execution of Review/Handoff/Spawn/DOCS/GIT |
| Workspace Files, SOURCE/CHANGES/LIVE/REMOTE/Blast radius | Synthetic paths, real Markdown/code rendering and DiffView | Live filesystem, Git staging/revert/fetch, editor save, remote comparison, blast-radius analysis |
| Plan, Tasks, Ledger | Fixture attached plan, checkboxes, owner/state metadata and artifacts | Native Task-child lifecycle and persistent project ledger operations |
| Review, Research, Handoffs | Populated fixture review body/findings | Research reports, citations, handoff history, bake-offs and execution |
| Activity, Usage, History | Fixture event table and graph/table; real TokenBadge | Live telemetry, time-series polling, HISTORY rewind/fork actions |
| Preview, Config, GitHub | HTML preview map, resizable pane, provider controls | Live preview proxy/iframe, full Config panel and account/MCP settings, GitHub PR/issues |
| Settings, dialogs, menus, help, notifications | Separate family/category/search picker, font/brightness/frost controls, native dialogs, menu and tooltip | Full production SettingsPanel, account login, trust dialogs, global Recall/Cookbook/manual surfaces |
| Cluster parent/member grid, mailbox, board, plan, activity, reviews | Not exercised | Entire cluster-specific UI and all peer operations |
| Genesis, artifact explorer, terminal pop-out, media studios | Artifact bodies and selectable terminal output only | Creation wizard, standalone explorer, real xterm/PTY, image/audio/video editors |

Navigation is illustrative: the fixture workflows intentionally share transcript
content for comparison; they are not reconstructed production workflows. Task
checkboxes and review operations are local simulations. The preview map borrows
the atlas's fine rectangular framing, numbered groups, colored relationships
and inspection affordances; it does not claim to be Arco's production map.

## Isolation

`client/phosphor-demo.html` loads `src/phosphor-demo/main.ts` instead of
`src/main.tsx`. Before any production component/store imports, it supplies fresh
in-memory localStorage/sessionStorage, a fixture-only fetch implementation and
a WebSocket constructor that rejects workflow/PTY connections. Only the
synthetic file-content reader returns data; other operations fail closed with a
fixture error. Vite's already-created HMR socket is independent.

The separate Vite config has **no server proxy** and rejects `/api`, `/ws`,
terminal and production entry requests. Its CSP restricts connections to the
preview origin/HMR. The browser harness asserts zero API/control-plane requests.
Production store methods for saving theme/settings are never called. The real
store is used only behind the memory boundary for native component rendering
and local approval/question resolution. No fake workflow is registered server-side.

Existing same-origin cached crisp-text/font overrides, if present, are read
before isolation, never written back. This port has a separate browser origin
from the production service, so its saved display preferences are not readable
here; the preview exposes corresponding controls explicitly.

## Theme integration and compatibility

Current production flow remains unchanged:

1. `bootstrapCachedTheme()` applies cached theme, fonts, frost, opacity,
   brightness and crisp text before the normal React mount.
2. `appStore.setSettings` reconciles the server settings and updates caches.
   `setThemeId`, font/frost/brightness setters apply optimistically and persist
   through `/api/settings`; rejected writes restore authoritative settings.
3. `provider-auto` is a preserved sentinel. The active provider determines its
   effective palette through `resolveProviderTheme`; it is not a new palette ID.
4. `applyTheme` applies tokens, optional font pack, theme density and animation
   flags; handles background images and frosted surface alpha; and emits
   `archon:theme-changed`. `applyCrispText` is an independent root attribute.
5. Shared `VALID_THEME_IDS` validates persistent selections server-side.

**Classic:** imports all 43 existing registry entries unchanged. Original IDs,
names, fonts, CSS treatments, background images and lazy shader presets remain
available. The fixture shell is new, so this is not a pixel-identical screenshot
of the production App. Theme-native density is retained in Classic; the demo's
compact/comfortable spacing adjustment applies only in Phosphor. Existing rough
border renderers on production-specific panels are not exercised by this shell.

**Phosphor:** 68 palette variants share one typography/density/effects contract.
IDs are `phosphor:arco:<original-id>`, including `phosphor:arco:everforest`
and `phosphor:arco:red-planet`; neither collides with Classic. These IDs are
intentionally absent from both production registries. There is no migration.

The preview clears all previous theme token keys before applying another family,
including reference-only aliases. Family/palette changes do not key/remount the
transcript, change its arrays, or reconstruct the diff viewer. Font changes can
reflow content as expected. Crisp text disables all Phosphor glyph emission,
including the wordmark; Classic retains its existing wordmark exception.

## Palette adapter and provenance

The local `arco-palette.ts` is a catalog/resolver snapshot from
the upstream reference palette module, identical apart from renamed identifiers, inspected at checkout revision
`d52d43042e954586035ef259c3d5a3e3ebf9c5ea` on 2026-09-07. It carries the complete
68-entry catalog, eight categories and version 1 resolver. No runtime sibling
checkout dependency exists. The test pins its SHA-256:

`286fa0ebce77c7b60c94205e90c8ed11067b7f3f1480f8e2b77a787ab7f50ed2`

`paletteAdapter.ts` constructs Arco manifests from the resolver:

| Reference resolved roles | Arco roles |
| --- | --- |
| bg-primary / secondary / tertiary / input | color-bg / bg-panel / bg-elevated / bg-input + sunken/base compatibility aliases |
| text-primary / text-muted | color-fg / color-fg-muted + secondary/text-primary compatibility aliases |
| accent / accent-glow | accent-primary / primary-glow; primary alpha ramp generated from the resolved accent |
| blue / blue-bg | accent-secondary family and its generated alpha ramp; links/syntax functions remain blue |
| red / orange / green | danger+error / warning / success |
| border-primary / control-border | border-hairline / border-bright |
| emission / cold / glass / RGB roles | namespaced `--arco-*` ambient, glass and raster colors |
| purple / green / orange / blue / muted / red | syntax keywords / strings / literals / functions / comments / deletion |
| chart-1…12 / on-accent | graph colors / selection and filled-control foreground |

The imported resolver retains hue while lifting foregrounds to at least 4.5:1
against its four defined surfaces; essential controls use 3:1. Tests check every
palette's foreground roles and complete Arco token coverage. Rendered effects,
operator brightness changes and arbitrary production surfaces require separate
review; passing token tests is not an accessibility certification.

JetBrains Mono 400/700/800 files are copied locally with their OFL license. They
use a demo-specific font-family name so Classic font selection is unaffected.
To refresh the snapshot, deliberately replace it with the complete new catalog,
record the revision/hash, and review count/category/resolver changes in the
completeness test. Do not duplicate individual theme definitions.

## CRT implementation and cost

Read/visually inspected the running synthetic overview and Help atlas.
Primary implementation references:

- `docs/ui.md`, `public/css/crt.css`, `public/js/crt.js`, `src/ui/palette.ts`.
- `public/css/architecture.css`, `public/js/architecture-renderer.js`, and the
  isolated `scripts/preview-ui.ts` fixture approach.
- Secondary lineage: Unfinished Works presentation layers, OdyTTY presentation
  controls/theme structure, Kill-9 postprocessing. Kill-9 bloom is not imported.

The five-part reference glyph-emission stack remains available at 100% softness:
2px core, 7px/54% halo, 20px/24% outer emission, and ±0.7px restrained chromatic
separation. The revised 50% default uses a 1px core, 3.5px/27% halo,
10px/12% outer halo and ±0.35px chromatic offset. Each foreground element
resolves its own emission. Code, diffs and
terminal output deliberately have no text blur. CSS owns the stationary 3px
raster, translucent surfaces and glass. Vignette edge attenuation is lighter
than the reference's because Arco places operational terminal output at the bottom.
No text or controls are painted to canvas; no full-content bloom/filter is used.

The ambient fragment is adapted from the reference's single-pass float/dithered tube
field. All time-driven scan, band and hum terms are removed. Only a restrained
pointer charge can animate; it decays to a static image and stops scheduling
frames entirely. DPR is capped at 1.5 and the buffer's largest edge at 900px.
There is no traveling line, periodic highlight, flicker or pulsing in Phosphor.

Why a dedicated renderer: the existing Three.js implementation loads a ~566 KB
minified lazy chunk containing all Classic shaders and creates a glyph atlas,
scene, geometry and material cache. A single ambient triangle needs none of
that preset machinery. The dedicated renderer preserves the reference's field and
keeps its lifecycle independent of transcript updates. Classic still uses the
existing lazy renderer. Conditional mounts prevent simultaneous renderers.

`Ambient.tsx` owns/deletes its shaders, program and buffer, cancels timers/rAF,
removes all listeners, releases its context on unmount, and rebuilds after
context restoration. Hidden pages, reduced motion and coarse/small screens stop
canvas activity. CSS remains under reduced motion, loss or unavailable WebGL.
Effects-off unmounts decoration and disables text glow. Stats are inspectable
as `window.archonPhosphorStats` without per-frame React state updates.

## Verification and rollout boundary

The four catalog/contract tests and client TypeScript/isolated Vite build pass.
The browser harness covers the six requested palette samples (`arco-crt`,
`default`, `everforest`, `amber`, `phosphor`, `red-planet`), five Classic samples,
selection/draft/history-scroll/diff/split preservation, native approval/question
controls, streaming/queue, search, modal Escape/focus, tooltip focus, responsive
1024/768/390 layouts, 200% CSS zoom with a fully bounded dialog, effects/crisp/
reduced-motion states, context loss/restoration and unavailable WebGL. The
visibility listener is tested with a controlled hidden state because headless
Chromium keeps background pages visible. Screenshots and machine-readable
results are in `/tmp/archon-phosphor-review/`.

Performance measurements use headless Chromium/SwiftShader at 1536×1080, with a
900×633 ambient buffer. Measurements report browser task time and JS draw-submit
time, **not GPU elapsed time, compositor cost or workstation watts**. Idle and
streamed-token-only sampling produce zero ambient draws; pointer sampling is
bounded below 30fps. See `results.json` for the latest measured values. The real
Markdown/virtualized transcript still has its own streaming CPU cost. Workbench
controls and catalog are isolated from that store subscription.

Observed two-second samples on this machine: idle 0 draws / 0.28ms browser task
time; streaming without pointer activity 0 draws / 477ms task time; pointer
activity 46 draws / 209ms task time (~23fps); effects off 0 draws / 0.56ms task
time. Across the run, 237 ambient submissions used 3.6ms total JS submit time
(0.10ms maximum). These include headless software-rendering conditions and are
short measurements, not an hours-long or hardware power result.

The isolated build warns about its ~1.57 MB uncompressed main demo chunk:
reusing native ChatMessage also brings the file viewer/editor dependencies.
Three.js stays in its own lazy Classic chunk. This preview has not been tuned
for initial-load bundle size or validated on Firefox/Wayland/NVIDIA, Safari,
screen readers, true browser-chrome zoom, or a physical long-running monitor.
No whole-site or all-palette rendered accessibility claim is made.

Before rollout: operator visual acceptance; extend fixtures to omitted screen
families; audit hardcoded/legacy token aliases and overlay accessibility; measure
the workstation GPU/compositor over a long session; integrate family/palette
preferences and cache startup together; update client registry and server/shared
validation in the same change; prove legacy preferences remain unchanged. None
of those production integrations or migrations is part of this isolated demo.

Reversal: stop the separate Vite process, remove the added preview files and the
two client package scripts/ignore entry. There are no saved preferences or
workflow records to revert. The pre-existing untracked `ready-agent` is untouched.

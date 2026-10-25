# Arco Phosphor, isolated design preview

The Phosphor theme family is integrated in Arco. This page documents a separate
visual-preview entry built with synthetic data and local operation adapters. It
does not replace the normal app entry, change production layout, or persist
preview selections across reloads. Shared palette, adapter, emission, and
renderer modules live in `client/src/themes/phosphor/`.

Run the preview with `npm run dev:phosphor-demo -w client` and open
`http://localhost:5178/phosphor-demo.html`. Its build output uses an ignored
directory separate from the production client bundle.

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

- Starts in **Arco Phosphor -> Arco CRT**, compact, effects on. Compare
  **Arco Classic** using the same transcript, viewport and panel state.
- **GLOW SOFTNESS** defaults to 50% after review of the softer-looking transcript.
  It tightens the luminous core and reduces halo/chromatic spread without changing
  foreground ink, fonts or layout. 100% retains the original reference emission
  stack; 0 removes text glow only. Crisp text/effects-off override and disable
  the slider without forgetting its value. Reduced motion retains the setting.
- **FONTS / BRIGHTNESS** opens the display settings, including all existing font
  packs, separate text brightness (−30...+80) and background brightness (−30...+30).
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
   `arco:theme-changed`. `applyCrispText` is an independent root attribute.
5. Shared `VALID_THEME_IDS` validates persistent selections server-side.

**Classic:** imports all 43 existing registry entries unchanged. Original IDs,
names, fonts, CSS treatments, background images and lazy shader presets remain
available. The fixture shell is new, so this does not reproduce the production app layout. Theme-native density is retained in Classic; the demo's
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

The local `arco-palette.ts` file carries the complete catalog, category labels,
and resolver data used by the preview. There is no runtime dependency on another
checkout. Palette completeness and token coverage are checked by the theme tests.

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
| chart-1...12 / on-accent | graph colors / selection and filled-control foreground |

The imported resolver retains hue while lifting foregrounds to at least 4.5:1
against its four defined surfaces; essential controls use 3:1. Tests check every
palette's foreground roles and complete Arco token coverage. Rendered effects,
brightness changes and other production surfaces require separate review;
passing token tests is not an accessibility certification.

JetBrains Mono 400/700/800 files are copied locally with their OFL license. They
use a demo-specific font-family name so Classic font selection is unaffected.
To refresh the snapshot, deliberately replace it with the complete new catalog,
record the revision/hash, and review count/category/resolver changes in the
completeness test. Do not duplicate individual theme definitions.

## Implementation map

The preview and production theme share palette, adapter, and emission modules.
`client/src/themes/phosphor/Ambient.tsx` owns the isolated shader, WebGL program,
buffer, animation frame, and event listeners. It releases them on unmount and
rebuilds after WebGL context restoration. Hidden pages, reduced motion, and small
screens stop ambient rendering. The Phosphor backdrop is separate from the lazy
Classic shader renderer.

Text remains DOM content, not canvas pixels. Crisp-text and effects-off controls
remove Phosphor glyph emission. Preview preferences remain separate from saved
production theme preferences. See [`CLIENT.md`](CLIENT.md) for the production
theme integration and controls.

## Verification and limits

`npm run test:phosphor` checks the palette catalog, resolver, token coverage, and
settings behavior. `npm run build:phosphor-demo -w client` builds the isolated
entry. `scripts/smoke/phosphor-demo-browser.py` exercises palette selection,
fonts, brightness, effects, reduced motion, layout changes, context restoration,
and unavailable WebGL against synthetic data. The preview harness intercepts
API and WebSocket requests; it does not connect to providers or persist workflows.

The demo is not the complete production workbench. It does not exercise live
provider connections, cluster operations, filesystem access, or every app
screen. Automated theme tests do not certify accessibility, physical display
quality, long-session performance, or every browser/GPU combination. Production
theme changes require the normal client build and review.

The demo uses synthetic data and separate preview assets. Removing its dedicated
Vite entry, preview modules, package scripts, and ignored output directory does
not require a data migration.

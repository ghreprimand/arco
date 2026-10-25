# Vendored: Odysseus image editor

This directory is a **vendored copy** of the layer-based raster editor from the
MIT-licensed **Odysseus** project, ported into Arco for Workbench Expansion
**§H2 (Layer-based raster editor)**. It is third-party code — **not** an Arco
refactor target (the `size:check` gate excludes `vendor/` accordingly).

The upstream MIT notice is retained verbatim in `./LICENSE`
(Copyright (c) 2025 Odysseus Contributors).

## Upstream source

- Entry: `<odysseus>/static/js/galleryEditor.js`
- Modules: `<odysseus>/static/js/editor/*.js` + subdirs `editor/build/`,
  `editor/filters/`, `editor/fx/`, `editor/tools/`
- CSS: `<odysseus>/static/style.css` (the `.ge-*` / `.gallery-*` rules)

The editor is native ES6 modules (import/export, no bundler). Vite bundles them
from source via the wrapper's dynamic `import()`.

## What was EXCLUDED — H3 deferred (local image AI)

H3 (local AI image ops: background-remove / smart-select / inpaint) is
**deferred** (operator decision, 2026-05-31 — no local image AI in Arco for
now). The 5 AI modules are therefore **not vendored**:

```
editor/ai-inpaint.js
editor/ai-rembg.js
editor/ai-models.js
editor/ai-tool-runner.js
editor/ai-tools-misc.js
```

`editor/wire-inpaint-controls.js` is a **core mask-UI** module (feather/strength
previews, mask vis/invert/clear, paint-erase toggle) — it is **kept**. Only the
five `ai-*.js` files are AI.

## Patch log (galleryEditor.js + wire-import.js)

Every Arco change is tagged with an `ARCO VENDOR PATCH (H2)` comment in-tree
so it's greppable. To re-enable H3, restore the originals listed below.

### 1. Stubbed ai-* imports

`galleryEditor.js` statically imported the 5 ai-* modules at the top (originally
~lines 87 and 98–101). Since those files aren't vendored, the imports are
replaced by local no-op stubs whose return shapes match what `_buildEditor()`
destructures:

```js
const createApplyImageTool = () => ({});                                  // was ./editor/ai-tool-runner.js
const wireAIModelSelectors = () => {};                                    // was ./editor/ai-models.js
const wireInpaintButtons = () => {};                                      // was ./editor/ai-inpaint.js
const wireAIToolsMisc = () => ({ addEmptyLayer: () => {} });              // was ./editor/ai-tools-misc.js
const wireRembgAndSharpen = () => ({ buildSelectionHintMask: () => null }); // was ./editor/ai-rembg.js
```

The wiring **call sites** (`createApplyImageTool` ~L254, `wireAIModelSelectors`
~L2708, `wireInpaintButtons` ~L2804, `wireRembgAndSharpen` ~L2825,
`wireAIToolsMisc` ~L2847) are left intact — the stubs make them harmless no-ops.

**Graceful-degradation note (Wand "Bg Remove"):** `wire-selection-controls.js`
(`#ge-wand-rembg` handler) calls `buildSelectionHintMask()` and early-returns
with a toast if it yields a falsy value. The `wireRembgAndSharpen` stub returns
`buildSelectionHintMask: () => null`, so that handler hits its `if (!hint)
return` guard **before** ever calling `applyImageTool` — no crash, no fetch.

### 2. Neutralized non-existent backend calls

These endpoints don't exist in Arco (they'd 404). Each fetch site is guarded
by an early `return;` (with the original body preserved below the guard) so
nothing throws or spams the console. Saving is owned by the React wrapper.

| Endpoint | Site (function) | Neutralization |
|---|---|---|
| `/api/editor-drafts` (PUT/POST/GET/DELETE) | `_persistDraft`, `_loadDraftById`, `_findDraftForImage`, `_clearDraftServer` | early `return;` — auto-draft persistence is inert |
| `/api/gallery/{id}/replace` | `#ge-save` click handler | routed to the inert `exportToGallery()` |
| `/api/gallery/upload` | `exportToGallery()` | early `return;` + toast pointing at the toolbar Save |
| `/api/cookbook/packages` | `_checkRembgInstalled()` | early `return;` — hides the rembg run row |
| `/api/gallery/library` | `wire-import.js` `#ge-import-gallery` handler | early `return;` + toast (use Import/File) |

### 3. Local shim modules

The upstream entry + a couple of `editor/*` modules import top-level Odysseus
app modules that pull in the whole windowing tree (theme / tileManager /
modalSnap / storage). Rather than vendor that unrelated tree, this directory
provides small self-contained shims for the tiny surface actually used:

- `ui.js` — `showToast`, `showError`, `styledConfirm` (Arco-themed toasts;
  styledConfirm falls back to native `confirm`).
- `modalManager.js` — `register` / `unregister` / `minimize` / `restore`
  (no-op-ish; the detachable History / FX popups simply don't dock).
- `storage.js` — localStorage JSON helper (only `dragSort.js` touches it, and
  only when a `storageKey` option is passed, which the editor never does).

`spinner.js`, `colorPicker.js`, `dragSort.js` were **self-contained upstream**
and are vendored as-is (dragSort's `./storage.js` import resolves to the shim).

### 4. CSS (`editor.css`)

Brace-aware extraction of every `style.css` rule whose selector references a
`.ge-*` / `.gallery-*` / `#gallery-editor*` / `#ge-*` token (`@media`/`@supports`
blocks filtered to their matching inner rules; ge-named `@keyframes` kept). A
header re-points the Odysseus tokens (`--bg --fg --panel --border --red --accent
--fg-muted` + a few semantic ones) at Arco's CSS vars (`--color-bg`,
`--color-fg`, `--color-accent-primary`, `--color-border-bright`, …), scoped to
`#gallery-editor-container`, so the editor inherits the active Arco theme.
A few grouped selectors carry an unrelated sibling and some
`#gallery-editor-drafts-*` rules style the now-inert draft UI — harmless dead CSS.

## Ported upstream fixes (2026-09-01)

Selective correctness sync from upstream `d8a2059` and the batch around it,
identified by the Odysseus delta audit (2026-08-30). **Only manual-editor bug
fixes were taken.** The rest of the upstream delta since vendoring — SAM / text
selection, inpainting, local-model routing, the AI command box — is H3 material
and stays excluded (see §"What was EXCLUDED").

If you re-vendor from upstream later, these are already upstream; nothing here
needs re-applying.

### `editor/wire-merge-buttons.js` — merge/flatten lost adjustments

Taken whole from upstream (self-contained; imports only `./state.js`).

The vendored copy baked `layer.canvas` directly, so **Merge Down / Merge All /
Flatten Copy silently discarded a layer's non-destructive adjustments** and left
the baked layer carrying stale opacity, offset and adjustment-cache state — the
next composite would then apply the already-baked opacity a second time.

Upstream routes each layer through the adjustment pipeline first, composites
onto a canvas sized to the DOCUMENT (not to either layer), then resets
`opacity` / `visible` / offset / `adjLayers` / `_adjFinal*` / `_adjCache*` on the
survivor.

This required threading a new `renderLayer` dep through two Arco call sites,
both already present in this copy as `_renderLayerWithAdjLayers`:

- `galleryEditor.js` → `wireMergeButtons({ …, renderLayer })`
- `galleryEditor.js` → `createLayerPanelRenderer({ …, renderLayer })`, which
  `editor/layer-panel.js` destructures and forwards to
  `mergeLayerDownAtIndex(i, renderLayer)`

`renderLayer` is optional in the primitive and a throwing implementation falls
back to the raw canvas, so a missed call site degrades rather than breaking.

### `editor/snap.js` — defensive guards

Tolerates a missing/invalid `layer`, `ctx`, `zoom`, `canvasW/H`, and a
non-array `otherLayers` instead of throwing mid-drag.

### `editor/wire-topbar.js` — Save menu scoping

Scopes the Save menu lookup to `#gallery-editor-container` (Arco's own mount
id) instead of a bare document-wide `getElementById`, removes stale
body-portaled `#ge-save-menu` copies left by a previous editor open, and fixes
the click-away test to use `saveBtn.contains(e.target)` so clicking the button's
inner icon no longer closes the menu it just opened.

### Tests

`npm run test:editor-merge -w client` — `mergeLayers.test.js` pins the merge
behaviour (adjusted source used, opacity honoured, offsets normalized to
document coordinates, caches cleared, bottom-layer guard, throwing-renderLayer
fallback). 6 of its 8 cases fail against the pre-port implementation, so it is a
real regression test rather than a restatement of current behaviour.

There is no jsdom / node-canvas in this repo and adding both to test third-party
code was judged disproportionate; the defect was a call-shape bug (which source
is drawn, at what opacity and offset), so the test drives a recording canvas
stub instead of comparing pixels.

## How to revive H3 (later)

1. Re-vendor the 5 `editor/ai-*.js` files from upstream.
2. Replace the `const … = () => …;` stubs (patch §1) with the real
   `import … from './editor/ai-*.js'` lines.
3. Stand up the AI backend the editor expects: `/api/image/remove-bg` (and
   whatever the inpaint/upscale flows POST to) under Arco's guarded routes,
   coordinating 5090 VRAM per the H3 plan + Part G.
4. Un-neutralize only the calls that H3 actually needs (the gallery/draft
   neutralizations in §2 stay — those are not AI and have no Arco backend).

## Integrity smoke

`npm run smoke:image-editor-vendor` asserts the above invariants without a
browser (no ai-* files, no live ai-* import, LICENSE + VENDOR.md present, no live
fetch to a non-existent backend, exportPNG/openEditor/closeEditor still exported).

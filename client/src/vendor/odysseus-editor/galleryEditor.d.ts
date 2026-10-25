// Ambient types for the vendored (plain-JS) Odysseus editor entry point.
//
// The vendored tree is untyped ES modules (allowJs is off in this repo's
// tsconfig, so tsc never compiles the .js). TS pairs this declaration file with
// the sibling `galleryEditor.js` by basename, giving the React wrapper
// (ImageEditor.tsx) typed access to the exports it dynamically imports. Only the
// surface the wrapper actually uses is declared; the editor exposes more
// internally. See VENDOR.md.

/**
 * Open the editor, loading `imageUrl` as the first (base) layer. Requires a
 * `<div id="gallery-editor-container">` to already exist in the DOM — it logs an
 * error and returns if absent.
 */
export function openEditor(
  imageUrl?: string,
  imageId?: string,
  presetSize?: unknown,
  displayName?: string,
  draftId?: string,
): void;

/** Tear down the editor and free its canvases/listeners. */
export function closeEditor(): void;

/** Whether the editor is currently mounted/open. */
export function isEditorOpen(): boolean;

/** Flatten all layers and return a `data:image/png;base64,…` data URL. */
export function exportPNG(): string;

/** Trigger a browser download of the flattened PNG. */
export function downloadPNG(): void;

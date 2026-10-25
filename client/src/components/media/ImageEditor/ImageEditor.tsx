import { useEffect, useRef, useState, useCallback } from 'react';
import '../../../vendor/odysseus-editor/editor.css';

// WORKBENCH_EXPANSION §H2 (part 2) — React wrapper that mounts the vendored
// Odysseus raster editor (client/src/vendor/odysseus-editor/) inside Arco's
// media modal and bridges its LOAD + SAVE to Arco's guarded endpoints.
//
// HONEST SCOPE (ALPHA — read before extending):
//   - The editor itself is vendored plain-JS (galleryEditor.js + editor/*). It
//     owns a `<div id="gallery-editor-container">` we render here; on mount we
//     dynamically import() the entry and call openEditor(src,…) which loads the
//     image as the base layer. On unmount we closeEditor().
//   - The 5 ai-*.js modules are NOT vendored (H3 deferred). Their wiring is
//     stubbed in the vendored galleryEditor.js — Bg Remove / Inpaint / AI tools
//     degrade to no-ops. See vendor/odysseus-editor/VENDOR.md.
//   - SAVE goes ONLY through POST /api/image/write (the guarded part-1 endpoint):
//     exportPNG() → dataURL → write. The editor's own gallery/draft save paths
//     are neutralized in the vendored copy.
//   - Boot race: openEditor errors if #gallery-editor-container is absent, so we
//     call it from a useEffect that runs AFTER the div is in the DOM.

// The shape of the part-1 write endpoint's response (mirrors ImageWriteResult).
type WriteResult =
  | { ok: true; relPath: string; bytes: number }
  | { ok: false; code: string; error: string };

interface VendoredEditor {
  openEditor: (imageUrl?: string, imageId?: string, presetSize?: unknown, displayName?: string, draftId?: string) => void;
  closeEditor: () => void;
  isEditorOpen: () => boolean;
  exportPNG: () => string;
  downloadPNG: () => void;
}

interface Props {
  // The image source to load as the base layer (on-disk dataUrl or object URL).
  src: string;
  // The on-disk filename (display + default Save target). null for imported.
  filename?: string | null;
  // The on-disk cwd-relative path (contextual open) — the default Save target.
  // null for imported/Save-As (the operator is prompted for a new name).
  diskPath?: string | null;
  // cwd + workflowId for the guarded write. Without it, Save can't resolve a
  // confined target and is disabled with a note.
  fileContext?: { cwd: string; workflowId: string };
  // Reveal a freshly-written file (cwd-relative path) in the Files panel.
  onRevealInFiles?: (relPath: string) => void;
}

export function ImageEditor({ src, filename, diskPath, fileContext, onRevealInFiles }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<VendoredEditor | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Mount the vendored editor once the container div is in the DOM. The dynamic
  // import keeps the ~3.8k-line editor + its CSS out of the main bundle until an
  // operator actually opens it.
  useEffect(() => {
    let disposed = false;
    setBooting(true);
    setBootError(null);
    import('../../../vendor/odysseus-editor/galleryEditor.js')
      .then((mod) => {
        if (disposed) return;
        const ed = mod as unknown as VendoredEditor;
        editorRef.current = ed;
        // The container must already exist (rendered below). openEditor loads
        // `src` as the base layer; imageId stays undefined so the editor's own
        // gallery-save branch never engages (Arco's Save is our button).
        //
        // The vendored editor SWALLOWS its own build/init failures — it logs via
        // console.error and returns instead of throwing — so a failed build
        // would otherwise leave a blank pane with no bootError. Capture its
        // console.error across the call so we can surface the real reason, and
        // (as a backstop) detect an empty container after the synchronous build.
        const captured: string[] = [];
        const origErr = console.error;
        console.error = (...args: unknown[]) => { captured.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')); origErr(...args); };
        let threw = false;
        try {
          ed.openEditor(src, undefined, undefined, filename ?? 'image');
        } catch (e) {
          threw = true;
          setBootError(e instanceof Error ? e.message : String(e));
        } finally {
          console.error = origErr;
        }
        setBooting(false);
        // Verify the build actually rendered. _buildEditor is synchronous, so a
        // tick later the container should hold the editor DOM; an empty
        // container or a not-open editor means the build silently failed.
        setTimeout(() => {
          if (disposed || threw) return;
          const childCount = containerRef.current?.childElementCount ?? 0;
          let open = false;
          try { open = ed.isEditorOpen(); } catch { open = false; }
          // The editor swallows _buildEditor throws (console.error + return), so
          // a captured build/open error is the real reason EVEN IF some partial
          // DOM was appended first — surface it regardless of child count.
          const buildErr = captured.find((c) => /openEditor|_buildEditor|is not a function|undefined|cannot read/i.test(c));
          if (buildErr) { setBootError(buildErr); return; }
          if (childCount === 0 || !open) {
            setBootError(captured[0]
              ?? 'editor mounted but produced no content (no error thrown). Likely a CSS-layout or build issue — check the console for "[openEditor]" / "ge-" logs.');
          }
        }, 60);
      })
      .catch((e) => {
        if (disposed) return;
        setBootError(e instanceof Error ? e.message : String(e));
        setBooting(false);
      });
    return () => {
      disposed = true;
      try { editorRef.current?.closeEditor(); } catch { /* best-effort teardown */ }
      editorRef.current = null;
    };
    // src/filename are captured at open; re-opening on prop change isn't needed
    // for the modal's lifecycle (a new file remounts the component).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // POST a dataURL to the guarded write endpoint. Returns the parsed result.
  const postWrite = useCallback(
    async (path: string, dataUrl: string, overwrite: boolean): Promise<WriteResult> => {
      const resp = await fetch('/api/image/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: fileContext?.cwd,
          workflowId: fileContext?.workflowId,
          path,
          dataUrl,
          overwrite,
        }),
      });
      return (await resp.json()) as WriteResult;
    },
    [fileContext?.cwd, fileContext?.workflowId],
  );

  const handleSave = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    if (!fileContext) {
      setSaveMsg({ kind: 'err', text: 'No workflow context (cwd) — open from FILES to save into your project.' });
      return;
    }
    let dataUrl: string;
    try {
      dataUrl = ed.exportPNG();
    } catch (e) {
      setSaveMsg({ kind: 'err', text: `Could not encode image: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }

    // Pick the target path. A contextual open (diskPath) defaults to the
    // original — but the endpoint refuses to clobber unless overwrite:true, so
    // we try overwrite:false first and confirm on 'exists'. An imported / no
    // disk path asks for a new filename (a plain prompt is fine for alpha).
    let path = diskPath ?? '';
    if (!path) {
      const suggested = (filename || 'edited.png').replace(/\.(jpe?g|webp|gif|bmp|tiff?)$/i, '.png');
      const entered = window.prompt('Save as (path relative to the workflow cwd):', suggested);
      if (entered == null || !entered.trim()) return;
      path = entered.trim();
    }

    setSaving(true);
    setSaveMsg(null);
    try {
      let res = await postWrite(path, dataUrl, false);
      if (!res.ok && res.code === 'exists') {
        const confirmed = window.confirm(`"${path}" already exists. Overwrite it?`);
        if (!confirmed) { setSaving(false); return; }
        res = await postWrite(path, dataUrl, true);
      }
      if (res.ok) {
        setSaveMsg({ kind: 'ok', text: `Saved ${res.relPath} (${(res.bytes / 1024).toFixed(0)} KB)` });
        onRevealInFiles?.(res.relPath);
      } else {
        setSaveMsg({ kind: 'err', text: `Save failed (${res.code}): ${res.error}` });
      }
    } catch (e) {
      setSaveMsg({ kind: 'err', text: `Save failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSaving(false);
    }
  }, [diskPath, filename, fileContext, postWrite, onRevealInFiles]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Save bar — Arco's guarded Save (the vendored editor's own gallery/
          draft saves are neutralized). */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: '12px', padding: '6px 12px',
          borderBottom: '1px solid var(--color-border-hairline)', flexShrink: 0,
        }}
      >
        <button
          data-help="media.save"
          onClick={handleSave}
          disabled={saving || booting || !!bootError}
          className="display-font"
          style={{
            background: 'transparent', border: '1px solid var(--color-accent-primary)',
            borderRadius: '3px', color: 'var(--color-accent-primary)', cursor: saving ? 'wait' : 'pointer',
            fontSize: '11px', letterSpacing: '1px', padding: '4px 14px', opacity: saving || booting ? 0.6 : 1,
          }}
        >
          {saving ? 'SAVING…' : 'SAVE'}
        </button>
        {saveMsg && (
          <span
            style={{
              fontSize: '11px', fontFamily: 'var(--font-body)',
              color: saveMsg.kind === 'ok' ? 'var(--color-accent-primary)' : 'var(--color-danger)',
            }}
          >
            {saveMsg.text}
          </span>
        )}
        {!fileContext && !saveMsg && (
          <span style={{ fontSize: '11px', color: 'var(--color-warning)', fontFamily: 'var(--font-body)' }}>
            Open from FILES to save into your project.
          </span>
        )}
      </div>

      {/* The vendored editor mounts into this container. It MUST exist before
          openEditor runs — it does, because this render precedes the mount
          useEffect. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        <div id="gallery-editor-container" ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
        {bootError && (
          <div
            style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '24px', textAlign: 'center', color: 'var(--color-danger)', fontSize: '12px',
            }}
          >
            Image editor failed to load: {bootError}
          </div>
        )}
      </div>
    </div>
  );
}

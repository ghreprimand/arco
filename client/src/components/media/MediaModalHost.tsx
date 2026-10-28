import { layoutPoint } from '../../utils/pointer';
import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ModalHelpButton } from '../help/ModalHelpButton';
import { AudioEditor, AudioOpsPanel } from './AudioEditor';
import { VideoEditor, VideoOpsPanel } from './VideoEditor';
import { ImageEditor } from './ImageEditor';
import { classifyMediaExt, type MediaMode } from './launchers';

// WORKBENCH_EXPANSION §H1 — Media studio modal host. The shared shell for the
// later editors (H2 image / H5 audio / H7 video — none of which exist yet).
// Routes a media file → the right mode by the launcher's classification, OR
// opens empty with an Import affordance.
//
// HONEST SCOPE (read before extending):
//   - Image mode is FULLY functional: an enhanced viewer (zoom/pan/fit/1:1 +
//     dimensions). On-disk images load via the SAME guarded fetch FileViewerModal
//     uses (/api/file-content → { type:'image', dataUrl }); imported images use a
//     browser object URL. EXIF is intentionally omitted — deriving it needs an npm
//     dep, deferred to a later H phase (see the inline note in the image panel).
//   - Audio mode (H5/H6): IMPORTED audio renders the AudioEditor (waveform +
//     transport + region select) off a browser object URL. ON-DISK audio
//     (contextual open) now renders too — its src points at the guarded
//     GET /api/media/raw serve route (path-confined, Range-able) that shipped
//     with H6. FFmpeg ops (clip/convert/normalize/…) are available ONLY for
//     on-disk audio — ffmpeg can't read a browser object URL, so an IMPORTED
//     file disables the ops with an inline note (open it from Files to run them).
//   - Video mode (H7): IMPORTED video renders the VideoEditor (preview + scrub +
//     in/out markers) off a browser object URL. ON-DISK video (contextual open)
//     now streams from the SAME guarded GET /api/media/raw route audio uses
//     (path-confined, Range-able for seeking). FFmpeg ops (vclip / vconvert /
//     extract-audio) are available ONLY for on-disk video — same reason as audio
//     (ffmpeg can't read a browser object URL), so an IMPORTED file disables the
//     ops with an inline note.
//   - Layers/brush (H2) are still out of scope here.

type ImagePayload =
  | { type: 'image'; dataUrl: string }
  | { type: 'error'; error: string }
  | { type: 'unsupported'; detail: string };

interface Props {
  initialPath?: string;
  initialMode?: MediaMode;
  // §H4 — open image mode directly in the raster editor (Open-in-editor on a
  // generated-image artifact), skipping the manual EDIT toggle.
  initialEditing?: boolean;
  onClose: () => void;
  // Supplied by App when a workflow is active — lets the on-disk image fetch
  // recover via the artifacts-dir fallback exactly like FileViewerModal does,
  // and lets H6 audio ops POST against a confined cwd.
  fileContext?: { cwd: string; workflowId: string };
  // Reveal a freshly-written op output (cwd-relative path) in the Files panel.
  onRevealInFiles?: (relPath: string) => void;
}

export function MediaModalHost({ initialPath, initialMode = 'image', initialEditing = false, onClose, fileContext, onRevealInFiles }: Props) {
  // Mode is operator-switchable in-modal (the header IMAGE/AUDIO/VIDEO toggle),
  // seeded from how the studio was opened. Previously this was a fixed `const`
  // from initialMode, which stranded anyone who opened via the header MEDIA
  // button (always image) in an image-only modal with no way to reach the
  // audio/video editors that already exist.
  const [mode, setMode] = useState<MediaMode>(initialMode);
  // The on-disk file currently in scope. Seeded from a contextual open; CLEARED
  // on a manual mode switch so flipping image→audio on a PNG lands on the clean
  // Import affordance rather than trying to stream a PNG through the audio path.
  const [activePath, setActivePath] = useState<string | null>(initialPath ?? null);
  const filename = activePath ? activePath.split('/').pop() || activePath : null;

  // Imported (browser File API) source — an object URL we own and must revoke.
  const [importedUrl, setImportedUrl] = useState<string | null>(null);
  const [importedName, setImportedName] = useState<string | null>(null);
  const importedUrlRef = useRef<string | null>(null);
  // N2 — the imported File itself. ffmpeg ops on an imported source stage these
  // bytes to Arco scratch (postMediaOp), so the ops panels need the raw File,
  // not just the playback object URL.
  const [importedFile, setImportedFile] = useState<File | null>(null);

  // The source we were on BEFORE clicking an op output to load it — so loading a
  // result (e.g. a spectrogram → image mode) is non-destructive: a ← BACK button
  // restores the prior file. Single-level (the common audio→spectrogram→back).
  const [prevSource, setPrevSource] = useState<{ mode: MediaMode; activePath: string | null; importedFile: File | null } | null>(null);

  // On-disk image payload (image mode only; fetched like FileViewerModal).
  const [imagePayload, setImagePayload] = useState<ImagePayload | null>(null);

  // H2 part 2 — when true, the image mode renders the vendored Odysseus raster
  // editor instead of the zoom/pan viewer. Toggled by the header EDIT button.
  // §H4 — `initialEditing` seeds it true for Open-in-editor (image mode only).
  const [editing, setEditing] = useState(initialEditing && initialMode === 'image');

  // Audio region in/out (seconds) — lifted from AudioEditor via its callback so
  // H6's clip op can read the operator's selection without re-deriving it.
  const audioRegionRef = useRef<{ start: number; end: number } | null>(null);
  // Same for the H7 video editor's in/out markers (vclip / extract-audio read it).
  const videoRegionRef = useRef<{ start: number; end: number } | null>(null);

  // Enhanced-viewer transform state (image mode).
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const dragState = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Revoke any object URL on unmount (no leaks).
  useEffect(() => () => {
    if (importedUrlRef.current) URL.revokeObjectURL(importedUrlRef.current);
  }, []);

  // Fetch the on-disk image (image mode + a path + nothing imported yet) the
  // same way FileViewerModal does. Audio/video on-disk is NOT fetched — that
  // needs the H5/H7 streaming route; we show the Import affordance instead.
  useEffect(() => {
    // Relative cwd paths load via /api/file-content (the FileViewerModal path,
    // with the artifacts-dir fallback). An ABSOLUTE path (e.g. an op output in
    // scratch / a chosen dir) is served by the fence-aware raw route instead —
    // see imageServeUrl below — so skip the fetch for it.
    if (mode !== 'image' || !activePath || importedUrl || activePath.startsWith('/')) { return; }
    let cancelled = false;
    const params = new URLSearchParams({ path: activePath });
    if (fileContext) {
      params.set('cwd', fileContext.cwd);
      params.set('workflowId', fileContext.workflowId);
    }
    fetch(`/api/file-content?${params.toString()}`)
      .then((r) => r.json() as Promise<{ type: string; dataUrl?: string; error?: string }>)
      .then((p) => {
        if (cancelled) return;
        if (p.type === 'image' && p.dataUrl) setImagePayload({ type: 'image', dataUrl: p.dataUrl });
        else if (p.type === 'error') setImagePayload({ type: 'error', error: p.error || 'load failed' });
        else setImagePayload({ type: 'unsupported', detail: `server returned "${p.type}" (too large / not an image)` });
      })
      .catch((e) => { if (!cancelled) setImagePayload({ type: 'error', error: String(e) }); });
    return () => { cancelled = true; };
  }, [mode, activePath, importedUrl, fileContext?.cwd, fileContext?.workflowId]);

  // Import a picked/dropped file → object URL, replacing any prior one.
  const importFile = useCallback((file: File) => {
    if (importedUrlRef.current) URL.revokeObjectURL(importedUrlRef.current);
    const url = URL.createObjectURL(file);
    importedUrlRef.current = url;
    setImportedUrl(url);
    setImportedName(file.name);
    setImportedFile(file);
    // Reset viewer transform for the freshly-loaded image.
    setZoom(1); setPan({ x: 0, y: 0 }); setDims(null);
    setImagePayload(null);
    // Drop back to the viewer so the editor remounts cleanly on the new source.
    setEditing(false);
  }, []);

  // Drop the current source: revoke any imported object URL, clear the on-disk
  // path + image payload, close the editor, and reset the viewer transform +
  // region selections. Leaves the MODE intact, so the same-mode Import affordance
  // comes back — this is the UNLOAD action (and the shared reset switchMode uses).
  const clearSource = useCallback(() => {
    if (importedUrlRef.current) { URL.revokeObjectURL(importedUrlRef.current); importedUrlRef.current = null; }
    setImportedUrl(null);
    setImportedName(null);
    setImportedFile(null);
    setImagePayload(null);
    setActivePath(null);
    setEditing(false);
    setZoom(1); setPan({ x: 0, y: 0 }); setDims(null);
    audioRegionRef.current = null;
    videoRegionRef.current = null;
    setPrevSource(null);
  }, []);

  // Operator switch between image/audio/video. Resets all transient per-source
  // state (via clearSource) so the target mode opens on a clean Import affordance
  // — the originally-opened file rarely makes sense in a different mode.
  const switchMode = useCallback((next: MediaMode) => {
    if (next === mode) return;
    clearSource();
    setMode(next);
  }, [mode, clearSource]);

  // Load a server-side output file (an op result) back in as the new source.
  // Classifies by extension → switches mode if needed, drops any imported blob,
  // and points activePath at the ABSOLUTE output (served via the fence-aware
  // /api/media/raw route, which handles scratch / unconfined paths). This is what
  // makes the "✓ output" line clickable.
  const loadOutputPath = useCallback((absPath: string) => {
    if (!absPath) return;
    const next = classifyMediaExt(absPath) ?? mode;
    // Snapshot the current source so ← BACK can restore it (an imported source
    // keeps its File; the object URL is recreated on restore).
    setPrevSource({ mode, activePath, importedFile });
    if (importedUrlRef.current) { URL.revokeObjectURL(importedUrlRef.current); importedUrlRef.current = null; }
    setImportedUrl(null);
    setImportedName(null);
    setImportedFile(null);
    setImagePayload(null);
    setEditing(false);
    setZoom(1); setPan({ x: 0, y: 0 }); setDims(null);
    audioRegionRef.current = null;
    videoRegionRef.current = null;
    setMode(next);
    setActivePath(absPath);
  }, [mode, activePath, importedFile]);

  // Restore the pre-load source (← BACK). For an imported source the File is
  // re-imported (a fresh object URL); for an on-disk source the path is rebound.
  const goBack = useCallback(() => {
    if (!prevSource) return;
    const prev = prevSource;
    setPrevSource(null);
    setImagePayload(null);
    setEditing(false);
    setZoom(1); setPan({ x: 0, y: 0 }); setDims(null);
    setMode(prev.mode);
    if (prev.importedFile) {
      setActivePath(null);
      importFile(prev.importedFile); // recreates the object URL
    } else {
      if (importedUrlRef.current) { URL.revokeObjectURL(importedUrlRef.current); importedUrlRef.current = null; }
      setImportedUrl(null);
      setImportedName(null);
      setImportedFile(null);
      setActivePath(prev.activePath);
    }
  }, [prevSource, importFile]);

  // Something is loaded (imported blob OR an on-disk path) ⇒ offer UNLOAD.
  const hasSource = !!importedUrl || !!activePath;

  // Build a fence-aware /api/media/raw URL for an on-disk source. A RELATIVE path
  // needs a cwd to resolve against (so it requires fileContext); an ABSOLUTE path
  // (e.g. a loaded op output in scratch / a chosen dir) doesn't — the raw route
  // gates it (cwd | scratch | unconfined) with cwd optional.
  const serveUrl = (path: string | null): string | null => {
    if (!path) return null;
    if (!fileContext && !path.startsWith('/')) return null; // relative needs a cwd
    const p = new URLSearchParams({ path });
    if (fileContext) { p.set('cwd', fileContext.cwd); p.set('workflowId', fileContext.workflowId); }
    return `/api/media/raw?${p.toString()}`;
  };

  // The active image source: imported object URL wins; an ABSOLUTE on-disk path
  // streams via the raw route; otherwise the file-content dataUrl (relative open).
  const imageServeUrl = mode === 'image' && !importedUrl && activePath?.startsWith('/') ? serveUrl(activePath) : null;
  const imageSrc = mode === 'image'
    ? (importedUrl ?? imageServeUrl ?? (imagePayload?.type === 'image' ? imagePayload.dataUrl : null))
    : null;

  // The active AUDIO source. Imported object URL wins; otherwise an on-disk file
  // streams through the guarded Range-able serve route (H6) so the waveform +
  // playback + seeking work without faking anything.
  const audioServeUrl = mode === 'audio' && !importedUrl ? serveUrl(activePath) : null;
  const audioSrc = mode === 'audio' ? (importedUrl ?? audioServeUrl) : null;

  // The active VIDEO source — same shape as audio (H7). Imported object URL wins;
  // otherwise an on-disk file streams through the guarded Range-able serve route
  // so <video> can seek without faking anything.
  const videoServeUrl = mode === 'video' && !importedUrl ? serveUrl(activePath) : null;
  const videoSrc = mode === 'video' ? (importedUrl ?? videoServeUrl) : null;

  const acceptForMode = mode === 'image'
    ? 'image/*'
    : mode === 'audio' ? 'audio/*' : 'video/*';

  // Whether the empty/Import affordance should front-and-centre. Image with a
  // resolved src or pending on-disk fetch is "loaded"; audio/video on-disk has
  // no playback path yet so we always offer Import there.
  const hasImage = mode === 'image' && (imageSrc != null || imagePayload?.type === 'image');
  const hasAudio = mode === 'audio' && audioSrc != null;
  const hasVideo = mode === 'video' && videoSrc != null;
  const hasMedia = mode === 'image' ? hasImage : mode === 'audio' ? hasAudio : hasVideo;
  // Both on-disk audio (H6) AND on-disk video (H7) now stream via the serve
  // route. The "import to play" note only fires when there's neither a serve URL
  // nor an import — i.e. a contextual open with no fileContext (no cwd to confine
  // the path against), which is rare.
  const onDiskMediaUnsupported =
    (mode === 'audio' || mode === 'video') && !!activePath && !importedUrl && !fileContext;

  // ── viewer controls (image) ──
  const fit = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const oneToOne = () => {
    // 1:1 = device pixel mapping. naturalWidth vs rendered width gives the
    // scale that makes them equal; we approximate against the viewport.
    if (!dims || !viewportRef.current) { setZoom(1); setPan({ x: 0, y: 0 }); return; }
    const vw = viewportRef.current.clientWidth;
    // The fit image is constrained to maxWidth:100%; 1:1 means show at natural
    // px. Scale factor from fit → natural is naturalWidth / displayedWidth, and
    // displayedWidth ≈ min(vw, naturalWidth). So zoom = naturalWidth/displayed.
    const displayed = Math.min(vw, dims.w);
    setZoom(displayed > 0 ? dims.w / displayed : 1);
    setPan({ x: 0, y: 0 });
  };
  const zoomBy = (factor: number) => setZoom((z) => Math.min(8, Math.max(0.1, z * factor)));

  const onWheel = (e: React.WheelEvent) => {
    if (mode !== 'image' || !hasImage) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  };
  const onMouseDown = (e: React.MouseEvent) => {
    if (mode !== 'image' || !hasImage) return;
    const point = layoutPoint(e);
    dragState.current = { startX: point.x, startY: point.y, baseX: pan.x, baseY: pan.y };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragState.current) return;
    const point = layoutPoint(e);
    setPan({
      x: dragState.current.baseX + (point.x - dragState.current.startX),
      y: dragState.current.baseY + (point.y - dragState.current.startY),
    });
  };
  const endDrag = () => { dragState.current = null; };

  // Drag-drop import.
  const [dragOver, setDragOver] = useState(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) importFile(file);
  };

  const body = typeof document !== 'undefined' ? document.body : null;
  if (!body) return null;

  const displayName = importedName ?? filename ?? `${mode} studio`;
  const modeLabel = mode.toUpperCase();

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9400, padding: '36px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glow-border"
        style={{
          width: '100%', maxWidth: '1100px', maxHeight: '100%',
          // The viewer sizes to its content (the <img> gives the body intrinsic
          // height). The EDITOR's body is `flex: 1` with NO intrinsic height, so
          // without a definite modal height it collapses to zero and only the
          // SAVE bar shows (the vendored editor's `.gallery-editor { height:100% }`
          // resolves against a 0-height parent). Fill the available height while
          // editing so the flex:1 editor area — and the canvas inside it — has
          // real height to occupy.
          height: editing ? '100%' : undefined,
          background: 'var(--color-bg)', border: '1px solid var(--color-border-bright)',
          borderRadius: '6px', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', overflow: 'hidden' }}>
            {/* Mode switcher — the indicator IS the control. Flips the studio
                between image / audio / video in place; the underlying editors +
                FFmpeg ops already exist for all three. */}
            <div data-help="media.mode" role="group" aria-label="Media mode" style={{ display: 'flex', border: '1px solid var(--color-accent-secondary)', borderRadius: '2px', overflow: 'hidden', flexShrink: 0 }}>
              {(['image', 'audio', 'video'] as MediaMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => switchMode(m)}
                  className="display-font"
                  title={`${m} studio`}
                  aria-pressed={mode === m}
                  style={{
                    background: mode === m ? 'var(--color-accent-secondary)' : 'transparent',
                    color: mode === m ? 'var(--color-bg)' : 'var(--color-accent-secondary)',
                    border: 'none', cursor: 'pointer', fontSize: '10px', letterSpacing: '1.5px',
                    padding: '3px 9px',
                  }}
                >
                  {m.toUpperCase()}
                </button>
              ))}
            </div>
            <span className="display-font glow-text-cyan" style={{ fontSize: '12px', letterSpacing: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displayName}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '6px', flexShrink: 0, alignItems: 'center' }}>
            {mode === 'image' && hasImage && !editing && (
              <>
                <button data-help="media.zoom-out" onClick={() => zoomBy(1 / 1.2)} className="display-font" title="Zoom out" style={ctrlBtn}>−</button>
                <span className="display-font" style={{ fontSize: '10px', color: 'var(--color-fg-muted)', minWidth: '38px', textAlign: 'center', letterSpacing: '0.5px' }}>{Math.round(zoom * 100)}%</span>
                <button data-help="media.zoom-in" onClick={() => zoomBy(1.2)} className="display-font" title="Zoom in" style={ctrlBtn}>+</button>
                <button data-help="media.fit" onClick={fit} className="display-font" title="Fit to window" style={ctrlBtn}>FIT</button>
                <button data-help="media.one-to-one" onClick={oneToOne} className="display-font" title="Actual pixels (1:1)" style={ctrlBtn}>1:1</button>
              </>
            )}
            {/* EDIT toggles the zoom/pan viewer ↔ the vendored Odysseus raster
                editor (layers / brush / crop / filters / Save). Image mode only,
                once an image source is loaded. */}
            {mode === 'image' && hasImage && (
              <button
                data-help="media.edit"
                onClick={() => setEditing((e) => !e)}
                className="display-font"
                title={editing ? 'Back to viewer' : 'Edit image'}
                style={{ ...ctrlBtn, color: editing ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)', borderColor: editing ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)' }}
              >
                {editing ? 'VIEW' : 'EDIT'}
              </button>
            )}
            {/* BACK — restore the source we were on before clicking an op output
                to load it (non-destructive result preview). */}
            {prevSource && (
              <button data-help="media.back" onClick={goBack} className="display-font" title="Back to the previous file" style={{ ...ctrlBtn, color: 'var(--color-accent-primary)', borderColor: 'var(--color-accent-primary)' }}>← BACK</button>
            )}
            {/* UNLOAD — drop the current file back to the Import affordance
                without leaving the modal or switching mode. */}
            {hasSource && (
              <button data-help="media.unload" onClick={clearSource} className="display-font" title="Unload the current file (back to import)" style={ctrlBtn}>UNLOAD</button>
            )}
            <ModalHelpButton section="media-studio" title="Media Studio" />
            <button onClick={onClose} className="display-font" title="Close" style={{ ...ctrlBtn, width: '26px', height: '26px', fontSize: '14px' }}>×</button>
          </div>
        </div>

        {/* Dimensions readout (image, loaded) — hidden while editing (the
            editor shows its own canvas-size badge). */}
        {mode === 'image' && dims && hasImage && !editing && (
          <div data-help="media.dimensions" className="display-font" style={{ padding: '4px 16px', fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)', borderBottom: '1px solid var(--color-border-hairline)', flexShrink: 0 }}>
            {dims.w} × {dims.h} px
            {/* EXIF intentionally omitted in H1 — needs an npm dep; deferred. */}
            <span style={{ marginLeft: '10px', opacity: 0.6 }}>· EXIF metadata: coming with the image editor</span>
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* IMAGE — raster editor (H2). Mounts the vendored Odysseus editor
              with the current image source; Save writes through the guarded
              /api/image/write endpoint. Replaces the viewer while editing. */}
          {mode === 'image' && hasImage && imageSrc && editing && (
            <ImageEditor
              src={imageSrc}
              filename={filename}
              // A contextual on-disk open carries activePath; an imported image
              // has none (object URL) → Save prompts for a new name.
              diskPath={importedUrl ? null : (activePath ?? null)}
              fileContext={fileContext}
              onRevealInFiles={onRevealInFiles}
            />
          )}

          {/* IMAGE — enhanced viewer */}
          {mode === 'image' && hasImage && imageSrc && !editing && (
            <div
              ref={viewportRef}
              data-help="media.viewport"
              onWheel={onWheel}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={endDrag}
              onMouseLeave={endDrag}
              style={{
                flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--color-bg-sunken)',
                cursor: dragState.current ? 'grabbing' : 'grab',
              }}
            >
              <img
                src={imageSrc}
                alt={displayName}
                draggable={false}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  setDims({ w: img.naturalWidth, h: img.naturalHeight });
                }}
                style={{
                  maxWidth: '100%', maxHeight: '100%',
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: 'center center',
                  userSelect: 'none',
                }}
              />
            </div>
          )}

          {/* IMAGE — on-disk fetch error / unsupported */}
          {mode === 'image' && !hasImage && imagePayload && imagePayload.type !== 'image' && (
            <div style={noteBox}>
              {imagePayload.type === 'error' ? `Could not load image: ${imagePayload.error}` : imagePayload.detail}
            </div>
          )}

          {/* AUDIO — waveform editor (H5) for imported OR on-disk files, plus the
              H6 FFmpeg ops. Imported audio plays off the object URL but has no
              server path, so its ops are disabled; on-disk audio streams from the
              guarded /api/media/raw route and its ops run server-side. */}
          {mode === 'audio' && audioSrc && (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
              <AudioEditor
                src={audioSrc}
                filename={displayName}
                // Hold the selection for H6's clip op; cheap ref, no re-render.
                onRegionChange={(start, end) => { audioRegionRef.current = { start, end }; }}
              />
              <div style={{ padding: '0 16px 16px' }}>
                <AudioOpsPanel
                  // On-disk path for a workflow file; for an imported file we pass
                  // the File instead (postMediaOp stages it to scratch).
                  diskPath={importedUrl ? null : (activePath ?? null)}
                  importedFile={importedUrl ? importedFile : null}
                  fileContext={fileContext}
                  getRegion={() => audioRegionRef.current}
                  onReveal={onRevealInFiles}
                  onLoadOutput={loadOutputPath}
                />
              </div>
            </div>
          )}
          {/* VIDEO — preview/scrub/markers (H7) for imported OR on-disk files,
              plus the FFmpeg ops. Imported video plays off the object URL but has
              no server path, so its ops are disabled; on-disk video streams from
              the guarded /api/media/raw route and its ops run server-side. */}
          {mode === 'video' && videoSrc && (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
              <VideoEditor
                src={videoSrc}
                filename={displayName}
                onRegionChange={(start, end) => { videoRegionRef.current = { start, end }; }}
              />
              <div style={{ padding: '0 16px 16px' }}>
                <VideoOpsPanel
                  diskPath={importedUrl ? null : (activePath ?? null)}
                  importedFile={importedUrl ? importedFile : null}
                  fileContext={fileContext}
                  getRegion={() => videoRegionRef.current}
                  onReveal={onRevealInFiles}
                  onLoadOutput={loadOutputPath}
                />
              </div>
            </div>
          )}

          {/* EMPTY / IMPORT affordance — shown until a source loads. For
              on-disk audio/video it carries the honest "import to play now" note. */}
          {!hasMedia && (
            <div
              data-help="media.import"
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              style={{
                flex: 1, minHeight: 0, margin: '16px',
                border: `2px dashed ${dragOver ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
                borderRadius: '6px', display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: '14px',
                background: dragOver ? 'var(--color-accent-primary-a06)' : 'transparent',
                padding: '32px', textAlign: 'center',
              }}
            >
              <div className="display-font" style={{ fontSize: '12px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}>
                DROP A {modeLabel} FILE OR
              </div>
              <label className="display-font" style={{ ...ctrlBtn, padding: '8px 16px', cursor: 'pointer', fontSize: '11px', letterSpacing: '1px' }}>
                IMPORT…
                <input
                  type="file"
                  accept={acceptForMode}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); }}
                  style={{ display: 'none' }}
                />
              </label>
              {onDiskMediaUnsupported && (
                <div style={{ fontSize: '11px', color: 'var(--color-warning)', fontFamily: 'var(--font-body)', maxWidth: '460px', lineHeight: 1.5 }}>
                  {/* Both on-disk audio (H6) AND video (H7) now stream via the
                      /api/media/raw route. This note only remains for a
                      contextual open with no fileContext (no cwd to confine the
                      path against), which is rare. */}
                  This {mode} file can’t stream without a workflow context (cwd). Import it above to work with it now.
                  {filename && <div style={{ marginTop: '6px', opacity: 0.7, fontFamily: 'var(--font-code)' }}>{filename}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    body,
  );
}

const ctrlBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary-dim)',
  cursor: 'pointer',
  fontSize: '11px',
  letterSpacing: '1px',
  padding: '3px 8px',
};

const noteBox: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '32px',
  color: 'var(--color-danger)',
  fontSize: '12px',
  fontStyle: 'italic',
  textAlign: 'center',
};

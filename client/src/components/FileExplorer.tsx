import { layoutPoint } from '../utils/pointer';
import { useEffect, useState, useCallback } from 'react';
import { FileViewerModal } from './FileViewerModal';
import { useTerminalStore } from '../stores/terminalStore';
import { classifyMediaExt, openMediaFile, type MediaMode } from './media/launchers';

interface Entry {
  name: string;
  path: string;
  isDirectory: boolean;
}

// Phase 4 Lite: FileExplorer now embeds in the right-pane Files tab in
// addition to the legacy full-screen overlay. `onClose` is optional — when
// absent the × close button is hidden (tab-embedded mode has no close
// target; operators switch tabs instead).
interface Props {
  cwd: string;
  onClose?: () => void;
  // A6 — when supplied, opened files get the Edit/Lock toggle (writes resolve
  // against this wfid's cwd, path-escape guarded server-side).
  workflowId?: string;
  // ARCHIVE (docs/CLIENT.md) - reveal + select a file when the
  // operator clicks an ARTIFACTS/RECENTS entry. Best-effort: expands every
  // ancestor dir between cwd and the file, then selects it (opens the viewer).
  // Opt-in; the workspace FILES panel never passes it, so its behavior is
  // unchanged. `revealNonce` forces a re-reveal even when the same path is
  // clicked twice.
  revealPath?: string;
  revealNonce?: number;
}

export function FileExplorer({ cwd, onClose, workflowId, revealPath, revealNonce }: Props) {
  const [tree, setTree] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([cwd]));
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  // §H1 — right-click menu for media files (Open in Image/Audio/Video editor).
  // A simple absolutely-positioned menu (no menu primitive exists in the
  // codebase; the directory context menu fires its action directly). Closed on
  // any outside click / Escape / scroll.
  const [mediaMenu, setMediaMenu] = useState<{ x: number; y: number; path: string; mode: MediaMode } | null>(null);

  const loadDir = useCallback(async (path: string) => {
    setLoading((s) => new Set(s).add(path));
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
      const data = await res.json() as { files: Entry[] };
      setTree((t) => ({ ...t, [path]: data.files }));
    } finally {
      setLoading((s) => {
        const next = new Set(s);
        next.delete(path);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    if (!tree[cwd]) loadDir(cwd);
    // tree/loadDir intentionally omitted: tree updating after a fetch must
    // not re-trigger the same fetch, and loadDir is stable. The cwd-only
    // dep is the actual reason to re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  // ARCHIVE reveal — expand every ancestor dir between cwd and revealPath, then
  // select the file (opens the viewer). Fetches each level directly rather than
  // leaning on loadDir's async state timing. `.arco` and other dotdirs are
  // filtered server-side, so artifacts under them aren't revealable — callers
  // only pass paths that live in the visible tree (real project files).
  useEffect(() => {
    if (!revealPath) return;
    const root = cwd.replace(/\/$/, '');
    if (revealPath !== root && !revealPath.startsWith(root + '/')) return;
    let cancelled = false;
    (async () => {
      const rel = revealPath.slice(root.length + 1);
      const segs = rel.split('/').filter(Boolean);
      // Ancestor dirs: root, root/a, root/a/b … (exclude the file itself).
      const dirs: string[] = [root];
      let acc = root;
      for (let i = 0; i < segs.length - 1; i++) { acc = `${acc}/${segs[i]}`; dirs.push(acc); }
      for (const dir of dirs) {
        if (cancelled) return;
        if (!tree[dir]) {
          try {
            const res = await fetch(`/api/files?path=${encodeURIComponent(dir)}`);
            const data = await res.json() as { files: Entry[] };
            if (cancelled) return;
            setTree((t) => ({ ...t, [dir]: data.files }));
          } catch { /* best-effort reveal */ }
        }
        setExpanded((s) => new Set(s).add(dir));
      }
      if (!cancelled) setSelected(revealPath);
    })();
    return () => { cancelled = true; };
    // Re-run when the target changes OR the operator re-clicks the same entry
    // (revealNonce). tree intentionally omitted — we read it opportunistically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealPath, revealNonce, cwd]);

  const toggle = (entry: Entry) => {
    if (!entry.isDirectory) {
      setSelected(entry.path);
      return;
    }
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
        if (!tree[entry.path]) loadDir(entry.path);
      }
      return next;
    });
  };

  const refresh = () => {
    setTree({});
    loadDir(cwd);
  };

  // WORKBENCH_EXPANSION §K1 — Files-tab "open terminal here". Both the header
  // icon (root cwd) and the directory right-click route through here. No-op
  // when this explorer isn't bound to a workflow (a terminal needs a wfid).
  const openTerminalWindow = useTerminalStore((s) => s.openTerminal);
  const openTerminalAt = useCallback((dir?: string) => {
    if (!workflowId) return;
    openTerminalWindow({ workflowId, ...(dir ? { cwd: dir } : {}) });
  }, [workflowId, openTerminalWindow]);

  // Open the media context menu at the cursor for a media-classified file.
  const openMediaMenu = useCallback((e: React.MouseEvent, path: string) => {
    const mode = classifyMediaExt(path);
    if (!mode) return; // non-media files keep the default (no) context menu
    e.preventDefault();
    setMediaMenu({ ...layoutPoint(e), path, mode });
  }, []);

  // Close the media menu on any outside interaction.
  useEffect(() => {
    if (!mediaMenu) return;
    const close = () => setMediaMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMediaMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [mediaMenu]);

  const rootName = cwd.split('/').filter(Boolean).pop() || cwd;

  return (
    <>
      <aside
        style={{
          width: '280px',
          flexShrink: 0,
          // flex:1 + minHeight:0 makes the aside fill its height-bounded
          // flex-column parent (RightPanel/ClusterRightPanel tab body) so the
          // scroll body below can actually scroll. Without it the aside grew
          // to content height and the file list overflowed past the panel.
          flex: 1,
          minHeight: 0,
          borderLeft: '1px solid var(--color-border-hairline)',
          background: 'var(--color-bg-panel)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative',
          zIndex: 5,
        }}
      >
        <div
          style={{
            padding: '10px 12px',
            borderBottom: '1px solid var(--color-border-hairline)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            flexShrink: 0,
          }}
        >
          <div style={{ overflow: 'hidden' }}>
            <div
              className="display-font"
              style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary)' }}
            >
              FILES
            </div>
            <div
              style={{
                fontSize: '10px',
                color: 'var(--color-fg-muted)',
                marginTop: '2px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={cwd}
            >
              {rootName}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
            {workflowId && (
              <button
                onClick={() => openTerminalAt()}
                data-help="files.open-terminal"
                className="display-font"
                title="Open a terminal in this folder"
                style={iconBtnStyle}
              >
                &gt;_
              </button>
            )}
            <button
              onClick={refresh}
              data-help="files.refresh"
              className="display-font"
              title="Refresh"
              style={iconBtnStyle}
            >
              ↻
            </button>
            {onClose && (
              <button
                onClick={onClose}
                className="display-font"
                title="Close"
                style={iconBtnStyle}
              >
                ×
              </button>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
          {renderEntries(tree[cwd], 0, {
            tree,
            expanded,
            loading,
            toggle,
            onOpenTerminal: workflowId ? openTerminalAt : undefined,
            onMediaContext: openMediaMenu,
          })}
        </div>
      </aside>

      {selected && (
        <FileViewerModal
          path={selected}
          onClose={() => setSelected(null)}
          editContext={{ cwd, ...(workflowId ? { workflowId } : {}) }}
        />
      )}

      {mediaMenu && (
        <div
          data-help="files.media-context"
          // Stop propagation so clicking an item doesn't trip the outside-click
          // close before the action runs.
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: mediaMenu.y,
            left: mediaMenu.x,
            zIndex: 9600,
            background: 'var(--color-bg-panel)',
            border: '1px solid var(--color-border-bright)',
            borderRadius: '4px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            padding: '4px',
            minWidth: '200px',
          }}
        >
          <button
            onClick={() => { openMediaFile(mediaMenu.path); setMediaMenu(null); }}
            className="display-font"
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              color: 'var(--color-accent-primary-dim)',
              cursor: 'pointer',
              fontSize: '11px',
              letterSpacing: '1px',
              padding: '7px 10px',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent-primary-a06)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
          >
            Open in {mediaMenu.mode === 'image' ? 'Image' : mediaMenu.mode === 'audio' ? 'Audio' : 'Video'} editor
          </button>
        </div>
      )}
    </>
  );
}

interface RenderCtx {
  tree: Record<string, Entry[]>;
  expanded: Set<string>;
  loading: Set<string>;
  toggle: (entry: Entry) => void;
  // WORKBENCH_EXPANSION §K1 — right-click a directory to open a terminal in
  // it. Undefined when the explorer isn't workflow-bound (no cwd to root at).
  onOpenTerminal?: (dir: string) => void;
  // §H1 — right-click a media file to open it in the matching editor. Fires
  // only for media-classified extensions (the handler no-ops otherwise).
  onMediaContext: (e: React.MouseEvent, path: string) => void;
}

function renderEntries(entries: Entry[] | undefined, level: number, ctx: RenderCtx) {
  if (!entries) return null;
  if (entries.length === 0 && level === 0) {
    return (
      <div
        style={{
          padding: '12px',
          fontSize: '11px',
          color: 'var(--color-fg-muted)',
          fontStyle: 'italic',
        }}
      >
        Empty directory
      </div>
    );
  }

  return entries.map((entry) => {
    const isExpanded = ctx.expanded.has(entry.path);
    const isLoading = ctx.loading.has(entry.path);
    return (
      <div key={entry.path}>
        <button
          onClick={() => ctx.toggle(entry)}
          onContextMenu={entry.isDirectory
            ? (ctx.onOpenTerminal
                ? (e) => { e.preventDefault(); ctx.onOpenTerminal!(entry.path); }
                : undefined)
            : (e) => ctx.onMediaContext(e, entry.path)}
          title={entry.isDirectory
            ? (ctx.onOpenTerminal ? 'Right-click: open terminal here' : undefined)
            : (classifyMediaExt(entry.name) ? 'Right-click: open in media editor' : undefined)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            width: '100%',
            padding: `2px 8px 2px ${8 + level * 14}px`,
            background: 'transparent',
            border: 'none',
            color: entry.isDirectory ? 'var(--color-accent-primary-dim)' : 'var(--color-accent-secondary-dim)',
            cursor: 'pointer',
            fontFamily: 'var(--font-body)',
            fontSize: '12px',
            textAlign: 'left',
            lineHeight: '1.5',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent-primary-a06)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
        >
          <span style={{ width: '12px', color: 'var(--color-fg-muted)', fontSize: '10px', textAlign: 'center', flexShrink: 0 }}>
            {entry.isDirectory ? (isLoading ? '…' : isExpanded ? '▼' : '▶') : ''}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {entry.name}{entry.isDirectory ? '/' : ''}
          </span>
        </button>
        {entry.isDirectory && isExpanded && renderEntries(ctx.tree[entry.path], level + 1, ctx)}
      </div>
    );
  });
}

const iconBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary-dim)',
  cursor: 'pointer',
  fontSize: '12px',
  width: '22px',
  height: '22px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
};

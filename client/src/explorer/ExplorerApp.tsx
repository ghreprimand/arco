import { useEffect, useMemo, useState } from 'react';
import { FileExplorer } from '../components/FileExplorer';
import { FileViewerModal } from '../components/FileViewerModal';
import { ArtifactsLens } from './ArtifactsLens';
import { RecentsLens } from './RecentsLens';
import { PlansLens } from './PlansLens';

// ARCHIVE (docs/CLIENT.md) - the standalone chromeless explorer window,
// mounted by main.tsx on `?app=explorer` INSTEAD of the workspace <App/>. It is
// a project-artifact tool, not a generic file browser: the landing lens is a
// home of project cards + recent artifacts across all projects (ARTIFACTS);
// TREE is the "go find something specific" escape hatch. Pure HTTP (no
// workspace WS in v1 — §3): lenses refetch on window focus (poll-on-focus) plus
// a manual refresh.

type LensId = 'artifacts' | 'recents' | 'plans' | 'tree';

interface LensDef { id: LensId; label: string; icon: string; hint: string }

// Order = top-to-bottom in the switcher. ARTIFACTS is the landing home.
const LENSES: LensDef[] = [
  { id: 'artifacts', label: 'ARTIFACTS', icon: '⌸', hint: 'Projects + agent-produced artifacts' },
  { id: 'recents', label: 'RECENTS', icon: '⌁', hint: 'Recently written / changed files' },
  { id: 'plans', label: 'PLANS', icon: '☰', hint: 'Every plan across all projects — review without attaching' },
  { id: 'tree', label: 'TREE', icon: '⊞', hint: 'Browse the filesystem' },
];

// `?app=explorer&lens=plans` (openArchive('plans')) lands on a specific lens.
const INITIAL_LENS: LensId = (() => {
  const want = new URLSearchParams(window.location.search).get('lens');
  return LENSES.some((l) => l.id === want) ? want as LensId : 'artifacts';
})();

export function ExplorerApp() {
  const [lens, setLens] = useState<LensId>(INITIAL_LENS);
  const [root, setRoot] = useState<string | null>(null);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  // Reveal-in-tree (§4.3): switch to TREE with a target path. `.arco`
  // artifacts are hidden, so only real project files (RECENTS) trigger this.
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(null);
  // Poll-on-focus (§5): bump on window focus so the active lens refetches when
  // the operator flips back to the window ("agent said it wrote the doc").
  const [focusTick, setFocusTick] = useState(0);
  // Window-wide zoom — optional reading-comfort control. Defaults to 100% now
  // that the popup inherits correct per-monitor DPI (a fixed default multiplier
  // would re-introduce the "huge on 1200p, tiny on 4K" mismatch). One
  // `document.documentElement.zoom` scales EVERYTHING uniformly, including the
  // reused FileExplorer / FileViewerModal. Persisted; A−/A+ tunes it to taste.
  // Key is v3 so earlier persisted values (1.3, then 1.0) are dropped. Now that
  // the popup renders at correct per-monitor DPI, the element px read a touch
  // large, so the baseline trims the whole window to ~85% (approx the earlier
  // compact size). Range dips below 100% so A− can go smaller still.
  const [zoom, setZoom] = useState<number>(() => {
    try { const v = Number(localStorage.getItem('arco_explorer_zoom3')); return Number.isFinite(v) && v >= 0.6 ? v : 0.85; }
    catch { return 0.85; }
  });
  useEffect(() => {
    (document.documentElement.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(zoom);
    try { localStorage.setItem('arco_explorer_zoom3', String(zoom)); } catch { /* private mode */ }
  }, [zoom]);
  const bumpZoom = (d: number) => setZoom((z) => Math.min(2, Math.max(0.6, Math.round((z + d) * 100) / 100)));

  useEffect(() => {
    let cancelled = false;
    fetch('/api/list-dirs')
      .then((r) => r.json() as Promise<{ parent?: string }>)
      .then((d) => { if (!cancelled) setRoot(d.parent || null); })
      .catch(() => { if (!cancelled) setRoot(null); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { document.title = 'ARCHIVE — Arco'; }, []);

  useEffect(() => {
    const onFocus = () => setFocusTick((t) => t + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const activeLens = useMemo(() => LENSES.find((l) => l.id === lens) ?? LENSES[0], [lens]);

  const revealInTree = (path: string) => {
    setReveal({ path, nonce: Date.now() });
    setLens('tree');
  };

  // Transparent root so the theme's baked-in body background (e.g.
  // arco-default's waves, painted on document.body by applyTheme via
  // bootstrapCachedTheme) shows through — the frosted panels below use the
  // alpha'd --color-bg-panel just like the main workspace. An opaque root here
  // would hide the themed background entirely.
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'transparent', color: 'var(--color-fg)', overflow: 'hidden' }}>
      <style>{`
        .archive-project-card:hover { border-color: var(--color-accent-primary) !important; background: var(--color-accent-primary-a06) !important; }
        .archive-row:hover { background: var(--color-accent-primary-a06); }
      `}</style>

      <header style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 18px', borderBottom: '1px solid var(--color-border-hairline)', background: 'var(--color-bg-panel)', flexShrink: 0 }}>
        <span className="display-font glow-text-bright" style={{ fontSize: '17px', letterSpacing: '3px' }}>⌸ ARCHIVE</span>
        <span style={{ fontSize: '12px', color: 'var(--color-fg-muted)', letterSpacing: '1px' }}>project documents · artifacts · recents · plans · files</span>
        <span style={{ flex: 1 }} />
        {/* Text-size (window zoom) control. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginRight: '4px' }}>
          <button onClick={() => bumpZoom(-0.1)} className="display-font" title="Smaller text" style={zoomBtnStyle}>A−</button>
          <span className="display-font" title="Text size" style={{ fontSize: '11px', color: 'var(--color-fg-muted)', minWidth: '34px', textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <button onClick={() => bumpZoom(0.1)} className="display-font" title="Larger text" style={zoomBtnStyle}>A+</button>
        </div>
        <button
          onClick={() => setFocusTick((t) => t + 1)}
          className="display-font"
          title="Refresh"
          style={{ background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-primary-dim)', cursor: 'pointer', fontSize: '13px', padding: '5px 11px' }}
        >
          ↻ REFRESH
        </button>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <nav style={{ width: '150px', flexShrink: 0, borderRight: '1px solid var(--color-border-hairline)', background: 'var(--color-bg-panel)', display: 'flex', flexDirection: 'column', padding: '10px 7px', gap: '4px' }}>
          {LENSES.map((l) => (
            <button
              key={l.id}
              onClick={() => setLens(l.id)}
              className="display-font"
              title={l.hint}
              style={{
                display: 'flex', alignItems: 'center', gap: '9px', textAlign: 'left',
                padding: '9px 11px', borderRadius: '3px', border: '1px solid transparent',
                background: l.id === lens ? 'var(--color-accent-primary-a10)' : 'transparent',
                color: l.id === lens ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
                cursor: 'pointer', fontSize: '13px', letterSpacing: '1px',
              }}
            >
              <span style={{ width: '15px', textAlign: 'center' }}>{l.icon}</span>
              {l.label}
            </button>
          ))}
        </nav>

        <main style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
          {activeLens.id === 'artifacts' && (
            <ArtifactsLens focusTick={focusTick} onOpen={setViewerPath} onRevealInTree={revealInTree} />
          )}
          {activeLens.id === 'recents' && (
            <RecentsLens focusTick={focusTick} onOpen={setViewerPath} onRevealInTree={revealInTree} />
          )}
          {activeLens.id === 'plans' && <PlansLens focusTick={focusTick} />}
          {activeLens.id === 'tree' && (
            root ? (
              <FileExplorer cwd={root} revealPath={reveal?.path} revealNonce={reveal?.nonce} />
            ) : (
              <EmptyState text="Resolving project root…" />
            )
          )}
        </main>
      </div>

      {/* Shared viewer for the ARTIFACTS/RECENTS lenses. The TREE lens
          (FileExplorer) opens its own modal internally. */}
      {viewerPath && <FileViewerModal path={viewerPath} onClose={() => setViewerPath(null)} />}
    </div>
  );
}

const zoomBtnStyle: React.CSSProperties = {
  background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px',
  color: 'var(--color-accent-primary-dim)', cursor: 'pointer', fontSize: '12px', padding: '4px 8px',
};

export function EmptyState({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-fg-muted)', fontSize: '12px', fontStyle: 'italic', padding: '24px', textAlign: 'center' }}>
      {text}
    </div>
  );
}

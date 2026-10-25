import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';
import './styles/matrix.css';
import './themes/phosphor/phosphor.css';
import './styles/contextual-help.css';
import { bootstrapCachedTheme } from './themes/bootstrap';
import { TerminalPopout } from './components/Terminal/TerminalPopout';
import { ExplorerApp } from './explorer/ExplorerApp';
import { installSessionFetch, startSessionRefresh } from './utils/wsSession';

// Apply cached theme synchronously before React mounts so the first paint
// matches the operator's saved theme. Without this the :root defaults
// (matrix green) render for ~100–500ms while /api/settings fetches. The pop-out
// route (below) inherits this for free — it is same-origin / same-localStorage.
bootstrapCachedTheme();

// WORKBENCH_EXPANSION §K4 — terminal pop-out route. There is NO router in this
// app; main.tsx mounts a single <App/>. The pop-out is a `window.open` to
// `/?popoutTerminal=<sessionId>` and we branch on that query param here, rendering
// a standalone <TerminalPopout/> INSTEAD of the full app. Rationale for the
// query-param-on-root shape (over a `/terminal/<id>` path segment): the root path
// is always served index.html (Vite dev serves `/` directly; the `^/.*` proxy
// bypass returns req.url for any non-preview request → Vite's SPA fallback), so it
// can never collide with the `/terminal` WS upgrade path, `/ws`, or `/api/*`.
// (Arco ships only as a Vite dev server today — the server at :3001 is API/WS
// only and never serves the client HTML — so dev is the only environment, and this
// shape is collision-free there. See docs/TERMINAL.md § Pop-out.) The pop-out boots
// NO app stores and NO `/ws` control plane — it attaches by sessionId over the
// `/terminal` WS alone.
const query = new URLSearchParams(window.location.search);
const popoutSessionId = query.get('popoutTerminal');
// ARCHIVE (docs/ARCHIVE_PLAN.md §3) — the standalone file-explorer window is a
// second `?app=explorer` branch on the same root entry (no router, same shape
// as the terminal pop-out above). Serves index.html in both dev (Vite) and
// prod (ARCO_SERVE_CLIENT SPA fallback), so it's collision-free everywhere.
const explorerApp = query.get('app') === 'explorer';
// These standalone entries don't mount App's renderer gate. Share only the
// Phosphor backdrop; no workflow store, connection or layout wrapper is added.
const StandalonePhosphorBackdrop = lazy(() => import('./themes/phosphor/PhosphorBackdrop'));
const standalonePhosphor = (explorerApp || popoutSessionId) && document.documentElement.dataset.themeFamily === 'phosphor' && document.documentElement.dataset.phosphorEffects !== 'off';

// Operator session cookie (server/src/http/wsAuth.ts) — before any window
// renders, so every surface (main app, terminal pop-out, explorer) has it.
installSessionFetch();
startSessionRefresh();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {standalonePhosphor && <Suspense fallback={null}><StandalonePhosphorBackdrop /></Suspense>}
    {explorerApp ? <ExplorerApp />
      : popoutSessionId ? <TerminalPopout sessionId={popoutSessionId} />
      : <App />}
  </StrictMode>
);

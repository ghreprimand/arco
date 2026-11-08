import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createProxyMiddleware } from 'http-proxy-middleware';

// Ports come from the launcher when present (which probes for free ports
// before invoking npm run dev). Defaults match the historical hardcoded
// values so `npm run dev` from a shell still works.
const CLIENT_PORT = Number(process.env.ARCO_CLIENT_PORT ?? 5173);
const SERVER_PORT = Number(process.env.ARCO_PORT ?? 3001);
const SERVER_TARGET = `http://localhost:${SERVER_PORT}`;

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'arco-ws-proxy',
      configureServer(server) {
        // Create the WS proxy ONCE, at startup. The prior shape created a fresh
        // createProxyMiddleware on EVERY upgrade event and called `.upgrade()`
        // synchronously — each call spins up a new internal http-proxy whose WS
        // setup races the synchronous upgrade, intermittently corrupting the
        // handshake ("Invalid frame header" / "WebSocket is closed before the
        // connection is established"). `/ws` survived because the client's
        // useWebSocket RETRIES, so the flakiness read as harmless reconnect
        // noise; `/terminal` (XtermView, no retry) had no such cover and went
        // permanently dead. A single long-lived instance — the documented
        // http-proxy-middleware v3 pattern — is ready before any upgrade fires
        // and removes the race.
        const wsProxy = createProxyMiddleware({
          target: SERVER_TARGET,
          ws: true,
          changeOrigin: false,
        });
        // Intercept WebSocket upgrades and proxy them to the Arco server.
        // `/ws` = the main seq'd protocol; `/terminal` = the operator-PTY raw
        // stream (XtermView / K4 pop-out) — both must reach the server, else the
        // in-app terminal AND the pop-out are dead in the browser / over a 5173
        // tunnel (the terminal smokes miss this — they hit :3001 direct). Vite's own HMR handler keys off the `vite-hmr`
        // subprotocol, which a bare `new WebSocket('/terminal'|'/ws')` never
        // sends, so claiming these here can't collide with HMR.
        server.httpServer?.on('upgrade', (req, socket, head) => {
          const wsPath = (req.url || '').split('?')[0];
          if (wsPath === '/ws' || wsPath === '/terminal') {
            wsProxy.upgrade!(req, socket, head);
          }
        });
      },
    },
  ],
  server: {
    port: CLIENT_PORT,
    host: true,
    // Launcher already chose a free port; if vite can't bind it, fail
    // loudly rather than silently sliding to the next port (which would
    // diverge from $URL and break the launcher's wait_ready check).
    strictPort: true,
    proxy: {
      '/upload': { target: SERVER_TARGET, changeOrigin: false },
      '/health': { target: SERVER_TARGET, changeOrigin: false },
      '/api': { target: SERVER_TARGET, changeOrigin: false },

    },
  },
});

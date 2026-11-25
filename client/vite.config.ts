import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { readdirSync, readFileSync, statSync } from 'node:fs';

// Ports come from the launcher when present (which probes for free ports
// before invoking npm run dev). Defaults match the historical hardcoded
// values so `npm run dev` from a shell still works.
const CLIENT_PORT = Number(process.env.ARCO_CLIENT_PORT ?? 5173);
const SERVER_PORT = Number(process.env.ARCO_PORT ?? 3001);
const SERVER_TARGET = `http://localhost:${SERVER_PORT}`;

// Writes client/dist/THIRD_PARTY_LICENSES.txt: every npm package that has a
// module in the built client, with its version, declared license and the text
// of its own LICENSE and NOTICE files. Sorted by name, so output is repeatable.
function thirdPartyLicenses() {
  return {
    name: 'arco-third-party-licenses',
    apply: 'build' as const,
    generateBundle(_options: unknown, bundle: Record<string, { type: string; modules?: Record<string, unknown> }>) {
      const roots = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules ?? {})) {
          const clean = id.split('?')[0].replace(/\\/g, '/').replace(/^\0/, '');
          const at = clean.lastIndexOf('/node_modules/');
          if (at < 0) continue;
          const parts = clean.slice(at + '/node_modules/'.length).split('/');
          const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
          roots.add(clean.slice(0, at + '/node_modules/'.length) + name);
        }
      }
      // react-diff-view ships one pre-built file with its own dependencies
      // compiled in, so they never show up as modules of their own.
      for (const root of [...roots]) {
        if (!root.endsWith('/node_modules/react-diff-view')) continue;
        const deps = (JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {};
        for (const dep of Object.keys(deps)) roots.add(`${root.slice(0, -'react-diff-view'.length)}${dep}`);
      }
      const entries = [...roots].map((root) => {
        const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as { name: string; version: string; license?: string; licenses?: Array<{ type: string }> };
        const files = readdirSync(root).filter((f) => /^(licen[sc]e|copying|notice)/i.test(f) && statSync(`${root}/${f}`).isFile()).sort();
        return { name: pkg.name, version: pkg.version, license: pkg.license ?? pkg.licenses?.map((l) => l.type).join(' OR ') ?? 'not declared', files: files.map((f) => ({ f, text: readFileSync(`${root}/${f}`, 'utf8').replace(/\r\n/g, '\n').replace(/<?[\w.+-]+@[\w-]+(?:\.[\w-]+)+>?/g, '<address omitted>').trim() })) };
      }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));
      const seen = new Set<string>();
      const unique = entries.filter((e) => !seen.has(`${e.name}@${e.version}`) && seen.add(`${e.name}@${e.version}`));
      const body = unique.map((e) => [
        '='.repeat(72), `${e.name} ${e.version}`, `License: ${e.license}`, '='.repeat(72), '',
        e.files.length ? e.files.map((x) => `${x.f}\n\n${x.text}`).join('\n\n') : '(this package ships no license file; the license above is the one it declares)', '',
      ].join('\n')).join('\n');
      const head = `Third-party packages bundled into the Arco client (${unique.length}).\nEach entry gives the package's declared license and the text of its own license and notice files.\nAuthor e-mail addresses in those texts are replaced by \"<address omitted>\".\n\n`;
      (this as unknown as { emitFile(f: { type: 'asset'; fileName: string; source: string }): void }).emitFile({ type: 'asset', fileName: 'THIRD_PARTY_LICENSES.txt', source: head + body });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    thirdPartyLicenses(),
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

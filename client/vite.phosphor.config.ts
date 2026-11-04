import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Separate entry and output: no Arco API/WS proxy, no production build writes.
export default defineConfig({
  plugins: [react(), {
    name: 'isolated-phosphor-preview',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/') { res.writeHead(302, { Location: '/phosphor-demo.html' }); res.end(); return; }
        if (/^\/(api(?:\/|\?)|ws(?:\?|$)|terminal(?:\/|\?|$)|src\/main.tsx|index.html)/.test(req.url ?? '')) {
          res.writeHead(403); res.end('Isolated preview: production entry and operations unavailable.'); return;
        }
        res.setHeader('Content-Security-Policy', "connect-src 'self' ws://127.0.0.1:5178 ws://localhost:5178; object-src 'none'; frame-src 'self' about:");
        next();
      });
    },
  }],
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: { outDir: 'dist-phosphor-demo', rollupOptions: { input: 'phosphor-demo.html' } },
});

#!/usr/bin/env node
// `npm start`: run the built server and serve the built client from it on one
// port (default http://localhost:3001). Cross-platform replacement for setting
// ARCO_SERVE_CLIENT=1 and NODE_ENV=production in a shell. Run `npm run build`
// first. Values already set in the environment win.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'server', 'dist', 'index.js');
if (!existsSync(entry) || !existsSync(join(root, 'client', 'dist', 'index.html'))) {
  console.error('Arco is not built yet. Run `npm run build`, then `npm start`.');
  process.exit(1);
}
process.env.ARCO_SERVE_CLIENT ??= '1';
process.env.NODE_ENV ??= 'production';
process.chdir(root);
await import(pathToFileURL(entry).href);

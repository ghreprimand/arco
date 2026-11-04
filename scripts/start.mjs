#!/usr/bin/env node
// `npm start`: run the built server and serve the built client from it on one
// port (default http://localhost:3001). Cross-platform replacement for setting
// ARCO_SERVE_CLIENT=1 and NODE_ENV=production in a shell. Run `npm run build`
// first. Values already set in the environment win.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'server', 'dist', 'index.js');
if (!existsSync(entry) || !existsSync(join(root, 'client', 'dist', 'index.html'))) {
  console.error('Arco is not built yet. Run `npm run build`, then `npm start`.');
  process.exit(1);
}
process.env.ARCO_SERVE_CLIENT ??= '1';
process.env.NODE_ENV ??= 'production';
if (process.env.ARCO_PACKAGED === '1') {
  const home = resolve(process.env.ARCO_HOME?.trim() || join(homedir(), '.arco'));
  process.env.ARCO_HOME = home;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  process.chdir(home);
  const { default: lockfile } = await import('proper-lockfile');
  const { bindArcoPort, isArcoHome, readPortState, writePortState, writeServicePort } = await import('./packaging/ports.mjs');
  let release;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { release = await lockfile.lock(home, { lockfilePath: join(home, '.server.lock') }); break; }
    catch (error) {
      if (error.code !== 'ELOCKED') throw error;
      const state = readPortState(home);
      if (state && await isArcoHome(state.port, home, fetch, process.env.ARCO_HOST)) {
        console.log(`Arco is already running on port ${state.port}.`);
        process.exit(0);
      }
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  if (!release) throw new Error('Another Arco process is starting for this home.');
  const saved = readPortState(home);
  let serviceConfig = {};
  try { serviceConfig = JSON.parse(readFileSync(join(home, 'service', 'config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const preferred = Number(process.env.ARCO_PORT ?? saved?.port ?? serviceConfig.env?.ARCO_PORT ?? '3001');
  const result = await bindArcoPort({ preferred, host: process.env.ARCO_HOST || '127.0.0.1', home });
  if (result.existing) { await release(); console.log(`Arco is already running on port ${result.port}.`); process.exit(0); }
  try {
    const workspacePort = saved?.workspacePort ?? preferred;
    const explicitPort = process.env.ARCO_PACKAGE_SERVICE !== '1' && process.env.ARCO_PORT ? preferred : saved ? saved.explicitPort : (process.env.ARCO_PORT || serviceConfig.env?.ARCO_PORT ? preferred : undefined);
    const state = { version: 1, port: result.port, workspacePort, ...(explicitPort ? { explicitPort } : {}), ...(result.port !== preferred ? { notice: { from: preferred, to: result.port } } : saved?.notice ? { notice: saved.notice } : {}) };
    writePortState(home, state);
    await writeServicePort(home, result.port);
    process.env.ARCO_PORT = String(result.port);
    process.env.ARCO_WORKSPACE_PORT = String(workspacePort);
    if (result.port !== preferred) console.log(`Port ${preferred} was unavailable; Arco is using port ${result.port}.`);
    globalThis.__arcoPreboundServer = result.server;
    globalThis.__arcoTakePortNotice = () => {
      const current = readPortState(home);
      if (!current?.notice) return null;
      const { notice, ...rest } = current;
      writePortState(home, rest);
      return notice;
    };
  } catch (error) { result.server.close(); await release(); throw error; }
} else {
  process.chdir(root);
}
await import(pathToFileURL(entry).href);

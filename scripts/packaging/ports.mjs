import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import lockfile from 'proper-lockfile';

// Only the digest of the canonical home crosses the health endpoint.
export function homeFingerprint(home) {
  let canonical;
  try { canonical = realpathSync.native(home); } catch { canonical = resolve(home); }
  if (process.platform === 'win32') canonical = canonical.replace(/\\/g, '/').toLowerCase();
  return createHash('sha256').update(canonical).digest('hex');
}

export function browserHost(host = '127.0.0.1') {
  if (host === '0.0.0.0' || host === '::') return 'localhost';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export async function isArcoHome(port, home, fetchImpl = fetch, host = '127.0.0.1') {
  try {
    const response = await fetchImpl(`http://${browserHost(host)}:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
    const body = await response.json();
    return response.ok && body.status === 'live' && body.homeFingerprint === homeFingerprint(home);
  } catch { return false; }
}

export function portCandidates(preferred, rangeEnd = 3099) {
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535) throw new Error('Invalid Arco port.');
  const ports = [preferred];
  for (let port = preferred >= 3001 && preferred <= rangeEnd ? preferred + 1 : 3001; port <= rangeEnd; port++) if (port !== preferred) ports.push(port);
  ports.push(0);
  return ports;
}

// Retain the actual listening socket so another process cannot win the port
// between probing and server startup. The caller owns it after this returns.
export async function bindArcoPort({ preferred, host, home, candidates = portCandidates(preferred), probe = isArcoHome }) {
  for (const port of candidates) {
    const server = createServer();
    try {
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, host, () => { server.removeListener('error', rejectListen); resolveListen(); });
      });
      return { server, port: server.address().port, previousPort: preferred };
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
      if (port && await probe(port, home, fetch, host)) return { existing: true, port };
    }
  }
  throw new Error('No available port for Arco.');
}

export function readPortState(home) {
  try {
    const path = join(home, 'port-state.json');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Unsafe port state.');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (state.version !== 1 || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || !Number.isInteger(state.workspacePort) || state.workspacePort < 1 || state.workspacePort > 65535 || (state.explicitPort !== undefined && (!Number.isInteger(state.explicitPort) || state.explicitPort < 1 || state.explicitPort > 65535))) throw new Error('Invalid port state.');
    return state;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function writePortState(home, state) {
  const path = join(home, 'port-state.json');
  // Refuse to replace an unexpected object or a link.
  readPortState(home);
  const staged = join(home, `.port-state-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(staged, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(staged, path);
  } finally { rmSync(staged, { force: true }); }
}

export async function writeServicePort(home, port) {
  const path = join(home, 'service', 'config.json');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsafe service configuration.');
    const parent = realpathSync.native(dirname(path));
    const rel = relative(realpathSync.native(home), parent);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Service configuration escapes the Arco home.');
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const release = await lockfile.lock(path, { retries: { retries: 50, minTimeout: 100, maxTimeout: 100 } });
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (config.version !== 1 || !config.env || config.env.ARCO_HOME !== home || !/^[a-f0-9]{64}$/.test(config.unitHash || '')) throw new Error('Invalid service configuration.');
    config.env.ARCO_PORT = String(port);
    const staged = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(staged, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(staged, path); }
    finally { rmSync(staged, { force: true }); }
  } finally { await release(); }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindArcoPort, browserHost, homeFingerprint, isArcoHome, portCandidates, readPortState, writePortState, writeServicePort } from './ports.mjs';

test('tries a preferred port then remaining range and an ephemeral port', () => {
  assert.deepEqual(portCandidates(3097), [3097, 3098, 3099, 0]);
  assert.deepEqual(portCandidates(4000, 3003), [4000, 3001, 3002, 3003, 0]);
  assert.throws(() => portCandidates(65536), /Invalid/);
  assert.equal(browserHost('::1'), '[::1]');
  assert.equal(browserHost('::'), 'localhost');
});

test('port state preserves the workspace key and rejects malformed state', () => {
  const home = mkdtempSync(join(tmpdir(), 'arco-port-state-'));
  try {
    assert.equal(readPortState(home), null);
    writePortState(home, { version: 1, port: 3012, workspacePort: 3001, notice: { from: 3001, to: 3012 } });
    assert.deepEqual(readPortState(home), { version: 1, port: 3012, workspacePort: 3001, notice: { from: 3001, to: 3012 } });
    writePortState(home, { version: 1, port: 3012, workspacePort: 3001, explicitPort: 3001 });
    assert.equal(readPortState(home).explicitPort, 3001);
    writeFileSync(join(home, 'port-state.json'), '{"version":1,"port":0}');
    assert.throws(() => readPortState(home), /Invalid port state/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('service port update keeps the remaining owned configuration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arco-port-config-'));
  const dir = join(home, 'service'); mkdirSync(dir);
  const path = join(dir, 'config.json');
  try {
    const saved = { version: 1, env: { ARCO_HOME: home, ARCO_PORT: '3001', ARCO_HOST: '127.0.0.1' }, unitHash: 'a'.repeat(64) };
    writeFileSync(path, JSON.stringify(saved));
    await writeServicePort(home, 3012);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { ...saved, env: { ...saved.env, ARCO_PORT: '3012' } });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('holds the selected socket and recognizes only a matching home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arco-ports-'));
  const other = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'live', homeFingerprint: homeFingerprint(home) })); });
  await new Promise((done) => other.listen(0, '127.0.0.1', done));
  const occupied = other.address().port;
  let selected;
  try {
    assert.equal(await isArcoHome(occupied, home), true);
    assert.equal(await isArcoHome(occupied, join(home, 'other')), false);
    assert.deepEqual(await bindArcoPort({ preferred: occupied, host: '127.0.0.1', home }), { existing: true, port: occupied });
    selected = await bindArcoPort({ preferred: occupied, host: '127.0.0.1', home: join(home, 'other'), candidates: [occupied, 0] });
    assert.notEqual(selected.port, occupied);
    assert.equal(selected.server.listening, true);
  } finally {
    if (selected?.server) await new Promise((done) => selected.server.close(done));
    await new Promise((done) => other.close(done));
    rmSync(home, { recursive: true, force: true });
  }
});

test('skips eleven occupied ports and retains the next bound socket', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arco-many-ports-'));
  const holders = [];
  let selected;
  try {
    for (let i = 0; i < 11; i++) {
      const holder = createServer();
      await new Promise((done) => holder.listen(0, '127.0.0.1', done));
      holders.push(holder);
    }
    const ports = holders.map((holder) => holder.address().port);
    selected = await bindArcoPort({ preferred: ports[0], host: '127.0.0.1', home, candidates: [...ports, 0], probe: async () => false });
    assert.ok(!ports.includes(selected.port));
    assert.equal(selected.server.listening, true);
  } finally {
    if (selected?.server) await new Promise((done) => selected.server.close(done));
    await Promise.all(holders.map((holder) => new Promise((done) => holder.close(done))));
    rmSync(home, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { after, test } from 'node:test';
import { promises as fs, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-history-safety-')));
installIsolatedTestHome(root);
process.env.ARCO_RECENT_FILES_LEDGER = join(root, 'recent.jsonl');
after(() => rmSync(root, { recursive: true, force: true }));
const pause = (ms = 80) => new Promise(r => setTimeout(r, ms));

for (const tracked of [false, true]) test(`B197: ${tracked ? 'tracked' : 'untracked'} collision leaves every file unchanged`, async () => {
  const cwd = await fs.mkdtemp(join(root, 'import-'));
  execFileSync('git', ['init', '-q', cwd]);
  const old = ['arc', 'hon'].join(''), source = `${old}-fixture.txt`;
  const files = { [source]: old + ' source', 'arco-fixture.txt': 'accepted destination', 'other.txt': old + ' unchanged' };
  for (const [name, text] of Object.entries(files)) await fs.writeFile(join(cwd, name), text);
  if (tracked) execFileSync('git', ['add', '.'], { cwd });
  const result = spawnSync(process.execPath, [resolve('scripts/rename-upstream.mjs'), '--root', cwd], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  for (const [name, text] of Object.entries(files)) assert.equal(await fs.readFile(join(cwd, name), 'utf8'), text);
});

test('B09: an append queued during compaction survives its replacement', async (t) => {
  const ledger = await import('./recentFilesLedger.js');
  const rec = (i: number) => ({ ts: i, path: `file-${i}`, op: 'modified' as const, workflowId: 'fixture', tabTitle: 'Fixture', provider: 'ollama', tool: 'Write' });
  await fs.writeFile(ledger.LEDGER_PATH, Array.from({ length: 1000 }, (_, i) => JSON.stringify(rec(i))).join('\n') + '\n');
  const read = fs.readFile;
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
  let once = true;
  t.mock.method(fs, 'readFile', async (...args: any[]) => {
    const raw = await Reflect.apply(read, fs, args);
    if (args[0] === ledger.LEDGER_PATH && once) { once = false; entered(); await blocked; }
    return raw;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const first = ledger.appendRecord(rec(1000)); await started;
  const second = ledger.appendRecord(rec(1001)); await pause(); release();
  await Promise.all([first, second]);
  assert.ok((await ledger.readRecent(500)).some(r => r.ts === 1001));
});

test('B11: a split UTF-8 JSONL row is emitted once after its newline', async () => {
  const { watchSessionJsonl } = await import('./sessionJsonl.js');
  const file = join(root, 'split.jsonl'); await fs.writeFile(file, '');
  const seen: unknown[] = [], stop = watchSessionJsonl(file, 0, e => seen.push(e));
  try {
    const row = Buffer.from(JSON.stringify({ type: 'user', message: { content: 'caf\u00e9' } }) + '\n');
    const split = row.indexOf(Buffer.from('\u00e9')) + 1;
    await fs.appendFile(file, row.subarray(0, split)); await pause();
    assert.equal(seen.length, 0);
    await fs.appendFile(file, row.subarray(split)); await pause(150);
    assert.equal(seen.length, 1); assert.equal((seen[0] as any).message.content, 'caf\u00e9');
  } finally { stop(); }
});

test('B11: disposal suppresses an already admitted asynchronous read', async (t) => {
  const { watchSessionJsonl } = await import('./sessionJsonl.js');
  const file = join(root, 'disposed.jsonl'); await fs.writeFile(file, '');
  const original = fs.readFile;
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
  t.mock.method(fs, 'readFile', async (...args: any[]) => {
    const raw = await Reflect.apply(original, fs, args);
    if (args[0] === file) { entered(); await blocked; }
    return raw;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const seen: unknown[] = [], stop = watchSessionJsonl(file, 0, e => seen.push(e));
  await fs.appendFile(file, JSON.stringify({ type: 'user' }) + '\n');
  await started; stop(); release(); await pause(); assert.equal(seen.length, 0);
});

test('B25: later subtrees can displace 500 older recent files', async t => {
  // Ranking is independent of the separately tested wall-clock scan budget.
  t.mock.method(performance, 'now', () => 0);
  const cwd = join(process.env.HOME!, 'recent-project');
  await fs.mkdir(join(cwd, 'a-new'), { recursive: true }); await fs.mkdir(join(cwd, 'z-old'));
  for (let i = 0; i < 505; i++) { const file = join(cwd, 'z-old', `old-${i}`); await fs.writeFile(file, 'old'); await fs.utimes(file, new Date(), new Date(Date.now() - 60000)); }
  const newest = join(cwd, 'a-new', 'newest'); await fs.writeFile(newest, 'new');
  const { patchSettings } = await import('./settings.js');
  await patchSettings({ projects: [cwd] });
  const { scanChanged } = await import('./explorerChanged.js');
  const result = await scanChanged({ project: cwd });
  assert.equal(result.length, 500); assert.equal(result[0].path, newest);
});

test('B54: an accepted empty rerun response succeeds after one request', async (t) => {
  const token = async (command: string, args: string[]) => {
    assert.equal(command, 'gh'); assert.deepEqual(args, ['auth', 'token']);
    return { stdout: 'fixture', stderr: '' };
  };
  const stub = Object.assign(() => { throw new Error('Expected promisified execFile'); }, { [promisify.custom]: token });
  const originalExecFile = childProcess.execFile;
  childProcess.execFile = stub as any;
  syncBuiltinESMExports();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 201 }); });
  try { const { github } = await import('./github.js'); assert.deepEqual(await github.rerunRun('fixture', 'project', 1), { ok: true }); assert.equal(calls, 1); }
  finally { childProcess.execFile = originalExecFile; t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('B62: explicit Build stage cannot claim earlier missing fields are ready', async () => {
  const { assessGenesisReadiness } = await import('./genesis/stages.js');
  const complete = { stage: 'build', spark: 'A detailed synthetic project idea with enough substance.', title: 'Sample', concept: 'Concept', theCase: 'Case', buildDirection: 'Build' } as const;
  for (const field of ['spark', 'title', 'concept', 'theCase', 'buildDirection']) {
    const seed = { ...complete, [field]: '' } as any;
    assert.equal(assessGenesisReadiness(seed).readyToScaffold, false, field);
  }
  assert.equal(assessGenesisReadiness(complete as any).readyToScaffold, true);
});

async function rotatedSession() {
  const cwd = await fs.mkdtemp(join(root, 'sessions-')), workflowId = 'workflow-fixture';
  const dir = join(cwd, '.arco', 'workflows', workflowId); await fs.mkdir(dir, { recursive: true });
  const index = await import('./workflows/sessionIndex.js');
  const meta = { workflowId, cwd, name: 'Fixture', createdAt: 1000, lastActiveAt: 2000, primaryProvider: 'ollama', cliSessions: [{ provider: 'ollama', sessionId: 'session-old', createdAt: 1000 }], lastEventSeq: 1 } as any;
  await fs.writeFile(join(dir, 'events.jsonl'), JSON.stringify({ seq: 1, type: 'user_message_echo', content: 'Improve storage safety' }) + '\n');
  await index.upsertSessionIndexFromMeta(meta);
  await index.renameSession(cwd, { provider: 'ollama', sessionId: 'session-old' }, 'Old accepted title');
  meta.cliSessions.push({ provider: 'ollama', sessionId: 'session-current', createdAt: 3000 }); meta.lastActiveAt = 4000;
  await fs.writeFile(join(dir, 'meta.json'), JSON.stringify(meta)); await index.upsertSessionIndexFromMeta(meta);
  return { cwd, workflowId, meta, index };
}
test('B10: summary and model title select the current metadata session', async () => {
  const { cwd, workflowId, index } = await rotatedSession();
  await index.recordSessionSummary(cwd, workflowId, 'Current summary');
  assert.equal((await index.applyModelTitle(cwd, workflowId, 'Current model title')).status, 'applied');
  const entries = (await index.readSessionIndex(cwd)).entries;
  const old = entries.find(e => e.sessionId === 'session-old')!, current = entries.find(e => e.sessionId === 'session-current')!;
  assert.equal(old.title, 'Old accepted title'); assert.notEqual(old.subtitle, 'Current summary');
  assert.equal(current.subtitle, 'Current summary'); assert.equal(current.title, 'Current model title');
});
test('B10: an old operator title does not suppress generation for a new session', async () => {
  const { meta, index, cwd } = await rotatedSession();
  const { maybeGenerateModelTitle } = await import('./workflows/modelTitles.js');
  let calls = 0;
  const result = await maybeGenerateModelTitle(meta, { readSettings: async () => ({ ollama: { utility: { titles: true, model: 'fixture' } } }), runUtilityJob: (async () => { calls++; return { ok: true, text: 'Current generated title' }; }) as any, notify() {} });
  assert.equal(result, 'applied'); assert.equal(calls, 1);
  assert.equal((await index.readSessionIndex(cwd)).entries.find(e => e.sessionId === 'session-current')!.title, 'Current generated title');
});
test('B50: production loader accepts every execution key of a supported 32-worker script', async () => {
  const { parseConditionDefinition } = await import('./voice/conditionSchema.js');
  const { ComputerConditions } = await import('./voice/conditionStore.js');
  const ids = Array.from({ length: 32 }, (_, i) => `worker-${String(i).padStart(4, '0')}`);
  const definition = parseConditionDefinition({ label: 'Wide script', cluster_ids: ['cluster-fixture'], hold_on_input: false, clauses: Array.from({ length: 2 }, (_, i) => ({ id: `step${i}`, when: { op: 'worker', worker_id: ids[0], field: 'busy', cmp: 'eq', value: false }, actions: Array.from({ length: 4 }, () => ({ kind: 'nudge', worker_ids: ids })) })) });
  const facts = ids.map(id => ({ id, name: id, clusterId: 'cluster-fixture', busy: false, queued: 0, compacting: false, pending_mail: 0, pendingIds: [], needs_input: false })) as any;
  const store = new ComputerConditions(), rule = store.create('owner-fixture', definition, facts);
  for (let i = 0; i < 256; i++) { const next = store.next(rule.id, facts)!; assert.ok(next); store.record(rule.id, next); }
  assert.equal(Object.keys(store.get(rule.id)!.executions).length, 256);
  const file = join(root, 'conditions.json'); process.env.ARCO_COMPUTER_CONDITIONS_FILE = file;
  await fs.writeFile(file, JSON.stringify(store.saved()));
  const { workflows } = await import('./server/state.js');
  workflows.set('owner-fixture', { config: { voiceOperator: true, kind: 'chat' } } as any);
  try {
    const { computerConditionControl } = await import('./voice/conditions.js');
    const loaded = await computerConditionControl('owner-fixture', { action: 'list' });
    assert.ok(JSON.stringify(loaded).includes(rule.id));
  } finally { workflows.delete('owner-fixture'); }
});

test('B27: mailbox context scans each sender history once and retains one preview', async (t) => {
  const cwd = await fs.mkdtemp(join(root, 'mailbox-project-'));
  const sender = 'sender-fixture', recipient = 'recipient-fixture';
  const clusters = await import('./clusterStore.js'), mailbox = await import('./clusterMailbox.js');
  const cluster = await clusters.createCluster({ cwd, memberWorkflowIds: [sender, recipient] });
  const dir = join(cwd, '.arco', 'workflows', sender), file = join(dir, 'events.jsonl'); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, Array.from({ length: 300 }, (_, i) => JSON.stringify({ seq: i + 1, type: 'peer_message_received', from: recipient, ts: i + 1000, content: `Reply ${i}\nrest` })).join('\n') + '\n');
  for (let i = 0; i < 20; i++) await mailbox.enqueue(recipient, { msgId: mailbox.mintMsgId(), fromWorkflowId: sender, fromDisplayName: 'Sender', toWorkflowId: recipient, content: `Pending ${i}`, createdAt: new Date().toISOString(), delivered: false });
  const { workflowCwds } = await import('./server/state.js'); workflowCwds.set(sender, cwd);
  const original = fs.open; let opens = 0;
  t.mock.method(fs, 'open', async (...args: any[]) => { if (args[0] === file) opens++; return Reflect.apply(original, fs, args); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); workflowCwds.delete(sender); });
  const { tryHandleClusterRoutes } = await import('./http/clusterRoutes.js');
  let status = 0, text = '';
  await tryHandleClusterRoutes({ method: 'GET', url: `/api/clusters/${cluster.clusterId}/mailbox/${recipient}` } as any, { writeHead(s: number) { status = s; }, end(s: string) { text = s; } } as any, {} as any);
  assert.equal(status, 200); const rows = JSON.parse(text); assert.equal(rows.length, 20);
  assert.equal(rows[0].recipientContext.lastMessage.firstLine, 'Reply 299');
  assert.ok(opens > 0 && opens <= 2, `one canonical stream uses two handles, saw ${opens}`);
});

test('B31: transcript search finds the same regex match in sealed and live history', async () => {
  const { brotliCompressSync } = await import('node:zlib');
  const { segmentName } = await import('./eventLog.js');
  const { search } = await import('./recall/search.js');
  const cwd = await fs.mkdtemp(join(root, 'recall-project-')), wfid = 'recall-fixture';
  const dir = join(cwd, '.arco', 'workflows', wfid); await fs.mkdir(dir, { recursive: true });
  const row = JSON.stringify({ seq: 1, type: 'user_message_echo', content: 'Synthetic QuokkaPrime phrase' }) + '\n';
  const entry = { wfid, cwd, title: 'Ordinary title', project: 'Fixture', provider: 'ollama', lastActiveAt: 1000, summaryRef: null, tags: [], pinned: false, links: [] };
  const index = { query: () => [entry], searchFtsRaw: () => [] } as any;
  await fs.writeFile(join(dir, 'events.jsonl'), row);
  const before = await search({ q: 'quokka(prime)', includeTranscripts: true }, index);
  assert.equal(before.hits.length, 1);
  await fs.writeFile(join(dir, segmentName(1, 1)), brotliCompressSync(row));
  await fs.writeFile(join(dir, 'events.jsonl'), JSON.stringify({ seq: 2, type: 'primary_text', text: 'Unrelated' }) + '\n');
  const after = await search({ q: 'quokka(prime)', includeTranscripts: true }, index);
  assert.equal(after.hits.length, 1); assert.equal(after.hits[0].matchedIn, 'transcript');
  assert.equal(after.hits[0].snippet, before.hits[0].snippet);
});

test('B197: successful tracked rename preserves the staged blob and unstaged edits', async () => {
  const cwd = await fs.mkdtemp(join(root, 'import-success-')); execFileSync('git', ['init', '-q', cwd]);
  const old = ['arc', 'hon'].join(''), source = `${old}-fixture.txt`, target = 'arco-fixture.txt';
  await fs.writeFile(join(cwd, source), old + ' staged'); execFileSync('git', ['add', '--', source], { cwd });
  const blob = execFileSync('git', ['rev-parse', `:${source}`], { cwd, encoding: 'utf8' }).trim();
  await fs.writeFile(join(cwd, source), old + ' unstaged');
  const args = [resolve('scripts/rename-upstream.mjs'), '--root', cwd];
  assert.equal(spawnSync(process.execPath, args).status, 0);
  assert.equal(await fs.readFile(join(cwd, target), 'utf8'), 'arco unstaged');
  await assert.rejects(fs.stat(join(cwd, source)), { code: 'ENOENT' });
  assert.equal(execFileSync('git', ['rev-parse', `:${target}`], { cwd, encoding: 'utf8' }).trim(), blob);
  assert.equal(spawnSync(process.execPath, args).status, 0);
});

test('B197: a mapped parent file collision is refused before any rewrite', async () => {
  const cwd = await fs.mkdtemp(join(root, 'import-parent-')); execFileSync('git', ['init', '-q', cwd]);
  const old = ['arc', 'hon'].join(''); await fs.mkdir(join(cwd, old));
  await fs.writeFile(join(cwd, old, 'file.txt'), old); await fs.writeFile(join(cwd, 'arco'), 'existing file');
  const result = spawnSync(process.execPath, [resolve('scripts/rename-upstream.mjs'), '--root', cwd]);
  assert.notEqual(result.status, 0); assert.equal(await fs.readFile(join(cwd, old, 'file.txt'), 'utf8'), old);
});

test('B11: initial loading leaves a partial final record for the watcher', async () => {
  const { loadSessionJsonl, watchSessionJsonl } = await import('./sessionJsonl.js');
  const file = join(root, 'initial-tail.jsonl'), complete = JSON.stringify({ type: 'user', uuid: 'first' }) + '\n';
  await fs.writeFile(file, complete + '{"type":"assistant"');
  const loaded = await loadSessionJsonl(file); assert.equal(loaded.entries.length, 1); assert.equal(loaded.byteLength, Buffer.byteLength(complete));
  const seen: unknown[] = [], stop = watchSessionJsonl(file, loaded.byteLength, e => seen.push(e));
  try { await fs.appendFile(file, '}\n'); await pause(150); assert.equal(seen.length, 1); }
  finally { stop(); }
});

test('B10: a title generation completing after session rotation cannot rename the new session', async () => {
  const { meta, index, cwd, workflowId } = await rotatedSession();
  const { maybeGenerateModelTitle } = await import('./workflows/modelTitles.js');
  const result = await maybeGenerateModelTitle(meta, { readSettings: async () => ({ ollama: { utility: { titles: true, model: 'fixture' } } }), runUtilityJob: (async () => {
    meta.cliSessions.push({ provider: 'ollama', sessionId: 'session-next', createdAt: 5000 });
    await fs.writeFile(join(cwd, '.arco', 'workflows', workflowId, 'meta.json'), JSON.stringify(meta)); await index.upsertSessionIndexFromMeta(meta);
    return { ok: true, text: 'Stale generation' };
  }) as any, notify() {} });
  assert.equal(result, 'skipped'); assert.ok((await index.readSessionIndex(cwd)).entries.every(e => e.title !== 'Stale generation'));
});

test('B31: missing ripgrep and invalid regex degrade without retaining transcript readers', async () => {
  const { searchTranscript } = await import('./recall/transcriptSearch.js');
  assert.deepEqual(await searchTranscript(root, 'fixture', join(root, 'absent-rg')), { available: false });
  assert.deepEqual(await searchTranscript(root, '[', 'rg'), { available: true });
});

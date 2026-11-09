import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, createWriteStream, promises as fs } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { copyReviewedArtifact, inspectArtifactCopy } from './artifactCopy.js';

// MOVE TO PROJECT on large binaries: only printable runs are scanned, the file
// is listed as not fully scanned, and noise in random bytes can no longer
// fill the findings limit and refuse the copy.
const ID = 'conv-1';
const secret = ['password', '=', 'synthetic', '-', 'value', '-', '42'].join('');
const mail = ['fixture', 'example.test'].join('@');

async function repo(): Promise<{ cwd: string; artifacts: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-copy-bin-'));
  execFileSync('git', ['init', '-q'], { cwd });
  const artifacts = path.join(cwd, '.arco', 'workflows', ID, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  await mkdir(path.join(cwd, 'ignored'));
  await writeFile(path.join(cwd, '.gitignore'), '/ignored/\n');
  return { cwd, artifacts };
}

// Random bytes in 1 MiB blocks, with readable text placed across the first
// 64 KiB read boundary and near the end.
async function writeRandom(file: string, mib: number): Promise<void> {
  const out = createWriteStream(file);
  for (let i = 0; i < mib; i++) {
    const block = randomBytes(1024 * 1024);
    if (i === 0) block.write(`\n${secret}\n`, 64 * 1024 - 8, 'latin1');
    if (i === mib - 1) block.write(`\n${mail}\n`, 4096, 'latin1');
    if (!out.write(block)) await new Promise<void>((r) => out.once('drain', () => r()));
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
}

test('a 72 MB random .bin is reviewed, not refused: printable runs scanned, listed as not fully scanned', { timeout: 120_000 }, async () => {
  const { cwd, artifacts } = await repo();
  try {
    await writeRandom(path.join(artifacts, 'disk.bin'), 72);
    const started = Date.now();
    const review = await inspectArtifactCopy(cwd, ID, 'artifacts/disk.bin', path.join(cwd, 'ignored'), false);
    const elapsed = Date.now() - started;
    const file = review.files[0];
    assert.equal(file.bytes, 72 * 1024 * 1024);
    assert.equal(file.unscanned, true);
    const rules = new Set(file.findings.map((f) => f.rule));
    assert.ok(rules.has('password-or-secret'), 'a credential split by a read boundary is found');
    assert.ok(rules.has('email-address'), 'text near the end is still scanned');
    // Colon runs in random bytes no longer count as IPv6 addresses.
    assert.ok(file.findings.length < 20, `random bytes produced ${file.findings.length} findings`);
    assert.ok(!file.findingsCapped);
    assert.equal(review.ignored, true);
    console.log(`72 MB random file reviewed in ${elapsed} ms with ${file.findings.length} findings`);
    await copyReviewedArtifact(cwd, ID, 'artifacts/disk.bin', path.join(cwd, 'ignored'), false, review.token);
    assert.equal((await readFile(path.join(cwd, 'ignored', 'disk.bin'))).length, 72 * 1024 * 1024);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// A minimal zip: one stored (uncompressed) entry and one deflated entry.
function zip(entries: Array<{ name: string; data: Buffer; deflate: boolean }>): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(e.deflate ? 8 : 0, 8);
    head.writeUInt32LE(0, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(e.data.length, 22); head.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(e.deflate ? 8 : 0, 10);
    dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(e.data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    local.push(head, name, body); central.push(dir, name); offset += 30 + name.length + body.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

test('a zip: text in a stored entry is found; the file is listed as not fully scanned', async () => {
  const { cwd, artifacts } = await repo();
  try {
    const archive = zip([
      { name: 'notes.txt', data: Buffer.from(`build notes\n${secret}\n`), deflate: false },
      { name: 'packed.bin', data: Buffer.concat([randomBytes(4096), Buffer.from(mail)]), deflate: true },
    ]);
    await writeFile(path.join(artifacts, 'bundle.zip'), archive);
    const review = await inspectArtifactCopy(cwd, ID, 'artifacts/bundle.zip', cwd, true);
    const file = review.files[0];
    assert.equal(file.unscanned, true);
    assert.ok(file.findings.some((f) => f.rule === 'password-or-secret'));
    assert.equal(review.publicRepository, true);
    await assert.rejects(copyReviewedArtifact(cwd, ID, 'artifacts/bundle.zip', cwd, true, review.token), /Confirm the files that were not scanned/);
    await copyReviewedArtifact(cwd, ID, 'artifacts/bundle.zip', cwd, true, review.token, undefined, true);
    assert.deepEqual(await readFile(path.join(cwd, 'bundle.zip')), archive);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('addresses in binary content: IPv4 and real IPv6 count, colon noise does not', async () => {
  const { cwd, artifacts } = await repo();
  try {
    const parts = [Buffer.from([1, 2, 255]), Buffer.from('x::y :0:4 '), Buffer.from([0xfe, 0xff]), Buffer.from('\nhost fe80::a1b2\n'), Buffer.from([0xfe]), Buffer.from(`\nat ${[198, 51, 100, 7].join('.')}\n`)];
    await writeFile(path.join(artifacts, 'trace.dat'), Buffer.concat(parts));
    const review = await inspectArtifactCopy(cwd, ID, 'artifacts/trace.dat', cwd, false);
    assert.deepEqual(review.files[0].findings, [{ line: 2, rule: 'ip-address' }, { line: 4, rule: 'ip-address' }]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('UTF-16 text with ASCII content is still scanned as text', async () => {
  const { cwd, artifacts } = await repo();
  try {
    await writeFile(path.join(artifacts, 'export.txt'), Buffer.from(`report\n${secret}\n`, 'utf16le'));
    const review = await inspectArtifactCopy(cwd, ID, 'artifacts/export.txt', cwd, false);
    assert.equal(review.files[0].unscanned, false);
    assert.deepEqual(review.files[0].findings, [{ line: 2, rule: 'password-or-secret' }]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// Let stream destruction finish before the enclosing finally closes its handle.
// A raw-fd stream can otherwise race that close and accidentally close a reused fd.
for (const phase of ['staging', 'publishing'] as const) test(`copy ${phase} preserves write errors without closing a descriptor twice`, async (t) => {
  const { cwd, artifacts } = await repo();
  const canonicalCwd = await fs.realpath(cwd);
  const originalOpen = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const isOutput = typeof args[1] === 'number' && (args[1] & constants.O_WRONLY) !== 0;
    const inject = phase === 'staging' ? String(args[0]).includes('arco-reviewed-copy-') : String(args[0]) === path.join(canonicalCwd, 'ignored', 'owned.bin');
    if (isOutput && inject) {
      handle.writeFile = async () => { throw new Error('Synthetic copy write failure'); };
    }
    const close = handle.close.bind(handle);
    handle.close = async () => { await delay(20); await close(); };
    return handle;
  });
  try {
    const bytes = Buffer.alloc(256 * 1024, 0xab);
    await writeFile(path.join(artifacts, 'owned.bin'), bytes);
    const folder = path.join(cwd, 'ignored');
    const review = await inspectArtifactCopy(cwd, ID, 'artifacts/owned.bin', folder, false);
    await assert.rejects(copyReviewedArtifact(cwd, ID, 'artifacts/owned.bin', folder, false, review.token), /Synthetic copy write failure/);
    assert.deepEqual(await readFile(path.join(artifacts, 'owned.bin')), bytes);
  } finally { t.mock.restoreAll(); await rm(cwd, { recursive: true, force: true }); }
});

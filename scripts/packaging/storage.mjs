// `arco storage unseal` (and `npm run storage:unseal` in a source checkout):
// write every sealed conversation log back to one plain events.jsonl before a
// downgrade to a release that reads only plain logs (docs/STORAGE_PLAN.md,
// P7.3). Lossless: the plain file is complete and checked before the sealed
// segments and the format marker are removed. Refuses while Arco is running.
import { promises as fs, readFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createBrotliDecompress } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const SEGMENT_RE = /^events\.(\d{12})-(\d{12})\.jsonl\.br$/;
const SEQ_RE = /^\{"seq":(\d+)[,}]/;
const WFID_RE = /^[a-zA-Z0-9-]{1,64}$/;

function lineSeq(line) {
  const m = SEQ_RE.exec(line);
  if (m) return Number(m[1]);
  try { const v = JSON.parse(line); return typeof v.seq === 'number' ? v.seq : null; } catch { return null; }
}

async function* lines(stream) {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of rl) if (line) yield line; } finally { rl.close(); }
}

export async function listSegments(dir) {
  let names = [];
  try { names = await fs.readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.map((name) => { const m = SEGMENT_RE.exec(name); return m ? { name, file: join(dir, name), firstSeq: Number(m[1]), lastSeq: Number(m[2]) } : null; })
    .filter(Boolean).sort((a, b) => a.firstSeq - b.firstSeq || a.lastSeq - b.lastSeq);
}

// The live file can start with copies of sealed records: the newest sealed
// record that every seal leaves, or every record of a seal that stopped
// before it replaced the live file. Only those are left out, matched by
// content, each sealed copy once, up to the first live record that is not a
// copy. A record with an old number written by a release before 0.1.5 is kept
// in its place. Same rule as SealedCopies in server/src/eventLog.ts.
function liveWithoutCopies(liveLines, sealed) {
  const firstSeq = liveLines.map(lineSeq).find((s) => s !== null);
  if (firstSeq === undefined) return liveLines;
  const counts = new Map();
  for (const { lastSeq, lines: segLines } of sealed) {
    if (lastSeq < firstSeq) continue;
    for (const line of segLines()) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const out = [];
  let leading = true;
  for (const line of liveLines) {
    if (leading && lineSeq(line) !== null) {
      const n = counts.get(line);
      if (n) { if (n === 1) counts.delete(line); else counts.set(line, n - 1); continue; }
      leading = false;
    }
    out.push(line);
  }
  return out;
}

// One conversation folder. Returns null when nothing is sealed.
export async function unsealLog(dir) {
  const segments = await listSegments(dir);
  if (!segments.length) return null;
  const parts = [];
  const sealed = [];
  for (const seg of segments) {
    const input = createReadStream(seg.file);
    const decompressed = createBrotliDecompress();
    // A segment that cannot be opened or read stops this conversation's export
    // (its segments are kept) instead of ending the process.
    input.on('error', (error) => decompressed.destroy(error));
    const start = parts.length;
    try {
      for await (const line of lines(input.pipe(decompressed))) parts.push(line);
    } finally { input.destroy(); }
    const end = parts.length;
    sealed.push({ lastSeq: seg.lastSeq, lines: () => parts.slice(start, end) });
  }
  const live = join(dir, 'events.jsonl');
  const liveLines = [];
  try {
    const input = createReadStream(live);
    try {
      for await (const line of lines(input)) liveLines.push(line);
    } finally { input.destroy(); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  parts.push(...liveWithoutCopies(liveLines, sealed));
  const text = parts.join('\n') + '\n';
  const tmp = join(dir, `events.jsonl.${randomUUID()}.tmp`);
  const fh = await fs.open(tmp, 'wx', 0o600);
  try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  try { await renameWithRetry(tmp, live); }
  catch (error) { await fs.rm(tmp, { force: true }).catch(() => {}); throw error; }
  if (await fs.readFile(live, 'utf8') !== text) throw new Error(`The exported log in ${dir} did not read back correctly; its sealed segments were kept.`);
  for (const seg of segments) await fs.rm(seg.file, { force: true });
  await fs.rm(join(dir, 'log-format.json'), { force: true });
  return { records: parts.length, segments: segments.length };
}

function readPaths(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(value)) return value.filter((x) => typeof x === 'string');
    if (Array.isArray(value?.records)) return value.records.map((r) => r?.path).filter((p) => typeof p === 'string');
  } catch { /* absent or unreadable */ }
  return [];
}

// Project folders Arco knows about, plus chat and Genesis folders in its home.
export async function knownProjects(home) {
  const out = new Set([...readPaths(join(home, 'projects.json')), ...readPaths(join(home, 'known-cwds.json'))]);
  for (const sub of ['chats', 'genesis']) {
    try { for (const d of await fs.readdir(join(home, sub), { withFileTypes: true })) if (d.isDirectory()) out.add(join(home, sub, d.name)); } catch { /* none */ }
  }
  return [...out];
}

// Windows refuses a rename over a file another program holds open (a virus
// scanner, the indexer) for a short moment; retry briefly there.
async function renameWithRetry(from, to) {
  const started = Date.now();
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try { await fs.rename(from, to); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() - started > 5000) throw error;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function isLink(p) {
  try { return (await fs.lstat(p)).isSymbolicLink(); } catch { return false; }
}

export async function unsealProjects(projects, log = console.log) {
  let conversations = 0, records = 0, failed = 0;
  for (const project of projects) {
    const root = join(project, '.arco', 'workflows');
    // Links are never followed: a linked .arco, .arco/workflows or
    // conversation folder is skipped.
    if (await isLink(join(project, '.arco')) || await isLink(root)) { log(`Skipped ${project}: its .arco or .arco/workflows folder is a link.`); continue; }
    let names = [];
    try { names = await fs.readdir(root); } catch { continue; }
    for (const name of names) {
      if (!WFID_RE.test(name)) continue;
      if (await isLink(join(root, name))) { log(`Skipped conversation ${name}: its folder is a link.`); continue; }
      let result;
      // One conversation that cannot be written back (a file held open, a
      // damaged segment) keeps its segments and does not stop the others.
      try { result = await unsealLog(join(root, name)); }
      catch (error) { failed++; log(`Kept the sealed log of conversation ${name}: ${error.message}`); continue; }
      if (!result) continue;
      conversations++; records += result.records;
    }
  }
  log(conversations ? `Wrote ${conversations} sealed conversation logs back to plain events.jsonl files (${records} records).` : 'No sealed conversation logs found.');
  if (failed) throw new Error(`${failed} conversation logs could not be written back and were left sealed; close other programs using them and run arco storage unseal again.`);
  return { conversations, records };
}

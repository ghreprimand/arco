import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeKeepPath } from './keepStore.js';
import { outputDirectory } from './outputStore.js';
import { assertSafePath, confinedPath, isPathWithin, safeDirectory } from './fileAccessPolicy.js';
import { projectGitEnv, suggestFromRemote } from './publicProject.js';
import { publicSafetyRules } from '@arco/shared';

const git = promisify(execFile);
async function gitCall(cwd: string, args: string[]): Promise<void> {
  await git('git', args, { cwd, timeout: 10000, env: projectGitEnv() });
}
const MiB = 1024 * 1024;
const MB = 1000 * 1000;
const TEXT = /\.(?:txt|md|markdown|csv|json|ya?ml|xml|html?|svg|js|mjs|cjs|jsx|ts|tsx|py|rs|go|java|css|sh|sql|diff|patch|log|ini|toml|env)$/i;
const MEDIA = /\.(?:png|jpe?g|webp|gif|bmp|svg|mp3|wav|ogg|flac|m4a|mp4|webm|mov|mkv|avi)$/i;
const safeUsers = new Set(['operator', 'example', 'user', 'username', 'u', 'op', 'root', 'nobody', 'glob', 'real', 'test', 'runner', 'node']);
const patterns: ReadonlyArray<readonly [string, RegExp]> = [
  ...publicSafetyRules,
  ['password-or-secret', /\b(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*["']?[^\s"']{1,}/i],
  ['ip-address', /\b(?:\d{1,3}\.){3}\d{1,3}\b|(?<![A-Za-z0-9])(?:[a-fA-F0-9]{0,4}:){2,}[a-fA-F0-9]{0,4}(?![A-Za-z0-9])/],
];
export function scanCopyLine(line: string): string[] {
  const rules = patterns.filter(([, re]) => re.test(line)).map(([name]) => name);
  if (/[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(line)) rules.push('email-address');
  const decoded = line.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  for (const m of decoded.matchAll(/(?:(?<![A-Za-z0-9_/])\/(?:home|Users)\/|[A-Za-z]:[\\/]Users[\\/])([A-Za-z0-9_.-]+)(?=[\\/])/g)) if (!safeUsers.has(m[1])) rules.push('personal-home-path');
  return [...new Set(rules)];
}
interface FileEntry { rel: string; bytes: number; hash: string; media: boolean; unscanned: boolean; findingsCapped?: boolean; findings: Array<{ line: number; rule: string }> }
interface CopyInspection { source: string; target: string; bytes: number; ignored: boolean; publicRepository: boolean; files: FileEntry[]; directories: string[]; token: string }
export const MAX_FILE_FINDINGS = 1000;
export const MAX_TOTAL_FINDINGS = 2000;
// Readable text inside a binary file: runs of four or more printable ASCII
// characters (as the `strings` tool finds them). Paths, addresses, keys and
// tokens are ASCII, so scanning the runs catches them without decoding the
// rest of the bytes as text.
const PRINTABLE_RUN = /[\x20-\x7e\t]{4,}/g;
const NOT_PRINTABLE = /[^\x20-\x7e\t]/;
function printableRuns(text: string): string { return (text.match(PRINTABLE_RUN) ?? []).join('\n'); }
// Random bytes often contain short colon runs such as "::" or ":0:4" that the
// IPv6 part of the ip-address rule accepts. In binary content an address
// counts only as an IPv4 address or an IPv6 form with at least four hex digits.
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const IPV6 = /(?<![A-Za-z0-9])(?:[a-fA-F0-9]{0,4}:){2,}[a-fA-F0-9]{0,4}(?![A-Za-z0-9])/g;
function scanBinaryRuns(runs: string): string[] {
  const rules = scanCopyLine(runs);
  if (!rules.includes('ip-address') || IPV4.test(runs) || [...runs.matchAll(IPV6)].some((m) => (m[0].match(/[a-fA-F0-9]/g) ?? []).length >= 4)) return rules;
  return rules.filter((rule) => rule !== 'ip-address');
}
// Text files are scanned line by line. A file that is not valid UTF-8 text
// (an undecodable sequence once NUL bytes are dropped) is scanned from that point on for
// printable runs only and listed as not fully scanned. When the findings
// limit is reached the file is hashed to the end but no longer scanned, and
// it is listed as not fully scanned instead of refusing the whole copy.
async function scanFile(file: string, rel: string, maxFindings = MAX_FILE_FINDINGS): Promise<FileEntry> {
  const fh = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await fh.stat(); if (!info.isFile()) throw new Error('Only regular files can be copied.');
    const hash = createHash('sha256'); const findings: FileEntry['findings'] = [];
    const media = MEDIA.test(rel); const scanText = !media || TEXT.test(rel); let line = 1; let pending = ''; let unscanned = !scanText;
    let binary = false; let capped = scanText && maxFindings <= 0; let carry = '';
    const decoder = new TextDecoder('utf-8');
    const scanLine = (text: string, at: number, rules = scanCopyLine(text)) => {
      for (const rule of rules) {
        if (findings.length >= maxFindings) { capped = true; return; }
        findings.push({ line: at, rule });
      }
    };
    // Binary mode keeps counting newline bytes so findings still point near
    // the right place; a printable run cut by a chunk boundary is carried.
    const scanBinary = (text: string, final: boolean) => {
      let body = carry + text;
      if (final) carry = '';
      else {
        let cut = body.length;
        while (cut > 0 && !NOT_PRINTABLE.test(body[cut - 1]) && body.length - cut < MiB) cut--;
        carry = body.slice(cut); body = body.slice(0, cut);
      }
      let from = 0;
      for (;;) {
        const i = body.indexOf('\n', from);
        const piece = body.slice(from, i < 0 ? body.length : i);
        const runs = printableRuns(piece);
        if (runs) scanLine(runs, line, scanBinaryRuns(runs));
        if (capped || i < 0) break;
        from = i + 1; line++;
      }
    };
    for await (const chunk of createReadStream('', { fd: fh.fd, autoClose: false, emitClose: false })) {
      const buffer = chunk as Buffer; hash.update(buffer);
      if (!scanText || capped) continue;
      // NUL bytes are dropped first, so UTF-16 text with ASCII content still
      // reads as text.
      const bytes = buffer.includes(0) ? Buffer.from(buffer.filter((byte) => byte !== 0)) : buffer;
      if (!binary) {
        const text = decoder.decode(bytes, { stream: true });
        if (text.includes('\ufffd')) {
          // Not text from here on: scan what was already decoded, then this
          // chunk's raw bytes for printable runs.
          binary = true; unscanned = true;
          if (pending) { scanLine(pending, line); pending = ''; }
          if (!capped) scanBinary(bytes.toString('latin1'), false);
          continue;
        }
        pending += text;
        for (;;) {
          const i = pending.indexOf('\n'); if (i < 0 || capped) break;
          scanLine(pending.slice(0, i), line);
          pending = pending.slice(i + 1); line++;
        }
        if (pending.length > MiB) throw new Error('A text line is too long to scan; split the artifact.');
      } else scanBinary(bytes.toString('latin1'), false);
    }
    if (scanText && !capped) {
      if (binary) scanBinary('', true);
      else {
        const remainder = decoder.decode();
        if (remainder.includes('\ufffd')) unscanned = true;
        scanLine(pending + remainder, line);
      }
    }
    if (capped) unscanned = true;
    return { rel, bytes: info.size, hash: hash.digest('hex'), media, unscanned, ...(capped ? { findingsCapped: true } : {}), findings };
  } finally { await fh.close(); }
}
async function gitIgnored(cwd: string, target: string): Promise<boolean> {
  try {
    await gitCall(cwd, ['ls-files', '--error-unmatch', '--', target]);
    return false;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code !== 1 && code !== 128) throw new Error('Git tracking status is unavailable.');
    if (code === 128) return false;
  }
  try { await gitCall(cwd, ['check-ignore', '-q', '--no-index', '--', target]); return true; }
  catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === 1) return false;
    if (code === 128) { try { await gitCall(cwd, ['rev-parse', '--is-inside-work-tree']); } catch (err) { if ((err as { code?: unknown }).code === 128) return false; } }
    throw new Error('Git ignore status is unavailable.');
  }
}
async function ensureNoLinks(root: string, rel: string): Promise<void> {
  let current = root;
  const base = await fs.lstat(root);
  if (base.isSymbolicLink()) throw new Error('Artifact links cannot be copied.');
  for (const part of rel ? rel.split('/') : []) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Artifact links cannot be copied.');
  }
  if (await fs.realpath(current) !== current) throw new Error('Artifact path changed; review it again.');
}
async function listSource(root: string): Promise<{ files: Array<{ path: string; rel: string }>; directories: string[] }> {
  const out: Array<{ path: string; rel: string }> = []; const directories: string[] = [];
  async function walk(file: string, rel: string) {
    const st = await fs.lstat(file);
    if (st.isSymbolicLink()) throw new Error('Artifact links cannot be copied.');
    if (st.isDirectory()) {
      if (rel) directories.push(rel);
      if (directories.length > 10000) throw new Error('Too many folders; copy a smaller folder.');
      const names: string[] = [];
      for await (const entry of await fs.opendir(file)) {
        if (names.length >= 10000) throw new Error('Too many entries; copy a smaller folder.');
        names.push(entry.name);
      }
      for (const name of names.sort()) await walk(path.join(file, name), rel ? `${rel}/${name}` : name);
      return;
    }
    if (!st.isFile()) throw new Error('Only regular files and folders can be copied.');
    if (out.length >= 10000) throw new Error('Too many files; copy a smaller folder.');
    out.push({ path: file, rel });
  }
  await walk(root, ''); return { files: out, directories };
}
export async function inspectArtifactCopy(cwd: string, workflowId: string, itemPath: string, destinationFolder: string, declaredPublic: boolean): Promise<CopyInspection> {
  const rel = normalizeKeepPath(itemPath);
  if (!rel || (rel !== 'artifacts' && !rel.startsWith('artifacts/'))) throw new Error('Choose an artifact file or folder.');
  const dir = await fs.realpath(await outputDirectory(cwd, workflowId)); let source = dir;
  for (const part of rel.split('/')) { source = path.join(source, part); const st = await fs.lstat(source); if (st.isSymbolicLink()) throw new Error('Artifact links cannot be copied.'); }
  source = await fs.realpath(source);
  if (!isPathWithin(path.join(dir, 'artifacts'), source)) throw new Error('Artifact path changed; review it again.');
  const project = await fs.realpath(safeDirectory(cwd));
  const folder = await fs.realpath(confinedPath(destinationFolder, [cwd], 'directory'));
  const target = path.join(folder, path.basename(source));
  assertSafePath(target);
  if (!isPathWithin(project, target) || target.split(path.sep).includes('.arco')) throw new Error('Choose a project folder outside Arco state.');
  try { await fs.lstat(target); throw new Error('The destination already exists.'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const listed = await listSource(source); const files: FileEntry[] = []; let findingCount = 0; let ignored = listed.files.length ? true : await gitIgnored(project, target);
  for (const f of listed.files) {
    const dest = f.rel ? path.join(target, ...f.rel.split('/')) : target;
    assertSafePath(dest);
    ignored = await gitIgnored(project, dest) && ignored;
    await ensureNoLinks(source, f.rel);
    // Past the total limit, later files are hashed but not scanned and are
    // listed as not fully scanned.
    const scanned = await scanFile(f.path, f.rel || path.basename(source), Math.min(MAX_FILE_FINDINGS, MAX_TOTAL_FINDINGS - findingCount));
    findingCount += scanned.findings.length;
    files.push(scanned);
    await ensureNoLinks(source, f.rel);
  }
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  const publicRepository = declaredPublic || (await suggestFromRemote(project)).state === 'public';
  const directories = listed.directories;
  for (const rel of directories) assertSafePath(path.join(target, ...rel.split('/')));
  const token = createHash('sha256').update(JSON.stringify({ source, target, ignored, publicRepository, files, directories })).digest('hex');
  return { source, target, bytes, ignored, publicRepository, files, directories, token };
}

// Re-scan immediately before copying and require an unchanged review token.
// Each destination is exclusively created; source bytes are checked against
// the preflight hash before success is reported. Originals are never removed.
export async function copyReviewedArtifact(cwd: string, workflowId: string, itemPath: string, destinationFolder: string, declaredPublic: boolean, token: string, beforePublish?: (index: number) => Promise<void>, confirmUnscanned = false): Promise<CopyInspection> {
  const check = await inspectArtifactCopy(cwd, workflowId, itemPath, destinationFolder, declaredPublic);
  if (!token || token !== check.token) throw new Error('The artifact or destination changed. Review it again.');
  if (!check.ignored && check.publicRepository && check.files.some((file) => file.unscanned) && !confirmUnscanned) throw new Error('Confirm the files that were not scanned before copying into a public repository.');
  if (!check.ignored && check.bytes > 100 * MB) throw new Error('Over 100 MB cannot be copied into a folder included in Git. Choose an ignored folder.');
  const sourceInfo = await fs.lstat(check.source);
  const tempRoot = await fs.realpath(tmpdir());
  if (isPathWithin(await fs.realpath(safeDirectory(cwd)), tempRoot)) throw new Error('The temporary folder must be outside the project.');
  for (let ancestor = tempRoot; ;) {
    try { await fs.lstat(path.join(ancestor, '.git')); throw new Error('The temporary folder must be outside Git repositories.'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  const temp = await fs.mkdtemp(path.join(tempRoot, 'arco-reviewed-copy-'));
  let published = false;
  try {
    // Stage outside the project in a private temporary directory. Only the
    // exact bytes reviewed above can be published, even if a worker edits the
    // artifact while it is being read.
    for (let i = 0; i < check.files.length; i++) {
      const entry = check.files[i];
      const rel = sourceInfo.isDirectory() ? entry.rel : '';
      const inputPath = rel ? path.join(check.source, ...rel.split('/')) : check.source;
      await ensureNoLinks(check.source, rel);
      const input = await fs.open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const st = await input.stat();
        if (!st.isFile() || st.size !== entry.bytes) throw new Error('The artifact changed. Review it again.');
        const output = await fs.open(path.join(temp, String(i)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          const hash = createHash('sha256');
          for await (const chunk of createReadStream('', { fd: input.fd, autoClose: false, emitClose: false })) { hash.update(chunk as Buffer); await output.writeFile(chunk as Buffer); }
          if (hash.digest('hex') !== entry.hash) throw new Error('The artifact changed. Review it again.');
          await ensureNoLinks(check.source, rel);
          await output.sync();
        } finally { await output.close(); }
      } finally { await input.close(); }
    }
    let ignored = check.files.length ? true : await gitIgnored(cwd, check.target);
    for (const entry of check.files) {
      const dest = sourceInfo.isDirectory() ? path.join(check.target, ...entry.rel.split('/')) : check.target;
      ignored = await gitIgnored(cwd, dest) && ignored;
    }
    if (ignored !== check.ignored) throw new Error('Git ignore status changed. Review again.');
    if (!ignored && check.bytes > 100 * MB) throw new Error('Over 100 MB cannot be copied into a folder included in Git. Choose an ignored folder.');
    const isPublic = declaredPublic || (await suggestFromRemote(cwd)).state === 'public';
    if (isPublic !== check.publicRepository) throw new Error('Repository visibility changed. Review again.');
    if (await fs.realpath(path.dirname(check.target)) !== path.dirname(check.target)) throw new Error('Destination folder changed.');
    if (sourceInfo.isDirectory()) { await fs.mkdir(check.target); published = true; }
    for (const rel of check.directories) await fs.mkdir(path.join(check.target, ...rel.split('/')));
    for (let i = 0; i < check.files.length; i++) {
      const entry = check.files[i];
      const outputPath = sourceInfo.isDirectory() ? path.join(check.target, ...entry.rel.split('/')) : check.target;
      await beforePublish?.(i);
      if (await fs.realpath(path.dirname(outputPath)) !== path.dirname(outputPath)) throw new Error('Destination folder changed.');
      const output = await fs.open(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      published = true;
      try {
        const opened = await output.stat(); const target = await fs.lstat(outputPath);
        if (!opened.isFile() || target.isSymbolicLink() || opened.dev !== target.dev || opened.ino !== target.ino || await fs.realpath(outputPath) !== outputPath) throw new Error('Destination folder changed.');
        const input = await fs.open(path.join(temp, String(i)), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { for await (const chunk of createReadStream('', { fd: input.fd, autoClose: false, emitClose: false })) await output.writeFile(chunk as Buffer); }
        finally { await input.close(); }
        await output.sync();
      } finally { await output.close(); }
    }
    return check;
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Copy failed.';
    throw new Error(published ? `${detail} Some copied files may remain; the original stays in Arco.` : detail);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

// Append one literal root-relative rule. Never replace an edited ignore file.
export async function ignoreCopyDestination(cwd: string, target: string): Promise<void> {
  const project = await fs.realpath(safeDirectory(cwd));
  if (!isPathWithin(project, target) || target === project) throw new Error('Choose a destination inside this project.');
  try { await gitCall(project, ['rev-parse', '--is-inside-work-tree']); }
  catch { throw new Error('This project is not a Git repository.'); }
  const rel = path.relative(project, target).split(path.sep).join('/');
  if (/[\r\n\0]/.test(rel)) throw new Error('This filename cannot be written to .gitignore.');
  const rule = '/' + rel.replace(/([\\*?\[\] ])/g, '\\$1');
  const ignore = path.join(project, '.gitignore');
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try { handle = await fs.open(ignore, flags); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; handle = await fs.open(ignore, flags | constants.O_CREAT | constants.O_EXCL, 0o600); }
  try {
    const opened = await handle.stat();
    const current = await fs.lstat(ignore);
    if (!opened.isFile() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino || opened.size > MiB) throw new Error('The project ignore file cannot be edited.');
    let prefix = '';
    if (opened.size) {
      const reader = await fs.open(ignore, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const last = Buffer.alloc(1); await reader.read(last, 0, 1, opened.size - 1); if (last[0] !== 10) prefix = '\n'; }
      finally { await reader.close(); }
    }
    const content = Buffer.from(`${prefix}${rule}\n`);
    const result = await handle.write(content);
    if (result.bytesWritten !== content.length) throw new Error('The ignore rule was only partially written. Review .gitignore.');
    await handle.sync();
  } finally { await handle.close(); }
}

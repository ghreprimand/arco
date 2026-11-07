import { getPublicProjectChoice } from './publicProjectChoice.js';
// P8.6 Skill management: IMPORT (GitHub link, local folder, zip), UPDATE with
// a per-file diff, ON/OFF, MOVE between project and global, DUPLICATE, the
// files and missing skill references of a skill, and SHARE WITH REPOSITORY.
// Nothing is fetched or written until the operator acts. Imports are staged in
// memory, checked (limits, paths, the skill audit on every text file) and
// written only on confirm. Arco ships no third-party skills.

import { readFileVersion } from './fileVersion.js';
import { withSkillMutation } from './skillMutation.js';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { auditSkillContent, type AuditFinding } from './skillAudit.js';
import {
  BODY_MAX, DESCRIPTION_MAX, NAME_MAX, SKILL_SIDECAR, isValidSlug, listBuiltinSkills, listSkills, parseSkillFile, readSkillSidecar,
  renderSkillFile, rootForScope, slugify, skillSlugCandidate, type SkillScope, type SkillSidecar, type StoredSkillSource,
} from './skills.js';
import { appendShareBlock, ensureProjectStateIgnore, skillShareLines } from './projectStateIgnore.js';
import { projectGitEnv, suggestFromRemote } from './publicProject.js';

const run = promisify(execFile);
export const IMPORT_LIMITS = { files: 64, totalBytes: 2 * 1024 * 1024, fileBytes: 512 * 1024, depth: 6, zipBytes: 8 * 1024 * 1024 } as const;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,99}$/;
const STAGE_TTL_MS = 15 * 60 * 1000;
const MAX_STAGED = 10;

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; url?: string; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>;
export type ImportSource = { kind: 'github'; url: string } | { kind: 'folder'; path: string } | { kind: 'zip'; name: string; data: Buffer };

interface Tree { files: Map<string, Buffer>; skipped: string[] }
export interface PreviewFile { path: string; bytes: number; text: boolean; findings: AuditFinding[] }
export interface ImportPreview { token: string; name: string; description: string; operatorOnly: boolean; files: PreviewFile[]; skipped: string[]; source: StoredSkillSource; findingCount: number }
interface Staged { kind: 'import' | 'update'; files: Map<string, Buffer>; source: StoredSkillSource; name: string; expires: number; target?: { scope: SkillScope; slug: string; cwd: string }; installedRevision?: string }
const staged = new Map<string, Staged>();

function stage(entry: Omit<Staged, 'expires'>): string {
  const now = Date.now();
  for (const [k, v] of staged) if (v.expires < now) staged.delete(k);
  while (staged.size >= MAX_STAGED) staged.delete(staged.keys().next().value as string);
  const token = randomBytes(16).toString('hex');
  staged.set(token, { ...entry, expires: now + STAGE_TTL_MS });
  return token;
}
function takeStaged(token: string, kind: Staged['kind']): Staged {
  const s = staged.get(token);
  if (!s || s.kind !== kind || s.expires < Date.now()) throw new Error('The review expired or is unknown. Review the skill again.');
  staged.delete(token);
  return s;
}

// --- paths and limits -------------------------------------------------------

export function safeRelative(raw: string): string | null {
  const rel = raw.replace(/^\.\//, '');
  if (!rel || rel.includes('\\') || rel.includes('\0') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.length > IMPORT_LIMITS.depth || parts.some((p) => !SEGMENT.test(p) || p === '.' || p === '..')) return null;
  return parts.join('/');
}

function isText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}

// Finds the skill folder in a collected tree (SKILL.md at the top, or inside a
// single top-level folder), then checks every path and the limits.
export function normalizeTree(input: Map<string, Buffer>, skippedIn: string[] = []): Tree {
  const skipped = [...skippedIn];
  let root = '';
  if (!input.has('SKILL.md')) {
    const skillFiles = [...input.keys()].filter((p) => p === 'SKILL.md' || p.endsWith('/SKILL.md'));
    const tops = new Set([...input.keys()].map((p) => p.split('/')[0]));
    if (skillFiles.length === 1 && tops.size === 1 && skillFiles[0] === `${[...tops][0]}/SKILL.md`) root = `${[...tops][0]}/`;
    else if (skillFiles.length > 1) throw new Error(`This source holds several skills (${skillFiles.slice(0, 4).join(', ')}). Import one skill folder.`);
    else throw new Error('No SKILL.md was found at the top of the source.');
  }
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const [raw, data] of input) {
    if (!raw.startsWith(root)) { skipped.push(raw); continue; }
    const inner = raw.slice(root.length);
    const name = inner.split('/').pop() ?? '';
    if (inner.split('/').some((p) => p === '.' || p === '..')) throw new Error(`Refused path in the source: ${inner.slice(0, 120)}`);
    if (inner.split('/').some((p) => p.startsWith('.'))) { skipped.push(inner); continue; }
    const rel = safeRelative(inner);
    if (!rel) throw new Error(`Refused path in the source: ${inner.slice(0, 120)}`);
    if (!name) continue;
    if (data.length > IMPORT_LIMITS.fileBytes) throw new Error(`${rel} is larger than ${IMPORT_LIMITS.fileBytes / 1024} KB.`);
    total += data.length;
    if (total > IMPORT_LIMITS.totalBytes) throw new Error(`The skill is larger than ${IMPORT_LIMITS.totalBytes / 1024 / 1024} MB in total.`);
    files.set(rel, data);
    if (files.size > IMPORT_LIMITS.files) throw new Error(`The skill has more than ${IMPORT_LIMITS.files} files.`);
  }
  return { files, skipped };
}

function describe(tree: Tree): { name: string; description: string; operatorOnly: boolean } {
  const skill = tree.files.get('SKILL.md');
  if (!skill || !isText(skill)) throw new Error('SKILL.md is missing or not text.');
  const parsed = parseSkillFile(skill.toString('utf8'));
  const name = (parsed.name ?? '').trim();
  if (!name) throw new Error('SKILL.md has no name in its frontmatter.');
  if (name.length > NAME_MAX) throw new Error(`The skill name is longer than ${NAME_MAX} characters.`);
  if ((parsed.description ?? '').length > DESCRIPTION_MAX) throw new Error(`The description is longer than ${DESCRIPTION_MAX} characters.`);
  if (parsed.body.length > BODY_MAX) throw new Error(`SKILL.md is longer than ${BODY_MAX / 1024} KB.`);
  return { name, description: (parsed.description ?? '').trim(), operatorOnly: !!parsed.operatorOnly };
}

// The audit's findings for one text file, without its "clean" note.
function auditFile(data: Buffer): AuditFinding[] {
  return auditSkillContent(data.toString('utf8')).findings.filter((f) => f.kind !== 'clean');
}

function previewFiles(files: Map<string, Buffer>): { list: PreviewFile[]; findingCount: number } {
  let findingCount = 0;
  const list = [...files].sort(([a], [b]) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b))).map(([p, data]) => {
    const text = isText(data);
    const findings = text ? auditFile(data) : [];
    findingCount += findings.length;
    return { path: p, bytes: data.length, text, findings };
  });
  return { list, findingCount };
}

// --- sources ----------------------------------------------------------------

export async function collectFromFolder(dir: string): Promise<Tree> {
  if (!path.isAbsolute(dir)) throw new Error('Choose a folder by its full path.');
  const root = await fs.realpath(dir);
  if (!(await fs.lstat(root)).isDirectory()) throw new Error('Choose a folder.');
  const files = new Map<string, Buffer>(); const skipped: string[] = [];
  let total = 0;
  async function walk(rel: string, depth: number): Promise<void> {
    if (depth > IMPORT_LIMITS.depth) throw new Error('The folder is nested too deeply.');
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith('.')) { skipped.push(child); continue; }
      if (e.isSymbolicLink()) throw new Error(`The folder contains a link (${child}); links are not imported.`);
      if (e.isDirectory()) { await walk(child, depth + 1); continue; }
      if (!e.isFile()) { skipped.push(child); continue; }
      const st = await fs.lstat(path.join(root, child));
      if (st.size > IMPORT_LIMITS.fileBytes) throw new Error(`${child} is larger than ${IMPORT_LIMITS.fileBytes / 1024} KB.`);
      total += st.size;
      if (total > IMPORT_LIMITS.totalBytes || files.size >= IMPORT_LIMITS.files) throw new Error('The folder is larger than a skill may be.');
      const fh = await fs.open(path.join(root, child), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { files.set(child, await fh.readFile()); } finally { await fh.close(); }
    }
  }
  await walk('', 1);
  return { files, skipped };
}

// A small reader for zip files: stored and deflated entries, no encryption,
// no zip64, no links. Sizes are checked against the central directory and the
// inflated data.
export function readZip(data: Buffer): Tree {
  if (data.length > IMPORT_LIMITS.zipBytes) throw new Error(`The zip file is larger than ${IMPORT_LIMITS.zipBytes / 1024 / 1024} MB.`);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This is not a zip file.');
  const count = data.readUInt16LE(eocd + 10);
  let at = data.readUInt32LE(eocd + 16);
  if (count > 4 * IMPORT_LIMITS.files) throw new Error('The zip file has too many entries.');
  const files = new Map<string, Buffer>(); const skipped: string[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) throw new Error('The zip file is damaged.');
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10);
    const csize = data.readUInt32LE(at + 20), usize = data.readUInt32LE(at + 24);
    const nameLen = data.readUInt16LE(at + 28), extraLen = data.readUInt16LE(at + 30), commentLen = data.readUInt16LE(at + 32);
    const attrs = data.readUInt32LE(at + 38), local = data.readUInt32LE(at + 42);
    const name = data.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (name.startsWith('__MACOSX/')) { skipped.push(name); continue; }
    if (flags & 1) throw new Error('Encrypted zip files are not supported.');
    if (((attrs >>> 16) & 0o170000) === 0o120000) throw new Error(`The zip file contains a link (${name}); links are not imported.`);
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error('Zip64 files are not supported.');
    if (usize > IMPORT_LIMITS.fileBytes) throw new Error(`${name} is larger than ${IMPORT_LIMITS.fileBytes / 1024} KB.`);
    total += usize;
    if (total > IMPORT_LIMITS.totalBytes) throw new Error('The zip file holds more than a skill may be.');
    if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) throw new Error('The zip file is damaged.');
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const body = data.subarray(start, start + csize);
    let out: Buffer;
    if (method === 0) out = Buffer.from(body);
    else if (method === 8) out = inflateRawSync(body, { maxOutputLength: IMPORT_LIMITS.fileBytes + 1 });
    else throw new Error(`Zip compression method ${method} is not supported.`);
    if (out.length !== usize) throw new Error('The zip file is damaged.');
    files.set(name, out);
  }
  return { files, skipped };
}

interface GitHubRef { owner: string; repo: string; ref: string; path: string; url: string }
export function parseGitHubUrl(raw: string): GitHubRef {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new Error('Enter a GitHub link to a skill folder or its SKILL.md.'); }
  if (u.protocol !== 'https:') throw new Error('Only https GitHub links are supported.');
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const valid = (s: string | undefined) => !!s && /^[A-Za-z0-9_.-]{1,100}$/.test(s);
  let ref: GitHubRef;
  if (u.hostname === 'github.com') {
    const [owner, repo, kind, branch, ...rest] = parts;
    if (!valid(owner) || !valid(repo?.replace(/\.git$/, ''))) throw new Error('Enter a GitHub link to a skill folder or its SKILL.md.');
    if (kind && kind !== 'tree' && kind !== 'blob') throw new Error('Link to a folder (…/tree/…) or a SKILL.md (…/blob/…).');
    ref = { owner, repo: repo.replace(/\.git$/, ''), ref: branch ?? 'HEAD', path: rest.join('/'), url: u.toString() };
  } else if (u.hostname === 'raw.githubusercontent.com') {
    const [owner, repo, branch, ...rest] = parts;
    if (!valid(owner) || !valid(repo) || !branch) throw new Error('Enter a GitHub link to a skill folder or its SKILL.md.');
    ref = { owner, repo, ref: branch, path: rest.join('/'), url: u.toString() };
  } else throw new Error('Only github.com and raw.githubusercontent.com links are supported.');
  if (/(^|\/)SKILL\.md$/.test(ref.path)) ref.path = ref.path.replace(/\/?SKILL\.md$/, '');
  if (ref.path && !safeRelative(ref.path)) throw new Error('The link has an unsupported path.');
  if (!/^[A-Za-z0-9_.\/-]{1,200}$/.test(ref.ref)) throw new Error('The link has an unsupported branch or tag.');
  return ref;
}

const GH_HEADERS = { 'User-Agent': 'arco-skill-import', Accept: 'application/vnd.github+json' };
async function getJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { headers: GH_HEADERS, signal: AbortSignal.timeout(15000) });
  if (res.status === 404) throw new Error('GitHub could not find that repository, branch or folder (private repositories are not supported).');
  if (res.status === 403 || res.status === 429) throw new Error('GitHub refused the request (rate limit). Try again later.');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  return res.json();
}

export async function collectFromGitHub(raw: string, fetchImpl: FetchLike): Promise<{ tree: Tree; source: StoredSkillSource }> {
  const gh = parseGitHubUrl(raw);
  const api = `https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}`;
  const commit = (await getJson(fetchImpl, `${api}/commits/${encodeURIComponent(gh.ref)}`) as { sha?: unknown }).sha;
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('GitHub did not return a commit for that branch or tag.');
  const files = new Map<string, Buffer>(); const skipped: string[] = [];
  let total = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > IMPORT_LIMITS.depth) throw new Error('The folder is nested too deeply.');
    const listing = await getJson(fetchImpl, `${api}/contents/${dir.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`);
    if (!Array.isArray(listing)) throw new Error('The link points to a file; link the skill folder or its SKILL.md.');
    for (const item of listing as Array<{ type?: string; path?: string; name?: string; size?: number; download_url?: string }>) {
      const rel = (item.path ?? '').slice(gh.path ? gh.path.length + 1 : 0);
      if (!rel || (item.name ?? '').startsWith('.')) { if (rel) skipped.push(rel); continue; }
      if (item.type === 'dir') { await walk(item.path ?? '', depth + 1); continue; }
      if (item.type !== 'file') { skipped.push(rel); continue; }
      if ((item.size ?? 0) > IMPORT_LIMITS.fileBytes) throw new Error(`${rel} is larger than ${IMPORT_LIMITS.fileBytes / 1024} KB.`);
      total += item.size ?? 0;
      if (total > IMPORT_LIMITS.totalBytes || files.size >= IMPORT_LIMITS.files) throw new Error('The folder is larger than a skill may be.');
      const dl = new URL(item.download_url ?? '');
      if (dl.protocol !== 'https:' || dl.hostname !== 'raw.githubusercontent.com') throw new Error('GitHub returned an unexpected download address.');
      const res = await fetchImpl(dl.toString(), { headers: { 'User-Agent': GH_HEADERS['User-Agent'] }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Could not download ${rel} (${res.status}).`);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > IMPORT_LIMITS.fileBytes) throw new Error(`${rel} is larger than ${IMPORT_LIMITS.fileBytes / 1024} KB.`);
      files.set(rel, data);
    }
  }
  await walk(gh.path, 1);
  return { tree: { files, skipped }, source: { kind: 'github', url: gh.url, owner: gh.owner, repo: gh.repo, ref: gh.ref, path: gh.path, commit } };
}

async function collect(source: ImportSource, fetchImpl: FetchLike): Promise<{ tree: Tree; stored: StoredSkillSource }> {
  if (source.kind === 'github') { const r = await collectFromGitHub(source.url, fetchImpl); return { tree: normalizeTree(r.tree.files, r.tree.skipped), stored: r.source }; }
  if (source.kind === 'folder') { const r = await collectFromFolder(source.path); return { tree: normalizeTree(r.files, r.skipped), stored: { kind: 'folder', path: await fs.realpath(source.path) } }; }
  const r = readZip(source.data);
  return { tree: normalizeTree(r.files, r.skipped), stored: { kind: 'zip', name: path.basename(source.name).slice(0, 200) } };
}

// --- import -----------------------------------------------------------------

export async function previewImport(source: ImportSource, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<ImportPreview> {
  const { tree, stored } = await collect(source, fetchImpl);
  const meta = describe(tree);
  const { list, findingCount } = previewFiles(tree.files);
  const token = stage({ kind: 'import', files: tree.files, source: stored, name: meta.name });
  return { token, ...meta, files: list, skipped: tree.skipped, source: stored, findingCount };
}

async function skillDir(scope: SkillScope, slug: string, cwd: string): Promise<string> {
  if (!isValidSlug(slug)) throw new Error('Unknown skill.');
  const root = rootForScope(scope, cwd);
  const dir = path.join(root, slug);
  const st = await fs.lstat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('Unknown skill.');
  return dir;
}

async function freeSlug(root: string, base: string): Promise<string> {
  for (let n = 1; n <= 10000; n++) {
    const candidate = skillSlugCandidate(base, n);
    try { await fs.lstat(path.join(root, candidate)); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw err;
    }
  }
  throw new Error('No free skill name was found. Choose another name.');
}

// Writes a skill folder next to its final place, then renames it in. Files get
// mode 0644 and folders 0755: no executable bits.
async function writeFolder(root: string, slug: string, files: Map<string, Buffer>, sidecar: SkillSidecar): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const temp = path.join(root, `.incoming-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(temp, { mode: 0o755 });
  try {
    for (const [rel, data] of files) {
      const target = path.join(temp, ...rel.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await fs.writeFile(target, data, { mode: 0o644, flag: 'wx' });
      await fs.chmod(target, 0o644);
    }
    if (Object.keys(sidecar).length) await fs.writeFile(path.join(temp, SKILL_SIDECAR), `${JSON.stringify(sidecar, null, 2)}\n`, { mode: 0o644 });
    const dest = path.join(root, slug);
    await fs.rename(temp, dest);
    return dest;
  } catch (err) { await fs.rm(temp, { recursive: true, force: true }); throw err; }
}

export async function confirmImport(token: string, scope: SkillScope, cwd: string): Promise<{ scope: SkillScope; slug: string; name: string }> {
  return withSkillMutation(async () => {
  const s = takeStaged(token, 'import');
  const root = rootForScope(scope, cwd);
  if (scope === 'project') ensureProjectStateIgnore(cwd);
  const slug = await freeSlug(root, slugify(s.name));
  await writeFolder(root, slug, s.files, { source: s.source, importedAt: Date.now() });
  return { scope, slug, name: s.name };
  });
}

// --- update -----------------------------------------------------------------

async function readFolderFiles(dir: string): Promise<Map<string, Buffer>> {
  const r = await collectFromFolder(dir);
  r.files.delete(SKILL_SIDECAR);
  return r.files;
}

// Include hidden files, sidecars, empty folders and links in the installed
// revision. Import collection intentionally skips some of these; replacement
// must still refuse to discard a later local change to any of them.
async function installedRevision(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (folder: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name, file = path.join(folder, entry.name);
      hash.update(JSON.stringify(relative));
      if (entry.isDirectory()) { hash.update('directory'); await walk(file, relative + '/'); }
      else if (entry.isSymbolicLink()) { hash.update('link'); hash.update(await fs.readlink(file)); }
      else if (entry.isFile()) {
        const version = await readFileVersion(file);
        hash.update(JSON.stringify([version.signature, version.sha256]));
      } else throw new Error('The installed skill contains an unsupported file. Review it before updating.');
    }
  };
  await walk(dir, '');
  return hash.digest('hex');
}

export interface UpdateFile { path: string; status: 'added' | 'removed' | 'changed' | 'unchanged'; text: boolean; before?: string; after?: string; findings: AuditFinding[] }
export interface UpdatePreview { token: string; name: string; files: UpdateFile[]; changed: boolean; source: StoredSkillSource; findingCount: number }

export async function previewUpdate(scope: SkillScope, slug: string, cwd: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<UpdatePreview> {
  return withSkillMutation(async () => {
  const dir = await skillDir(scope, slug, cwd);
  const side = await readSkillSidecar(dir);
  if (!side.source || side.source.kind === 'zip') throw new Error('This skill was not imported from a GitHub link or a folder, so there is nothing to update from.');
  const from: ImportSource = side.source.kind === 'github' ? { kind: 'github', url: side.source.url } : { kind: 'folder', path: side.source.path };
  const { tree, stored } = await collect(from, fetchImpl);
  const meta = describe(tree);
  const revision = await installedRevision(dir);
  const current = await readFolderFiles(dir);
  const names = [...new Set([...current.keys(), ...tree.files.keys()])].sort();
  let findingCount = 0;
  const files: UpdateFile[] = names.map((p) => {
    const a = current.get(p), b = tree.files.get(p);
    const text = (!a || isText(a)) && (!b || isText(b));
    const status: UpdateFile['status'] = !a ? 'added' : !b ? 'removed' : a.equals(b) ? 'unchanged' : 'changed';
    const findings = b && isText(b) ? auditFile(b) : [];
    findingCount += findings.length;
    return { path: p, status, text, ...(text && status !== 'unchanged' ? { before: a?.toString('utf8') ?? '', after: b?.toString('utf8') ?? '' } : {}), findings };
  });
  if (await installedRevision(dir) !== revision) throw new Error('The installed skill changed during preview. Review the update again.');
  const token = stage({ kind: 'update', installedRevision: revision, files: tree.files, source: stored, name: meta.name, target: { scope, slug, cwd } });
  return { token, name: meta.name, files, changed: files.some((f) => f.status !== 'unchanged'), source: stored, findingCount };
  });
}

// Replaces the skill folder with the reviewed files. The off state stays.
export async function confirmUpdate(token: string): Promise<{ scope: SkillScope; slug: string }> {
  return withSkillMutation(async () => {
  const s = takeStaged(token, 'update');
  const { scope, slug, cwd } = s.target!;
  const dir = await skillDir(scope, slug, cwd);
  const side = await readSkillSidecar(dir);
  if (await installedRevision(dir) !== s.installedRevision) throw new Error('The installed skill changed since preview. Review the update again.');
  const root = path.dirname(dir);
  const old = path.join(root, `.replaced-${randomBytes(6).toString('hex')}`);
  const tempSlug = `.updating-${randomBytes(6).toString('hex')}`;
  await writeFolder(root, tempSlug, s.files, { ...side, source: s.source, updatedAt: Date.now() });
  if (await installedRevision(dir) !== s.installedRevision) {
    await fs.rm(path.join(root, tempSlug), { recursive: true, force: true });
    throw new Error('The installed skill changed since preview. Review the update again.');
  }
  await fs.rename(dir, old);
  try { await fs.rename(path.join(root, tempSlug), dir); }
  catch (err) { await fs.rename(old, dir); await fs.rm(path.join(root, tempSlug), { recursive: true, force: true }); throw err; }
  await fs.rm(old, { recursive: true, force: true });
  return { scope, slug };
  });
}

// --- on/off, move, duplicate --------------------------------------------------

export async function setSkillOff(scope: SkillScope, slug: string, cwd: string, off: boolean): Promise<void> {
  return withSkillMutation(async () => {
  const dir = await skillDir(scope, slug, cwd);
  const side = await readSkillSidecar(dir);
  const next: SkillSidecar = { ...side };
  if (off) next.off = true; else delete next.off;
  const file = path.join(dir, SKILL_SIDECAR);
  if (!Object.keys(next).length) { await fs.rm(file, { force: true }); return; }
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
  await fs.rename(tmp, file);
  });
}

export async function moveSkill(scope: SkillScope, slug: string, cwd: string, to: SkillScope): Promise<{ scope: SkillScope; slug: string }> {
  return withSkillMutation(async () => {
  if (scope === to) throw new Error('The skill is already there.');
  const dir = await skillDir(scope, slug, cwd);
  const files = await readFolderFiles(dir);
  const side = await readSkillSidecar(dir);
  const root = rootForScope(to, cwd);
  if (to === 'project') ensureProjectStateIgnore(cwd);
  const nextSlug = await freeSlug(root, slug);
  await writeFolder(root, nextSlug, files, side);
  await fs.rm(dir, { recursive: true, force: true });
  return { scope: to, slug: nextSlug };
  });
}

export async function duplicateSkill(scope: SkillScope, slug: string, cwd: string, name: string): Promise<{ scope: SkillScope; slug: string; name: string }> {
  return withSkillMutation(async () => {
  const clean = name.trim();
  if (!clean || clean.length > NAME_MAX) throw new Error(`Give a name of 1 to ${NAME_MAX} characters.`);
  const dir = await skillDir(scope, slug, cwd);
  const files = await readFolderFiles(dir);
  const parsed = parseSkillFile((files.get('SKILL.md') ?? Buffer.alloc(0)).toString('utf8'));
  files.set('SKILL.md', Buffer.from(renderSkillFile(clean, parsed.description ?? '', parsed.body, parsed.operatorOnly)));
  const root = rootForScope(scope, cwd);
  const nextSlug = await freeSlug(root, slugify(clean));
  // A duplicate is the operator's own starting point: no import source.
  await writeFolder(root, nextSlug, files, {});
  return { scope, slug: nextSlug, name: clean };
  });
}

// --- contents and needs -------------------------------------------------------

const REF_PATTERNS = [
  /\b(?:the|use|using|run|invoke|load|see|with|apply|call)\s+(?:the\s+)?[`"']?([a-z0-9][a-z0-9-]{2,63})[`"']?\s+skill\b/gi,
  /\bskills\/([a-z0-9][a-z0-9-]{2,63})\b/gi,
  /\bskill[:\s]+[`"']([a-z0-9][a-z0-9-]{2,63})[`"']/gi,
];
const NOT_NAMES = new Set(['this', 'that', 'the', 'same', 'other', 'each', 'every', 'any', 'new', 'one', 'your', 'our', 'operator', 'arco']);

// Skill names the text refers to (by the patterns above) that are not
// installed in either scope and not built in.
export function missingSkillRefs(body: string, installed: Set<string>): string[] {
  const out = new Set<string>();
  for (const re of REF_PATTERNS) for (const m of body.matchAll(re)) {
    const ref = m[1].toLowerCase();
    if (!NOT_NAMES.has(ref) && !installed.has(ref)) out.add(ref);
  }
  return [...out].sort();
}

export interface SkillDetails { scope: SkillScope; slug: string; files: Array<{ path: string; bytes: number }>; missing: string[] }
export async function skillDetails(cwd: string): Promise<SkillDetails[]> {
  const catalog = await listSkills(cwd);
  const installed = new Set<string>();
  for (const s of [...catalog.project, ...catalog.global, ...listBuiltinSkills()]) { installed.add(s.slug); installed.add(slugify(s.name)); }
  const out: SkillDetails[] = [];
  for (const s of [...catalog.project, ...catalog.global]) {
    const dir = path.dirname(s.path);
    const files: SkillDetails['files'] = [];
    try {
      const r = await collectFromFolder(dir);
      for (const [p, data] of r.files) if (p !== 'SKILL.md' && p !== SKILL_SIDECAR) files.push({ path: p, bytes: data.length });
    } catch { /* too large or unreadable: no file list */ }
    let body = '';
    try { body = parseSkillFile(await fs.readFile(s.path, 'utf8')).body; } catch { /* unreadable */ }
    out.push({ scope: s.scope, slug: s.slug, files: files.sort((a, b) => a.path.localeCompare(b.path)), missing: missingSkillRefs(body, installed) });
  }
  return out;
}

// --- share with repository ------------------------------------------------------

async function gitIgnored(cwd: string, rel: string): Promise<boolean | null> {
  try { await run('git', ['check-ignore', '-q', '--no-index', '--', rel], { cwd, timeout: 10000, env: projectGitEnv() }); return true; }
  catch (e) { const code = (e as { code?: unknown }).code; return code === 1 ? false : null; }
}

export interface SharePreview { slug: string; files: string[]; alreadyTrackable: boolean; publicRepository: boolean; lines: string[] }

export async function previewShare(cwd: string, slug: string): Promise<SharePreview> {
  const dir = await skillDir('project', slug, cwd);
  const r = await collectFromFolder(dir);
  const files = [...r.files.keys(), ...(await fs.lstat(path.join(dir, SKILL_SIDECAR)).then(() => [SKILL_SIDECAR], () => []))].map((p) => `.arco/skills/${slug}/${p}`).sort();
  const ignore = await fs.readFile(path.join(cwd, '.arco', '.gitignore'), 'utf8').catch(() => '');
  const states = await Promise.all(files.map((f) => gitIgnored(cwd, f)));
  if (states.some((s) => s === null)) throw new Error('This project is not a Git repository, so there is nothing to share.');
  const publicRepository = await getPublicProjectChoice(cwd) === true || (await suggestFromRemote(cwd).catch(() => ({ state: 'unknown' }))).state === 'public';
  return { slug, files, alreadyTrackable: states.every((s) => s === false), publicRepository, lines: skillShareLines(slug, ignore) };
}

// The ignore rule Git applies to `rel`, as text for an error message, or ''.
async function ignoreRule(cwd: string, rel: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['check-ignore', '-v', '--no-index', '--', rel], { cwd, timeout: 10000, env: projectGitEnv() });
    // Output: <source>:<line>:<pattern><TAB><path>
    const hit = /^(.*):(\d+):(.*)\t/.exec(stdout);
    return hit ? ` The rule is in ${hit[1]} line ${hit[2]} (${hit[3]}).` : '';
  } catch { return ''; }
}

const STILL_IGNORED = "Git still ignores the skill's files through another ignore rule.";
const NOTHING_CHANGED = ' Nothing was changed.';

// Adds the exception lines to .arco/.gitignore (never replacing the file) and
// checks with Git that the skill's files are no longer ignored. Arco does not
// stage or commit them. When a rule outside .arco/.gitignore ignores the .arco
// folder itself, Git never reads .arco/.gitignore, so the share is refused
// before anything is written. Any other refusal or error after the write puts
// the file back byte for byte (or removes it if it did not exist).
export async function shareSkill(cwd: string, slug: string): Promise<SharePreview> {
  return withSkillMutation(async () => {
  const before = await previewShare(cwd, slug);
  if (before.alreadyTrackable) return before;
  // `.arco` without a trailing slash: with one, Git also applies the rules of
  // .arco/.gitignore to the folder itself. Git still sees it is a folder.
  if (await gitIgnored(cwd, '.arco')) {
    throw new Error(`${STILL_IGNORED}${await ignoreRule(cwd, '.arco')}${NOTHING_CHANGED}`);
  }
  const file = path.join(cwd, '.arco', '.gitignore');
  const st = await fs.lstat(file).catch(() => null);
  if (st && !st.isFile()) throw new Error('The project state ignore file is not a regular file.');
  const original = st ? await fs.readFile(file) : null;
  const existing = original ? original.toString('utf8') : '';
  const restore = async () => {
    if (original) await fs.writeFile(file, original);
    else await fs.rm(file, { force: true });
  };
  let after: SharePreview;
  try {
    await fs.appendFile(file, appendShareBlock(existing, slug).slice(existing.length));
    after = await previewShare(cwd, slug);
  } catch (err) {
    await restore();
    throw err;
  }
  if (!after.alreadyTrackable) {
    // Name the rule that still applies (for example a deeper .gitignore) so
    // the operator knows where to look, then undo the write.
    const rule = await ignoreRule(cwd, after.files[0]);
    await restore();
    throw new Error(`${STILL_IGNORED}${rule}${NOTHING_CHANGED}`);
  }
  return after;
  });
}

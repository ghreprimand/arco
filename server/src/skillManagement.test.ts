import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, promises as fs, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { linkFile } from './testSupport/links.js';

// P8.6 Skill management: import from a folder, a zip and GitHub (mocked
// network), update with a diff, on/off, move, duplicate, needs, and SHARE
// WITH REPOSITORY.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-skill-mgmt-')));
installIsolatedTestHome(root);
const m = await import('./skillManagement.js');
const skills = await import('./skills.js');
const { DEFAULT_PROJECT_IGNORE } = await import('./projectStateIgnore.js');
const { tryHandleSkillManagementRoutes, _setSkillFetchForTest } = await import('./http/skillManagementRoutes.js');
const { addProject } = await import('./projects.js');
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const ZWSP = String.fromCharCode(0x200b);
const SKILL = (name: string, body = 'Steps for the job.\n') => `---\nname: "${name}"\ndescription: "A fixture skill"\n---\n\n${body}`;
let n = 0;
function project(): string { const cwd = join(root, `project-${++n}`); mkdirSync(cwd, { recursive: true }); return cwd; }
function folder(files: Record<string, string>): string {
  const dir = join(root, `source-${++n}`);
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true }); writeFileSync(join(dir, ...rel.split('/')), text); }
  return dir;
}

function zip(entries: Array<{ name: string; data: string | Buffer; deflate?: boolean; flags?: number; mode?: number }>): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const body = e.deflate ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(e.flags ?? 0, 6); head.writeUInt16LE(e.deflate ? 8 : 0, 8); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(e.flags ?? 0, 8); dir.writeUInt16LE(e.deflate ? 8 : 0, 10); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); dir.writeUInt32LE(offset, 42);
    local.push(head, name, body); central.push(dir, name); offset += 30 + name.length + body.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

test('import from a folder: files listed with sizes, every text file audited, written without exec bits', async () => {
  const src = folder({ 'SKILL.md': SKILL('Release notes'), 'reference/style.md': `Write plainly.${ZWSP}\n`, 'LICENSE': 'Fixture license\n', '.hidden': 'x' });
  if (process.platform !== 'win32') execFileSync('chmod', ['+x', join(src, 'LICENSE')]);
  const cwd = project();
  const preview = await m.previewImport({ kind: 'folder', path: src });
  assert.equal(preview.name, 'Release notes');
  assert.deepEqual(preview.files.map((f) => f.path), ['SKILL.md', 'LICENSE', 'reference/style.md']);
  assert.ok(preview.files.find((f) => f.path === 'reference/style.md')!.findings.length > 0, 'the audit runs over every text file');
  assert.deepEqual(preview.skipped, ['.hidden']);
  const saved = await m.confirmImport(preview.token, 'project', cwd);
  assert.deepEqual(saved, { scope: 'project', slug: 'release-notes', name: 'Release notes' });
  const dir = join(cwd, '.arco', 'skills', 'release-notes');
  assert.equal(readFileSync(join(dir, 'reference', 'style.md'), 'utf8'), `Write plainly.${ZWSP}\n`);
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'LICENSE')).mode & 0o111, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.arco-skill.json'), 'utf8')).source, { kind: 'folder', path: await fs.realpath(src) });
  assert.equal(readFileSync(join(cwd, '.arco', '.gitignore'), 'utf8'), DEFAULT_PROJECT_IGNORE);
  await assert.rejects(m.confirmImport(preview.token, 'project', cwd), /expired or is unknown/);
  // A second import of the same name gets its own folder.
  const again = await m.confirmImport((await m.previewImport({ kind: 'folder', path: src })).token, 'project', cwd);
  assert.equal(again.slug, 'release-notes-2');
});

test('folder import refuses links, missing SKILL.md and oversized skills', async () => {
  const linked = folder({ 'SKILL.md': SKILL('Linked') });
  if (await linkFile(join(linked, 'SKILL.md'), join(linked, 'alias.md'))) await assert.rejects(m.previewImport({ kind: 'folder', path: linked }), /link/);
  await assert.rejects(m.previewImport({ kind: 'folder', path: folder({ 'README.md': 'x' }) }), /No SKILL.md/);
  await assert.rejects(m.previewImport({ kind: 'folder', path: folder({ 'SKILL.md': SKILL('Big'), 'data.txt': 'x'.repeat(600 * 1024) }) }), /larger than 512 KB/);
  const many: Record<string, string> = { 'SKILL.md': SKILL('Many') };
  for (let i = 0; i < 70; i++) many[`f${i}.md`] = 'x';
  await assert.rejects(m.previewImport({ kind: 'folder', path: folder(many) }), /more than|larger than a skill/);
  await assert.rejects(m.previewImport({ kind: 'folder', path: folder({ 'SKILL.md': '---\ndescription: none\n---\nbody' }) }), /no name/);
});

test('import from a zip: one top-level folder, stored and deflated entries; unsafe entries refused', async () => {
  const good = zip([
    { name: 'tidy/', data: '' },
    { name: 'tidy/SKILL.md', data: SKILL('Tidy'), deflate: true },
    { name: 'tidy/notes/extra.md', data: 'Extra notes\n' },
    { name: '__MACOSX/tidy/._SKILL.md', data: 'x' },
  ]);
  const preview = await m.previewImport({ kind: 'zip', name: 'tidy.zip', data: good });
  assert.deepEqual(preview.files.map((f) => f.path), ['SKILL.md', 'notes/extra.md']);
  assert.deepEqual(preview.source, { kind: 'zip', name: 'tidy.zip' });
  const cwd = project();
  await m.confirmImport(preview.token, 'global', cwd);
  assert.ok(existsSync(join(root, 'home', '.arco', 'skills', 'tidy', 'notes', 'extra.md')));
  for (const [name, entries, error] of [
    ['escape', [{ name: 'SKILL.md', data: SKILL('E') }, { name: '../evil.md', data: 'x' }], /Refused path/],
    ['absolute', [{ name: 'SKILL.md', data: SKILL('E') }, { name: '/etc/evil', data: 'x' }], /Refused path/],
    ['backslash', [{ name: 'SKILL.md', data: SKILL('E') }, { name: 'a\\b.md', data: 'x' }], /Refused path/],
    ['several', [{ name: 'a/SKILL.md', data: SKILL('A') }, { name: 'b/SKILL.md', data: SKILL('B') }], /several skills/],
    ['encrypted', [{ name: 'SKILL.md', data: SKILL('E'), flags: 1 }], /Encrypted/],
    ['link', [{ name: 'SKILL.md', data: SKILL('E') }, { name: 'l', data: 'SKILL.md', mode: 0o120777 }], /link/],
  ] as const) await assert.rejects(m.previewImport({ kind: 'zip', name: `${name}.zip`, data: zip(entries as never) }), error, name);
  await assert.rejects(m.previewImport({ kind: 'zip', name: 'x.zip', data: Buffer.from('not a zip') }), /not a zip/);
});

// A fake GitHub: repository fixture/skills at a branch, folder grill.
function github(files: Record<string, string>, commit = 'a'.repeat(40)) {
  const calls: string[] = [];
  const fetchImpl: import('./skillManagement.js').FetchLike = async (url) => {
    calls.push(url);
    const reply = (status: number, value: unknown) => ({ ok: status < 400, status, json: async () => value, text: async () => String(value), arrayBuffer: async () => { const b = Buffer.from(String(value)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
    if (url.startsWith('https://api.github.com/repos/fixture/skills/commits/')) return reply(200, { sha: commit });
    const contents = /^https:\/\/api\.github\.com\/repos\/fixture\/skills\/contents\/(.*)\?ref=([0-9a-f]{40})$/.exec(url);
    if (contents) {
      const dir = decodeURIComponent(contents[1]);
      const entries = new Map<string, { type: string; path: string; name: string; size: number; download_url: string | null }>();
      for (const [p, text] of Object.entries(files)) {
        if (!p.startsWith(`${dir}/`)) continue;
        const rest = p.slice(dir.length + 1).split('/');
        const childPath = `${dir}/${rest[0]}`;
        entries.set(childPath, rest.length > 1 ? { type: 'dir', path: childPath, name: rest[0], size: 0, download_url: null } : { type: 'file', path: p, name: rest[0], size: Buffer.byteLength(text), download_url: `https://raw.githubusercontent.com/fixture/skills/${contents[2]}/${p}` });
      }
      return entries.size ? reply(200, [...entries.values()]) : reply(404, {});
    }
    const raw = /^https:\/\/raw\.githubusercontent\.com\/fixture\/skills\/[0-9a-f]{40}\/(.*)$/.exec(url);
    if (raw && raw[1] in files) return reply(200, files[raw[1]]);
    return reply(404, {});
  };
  return { fetchImpl, calls };
}

test('GitHub links are parsed strictly', () => {
  assert.deepEqual(m.parseGitHubUrl('https://github.com/fixture/skills/tree/main/grill'), { owner: 'fixture', repo: 'skills', ref: 'main', path: 'grill', url: 'https://github.com/fixture/skills/tree/main/grill' });
  assert.equal(m.parseGitHubUrl('https://github.com/fixture/skills/blob/main/grill/SKILL.md').path, 'grill');
  assert.equal(m.parseGitHubUrl('https://raw.githubusercontent.com/fixture/skills/main/grill/SKILL.md').path, 'grill');
  for (const bad of ['http://github.com/a/b', 'https://example.com/a/b', 'https://github.com/a', 'not a url']) assert.throws(() => m.parseGitHubUrl(bad), Error, bad);
});

test('import from GitHub records the commit; UPDATE shows a per-file diff and keeps the off state', async () => {
  const v1 = { 'grill/SKILL.md': SKILL('Grill', 'Ask one question at a time.\n'), 'grill/notes.md': 'Old notes\n', 'grill/gone.md': 'Removed later\n' };
  const first = github(v1);
  const cwd = project();
  const preview = await m.previewImport({ kind: 'github', url: 'https://github.com/fixture/skills/tree/main/grill' }, first.fetchImpl);
  assert.deepEqual(preview.files.map((f) => f.path), ['SKILL.md', 'gone.md', 'notes.md']);
  assert.equal((preview.source as { commit: string }).commit, 'a'.repeat(40));
  assert.ok(first.calls.every((u) => u.startsWith('https://api.github.com/') || u.startsWith('https://raw.githubusercontent.com/')));
  const saved = await m.confirmImport(preview.token, 'project', cwd);
  await m.setSkillOff('project', saved.slug, cwd, true);
  const v2 = github({ 'grill/SKILL.md': SKILL('Grill', 'Ask one question at a time and wait.\n'), 'grill/notes.md': 'Old notes\n', 'grill/new.md': 'New file\n' }, 'b'.repeat(40));
  const update = await m.previewUpdate('project', saved.slug, cwd, v2.fetchImpl);
  assert.deepEqual(update.files.map((f) => [f.path, f.status]), [['SKILL.md', 'changed'], ['gone.md', 'removed'], ['new.md', 'added'], ['notes.md', 'unchanged']]);
  const changed = update.files.find((f) => f.path === 'SKILL.md')!;
  assert.match(changed.before!, /time\.\n$/); assert.match(changed.after!, /and wait\.\n$/);
  await m.confirmUpdate(update.token);
  const dir = join(cwd, '.arco', 'skills', saved.slug);
  assert.equal(existsSync(join(dir, 'gone.md')), false);
  assert.equal(readFileSync(join(dir, 'new.md'), 'utf8'), 'New file\n');
  const side = JSON.parse(readFileSync(join(dir, '.arco-skill.json'), 'utf8'));
  assert.equal(side.off, true);
  assert.equal(side.source.commit, 'b'.repeat(40));
  // Not found on GitHub: a plain message.
  await assert.rejects(m.previewImport({ kind: 'github', url: 'https://github.com/fixture/skills/tree/main/missing' }, first.fetchImpl), /could not find/);
});

test('ON/OFF: an off skill is left out of the manifest and of pins', async () => {
  const cwd = project();
  await skills.writeSkill({ scope: 'project', name: 'Checks', description: 'Run checks', body: 'Run them.' }, cwd);
  const catalog = await skills.listSkills(cwd);
  assert.match(skills.buildSkillsManifest(catalog), /Checks/);
  await m.setSkillOff('project', 'checks', cwd, true);
  const off = await skills.listSkills(cwd);
  assert.equal(off.project[0].off, true);
  assert.doesNotMatch(skills.buildSkillsManifest(off), /Checks/);
  assert.deepEqual((await skills.resolvePinnedSkills([{ scope: 'project', slug: 'checks' }], cwd)).missing, ['project:checks (off)']);
  await m.setSkillOff('project', 'checks', cwd, false);
  assert.equal((await skills.listSkills(cwd)).project[0].off, undefined);
  assert.equal(existsSync(join(cwd, '.arco', 'skills', 'checks', '.arco-skill.json')), false);
});

test('MOVE and DUPLICATE keep every file; a duplicate gets the new name and no source', async () => {
  const cwd = project();
  const imported = await m.confirmImport((await m.previewImport({ kind: 'folder', path: folder({ 'SKILL.md': SKILL('Mover'), 'ref/a.md': 'A\n' }) })).token, 'project', cwd);
  const moved = await m.moveSkill('project', imported.slug, cwd, 'global');
  assert.equal(moved.scope, 'global');
  assert.equal(existsSync(join(cwd, '.arco', 'skills', imported.slug)), false);
  const gdir = join(root, 'home', '.arco', 'skills', moved.slug);
  assert.equal(readFileSync(join(gdir, 'ref', 'a.md'), 'utf8'), 'A\n');
  assert.equal(JSON.parse(readFileSync(join(gdir, '.arco-skill.json'), 'utf8')).source.kind, 'folder');
  const dup = await m.duplicateSkill('global', moved.slug, cwd, 'Mover variant');
  const ddir = join(root, 'home', '.arco', 'skills', dup.slug);
  assert.match(readFileSync(join(ddir, 'SKILL.md'), 'utf8'), /name: "Mover variant"/);
  assert.equal(readFileSync(join(ddir, 'ref', 'a.md'), 'utf8'), 'A\n');
  assert.equal(existsSync(join(ddir, '.arco-skill.json')), false);
  await assert.rejects(m.moveSkill('global', moved.slug, cwd, 'global'), /already there/);
});

test('needs: skill names the text refers to that are not installed', async () => {
  assert.deepEqual(m.missingSkillRefs('First use the grilling skill. Then see skills/release-notes/SKILL.md. Use this skill. Apply skill: "checks".', new Set(['checks'])), ['grilling', 'release-notes']);
  const cwd = project();
  await skills.writeSkill({ scope: 'project', name: 'Planner', description: 'Plans', body: 'Run the grilling skill, then the architecture-review skill.' }, cwd);
  await m.confirmImport((await m.previewImport({ kind: 'folder', path: folder({ 'SKILL.md': SKILL('Extras'), 'docs/a.md': 'A' }) })).token, 'project', cwd);
  const details = await m.skillDetails(cwd);
  const planner = details.find((d) => d.slug === 'planner')!;
  assert.deepEqual(planner.missing, ['grilling']);
  assert.deepEqual(details.find((d) => d.slug === 'extras')!.files, [{ path: 'docs/a.md', bytes: 1 }]);
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' });
const ignored = (cwd: string, rel: string) => { try { git(cwd, 'check-ignore', '-q', '--no-index', '--', rel); return true; } catch { return false; } };

test('SHARE WITH REPOSITORY adds an exception to .arco/.gitignore so only that skill becomes trackable', async () => {
  const cwd = project(); git(cwd, 'init', '-q');
  await skills.writeSkill({ scope: 'project', name: 'Shared', description: 'x', body: 'y' }, cwd);
  await skills.writeSkill({ scope: 'project', name: 'Private', description: 'x', body: 'y' }, cwd);
  const preview = await m.previewShare(cwd, 'shared');
  assert.deepEqual(preview.files, ['.arco/skills/shared/SKILL.md']);
  assert.equal(preview.alreadyTrackable, false);
  assert.equal(preview.publicRepository, false);
  assert.deepEqual(preview.lines, ['!skills/', 'skills/*', '!skills/shared/', '!skills/shared/**']);
  const shared = await m.shareSkill(cwd, 'shared');
  assert.equal(shared.alreadyTrackable, true);
  assert.equal(ignored(cwd, '.arco/skills/shared/SKILL.md'), false);
  assert.equal(ignored(cwd, '.arco/skills/private/SKILL.md'), true);
  assert.equal(ignored(cwd, '.arco/workflows/x/events.jsonl'), true);
  assert.ok(readFileSync(join(cwd, '.arco', '.gitignore'), 'utf8').startsWith(DEFAULT_PROJECT_IGNORE));
  // A second shared skill adds only its own lines.
  assert.deepEqual((await m.previewShare(cwd, 'private')).lines, ['!skills/private/', '!skills/private/**']);
  assert.equal(git(cwd, 'status', '--porcelain', '--', '.arco/skills/shared').trim(), '?? .arco/skills/shared/');
  // A project-level rule that ignores .arco wins: refused with a message.
  const other = project(); git(other, 'init', '-q'); writeFileSync(join(other, '.gitignore'), '.arco/\n');
  await skills.writeSkill({ scope: 'project', name: 'Blocked', description: 'x', body: 'y' }, other);
  await assert.rejects(m.shareSkill(other, 'blocked'), /still ignores the skill's files through another ignore rule\. The rule is in \.gitignore line 1 \(\.arco\/\)\./);
});

test('a skill shared with SHARE WITH REPOSITORY and committed is left alone by the project-state check', async () => {
  const pp = await import('./publicProject.js');
  const cwd = project(); git(cwd, 'init', '-q');
  await skills.writeSkill({ scope: 'project', name: 'Shared', description: 'x', body: 'y' }, cwd);
  await skills.writeSkill({ scope: 'project', name: 'Private', description: 'x', body: 'y' }, cwd);
  await m.shareSkill(cwd, 'shared');
  git(cwd, 'add', '--', '.arco');
  git(cwd, 'commit', '-q', '-m', 'share');
  const tracked = git(cwd, 'ls-files', '--', '.arco').trim().split('\n');
  assert.ok(tracked.length > 0 && tracked.every((f) => f.startsWith('.arco/skills/shared/')), tracked.join(','));
  const report = await pp.checkProjectState(cwd);
  assert.deepEqual([report.tracked, report.ignored, report.ignoreFile, report.sharedSkills], [0, true, 'default', ['shared']]);
  // A second share keeps the file in the shape the check accepts.
  await m.shareSkill(cwd, 'private');
  const two = await pp.checkProjectState(cwd);
  assert.deepEqual([two.ignoreFile, two.sharedSkills], ['default', ['shared', 'private']]);
  assert.deepEqual(pp.restoreIgnoreFile(cwd), {});
  assert.deepEqual(await pp.stopTrackingState(cwd), { ok: true, removed: 0 });
  assert.deepEqual(git(cwd, 'ls-files', '--', '.arco').trim().split('\n'), tracked);
});

test('SHARE WITH REPOSITORY refused: .arco/.gitignore stays byte-identical, or absent when it was absent', async () => {
  const bytes = (cwd: string) => readFileSync(join(cwd, '.arco', '.gitignore'));
  const STILL = /still ignores the skill's files through another ignore rule\./;
  // The project's .gitignore ignores the .arco folder: refused before writing.
  const a = project(); git(a, 'init', '-q'); writeFileSync(join(a, '.gitignore'), 'dist/\n.arco/\n');
  await skills.writeSkill({ scope: 'project', name: 'Blocked', description: 'x', body: 'y' }, a);
  writeFileSync(join(a, '.arco', '.gitignore'), Buffer.concat([bytes(a), Buffer.from('# no newline at end')]));
  const beforeA = bytes(a);
  await assert.rejects(m.shareSkill(a, 'blocked'), (e: Error) => STILL.test(e.message) && /\.gitignore line 2 \(\.arco\/\)\. Nothing was changed\./.test(e.message));
  assert.deepEqual(bytes(a), beforeA);
  // A global ignore file on this computer (here: the repository's core.excludesFile).
  const b = project(); git(b, 'init', '-q');
  const excludes = join(b, '.git', 'fixture-excludes'); writeFileSync(excludes, '.arco\n'); git(b, 'config', 'core.excludesFile', excludes);
  await skills.writeSkill({ scope: 'project', name: 'Blocked', description: 'x', body: 'y' }, b);
  const beforeB = bytes(b);
  await assert.rejects(m.shareSkill(b, 'blocked'), (e: Error) => STILL.test(e.message) && e.message.includes('(.arco)') && e.message.endsWith('Nothing was changed.'));
  assert.deepEqual(bytes(b), beforeB);
  // A deeper ignore file wins over the exception: written, checked, then put back.
  const c = project(); git(c, 'init', '-q');
  await skills.writeSkill({ scope: 'project', name: 'Blocked', description: 'x', body: 'y' }, c);
  writeFileSync(join(c, '.arco', 'skills', '.gitignore'), '*\n');
  const beforeC = bytes(c);
  await assert.rejects(m.shareSkill(c, 'blocked'), (e: Error) => STILL.test(e.message) && e.message.includes('.arco/skills/.gitignore line 1 (*)'));
  assert.deepEqual(bytes(c), beforeC);
  // Same, with no .arco/.gitignore at first: the file the share created is removed.
  rmSync(join(c, '.arco', '.gitignore'));
  await assert.rejects(m.shareSkill(c, 'blocked'), STILL);
  assert.equal(existsSync(join(c, '.arco', '.gitignore')), false);
});

test('SHARE WITH REPOSITORY does not write through a symlinked .arco/.gitignore', async () => {
  const cwd = project(); git(cwd, 'init', '-q');
  await skills.writeSkill({ scope: 'project', name: 'Blocked', description: 'x', body: 'y' }, cwd);
  const target = join(cwd, 'ignore-target');
  const link = join(cwd, '.arco', '.gitignore');
  writeFileSync(target, readFileSync(link));
  rmSync(link);
  if (!await linkFile(target, link)) return;
  const before = readFileSync(target);
  // Git does not apply a symlinked ignore file, so the skill is already not
  // ignored. Sharing must still not replace or append to the link target.
  const preview = await m.shareSkill(cwd, 'blocked');
  assert.equal(preview.alreadyTrackable, true);
  assert.deepEqual(readFileSync(target), before);
  writeFileSync(join(cwd, '.gitignore'), '.arco/\n');
  await assert.rejects(m.shareSkill(cwd, 'blocked'), /Nothing was changed/);
  assert.deepEqual(readFileSync(target), before);
});

async function call(method: string, url: string, payload?: unknown): Promise<{ code: number; body: Record<string, unknown> }> {
  const req = Object.assign(Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]), { method, url }) as IncomingMessage;
  let code = 0, text = '';
  const res = { writeHead: (status: number) => { code = status; }, end: (value: string) => { text = value; } } as unknown as ServerResponse;
  assert.equal(await tryHandleSkillManagementRoutes(req, res), true);
  return { code, body: JSON.parse(text) };
}

test('routes: import through the review token, details, and share for registered projects only', async () => {
  const cwd = project(); git(cwd, 'init', '-q');
  const gh = github({ 'grill/SKILL.md': SKILL('Grill route') });
  _setSkillFetchForTest(gh.fetchImpl);
  const q = `?cwd=${encodeURIComponent(cwd)}`;
  const preview = await call('POST', `/api/skills/import/preview${q}`, { source: { kind: 'github', url: 'https://github.com/fixture/skills/tree/main/grill' } });
  assert.equal(preview.code, 200);
  assert.equal((await call('POST', `/api/skills/import/confirm${q}`, { token: preview.body.token, scope: 'project' })).code, 200);
  const details = await call('GET', `/api/skills/details${q}`);
  assert.deepEqual((details.body.skills as Array<{ slug: string; scope: string }>).filter((s) => s.scope === 'project').map((s) => s.slug), ['grill-route']);
  assert.equal((await call('POST', `/api/skills/share/preview${q}`, { slug: 'grill-route' })).code, 403);
  assert.equal((await addProject(cwd)).ok, true);
  assert.equal((await call('POST', `/api/skills/share${q}`, { slug: 'grill-route' })).code, 400);
  assert.equal((await call('POST', `/api/skills/share${q}`, { slug: 'grill-route', confirm: true })).code, 200);
  assert.equal((await call('POST', `/api/skills/import/preview${q}`, { source: { kind: 'folder', path: 'relative/path' } })).code, 400);
  assert.equal((await call('POST', `/api/skills/state${q}`, { scope: 'project', slug: 'nope', off: true })).code, 400);
});

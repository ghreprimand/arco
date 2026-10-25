import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

// Direct invocation is isolated too; imports that capture HOME happen below.
// Match the canonical paths returned by confinement, including symlinked temp roots.
const fixture = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'arco-file-policy-')));
const home = path.join(fixture, 'home');
const project = path.join(fixture, 'mount', 'project');
const outside = path.join(fixture, 'media');
const customProvider = path.join(fixture, 'provider');
for (const dir of [home, project, outside, customProvider, path.join(home, '.codex')]) mkdirSync(dir, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CODEX_HOME = customProvider;
process.env.ARCO_UPLOADS_DIR = path.join(fixture, 'uploads');
const { UPSTREAM_STATE_DIRECTORY } = await import('./envAliases.js');
const { confinedPath, safeDirectory } = await import('./fileAccessPolicy.js');
const { resolveBoundCwd } = await import('./http/writeConfinement.js');
const { patchSettings } = await import('./settings.js');
const { resolveBrowserRead, listBrowserDirectory, resolveWorkflowDocument } = await import('./http/readConfinement.js');
const { workflowCwds } = await import('./server/state.js');
const { resolveMediaInput, resolveMediaOutputDir } = await import('./media/ffmpeg.js');
const { SCRATCH_ROOT } = await import('./media/scratch.js');
const { readFileForExplorer } = await import('./http/fileRead.js');
after(() => rmSync(fixture, { recursive: true, force: true }));

function file(name: string, contents = 'fixture'): string {
  mkdirSync(path.dirname(name), { recursive: true });
  writeFileSync(name, contents);
  return name;
}
const inside = file(path.join(project, 'document.txt'));
const external = file(path.join(outside, 'clip.wav'));
const credential = file(path.join(home, '.codex', 'auth.json'));
const customCredential = file(path.join(customProvider, 'session.txt'));
symlinkSync(inside, path.join(project, 'inside-link'));
symlinkSync(outside, path.join(project, 'escape'));
symlinkSync(customProvider, path.join(project, 'provider-link'));

test('project roots work outside HOME; content grants do not come from arbitrary cwd', async () => {
  await patchSettings({ defaultWorkingDirectory: project });
  assert.equal(await resolveBrowserRead(inside), inside);
  assert.equal(await resolveBrowserRead('document.txt', project), inside);
  assert.equal((await readFileForExplorer(inside)).type, 'text');
  await assert.rejects(resolveBrowserRead(external));
  await assert.rejects(resolveBrowserRead(external, outside));
  await assert.rejects(resolveBrowserRead('document.txt'));
  await assert.rejects(resolveBrowserRead(inside, project, 'unknown-workflow'));
});

test('canonical containment accepts inward links and denies outward and provider links', async () => {
  assert.equal(confinedPath(path.join(project, 'inside-link'), [project]), inside);
  assert.throws(() => confinedPath(path.join(project, 'escape', 'clip.wav'), [project]));
  assert.throws(() => confinedPath(path.join(project, 'provider-link', 'session.txt'), [project]));
  assert.throws(() => confinedPath(project, [project]));
  assert.throws(() => confinedPath(path.join(project, '..', '..', 'media', 'clip.wav'), [project]));
  const alias = path.join(fixture, 'project-alias');
  symlinkSync(project, alias);
  assert.equal(confinedPath(path.join(alias, 'document.txt'), [alias]), inside);
  assert.equal(confinedPath(inside, [alias]), inside);
});

test('a symlinked temporary parent returns canonical paths and leaves Library protected', () => {
  const parentAlias = path.join(fixture, 'temporary-parent');
  symlinkSync(path.join(fixture, 'mount'), parentAlias);
  const spelledProject = path.join(parentAlias, 'project');
  const spelledFile = path.join(spelledProject, 'document.txt');
  assert.equal(safeDirectory(spelledProject), realpathSync(project));
  assert.equal(confinedPath(spelledFile, [spelledProject]), realpathSync(inside));
  const library = path.join(home, 'Library');
  mkdirSync(library);
  assert.throws(() => safeDirectory(library));
  assert.equal(safeDirectory(fixture), realpathSync(fixture));
});

test('registration, settings and broad HOME cannot authorize protected state', async () => {
  for (const dir of [path.parse(project).root, path.dirname(credential), customProvider, path.join(project, 'provider-link')]) {
    assert.throws(() => safeDirectory(dir));
  }
  await patchSettings({ defaultWorkingDirectory: customProvider });
  assert.equal((await resolveBoundCwd(customProvider, undefined)).ok, false);
  await patchSettings({ defaultWorkingDirectory: project });
  for (const p of [credential, customCredential, file(path.join(project, '.env')), path.join(home, '.arco', 'settings.json')]) {
    assert.throws(() => confinedPath(p, [home, project, customProvider]));
    await assert.rejects(resolveBrowserRead(p, home));
  }
  const example = file(path.join(project, '.env.example'));
  assert.equal(confinedPath(example, [project]), example);
});

test('picker navigation reveals ordinary directories without granting their files', async () => {
  const result = await listBrowserDirectory(fixture, true);
  assert.ok(result.entries.some((e) => e.name === 'media'));
  assert.ok(!result.entries.some((e) => e.name === 'provider'));
  await assert.rejects(listBrowserDirectory(path.dirname(credential), true));
  await assert.rejects(listBrowserDirectory(outside, false));
  await assert.rejects(listBrowserDirectory(path.parse(project).root, true));
  const listing = await listBrowserDirectory(project, false);
  assert.ok(listing.entries.some((e) => e.name === 'inside-link'));
  assert.ok(!listing.entries.some((e) => e.name === 'escape'));
  const nested = path.join(project, 'nested');
  mkdirSync(nested);
  symlinkSync(inside, path.join(nested, 'sibling-link'));
  assert.ok((await listBrowserDirectory(nested, false)).entries.some((e) => e.name === 'sibling-link'));
});

test('bound workflows, saved artifacts, uploads and scratch retain narrow access', async () => {
  workflowCwds.set('fixture-workflow', project);
  assert.equal(await resolveBrowserRead('document.txt', outside, 'fixture-workflow'), inside);
  const artifact = file(path.join(project, '.arco', 'workflows', 'fixture-workflow', 'artifacts', 'report.md'));
  assert.equal(await resolveBrowserRead('report.md', project, 'fixture-workflow'), artifact);
  assert.equal(await resolveWorkflowDocument(project, 'saved-workflow', 'artifacts', 'saved.md').catch(() => null), null);
  const saved = file(path.join(project, '.arco', 'workflows', 'saved-workflow', 'artifacts', 'saved.md'));
  assert.equal(await resolveWorkflowDocument(project, 'saved-workflow', 'artifacts', 'saved.md'), saved);
  await assert.rejects(resolveWorkflowDocument(project, '../../escape', 'artifacts', 'saved.md'));
  const events = file(path.join(project, '.arco', 'workflows', 'fixture-workflow', 'events.jsonl'));
  await assert.rejects(resolveBrowserRead(events, project));
  const scratch = file(path.join(SCRATCH_ROOT, 'fixture', 'clip.wav'));
  const upload = file(path.join(process.env.ARCO_UPLOADS_DIR!, 'fixture.png'));
  assert.equal(await resolveBrowserRead(scratch), scratch);
  assert.equal(await resolveBrowserRead(upload), upload);
  workflowCwds.delete('fixture-workflow');
});

test('media requires explicit finite roots and checks outputs, scratch and secrets equally', () => {
  const confined = { cwd: project, unconfined: false };
  assert.equal(resolveMediaInput(confined, inside), inside);
  assert.throws(() => resolveMediaInput(confined, external));
  assert.throws(() => resolveMediaInput({ ...confined, unconfined: true }, external));
  const granted = { ...confined, unconfined: true, allowedRoots: [outside] };
  assert.equal(resolveMediaInput(granted, external), external);
  assert.equal(resolveMediaOutputDir(granted, outside, external), outside);
  assert.throws(() => resolveMediaOutputDir(confined, outside, inside));
  assert.throws(() => resolveMediaInput(granted, path.join(project, 'escape', 'clip.wav')));
  for (const p of [credential, customCredential]) assert.throws(() => resolveMediaInput({ unconfined: true, allowedRoots: [home, customProvider] }, p));
  const scratchEscape = path.join(SCRATCH_ROOT, 'fixture', 'escaped.wav');
  symlinkSync(external, scratchEscape);
  assert.throws(() => resolveMediaInput(confined, scratchEscape));
});

test('OS pseudo-files stay denied regardless of caller roots', () => {
  if (process.platform !== 'win32') {
    assert.throws(() => confinedPath('/proc/self/environ', ['/proc', '/']));
    assert.throws(() => confinedPath('/dev/zero', ['/dev']));
    assert.throws(() => safeDirectory('/etc'));
  }
});

test('raw media HTTP grants are global, finite, Range-capable and immediately revocable', async () => {
  const { tryHandleMediaOpsRoutes } = await import('./http/mediaOpsRoutes.js');
  const server = createServer((req, res) => { void tryHandleMediaOpsRoutes(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const raw = (target: string, range?: string) => fetch(`http://127.0.0.1:${port}/api/media/raw?${new URLSearchParams({ path: target, cwd: project })}`, { headers: range ? { Range: range } : {} });
  try {
    // A repository cannot grant itself extra read authority.
    file(path.join(project, '.arco', 'settings.json'), JSON.stringify({ mediaUnconfined: true, mediaAllowedRoots: [outside] }));
    assert.equal((await raw(external)).status, 403);
    await patchSettings({ mediaUnconfined: true });
    assert.equal((await raw(external)).status, 403);
    await patchSettings({ mediaAllowedRoots: [outside] });
    const response = await raw(external, 'bytes=0-2');
    assert.equal(response.status, 206);
    assert.equal(await response.text(), 'fix');
    assert.equal(response.headers.get('content-range'), 'bytes 0-2/7');
    assert.equal((await raw(credential)).status, 403);
    await patchSettings({ mediaAllowedRoots: [] });
    assert.equal((await raw(external)).status, 403);
    const inProject = await raw(inside);
    assert.equal(inProject.status, 200);
    assert.equal(await inProject.text(), 'fixture');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('runtime aliases and scratch aliases cannot authorize account state', async () => {
  const runtime = path.join(home, '.arco');
  const moved = path.join(fixture, 'runtime-volume');
  file(path.join(runtime, 'provider-accounts', 'fixture', 'session.txt'));
  renameSync(runtime, moved);
  symlinkSync(moved, runtime);
  const privateFile = path.join(moved, 'provider-accounts', 'fixture', 'session.txt');
  assert.throws(() => confinedPath(privateFile, [moved]));
  assert.throws(() => safeDirectory(path.dirname(privateFile)));
  const scratchFile = path.join(SCRATCH_ROOT, 'fixture', 'clip.wav');
  assert.equal(resolveMediaInput({ unconfined: false }, scratchFile), path.join(moved, 'media-scratch', 'fixture', 'clip.wav'));
  rmSync(SCRATCH_ROOT, { recursive: true });
  symlinkSync(path.join(moved, 'provider-accounts'), SCRATCH_ROOT);
  assert.throws(() => resolveMediaInput({ unconfined: false }, path.join(SCRATCH_ROOT, 'fixture', 'session.txt')));
});

test('relocated runtime homes and their aliases keep private state protected', () => {
  const previous = process.env.ARCO_HOME;
  const relocated = path.join(project, 'runtime-home');
  const alias = path.join(project, 'runtime-alias');
  const settings = file(path.join(relocated, 'settings.json'));
  const account = file(path.join(relocated, 'provider-accounts', 'fixture', 'session.txt'));
  const artifact = file(path.join(relocated, 'workflows', 'fixture', 'artifacts', 'report.md'));
  symlinkSync(relocated, alias);
  try {
    for (const runtime of [relocated, alias]) {
      process.env.ARCO_HOME = runtime;
      for (const denied of [settings, account, path.join(alias, 'settings.json'), path.join(alias, 'provider-accounts', 'fixture', 'session.txt')]) {
        assert.throws(() => confinedPath(denied, [project]), `private runtime file: ${path.basename(denied)}`);
        assert.throws(() => resolveMediaInput({ cwd: project, unconfined: true, allowedRoots: [project] }, denied));
      }
      assert.throws(() => safeDirectory(relocated));
      assert.throws(() => safeDirectory(alias));
      assert.equal(confinedPath(artifact, [project]), artifact);
      assert.equal(confinedPath(path.join(alias, 'workflows', 'fixture', 'artifacts', 'report.md'), [project]), artifact);
      assert.equal(confinedPath(inside, [project]), inside);
    }
  } finally {
    if (previous === undefined) delete process.env.ARCO_HOME;
    else process.env.ARCO_HOME = previous;
  }
});

test('upstream state stays private inside project grants and through aliases', () => {
  const legacy = path.join(project, UPSTREAM_STATE_DIRECTORY);
  const secret = file(path.join(legacy, 'provider-accounts', 'fixture', 'session.txt'));
  const alias = path.join(project, 'upstream-state-alias');
  symlinkSync(legacy, alias);
  for (const target of [secret, path.join(alias, 'provider-accounts', 'fixture', 'session.txt')]) {
    assert.throws(() => confinedPath(target, [project]));
    assert.throws(() => resolveMediaInput({ cwd: project, unconfined: true, allowedRoots: [project] }, target));
  }
  assert.throws(() => safeDirectory(legacy));
  assert.throws(() => safeDirectory(alias));
});

test('missing authorized media retains the existing recovery codes without running a model', async () => {
  const access = { cwd: project, unconfined: false };
  const hasCode = (code: string) => (err: unknown) => (err as { code?: string }).code === code;
  assert.throws(() => resolveMediaInput(access, 'missing.wav'), hasCode('input-missing'));
  assert.throws(() => resolveMediaOutputDir(access, path.join(project, 'missing-output'), inside), hasCode('output-dir-missing'));
  const { runDemucsStems } = await import('./media/demucs.js');
  await assert.rejects(runDemucsStems(project, 'missing.wav'), hasCode('input-missing'));
});

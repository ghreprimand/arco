// docs/ARCHITECTURE.md - backup snapshot smoke (no live server, no real ~/.arco).
//
// Builds a temp fake Arco home with a known .arco tree (captured files, a
// secret tree, a regenerable cache, a cluster mailbox, settings with a secret
// field, and a SYMLINK to prove it's skipped), runs the PURE snapshot builder
// over it, then asserts:
//   • the archive round-trips (read entries back) to exactly the captured files;
//   • the manifest is truthful — every archive file is in a category, the symlink
//     + secret + cache + mailbox are in `skipped` with the right reasons;
//   • createdAt / arcoVersion match the INJECTED fixture values (determinism);
//   • no secret/token path is present in the archive (redaction holds).
//
// Run: npm run smoke:backup-snapshot   (no :3001 needed)

import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { step, assert, assertEq, summary } from './lib.js';
import { walkArcoHome, buildManifest, classify, redactSettingsJson } from '../backup/manifest.js';
import { writeArchive, readArchive } from '../backup/archive.js';

const FIXED_VERSION = '9.9.9-fixture';
const FIXED_CREATED_AT = '2026-01-02T03:04:05.000Z';

async function buildFakeHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'arco-backup-smoke-'));
  const home = join(root, '.arco');
  await mkdir(home, { recursive: true });

  // Captured categories.
  await writeFile(
    join(home, 'settings.json'),
    JSON.stringify({ enabledProviders: { claude: true }, githubToken: 'ghp_SECRET123', ollama: { baseUrl: 'http://x:11434' } }),
  );
  await writeFile(join(home, 'templates.json'), '{"templates":[]}');
  await mkdir(join(home, 'skills', 'demo'), { recursive: true });
  await writeFile(join(home, 'skills', 'demo', 'SKILL.md'), '# demo skill');
  await mkdir(join(home, 'recall'), { recursive: true });
  await writeFile(join(home, 'recall', 'recall.db'), Buffer.from([1, 2, 3, 4]));
  await mkdir(join(home, 'recall', 'wf123abc'), { recursive: true });
  await writeFile(join(home, 'recall', 'wf123abc', 'summary.md'), '# summary');
  await mkdir(join(home, 'workflows'), { recursive: true });
  await writeFile(join(home, 'workflows', 'meta.json'), '{}');
  // cluster: preset captured, mailbox skipped (transient).
  await writeFile(join(home, 'cluster-presets.json'), '{"presets":[]}');
  await mkdir(join(home, 'clusters', 'c1', 'mailbox', 'wfA'), { recursive: true });
  await writeFile(join(home, 'clusters', 'c1', 'plan.md'), '# plan');
  await writeFile(join(home, 'clusters', 'c1', 'mailbox', 'wfA', 'msg1.json'), '{"m":1}');

  // SECRETS — must be skipped.
  await writeFile(join(home, 'auth.json'), '{"claude":{"native":{"accessToken":"oauth_SECRET"}}}');
  await mkdir(join(home, 'provider-accounts', 'codex-a1'), { recursive: true });
  await writeFile(join(home, 'provider-accounts', 'codex-a1', 'auth.json'), '{"token":"cdx_SECRET"}');

  // REGENERABLE + LARGE — skipped.
  await mkdir(join(home, 'cli-snapshots'), { recursive: true });
  await writeFile(join(home, 'cli-snapshots', 'probe.json'), '{}');
  await mkdir(join(home, 'logs'), { recursive: true });
  await writeFile(join(home, 'logs', 'arco.log'), 'log line');

  // SYMLINK — must be skipped as special-file, never followed.
  await symlink(join(home, 'settings.json'), join(home, 'settings.link.json'));

  return home;
}

async function main(): Promise<void> {
  const home = await buildFakeHome();
  let archiveBuf: Buffer;
  let manifest: ReturnType<typeof buildManifest>;
  let readback: ReturnType<typeof readArchive>;

  await step('classify: capture/skip decision table', () => {
    assertEq(classify('settings.json').kind, 'capture', 'settings.json captured');
    assertEq(classify('skills/demo/SKILL.md').kind, 'capture', 'skills captured');
    assertEq(classify('recall/recall.db').kind, 'capture', 'recall captured');
    assertEq((classify('auth.json') as { reason: string }).reason, 'secret', 'auth.json secret');
    assertEq((classify('provider-accounts/x') as { reason: string }).reason, 'secret', 'provider-accounts secret');
    assertEq((classify('cli-snapshots/p.json') as { reason: string }).reason, 'regenerable', 'cli-snapshots regenerable');
    assertEq((classify('logs/x.log') as { reason: string }).reason, 'large-volatile', 'logs large-volatile');
    assertEq((classify('clusters/c1/mailbox/wfA/m.json') as { reason: string }).reason, 'transient', 'mailbox transient');
    assertEq(classify('clusters/c1/plan.md').kind, 'capture', 'cluster plan captured');
    assertEq((classify('mystery-thing') as { reason: string }).reason, 'unknown', 'unrecognized skipped as unknown');
  });

  await step('redactSettingsJson: scrubs secret-shaped keys, keeps shape', () => {
    const { text, fields } = redactSettingsJson('{"githubToken":"ghp_x","ollama":{"baseUrl":"http://y"}}');
    assert(fields.includes('githubToken'), 'githubToken recorded as redacted');
    assert(!text.includes('ghp_x'), 'secret value gone from text');
    assert(text.includes('http://y'), 'non-secret value preserved');
  });

  await step('build snapshot over fake home (injected clock/version)', async () => {
    const walk = await walkArcoHome(home);
    manifest = buildManifest({
      arcoVersion: FIXED_VERSION,
      createdAt: FIXED_CREATED_AT,
      sourceRoot: '~/.arco',
      walk,
    });
    archiveBuf = writeArchive(manifest, walk.files);
    assert(archiveBuf.length > 0, 'archive buffer non-empty');
  });

  await step('determinism: createdAt / arcoVersion match injected values', () => {
    assertEq(manifest.arcoVersion, FIXED_VERSION, 'version injected');
    assertEq(manifest.createdAt, FIXED_CREATED_AT, 'createdAt injected');
    assertEq(manifest.format, 'arco-backup/1', 'format tag');
  });

  await step('archive round-trips to exactly the captured regular files', () => {
    readback = readArchive(archiveBuf);
    assertEq(readback.manifest.fileCount, manifest.fileCount, 'fileCount survives round-trip');
    assertEq(readback.files.length, manifest.fileCount, 'entry count == manifest fileCount');
    // Every captured path appears in exactly one category, and every category
    // path corresponds to a real archive entry.
    const archivePaths = new Set(readback.files.map((f) => f.relPath));
    const categoryPaths = Object.values(readback.manifest.categories).flat();
    assertEq(categoryPaths.length, readback.files.length, 'categories enumerate every file');
    for (const p of categoryPaths) assert(archivePaths.has(p), `category path ${p} present in archive`);
    for (const f of readback.files) assert(categoryPaths.includes(f.relPath), `archive file ${f.relPath} is categorized`);
  });

  await step('expected files captured; expected items skipped with reasons', () => {
    const paths = new Set(readback.files.map((f) => f.relPath));
    assert(paths.has('settings.json'), 'settings captured');
    assert(paths.has('skills/demo/SKILL.md'), 'skill captured');
    assert(paths.has('recall/recall.db'), 'recall db captured');
    assert(paths.has('recall/wf123abc/summary.md'), 'recall summary captured');
    assert(paths.has('cluster-presets.json'), 'cluster preset captured');
    assert(paths.has('clusters/c1/plan.md'), 'cluster plan captured');
    assert(paths.has('templates.json'), 'templates captured');
    assert(paths.has('workflows/meta.json'), 'workflow meta captured');

    const skip = readback.manifest.skipped;
    const reasonOf = (pred: (p: string) => boolean) => skip.find((s) => pred(s.path))?.reason;
    assertEq(reasonOf((p) => p === 'settings.link.json'), 'special-file', 'symlink skipped as special-file');
    assertEq(reasonOf((p) => p === 'auth.json'), 'secret', 'auth.json skipped as secret');
    assertEq(reasonOf((p) => p.startsWith('provider-accounts')), 'secret', 'provider-accounts skipped as secret');
    assertEq(reasonOf((p) => p.startsWith('cli-snapshots')), 'regenerable', 'cli-snapshots skipped as regenerable');
    assertEq(reasonOf((p) => p.startsWith('logs')), 'large-volatile', 'logs skipped as large-volatile');
    assertEq(reasonOf((p) => p.includes('mailbox')), 'transient', 'mailbox skipped as transient');
  });

  await step('SECURITY: no secret/token path or value present in the archive', () => {
    for (const f of readback.files) {
      assert(!f.relPath.startsWith('auth.json'), 'no auth.json in archive');
      assert(!f.relPath.startsWith('provider-accounts'), 'no provider-accounts in archive');
    }
    // settings.json IS captured but its secret value must be scrubbed.
    const settings = readback.files.find((f) => f.relPath === 'settings.json');
    assert(settings !== undefined, 'settings.json present');
    const text = settings!.bytes.toString('utf8');
    assert(!text.includes('ghp_SECRET123'), 'settings secret value redacted in archive');
    assert(text.includes('<redacted>'), 'settings redaction marker present');
    assert(text.includes('11434'), 'non-secret settings field preserved');
    // The whole archive blob must never contain a known secret token string.
    const blob = Buffer.concat(readback.files.map((f) => f.bytes)).toString('utf8');
    assert(!blob.includes('oauth_SECRET'), 'oauth token never in archive');
    assert(!blob.includes('cdx_SECRET'), 'codex token never in archive');
    assert(!blob.includes('ghp_SECRET123'), 'github token never in archive');
    // Redaction is documented in the manifest.
    const red = readback.manifest.redactions.find((r) => r.path === 'settings.json');
    assert(red !== undefined && red.fields.includes('githubToken'), 'redaction recorded in manifest');
  });

  await step('corrupt archive is rejected (bad magic / truncation)', () => {
    let threw = false;
    try {
      readArchive(Buffer.from('not a gzip'));
    } catch {
      threw = true;
    }
    assert(threw, 'non-gzip blob rejected');
  });

  await rm(home, { recursive: true, force: true });
  summary('backup-snapshot');
}

void main();

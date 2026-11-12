import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-scan-deadline-')));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const { collectProjectDocsPage } = await import('./explorerDocs.js');
const { ignoredProjectPaths } = await import('./projectIgnore.js');

for (const mode of ['open', 'read', 'reject', 'read-reject'] as const) test(`a stalled directory ${mode} returns partial on time and disposes late resources`, async t => {
  const fixture = join(process.env.HOME!, mode); mkdirSync(fixture);
  // The scanner uses promises.realpath (native on Windows), which expands
  // temporary-folder short names. Intercept that same spelling.
  const project = await fs.realpath(fixture);
  writeFileSync(join(project, 'README.md'), 'fixture');
  const originalOpen = fs.opendir.bind(fs);
  let intercepted = 0;
  let closes = 0, closing: Promise<void> | undefined;
  let released!: () => void;
  const releaseFinished = new Promise<void>(resolve => { released = resolve; });
  t.mock.method(fs, 'opendir', async (...args: any[]) => {
    if (String(args[0]) !== project) return (originalOpen as any)(...args);
    intercepted++;
    if (mode === 'reject') return new Promise((_, reject) => setTimeout(() => { reject(new Error('fixture late rejection')); released(); }, 400));
    const handle = await (originalOpen as any)(...args);
    const originalClose = handle.close.bind(handle);
    handle.close = () => { closes++; closing = originalClose(); return closing; };
    if (mode === 'open') return new Promise(resolve => setTimeout(() => { resolve(handle); released(); }, 400));
    const originalRead = handle.read.bind(handle);
    const wrapped: any = {
      read: () => new Promise((resolve, reject) => setTimeout(() => {
        if (mode === 'read-reject') { reject(new Error('fixture late read rejection')); released(); }
        else originalRead().then(resolve, reject).finally(released);
      }, 400)),
      close: handle.close,
    };
    wrapped[Symbol.asyncIterator] = async function* () {
      try { for (;;) { const entry = await wrapped.read(); if (entry === null) break; yield entry; } }
      finally { await wrapped.close(); }
    };
    return wrapped;
  });
  syncBuiltinESMExports();
  try {
    const started = performance.now();
    const page = await collectProjectDocsPage(project);
    assert.ok(performance.now() - started < 350, 'the pending I/O exceeded the 250 ms scan budget');
    assert.equal(intercepted, 1, 'the delayed directory open must exercise the scanner');
    assert.equal(page.partial, true);
    await releaseFinished;
    await new Promise<void>(resolve => setImmediate(resolve));
    await closing;
    if (mode !== 'reject') assert.equal(closes, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('a fractional remaining deadline never produces an invalid Git subprocess timeout', async () => {
  assert.ok(await ignoredProjectPaths(process.env.HOME!, [join(process.env.HOME!, 'missing')], 1.5) instanceof Set);
});

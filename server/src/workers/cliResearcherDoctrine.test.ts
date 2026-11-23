import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';

test('sandboxed CLI researcher instructions allow its shell without changing other research rules', async () => {
  const { cliResearcherDoctrine } = await import('./cliResearcherDoctrine.js');
  const base = 'Private workspace. You have no shell and no project files. Send one report.';
  const cli = cliResearcherDoctrine(base);
  assert.match(cli, /may use shell tools inside the sandbox/);
  assert.match(cli, /Private workspace\.[\s\S]*Send one report\./);
  assert.match(base, /You have no shell/);
  assert.throws(() => cliResearcherDoctrine('Unexpected research doctrine.'), /unavailable/);
  const { RESEARCHER_DOCTRINE } = await import('../research/researchDoctrine.js');
  assert.match(cliResearcherDoctrine(RESEARCHER_DOCTRINE), /about 12 KB[\s\S]*artifact_paths[\s\S]*Never drop sources[\s\S]*Do not count bytes/);
});

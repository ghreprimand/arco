import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageDocPath } from './packageDocs.js';

test('package docs remain confined even when the install lives under a protected directory', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'arco-package-docs-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'AppData', 'npm', 'package'); mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'GUIDE.md'), 'fixture');
  writeFileSync(join(root, 'docs', 'credentials.json'), '{}');
  assert.ok(packageDocPath(root, 'docs/GUIDE.md').endsWith(join('docs', 'GUIDE.md')));
  assert.throws(() => packageDocPath(root, 'docs/credentials.json'));
  assert.throws(() => packageDocPath(root, 'docs/../../secret.md'));
  writeFileSync(join(base, 'secret.md'), 'fixture');
  try { symlinkSync(join(base, 'secret.md'), join(root, 'docs', 'escape.md')); }
  catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code || '')) throw error; return; }
  assert.throws(() => packageDocPath(root, 'docs/escape.md'));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { findDiagnosticExecutable } from './executableLookup.js';

for (const file of ['checks.ts', 'modelHealth.ts']) test(`B65: ${file} honors Windows PATH and configured llama-server`, async () => {
  const env = { Path: 'C:\\Tools', PATHEXT: '.EXE;.CMD', ARCO_LLAMACPP_BIN: 'C:\\Models\\custom.exe' };
  const isFile = (p: string) => ['C:\\Tools\\gopls.exe', env.ARCO_LLAMACPP_BIN].includes(p);
  const lookup = (bin: string) => findDiagnosticExecutable(bin, { env, platform: 'win32', isFile });
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    const fn = source.slice(source.indexOf('async function onPath('), source.indexOf('\n}\n', source.indexOf('async function onPath(')) + 2);
    const { code } = await transform(fn, { loader: 'ts', target: 'es2022' });
    const onPath = new Function('execFileAsync', 'findDiagnosticExecutable', code + ';return onPath;')(
      async () => { throw new Error('which is absent on Windows'); }, lookup);
    const bin = file === 'checks.ts' ? 'gopls' : 'llama-server';
    assert.equal(await onPath(bin), file === 'checks.ts' ? 'C:\\Tools\\gopls.exe' : env.ARCO_LLAMACPP_BIN, file);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import * as launchers from './launchers.js';

test('B190: standalone media reopens drive, UNC and POSIX outputs through the raw route', async () => {
  const source = await readFile(new URL('./MediaModalHost.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const serveUrl =');
  const end = source.indexOf('\n  };', start) + '\n  };'.length;
  const output = await transform(`${source.slice(start, end)}\nmodule.exports=serveUrl;`, { loader: 'ts', format: 'cjs' });
  const module = { exports: undefined as unknown as (path: string) => string | null };
  new Function('module', 'fileContext', 'URLSearchParams', 'isAbsoluteMediaPath', output.code)(module, undefined, URLSearchParams, (launchers as unknown as Record<string, unknown>).isAbsoluteMediaPath);
  for (const path of ['C:\\media\\output.mp4', '\\\\fixture\\share\\output.wav', '/fixture/output.png']) {
    const result = module.exports(path);
    assert.ok(result, path);
    assert.equal(new URL(result, 'http://localhost').searchParams.get('path'), path);
  }
  assert.equal(module.exports('relative.mp4'), null);
});

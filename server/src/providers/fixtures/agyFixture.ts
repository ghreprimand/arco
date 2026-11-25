// A fake `agy` for unit tests, launched by Node on every system. On Windows a
// POSIX script cannot be spawned, so the fixture is an npm-style `agy.cmd`
// shim, which `commandArgs` (windowsCommand.ts) resolves to Node and the
// script, as it does for a real npm-installed CLI.
import { chmodSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Write `source` (CommonJS) as the `agy` command in `dir`; returns a PATH
 * value with `dir` first. */
export function installAgyFixture(dir: string, source: string): string {
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'agy.js'), source);
    writeFileSync(join(dir, 'agy.cmd'), '@"%dp0%\\agy.js" %*\r\n');
  } else {
    writeFileSync(join(dir, 'agy'), `#!${process.execPath}\n${source}`);
    chmodSync(join(dir, 'agy'), 0o755);
  }
  return `${dir}${delimiter}${process.env.PATH ?? ''}`;
}

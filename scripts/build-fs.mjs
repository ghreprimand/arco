#!/usr/bin/env node
// Portable file steps for workspace build scripts, so `npm run build` works
// under cmd.exe and PowerShell as well as POSIX shells. Paths are relative to
// the current directory (npm runs workspace scripts in the workspace folder).
//
//   node ../scripts/build-fs.mjs rm <path>...            remove files or folders (missing is fine)
//   node ../scripts/build-fs.mjs copy <src>... <dest>/   copy files or folder contents into dest
import { cpSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const [command, ...args] = process.argv.slice(2);
if (command === 'rm' && args.length) {
  for (const p of args) rmSync(resolve(p), { recursive: true, force: true });
} else if (command === 'copy' && args.length >= 2) {
  const dest = resolve(args.at(-1));
  mkdirSync(dest, { recursive: true });
  for (const src of args.slice(0, -1)) {
    const from = resolve(src);
    if (statSync(from).isDirectory()) cpSync(from, dest, { recursive: true });
    else cpSync(from, join(dest, basename(from)));
  }
} else {
  console.error('usage: build-fs.mjs rm <path>... | copy <src>... <dest>');
  process.exit(2);
}

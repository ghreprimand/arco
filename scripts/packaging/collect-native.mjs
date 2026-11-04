#!/usr/bin/env node
// Collect the native artifacts built or supplied for this runner. The result is
// a build artifact, never installed in the source checkout or the Arco home.
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { scrubPeDebugPaths } from './pe-scrub.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.argv[2];
if (!output) throw new Error('Pass an empty output directory for the native artifacts.');
const platform = process.platform, arch = process.arch;
if (!['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch) || ![24, 26].includes(Number(process.versions.node.split('.')[0]))) throw new Error('A supported Node 24 or 26 runner is required.');
const name = `${platform}-${arch}`;
const destination = join(resolve(output), name);
if (existsSync(destination)) throw new Error('The native artifact destination already exists.');
const sqlitePlatform = platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? 'linuxmusl' : platform;
const sqlite = join(root, 'node_modules', 'better-sqlite3', 'prebuilds', `${sqlitePlatform}-${arch}.node`);
const ptyRoot = join(root, 'node_modules', 'node-pty');
const prebuild = join(ptyRoot, 'prebuilds', `${platform}-${arch}`);
const pty = existsSync(join(prebuild, 'pty.node')) ? prebuild : join(ptyRoot, 'build', 'Release');
if (!existsSync(sqlite) || !existsSync(join(pty, 'pty.node'))) throw new Error('Native modules are missing. Install and build dependencies before collection.');
// Construct a real SQLite database and load the terminal module.
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
new Database(':memory:').close();
mkdirSync(join(destination, 'pty'), { recursive: true });
copyFileSync(sqlite, join(destination, 'better_sqlite3.node'));
for (const item of readdirSync(pty)) {
  // Arco uses the OS ConPTY implementation; node-pty's optional private
  // ConPTY distribution is not used and contains signed build metadata.
  if (/\.pdb$/i.test(item) || (platform === 'win32' && item === 'conpty')) continue;
  const source = join(pty, item);
  if (statSync(source).isFile() || statSync(source).isDirectory()) cpSync(source, join(destination, 'pty', item), { recursive: true });
}
if (platform === 'darwin' && existsSync(join(destination, 'pty', 'spawn-helper'))) chmodSync(join(destination, 'pty', 'spawn-helper'), 0o755);
const files = {};
function record(dir, base = '') {
  for (const item of readdirSync(dir)) {
    const relative = base ? `${base}/${item}` : item; const path = join(dir, item); const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Unexpected native artifact type.');
    if (stat.isDirectory()) record(path, relative);
    else {
      let content = readFileSync(path);
      if (platform === 'win32' && /\.(?:node|dll|exe)$/i.test(item)) {
        const scrubbed = scrubPeDebugPaths(content);
        if (scrubbed.modified) { writeFileSync(path, scrubbed.bytes); content = scrubbed.bytes; }
      }
      const unsafe = (bytes) => {
        const pattern = /(?:\/home\/|\/Users\/|[A-Za-z]:[\\/](?:Users|a)[\\/])/i;
        const texts = [bytes.toString('latin1'), bytes.toString('utf16le'), bytes.subarray(1).toString('utf16le')];
        return texts.some((text) => pattern.test(text) || /(?:^|\0)[A-Za-z]:[\\/][ -~]{2,}\0/.test(text));
      };
      if (unsafe(content) && platform !== 'win32' && /(?:\.node|spawn-helper)$/.test(item)) {
        const stripped = spawnSync('strip', platform === 'darwin' ? ['-S', path] : ['--strip-debug', path], { encoding: 'utf8' });
        if (stripped.error || stripped.status !== 0) throw new Error('Could not strip private build metadata from a native artifact.');
        if (platform === 'darwin') {
          const signed = spawnSync('codesign', ['--force', '--sign', '-', path], { encoding: 'utf8' });
          if (signed.error || signed.status !== 0) throw new Error('Could not apply the required local executable signature.');
        }
        content = readFileSync(path);
      }
      if (unsafe(content)) throw new Error('A native artifact still contains an absolute local path.');
      files[relative] = createHash('sha256').update(content).digest('hex');
    }
  }
}
record(destination);
// Probe the collected bytes, not merely the installed originals: stripping or
// platform signing must not make a release artifact unloadable or unusable.
const verified = spawnSync(process.execPath, [join(root, 'scripts/packaging/probe-native.mjs'), destination], { encoding: 'utf8', timeout: 45000 });
if (verified.error || verified.status !== 0) {
  const markers = (verified.stdout || '').split(/\r?\n/).filter((line) => /^(sqlite-ready|terminal-loaded|terminal-started|terminal-exited|terminal-timeout)$/.test(line));
  throw new Error(`The collected native bindings did not pass the runtime probe (${markers.join(', ') || 'no milestones'}${verified.error?.code === 'ETIMEDOUT' ? ', process timed out' : ''}).`);
}
const dependencies = Object.fromEntries(['better-sqlite3', 'node-pty'].map((name) => [name, JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version]));
writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ platform, arch, binding: 'napi', node: process.versions.node, dependencies, files }, null, 2) + '\n');
console.log(`Collected ${name}; SQLite SHA-256: ${files['better_sqlite3.node']}`);

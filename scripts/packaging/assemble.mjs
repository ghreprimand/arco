#!/usr/bin/env node
// Assemble a package outside the source checkout. Native artifacts must come
// from matching platform runners, rather than from an install lifecycle script.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [output, nativeInput, mode] = process.argv.slice(2);
if (!output || !nativeInput || (mode && mode !== '--host-only')) throw new Error('Usage: node scripts/packaging/assemble.mjs <new-output-directory> <native-artifacts-directory> [--host-only]');
const destination = resolve(output), native = resolve(nativeInput);
if (existsSync(destination)) throw new Error('Output already exists. Choose a new directory.');
const targets = mode === '--host-only' ? [[process.platform, process.arch]] : ['linux', 'darwin', 'win32'].flatMap((platform) => ['x64', 'arm64'].map((arch) => [platform, arch]));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const nativeDependencies = Object.fromEntries(['better-sqlite3', 'node-pty'].map((name) => [name, lock.packages[`node_modules/${name}`].version]));
if (![24, 26].includes(Number(process.versions.node.split('.')[0]))) throw new Error('Assembly requires Node 24 or 26.');
for (const [platform, arch] of targets) {
  const dir = join(native, `${platform}-${arch}`);
  const metadata = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (metadata.platform !== platform || metadata.arch !== arch || metadata.binding !== 'napi' || Object.keys(nativeDependencies).some((name) => metadata.dependencies?.[name] !== nativeDependencies[name]) || !existsSync(join(dir, 'better_sqlite3.node')) || !existsSync(join(dir, 'pty', 'pty.node'))) throw new Error(`Invalid native artifact: ${platform}-${arch}`);
  const observed = {};
  function visit(current, base = '') {
    for (const name of readdirSync(current)) {
      if (!base && name === 'manifest.json') continue;
      const path = join(current, name), relative = base ? `${base}/${name}` : name, stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Unexpected native artifact type.');
      if (stat.isDirectory()) visit(path, relative);
      else observed[relative] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  visit(dir);
  if (JSON.stringify(Object.entries(observed).sort()) !== JSON.stringify(Object.entries(metadata.files || {}).sort())) throw new Error(`Native artifact integrity failed: ${platform}-${arch}`);
}
for (const path of ['server/dist/index.js', 'client/dist/index.html', 'shared/dist/index.js', 'scripts/packaging/arco.mjs']) if (!existsSync(join(root, path))) throw new Error(`Missing build input: ${path}`);
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const server = JSON.parse(readFileSync(join(root, 'server/package.json'), 'utf8'));
const packageName = JSON.parse(readFileSync(join(root, 'scripts/packaging/package-name.json'), 'utf8')).name;
const production = Object.fromEntries(Object.keys(server.dependencies).filter((name) => name !== '@arco/shared' && !name.startsWith('@types/')).map((name) => [name, lock.packages[`node_modules/${name}`].version]));
try {
  mkdirSync(destination, { recursive: true });
  const safeRuntimeFile = (path) => {
    const name = basename(path);
    if (/\.(?:png|jpe?g|gif|webp|avif|bmp|tiff?|wav|mp3|mp4|webm|m4a|mov|ogg|flac)$/i.test(name) && !path.includes(`${join('client', 'dist')}`) && !path.includes(`${join('server', 'dist')}`)) return false;
    return !/^(?:test|tests|testSupport|__tests__|devlog|screenshots?|fixtures)(?:\.[cm]?[jt]s)?$/i.test(name) && !/^test_.*\.[ch](?:pp)?$/i.test(name) && !/(?:\.(?:test|spec|test-support)\.|\.map$|\.pdb$)/i.test(name);
  };
  for (const item of ['server/dist', 'client/dist', 'shared/dist', 'server/src', 'shared/src', 'client/src', 'docs', 'README.md', 'CONTRIBUTING.md', 'scripts/voice', 'scripts/start.mjs', 'LICENSE']) cpSync(join(root, item), join(destination, item), { recursive: true, filter: safeRuntimeFile });
  mkdirSync(join(destination, 'scripts/packaging'), { recursive: true });
  for (const file of ['arco.mjs', 'services.mjs', 'launch.mjs', 'browsers.mjs', 'ports.mjs', 'service-logs.mjs', 'native-repair.mjs', 'update.mjs', 'storage.mjs']) cpSync(join(root, 'scripts/packaging', file), join(destination, 'scripts/packaging', file));
  const shared = join(destination, 'node_modules/@arco/shared');
  mkdirSync(shared, { recursive: true });
  cpSync(join(root, 'shared/dist'), join(shared, 'dist'), { recursive: true, filter: safeRuntimeFile });
  writeFileSync(join(shared, 'package.json'), JSON.stringify({ name: '@arco/shared', version: source.version, private: true, type: 'module', main: './dist/index.js', exports: './dist/index.js' }, null, 2));
  // The package carries the terminal JS and vetted native bindings. Bundling
  // its runtime without lifecycle scripts prevents npm from compiling on install.
  const ptySource = join(root, 'node_modules/node-pty'), pty = join(destination, 'node_modules/node-pty');
  mkdirSync(pty, { recursive: true });
  cpSync(join(ptySource, 'lib'), join(pty, 'lib'), { recursive: true, filter: safeRuntimeFile });
  cpSync(join(ptySource, 'typings'), join(pty, 'typings'), { recursive: true, filter: safeRuntimeFile });
  cpSync(join(ptySource, 'LICENSE'), join(pty, 'LICENSE'));
  const ptyManifest = JSON.parse(readFileSync(join(ptySource, 'package.json'), 'utf8'));
  delete ptyManifest.scripts; delete ptyManifest.devDependencies; delete ptyManifest.files;
  writeFileSync(join(pty, 'package.json'), JSON.stringify(ptyManifest, null, 2) + '\n');
  writeFileSync(join(destination, 'server/package.json'), JSON.stringify({ name: '@arco/server', version: source.version, private: true, type: 'module' }, null, 2));
  for (const [platform, arch] of targets) {
    const artifact = join(native, `${platform}-${arch}`);
    cpSync(artifact, join(destination, 'native', `${platform}-${arch}`), { recursive: true });
  }
  const licenses = join(destination, 'native', 'licenses'); mkdirSync(licenses, { recursive: true });
  for (const [name, sourceFile] of [['node-pty.txt', 'node_modules/node-pty/LICENSE'], ['winpty.txt', 'node_modules/node-pty/deps/winpty/LICENSE'], ['better-sqlite3.txt', 'node_modules/better-sqlite3/LICENSE'], ['node-addon-api.txt', 'node_modules/node-addon-api/LICENSE.md']]) cpSync(join(root, sourceFile), join(licenses, name));
  writeFileSync(join(licenses, 'NOTICE.md'), '# Bundled native components\n\nThe native bindings include node-pty, WinPTY, node-addon-api and better-sqlite3 under their respective MIT licenses in this directory. SQLite is public domain: https://sqlite.org/copyright.html. Windows diagnostic paths and macOS debug metadata are sanitized in the packaged copies.\n');
  const dependencies = { ...production, '@arco/shared': source.version };
  const manifest = { ...(mode === '--host-only' ? { private: true } : {}), arcoNativeDependencies: nativeDependencies, name: packageName, version: source.version, repository: { type: 'git', url: 'git+https://github.com/ghreprimand/arco.git' }, license: source.license, type: 'module', engines: { node: '^24.0.0 || ^26.0.0' }, bin: { arco: './scripts/packaging/arco.mjs' }, files: ['server/dist', 'server/package.json', 'client/dist', 'shared/dist', 'server/src', 'shared/src', 'client/src', 'docs', 'README.md', 'CONTRIBUTING.md', 'scripts/voice', 'scripts/start.mjs', 'scripts/packaging/arco.mjs', 'scripts/packaging/services.mjs', 'scripts/packaging/launch.mjs', 'scripts/packaging/browsers.mjs', 'scripts/packaging/ports.mjs', 'scripts/packaging/service-logs.mjs', 'scripts/packaging/native-repair.mjs', 'scripts/packaging/update.mjs', 'scripts/packaging/storage.mjs', 'native', 'LICENSE'], dependencies, bundleDependencies: ['@arco/shared', 'node-pty'] };
  writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Package assembled in ${destination}`);
} catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }

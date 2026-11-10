import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Every runtime version is locked. HTTPS-source packages are bundled below
// so installation never depends on reaching their original download host.
export function runtimeDependencySpec(name, declared, lock) {
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`Missing locked runtime dependency: ${name}`);
  return version;
}

export function archiveRuntimeDependencies(declared) {
  return Object.entries(declared).filter(([,spec]) => typeof spec === 'string' && spec.startsWith('https://')).map(([name]) => name);
}

/** Keep the imported SheetJS entry points and their codepage dependency intact. */
export function copyArchiveRuntimeDependency(name, source, destination, filter) {
  if (name !== 'xlsx') { cpSync(source, destination, { recursive: true, filter }); return; }
  mkdirSync(join(destination, 'dist'), { recursive: true });
  for (const file of ['xlsx.js', 'xlsx.mjs', 'dist/cpexcel.js', 'LICENSE']) cpSync(join(source, file), join(destination, file));
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  for (const key of ['bin', 'unpkg', 'jsdelivr', 'types', 'files', 'scripts', 'devDependencies']) delete manifest[key];
  manifest.exports = {
    '.': { import: './xlsx.mjs', require: './xlsx.js' },
    './xlsx.mjs': './xlsx.mjs', './xlsx.js': './xlsx.js',
    './dist/cpexcel.js': './dist/cpexcel.js', './package.json': './package.json',
  };
  writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
}

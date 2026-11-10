import { readdirSync } from 'node:fs';

export function snapshotTempFolders(root) {
  return new Set(readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('arco-'))
    .map(entry => entry.name));
}

export function remainingTempFolders(root, before) {
  return [...snapshotTempFolders(root)].filter(name => !before.has(name)).sort();
}

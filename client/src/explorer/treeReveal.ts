// Compare both path separators, retaining the tree's spelling for expansion keys.
export function treeRevealDirectories(path: string, treeRoot?: string | null): string[] | null {
  if (!treeRoot) return null;
  const root = treeRoot.replace(/[\\/]$/, '');
  const normalizedRoot = root.replace(/\\/g, '/');
  const normalizedPath = path.replace(/\\/g, '/');
  if (!normalizedPath.startsWith(normalizedRoot + '/')) return null;
  const segments = normalizedPath.slice(normalizedRoot.length + 1).split('/').filter(Boolean);
  const separator = root.includes('\\') ? '\\' : '/';
  const directories = [root];
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current += separator + segment;
    directories.push(current);
  }
  return directories;
}

export function canRevealInTree(path: string, treeRoot?: string | null): boolean {
  return !path.split(/[\\/]/).includes('.arco') && treeRevealDirectories(path, treeRoot) !== null;
}

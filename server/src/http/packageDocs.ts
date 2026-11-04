// Read only the package's shipped reference files. An npm prefix may itself be
// under a protected OS settings directory, so the ordinary project boundary is
// unsuitable here. Both lexical and canonical paths must stay in the allowed
// package subtrees, and sensitive path components remain forbidden.
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { assertSpellingSafe, FileAccessError, isPathWithin } from '../fileAccessPolicy.js';

function allowed(relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  return (parts[0] === 'docs' && parts.length > 1)
    || (['server', 'shared', 'client'].includes(parts[0]) && parts[1] === 'src' && parts.length > 2)
    || (parts.length === 1 && ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md'].includes(parts[0]));
}
export function packageDocPath(root: string, requested: string): string {
  if (!requested || path.isAbsolute(requested) || !allowed(requested)) throw new FileAccessError();
  const lexical = path.resolve(root, requested);
  if (!isPathWithin(root, lexical)) throw new FileAccessError();
  const canonicalRoot = realpathSync.native(root), canonical = realpathSync.native(lexical);
  if (!isPathWithin(canonicalRoot, canonical)) throw new FileAccessError();
  const relative = path.relative(canonicalRoot, canonical);
  if (!allowed(relative)) throw new FileAccessError();
  const publicRoot = path.join(path.parse(canonicalRoot).root, 'arco-public');
  assertSpellingSafe(path.resolve(publicRoot, requested));
  assertSpellingSafe(path.resolve(publicRoot, relative));
  if (!statSync(canonical).isFile()) throw new FileAccessError();
  return canonical;
}

import { matchesGlob, sep } from 'node:path';

// fs.glob accepts leading ./ and directory-ending patterns. Candidate matching
// needs an explicit directory spelling to preserve that behavior without walking
// ignored folders or nested checkouts through fs.glob again.
export function matchesProjectGlob(entry: string, pattern: string, directory: boolean): boolean {
  const normalized = pattern.replace(/^(?:\.\/)+/, '');
  return matchesGlob(entry, normalized) || (directory && matchesGlob(entry + sep, normalized));
}

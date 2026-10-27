import { readFileSync } from 'node:fs';
import { extractSection } from './helpers.mjs';

try {
  const [tag, ...extra] = process.argv.slice(2);
  if (!tag || extra.length) throw new Error('Usage: node scripts/release/notes.mjs vX.Y.Z');
  process.stdout.write(extractSection(readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'), tag));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

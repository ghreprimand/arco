import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : /\.(?:tsx?|js|css)$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : [];
  });
}
test('viewport units in interface styles account for interface scale', () => {
  const findings: string[] = [];
  for (const path of files(root)) {
    const source = readFileSync(path, 'utf8').replace(/\b\d+(?:\.\d+)?d?v[hw](?=\s*\/\s*var\(--ui-scale,\s*1\))/g, 'scaled');
    if (/\b\d+(?:\.\d+)?d?v[hw]\b/.test(source)) findings.push(path.slice(root.length + 1));
  }
  assert.deepEqual(findings, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeFilename, resolveChatFilePath, linkTextFiles } from './chatFileLinks';
test('Windows drive and UNC filenames pass recognition and prose linking', () => {
  for (const path of [String.raw`D:\Projects\fixture\report.md`, String.raw`\\fixture-server\share\report.md`]) {
    assert.equal(looksLikeFilename(path), true);
    const seen: string[] = [];
    linkTextFiles('Open ' + path + ' now.', name => resolveChatFilePath(name, '/projects/fixture'), name => { seen.push(name); return name; });
    assert.deepEqual(seen, [path]);
  }
});

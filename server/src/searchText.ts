import { readRegularPrefix, regularFileLines } from './boundedRead.js';
import { decodeLegacyText } from './fileContent/legacyText.js';
import { fileHeaderKind } from './fileContent.js';

// Search readable text but do not print byte-oriented document and media data.
export async function isSearchableTextFile(path: string, verifyAll = false): Promise<boolean> {
  const { buffer } = await readRegularPrefix(path, 8192);
  const kind = fileHeaderKind(buffer);
  if (!(kind === 'text/plain' || kind === 'application/rtf' || kind === 'invalid-utf8' || kind === 'text/utf-16le' || kind === 'text/utf-16be')) return false;
  if (kind === 'invalid-utf8' && decodeLegacyText(buffer) === null) return false;
  if (verifyAll) {
    try { for await (const _ of regularFileLines(path, 0, undefined, true)) { /* verify the whole file */ } }
    catch { return false; }
  }
  return true;
}

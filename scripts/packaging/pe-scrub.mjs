// Remove build-machine paths from unsigned PE debug records and diagnostic
// source-file strings. Runtime code and GUIDs are not modified. Signed images
// fail closed instead of invalidating a signature. Unknown paths are rejected.
export function scrubPeDebugPaths(input) {
  const data = Buffer.from(input);
  const u16 = (at) => { if (at < 0 || at + 2 > data.length) throw new Error('Invalid PE metadata.'); return data.readUInt16LE(at); };
  const u32 = (at) => { if (at < 0 || at + 4 > data.length) throw new Error('Invalid PE metadata.'); return data.readUInt32LE(at); };
  if (data.length < 64 || data.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid PE image.');
  const pe = u32(0x3c);
  if (pe + 24 > data.length || data.toString('binary', pe, pe + 4) !== 'PE\0\0') throw new Error('Invalid PE image.');
  const count = u16(pe + 6), optSize = u16(pe + 20), opt = pe + 24, magic = u16(opt);
  if (![0x10b, 0x20b].includes(magic)) throw new Error('Unsupported PE image.');
  const directories = opt + (magic === 0x20b ? 112 : 96), numberOffset = opt + (magic === 0x20b ? 108 : 92);
  if (u32(numberOffset) < 7 || directories + 56 > opt + optSize) return { bytes: data, modified: false };
  const certificate = u32(directories + 32), certificateSize = u32(directories + 36);
  const debugRva = u32(directories + 48), debugSize = u32(directories + 52);
  if ((!certificate) !== (!certificateSize) || (!debugRva && debugSize)) throw new Error('Invalid PE directory.');
  if (debugSize % 28 !== 0 || debugSize > 1024 * 1024) throw new Error('Invalid PE debug directory.');
  const sections = opt + optSize;
  function toOffset(rva, size) {
    for (let i = 0; i < count; i++) {
      const s = sections + i * 40, start = u32(s + 12), bytes = u32(s + 16), raw = u32(s + 20);
      if (rva >= start && rva - start <= bytes && size <= bytes - (rva - start) && raw + (rva - start) + size <= data.length) return raw + rva - start;
    }
    throw new Error('Invalid PE debug address.');
  }
  const start = debugRva && debugSize ? toOffset(debugRva, debugSize) : 0; let modified = false;
  for (let offset = start; offset < start + debugSize; offset += 28) {
    if (u32(offset + 12) !== 2) continue;
    const length = u32(offset + 16), pointer = u32(offset + 24);
    if (length < 25 || pointer + length > data.length || data.toString('ascii', pointer, pointer + 4) !== 'RSDS') continue;
    const begin = pointer + 24, end = data.indexOf(0, begin);
    if (end < begin || end >= pointer + length) throw new Error('Invalid PE CodeView path.');
    const prior = data.toString('utf8', begin, end);
    if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(prior)) continue;
    if (certificate && certificateSize) throw new Error('A signed native artifact contains an absolute debug path.');
    data.fill(0, begin, end);
    const placeholder = Buffer.from('arco.pdb');
    placeholder.copy(data, begin, 0, Math.min(placeholder.length, end - begin));
    modified = true;
  }
  // WinPTY embeds __FILE__ strings for assertion diagnostics. Preserve each
  // string's length and basename so existing references remain valid, but
  // replace its absolute directory with neutral characters. Only complete,
  // NUL-terminated source-file strings in the read-only data section qualify.
  for (let i = 0; i < count; i++) {
    const section = sections + i * 40;
    const name = data.toString('ascii', section, section + 8).replace(/\0/g, '');
    if (name !== '.rdata') continue;
    const raw = u32(section + 20), size = u32(section + 16);
    if (raw + size > data.length) throw new Error('Invalid PE section.');
    let cursor = raw;
    while (cursor < raw + size) {
      const end = data.indexOf(0, cursor);
      if (end < 0 || end >= raw + size) break;
      const value = data.toString('latin1', cursor, end);
      if (/^[A-Za-z]:[\\/][ -~]*\.(?:c|cc|cpp|h|hpp)$/i.test(value)) {
        if (certificate && certificateSize) throw new Error('A signed native artifact contains an absolute source path.');
        const slash = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
        if (slash >= 0) { data.fill(0x5f, cursor, cursor + slash + 1); modified = true; }
      }
      cursor = end + 1;
    }
    // The same diagnostic paths may be compiled as UTF-16LE literals.
    for (let position = raw; position + 8 < raw + size; position++) {
      if (position > raw + 1 && (data[position - 1] !== 0 || data[position - 2] !== 0)) continue;
      if (!/[A-Za-z]/.test(String.fromCharCode(data[position])) || data[position + 1] !== 0 || data[position + 2] !== 0x3a || data[position + 3] !== 0 || ![0x2f, 0x5c].includes(data[position + 4]) || data[position + 5] !== 0) continue;
      let end = position, value = '';
      while (end + 1 < raw + size && value.length < 512) {
        const character = data.readUInt16LE(end); if (character === 0) break;
        if (character < 32 || character > 126) { value = ''; break; }
        value += String.fromCharCode(character); end += 2;
      }
      if (!/^[A-Za-z]:[\\/][ -~]*\.(?:c|cc|cpp|h|hpp)$/i.test(value) || end + 1 >= raw + size || data.readUInt16LE(end) !== 0) continue;
      if (certificate && certificateSize) throw new Error('A signed native artifact contains an absolute source path.');
      const slash = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
      for (let j = 0; j <= slash; j++) data.writeUInt16LE(0x5f, position + j * 2);
      modified = true; position = end + 1;
    }
  }
  return { bytes: data, modified };
}

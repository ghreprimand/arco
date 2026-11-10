/** Cheap content classification for search walkers; never decodes binary as text. */
export function fileHeaderKind(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = b.subarray(0, 256), ascii = start.toString('latin1');
  if (b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(ascii)) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8,12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('BM') && b.length >= 26 && [12,40,52,56,108,124].includes(b.readUInt32LE(14))) return 'image/bmp';
  if (b.subarray(0,4).equals(Buffer.from([73,73,42,0])) || b.subarray(0,4).equals(Buffer.from([77,77,0,42]))) return 'image/tiff';
  if (ascii.slice(4,8) === 'ftyp') return /heic|heix|hevc|hevx|mif1|msf1/.test(ascii.slice(8)) ? 'image/heic' : /M4A /.test(ascii.slice(8)) ? 'audio/mp4' : 'video/mp4';
  if (ascii.startsWith('%PDF-')) return 'application/pdf';
  if (b[0] === 80 && b[1] === 75 && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6) || (b[2] === 7 && b[3] === 8))) return 'application/zip';
  if (b.subarray(0,8).equals(Buffer.from([208,207,17,224,161,177,26,225]))) return 'application/x-ole-storage';
  if (ascii.startsWith('{\\rtf')) return 'application/rtf';
  if (b[0] === 255 && b[1] === 254) return 'text/utf-16le';
  if (b[0] === 254 && b[1] === 255) return 'text/utf-16be';
  if (ascii.startsWith('ID3') || (b[0] === 255 && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii.startsWith('RIFF') && ascii.slice(8,12) === 'WAVE') return 'audio/wav';
  if (ascii.startsWith('fLaC')) return 'audio/flac';
  if (ascii.startsWith('OggS')) return 'application/ogg';
  if (ascii.startsWith('SQLite format 3')) return 'application/vnd.sqlite3';
  if (ascii.startsWith('MZ') || ascii.startsWith('\x7fELF')) return 'application/x-executable';
  if (b.includes(0)) return 'application/octet-stream';
  try { new TextDecoder('utf-8',{fatal:true}).decode(b,{stream:true}); return 'text/plain'; }
  catch { return 'invalid-utf8'; }
}

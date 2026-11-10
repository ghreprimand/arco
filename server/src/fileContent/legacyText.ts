/** Windows-1252 is used only when each bounded chunk looks like text. */
export function isLegacyTextChunk(bytes: Uint8Array): boolean {
  let controls = 0;
  for (const value of bytes) {
    if (value === 0) return false;
    if (value < 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0b && value !== 0x0c && value !== 0x0d && value !== 0x1b) controls++;
  }
  return controls === 0 || controls * 100 < bytes.length;
}

export function decodeLegacyText(bytes: Uint8Array): string | null {
  for (let start = 0; start < bytes.length; start += 16384) {
    if (!isLegacyTextChunk(bytes.subarray(start, start + 16384))) return null;
  }
  return new TextDecoder('windows-1252').decode(bytes);
}

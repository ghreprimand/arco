// A portable single folder name for explicit project creation.
export function newFolderNameError(name: string): string | null {
  if (!name || !name.trim()) return 'Enter a folder name.';
  if (name !== name.trim()) return 'Remove leading or trailing spaces from the folder name.';
  if (name.startsWith('.') || name.endsWith('.')) return 'Use a name that does not start or end with a dot.';
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) return 'Use one folder name without path separators or reserved characters.';
  const stem = name.split('.')[0].replace(/ +$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) return 'Choose a name that is not reserved by Windows.';
  if (new TextEncoder().encode(name).length > 255) return 'Use a folder name of at most 255 bytes.';
  return null;
}

// The phone key row sends the same bytes a physical terminal keyboard sends.
export const PHONE_TERMINAL_KEYS = [
  ['ESC', '\u001b'], ['TAB', '\t'], ['←', '\u001b[D'], ['↓', '\u001b[B'],
  ['↑', '\u001b[A'], ['→', '\u001b[C'], ['|', '|'], ['~', '~'],
] as const;

export function phoneControlInput(data: string): string {
  return /^[a-z]$/i.test(data) ? String.fromCharCode(data.toUpperCase().charCodeAt(0) - 64) : data;
}

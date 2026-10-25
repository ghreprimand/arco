// Ctrl+K — Ghostty/readline kill-to-end-of-line, shared by the Agent composer
// (TerminalInput) and the Chat-tab composer (ChatModeView). Deletes from the
// cursor to the end of the current line; at a line end it eats the newline and
// joins the next line. No clipboard — a fast-delete, not a cut.
//
// Returns true when the event was a Ctrl+K (handled, default prevented) so the
// caller can stop routing it. preventDefault is load-bearing: without it
// Chrome's Ctrl+K "search in address bar" steals focus — which is exactly what
// the Chat composer did before it shared this helper.
export function handleKillLine(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  setValue: (next: string) => void,
): boolean {
  if (!(e.ctrlKey && e.key === 'k' && !e.metaKey && !e.altKey)) return false;
  e.preventDefault();
  const ta = e.currentTarget;
  const cursor = ta.selectionStart;
  const text = ta.value;
  let lineEnd = text.indexOf('\n', cursor);
  if (lineEnd === -1) lineEnd = text.length;
  const deleteTo = cursor === lineEnd && lineEnd < text.length ? lineEnd + 1 : lineEnd;
  if (deleteTo === cursor) return true;
  setValue(text.slice(0, cursor) + text.slice(deleteTo));
  queueMicrotask(() => {
    ta.selectionStart = ta.selectionEnd = cursor;
  });
  return true;
}

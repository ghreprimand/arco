// DEBAG (docs/PROVIDERS.md) - edit-then-approve arg parsing for the gate card.
//
// Pure so it can be unit/smoke-tested without React. Turns the operator's edited
// textarea content back into tool args: a Bash command edits its command line in
// place; any other tool edits pretty JSON of its full input. Returns undefined
// when the text is unchanged (a plain approve, not an edit) and throws on
// invalid JSON so the caller can surface the error instead of sending garbage.

export function buildGateFinalArgs(
  toolName: string,
  originalText: string,
  editedText: string,
  proposedArgs: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (editedText === originalText) return undefined;
  if (toolName === 'Bash') return { ...proposedArgs, command: editedText };
  const parsed = JSON.parse(editedText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('edited args must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

// Render the proposed args into the editable textarea: a Bash command shows its
// command line; any other tool shows pretty JSON of its input.
export function renderGateArgs(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof args.command === 'string') return args.command;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

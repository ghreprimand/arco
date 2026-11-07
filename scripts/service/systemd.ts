// systemd.syntax quoting, with specifier escaping. Environment assignments and
// directory values do not expand dollars; ExecStart arguments do.
export function systemdValue(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Unsupported control character in service configuration');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}
export function systemdArg(value: string): string {
  return systemdValue(value.replace(/\$/g, '$$$$'));
}

// WorkingDirectory is one path, not a command-line word: quotes are literal.
export function systemdDirectory(value: string): string {
  if (!value.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(value) || value.trim() !== value) throw new Error('Unsupported service working directory');
  return value.replace(/%/g, '%%');
}

// The model's shell tool: "Bash", or "PowerShell" on Windows without Git Bash
// (as in Claude Code, which registers a PowerShell tool there instead of Bash).
// Every check, card and summary that treats Bash specially treats PowerShell
// the same way, so no safety check is lost to the name.
export const SHELL_TOOL_NAMES = ['Bash', 'PowerShell'] as const;

export function isShellToolName(name: unknown): boolean {
  return name === 'Bash' || name === 'PowerShell';
}

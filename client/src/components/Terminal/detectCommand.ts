// docs/ARCHITECTURE.md - shell-command code-block detector.
//
// A pure, unit-testable function (smoke: scripts/smoke/terminal-prefill.ts)
// that decides whether a fenced code block in an agent reply is a SHELL
// command worth offering a "Run in terminal" chip on, and — if so — what text
// to pre-fill on the PTY input line.
//
// THE load-bearing fence lives downstream (the prefill path appends NO
// newline so nothing auto-runs); this detector only classifies + extracts.
// It NEVER decides to run anything.

// Info-strings (the token right after the opening ```) we treat as shell.
// Case-insensitive. `console` is the markdown convention for a shell session
// transcript (often `$ `-prefixed lines), so it qualifies too.
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'console', 'zsh']);

// Normalize a ReactMarkdown `language-xxx` className (or a bare info-string)
// to the language token. Returns '' when there's no recognizable info-string.
export function extractLang(infoStringOrClassName: string | undefined | null): string {
  if (!infoStringOrClassName) return '';
  // ReactMarkdown hands the <code> element a className like "language-bash".
  // Pull the first language-* token; otherwise treat the whole string as the
  // raw info-string (e.g. when callers pass it directly).
  const m = /(?:^|\s)language-([\w.+-]+)/.exec(infoStringOrClassName);
  const raw = m ? m[1] : infoStringOrClassName.trim();
  // An info-string can carry extras after the language (```bash {.line-numbers}).
  // Only the leading token is the language.
  return (raw.split(/\s+/)[0] || '').toLowerCase();
}

// Is this language token one we offer the chip on?
export function isShellLang(lang: string): boolean {
  return SHELL_LANGS.has(lang.toLowerCase());
}

export interface DetectResult {
  // True when the block qualifies for a "Run in terminal" chip.
  isShell: boolean;
  // The command text to PRE-FILL on the PTY input line (no trailing newline is
  // ever added downstream). Empty when !isShell.
  command: string;
}

// Strip a single leading shell prompt (`$ ` or `# `) from one line. Used only
// for `console`-style transcripts, where the convention is `$ <command>`.
// Multi-line blocks keep their content verbatim (the operator edits) EXCEPT a
// single-line console block, where the prompt is noise.
function stripPromptPrefix(line: string): string {
  return line.replace(/^[$#]\s+/, '');
}

// Classify a fenced code block. `infoStringOrClassName` is either the markdown
// info-string (`bash`) or ReactMarkdown's `language-bash` className. `content`
// is the raw block body (without the fences). Trailing newline is trimmed so
// the pre-fill never carries the fence's terminating newline (which would, by
// itself, submit the line — the whole point of K3 is no auto-run).
export function detectCommand(
  infoStringOrClassName: string | undefined | null,
  content: string,
): DetectResult {
  const lang = extractLang(infoStringOrClassName);
  if (!isShellLang(lang)) return { isShell: false, command: '' };

  // Drop a single trailing newline (markdown fences always carry one). We do
  // NOT collapse interior newlines — a multi-line block is pre-filled whole so
  // the operator can review/edit it; the shell handles multi-line paste.
  let body = content.replace(/\n$/, '');

  // `console` single-line transcripts conventionally start with `$ `; strip it
  // so the pre-fill is the bare command. Multi-line console blocks are left
  // verbatim (mixing commands + output — the operator edits).
  if (lang === 'console' && !body.includes('\n')) {
    body = stripPromptPrefix(body);
  }

  const command = body.trim();
  // An empty block (e.g. ```bash``` with nothing inside) isn't worth a chip.
  if (command.length === 0) return { isShell: false, command: '' };

  return { isShell: true, command };
}

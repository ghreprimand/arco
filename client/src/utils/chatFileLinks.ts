import { createElement, Fragment, type ReactNode } from 'react';

// Heuristic for "this string is a filename": ends in a 1–8-char alpha-leading
// extension, allowed body chars are word/dot/slash/dash. URLs are rejected by
// resolveChatFilePath before we get here. False positives are tolerable —
// clicking a non-file just opens FileViewerModal which renders a clean error.
const FILENAME_RE = /^[\w./_-]+\.[A-Za-z][A-Za-z0-9]{0,7}$/;

export function looksLikeFilename(s: string | undefined | null): boolean {
  if (!s) return false;
  const trimmed = s.trim();
  if (trimmed.length < 3 || trimmed.length > 200) return false;
  return FILENAME_RE.test(trimmed);
}

// Index of files the agent has touched via Read/Write/Edit tool calls in the
// current workflow. Built upstream from displayMessages (see ChatPanel).
// `byBasename` keys on the bare filename (`audit.md`); `byTail` keys on
// trailing-N-segments (`reports/audit.md`) so partial paths resolve too.
export interface WrittenFilesIndex {
  byBasename: Map<string, string>;
  byTail: Map<string, string>;
}

// Resolve a path string from chat markdown to an absolute filesystem path
// the /api/file-content endpoint can serve. Resolution order:
//   1. Index of files the agent actually touched (most reliable).
//   2. Absolute path as-is.
//   3. cwd-relative join (last-resort heuristic — may 404 if the agent put
//      the file somewhere else; the server-side fallback in /api/file-content
//      then tries the workflow's artifacts dir before giving up).
// Returns null for things we can't or shouldn't open (URLs, anchors, ~/…).
export function resolveChatFilePath(
  raw: string,
  cwd: string | undefined,
  index?: WrittenFilesIndex,
): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null; // http://, file://, etc.
  if (t.startsWith('#') || t.startsWith('mailto:')) return null;
  if (t.startsWith('~/')) return null;

  if (index) {
    const stripped = t.startsWith('./') ? t.slice(2) : t;
    const tailHit = index.byTail.get(stripped.replace(/\\/g, '/'));
    if (tailHit) return tailHit;
    const base = stripped.split(/[\\/]/).pop() || '';
    const baseHit = index.byBasename.get(base);
    if (baseHit) return baseHit;
  }

  if (t.startsWith('/') || WINDOWS_ABSOLUTE_RE.test(t)) return t;
  if (!cwd) return null;
  // Relative names are sent as written. The server resolves them against the
  // bound project folder and then the workflow's artifacts folder, and reports
  // the path it actually read; the viewer never shows a guessed join.
  return t.startsWith('./') || t.startsWith('.\\') ? t.slice(2) : t;
}

const WINDOWS_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

const FILENAME_TOKEN_RE = /(?<![\w./\\:-])((?:[A-Za-z]:)?[\w./\\_-]+\.[A-Za-z][A-Za-z0-9]{0,7})(?![\w-])/g;

// Link filenames inside prose text: a whole line that is one filename links
// (the viewer reports a missing file), while a filename inside a sentence links
// only when it matches a file the agent wrote or the workflow's artifacts.
export function linkTextFiles(
  node: ReactNode,
  resolve: (name: string, strict: boolean) => string | null,
  render: (filePath: string, label: ReactNode, key: string) => ReactNode,
): ReactNode {
  if (Array.isArray(node)) return node.map((n, i) => (typeof n === 'string' ? createElement(Fragment, { key: i }, linkTextFiles(n, resolve, render)) : n));
  if (typeof node !== 'string') return node;
  const out: ReactNode[] = [];
  node.split('\n').forEach((line, li, lines) => {
    const whole = line.trim();
    const wholePath = whole && looksLikeFilename(whole) ? resolve(whole, false) : null;
    if (wholePath) {
      const at = line.indexOf(whole);
      if (at > 0) out.push(line.slice(0, at));
      out.push(render(wholePath, whole, `l${li}`));
      const rest = line.slice(at + whole.length);
      if (rest) out.push(rest);
    } else {
      let last = 0;
      for (const m of line.matchAll(FILENAME_TOKEN_RE)) {
        const p = looksLikeFilename(m[1]) ? resolve(m[1], true) : null;
        if (!p) continue;
        const at = m.index ?? 0;
        if (at > last) out.push(line.slice(last, at));
        out.push(render(p, m[1], `l${li}t${at}`));
        last = at + m[1].length;
      }
      out.push(last ? line.slice(last) : line);
    }
    if (li < lines.length - 1) out.push('\n');
  });
  return out.length === 1 ? out[0] : createElement(Fragment, null, ...out);
}


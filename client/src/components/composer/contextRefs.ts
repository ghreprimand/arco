// Context-reference parser for the composer (WORKBENCH_EXPANSION_PLAN.md §D1).
//
// The operator types inline `@`-refs in the composer — `@file:src/x.ts`,
// `@diff`, `@staged`, `@git:3`, `@url:…` — and Archon expands them into the
// turn's context at send time (server-side). This module is the PARSE half:
// it turns the raw composer text into a structured list of refs so the
// composer can render a chip per ref (with a remove affordance) and so the
// server can expand each one.
//
// LOAD-BEARING: this file is pure and DOM-free. It is imported by both the
// React composer (TerminalInput.tsx) AND the headless smoke (which runs under
// tsx, no DOM). Do NOT add React / browser imports here, or the smoke breaks
// and the parser stops being unit-testable in isolation.
//
// Scope note (director decision, §D1): `@url:` is parsed as a KNOWN ref kind
// so the chip renders and the grammar is stable, but the server expands it to
// a "not yet supported" notice rather than fetching — a safe SSRF-guarded
// fetch is a security-sensitive sub-phase of its own and is deferred. Keeping
// it a recognized kind here means turning it on later is a localized change
// (the parser already classifies it; only the server expander changes).

export type ContextRefKind = 'file' | 'diff' | 'staged' | 'git' | 'url';

export interface ContextRef {
  kind: ContextRefKind;
  // The raw matched token, exactly as it appeared in the text (including the
  // leading `@`). Used as the chip label and to strip/replace the ref later.
  raw: string;
  // Kind-specific payload:
  //   file → the path argument (e.g. "src/x.ts")
  //   git  → undefined (count carried on `count`)
  //   url  → the URL argument
  //   diff / staged → undefined (no argument)
  arg?: string;
  // `@git:N` only — the parsed positive integer N. Undefined for other kinds.
  count?: number;
  // Character offsets of `raw` within the source text. Lets the composer
  // highlight / a future inline-strip remove the exact span.
  start: number;
  end: number;
}

// Hard cap on `@git:N`, mirrored server-side. A composer that types `@git:9999`
// gets clamped at expansion time; we still parse the real number here so the
// chip can show what the operator typed (and the server clamps + notes it).
export const MAX_GIT_COUNT = 50;

// One regex, anchored on `@` at a word boundary so we don't match an `@` that
// is mid-token (e.g. an email "a@b.com" or an npm scope "@scope/pkg" used as
// prose). A ref must be preceded by start-of-string or whitespace.
//
// Token bodies:
//   @file:<path>   path runs to the next whitespace (paths with spaces aren't
//                  supported inline — operators quote-free here; a spaced path
//                  is rare and the attach button covers it).
//   @diff          bare keyword.
//   @staged        bare keyword.
//   @git:<digits>  digits only; `@git:abc` does NOT match the git arm and is
//                  left as plain text (not a recognized ref).
//   @url:<url>     url runs to the next whitespace.
//
// The keyword arms (`diff`/`staged`) require a trailing non-word boundary so
// `@diffstat` or `@difftool` aren't misread as `@diff` + "stat".
const REF_RE =
  /(^|\s)@(?:(file):(\S+)|(diff)\b|(staged)\b|(git):(\d+)\b|(url):(\S+))/g;

// Parse all `@`-refs out of `text`. Pure, deterministic, DOM-free. Returns the
// refs in source order; duplicates are preserved (the operator may legitimately
// reference two different files, or the same file twice — the chip list de-dups
// for display via the component, not here).
export function parseContextRefs(text: string): ContextRef[] {
  const refs: ContextRef[] = [];
  if (typeof text !== 'string' || text.length === 0) return refs;

  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(text))) {
    const lead = m[1] ?? '';
    // `start` skips the leading whitespace/BOS captured in group 1 so `raw`
    // begins exactly at the `@`.
    const start = m.index + lead.length;
    const raw = m[0].slice(lead.length);
    const end = start + raw.length;

    if (m[2] === 'file') {
      refs.push({ kind: 'file', raw, arg: m[3], start, end });
    } else if (m[4] === 'diff') {
      refs.push({ kind: 'diff', raw, start, end });
    } else if (m[5] === 'staged') {
      refs.push({ kind: 'staged', raw, start, end });
    } else if (m[6] === 'git') {
      const n = Number(m[7]);
      refs.push({ kind: 'git', raw, count: Number.isInteger(n) ? n : undefined, start, end });
    } else if (m[8] === 'url') {
      refs.push({ kind: 'url', raw, arg: m[9], start, end });
    }
  }
  return refs;
}

// A short human label for a chip. Kept tiny — the chip itself is small.
export function contextRefLabel(ref: ContextRef): string {
  switch (ref.kind) {
    case 'file':
      return `@file:${ref.arg ?? ''}`;
    case 'diff':
      return '@diff';
    case 'staged':
      return '@staged';
    case 'git':
      return `@git:${ref.count ?? '?'}`;
    case 'url':
      return `@url (deferred)`;
  }
}

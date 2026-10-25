import type { ReactNode } from 'react';

// Match http(s):// and bare www. URLs. Intentionally greedy on the tail
// (`[^\s<>]+`); we trim common trailing punctuation post-match so a URL at
// the end of a sentence doesn't swallow the terminating `.`, `,`, `)` etc.
const URL_RE = /(https?:\/\/[^\s<>]+|www\.[^\s<>]+)/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}>'"»]+$/;

// Turn a plain-text string into an array of React nodes, wrapping each URL
// in an `<a target="_blank">`. Preserves surrounding whitespace so the
// caller can render inside a `white-space: pre-wrap` container and still
// get correct line breaks.
export function linkifyText(text: string): ReactNode[] {
  if (!text) return [text];
  const out: ReactNode[] = [];
  let lastIdx = 0;
  let key = 0;
  for (const match of text.matchAll(URL_RE)) {
    const idx = match.index ?? 0;
    const raw = match[0];
    // Strip trailing punctuation off the URL so `see https://x.com.` links
    // the URL but leaves the sentence-ending period as plain text.
    const punctMatch = raw.match(TRAILING_PUNCT_RE);
    const trailing = punctMatch ? punctMatch[0] : '';
    const url = trailing ? raw.slice(0, raw.length - trailing.length) : raw;
    const href = url.startsWith('www.') ? `http://${url}` : url;
    if (idx > lastIdx) out.push(text.slice(lastIdx, idx));
    out.push(
      <a
        key={`u${key++}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: 'inherit', textDecoration: 'underline' }}
      >
        {url}
      </a>,
    );
    if (trailing) out.push(trailing);
    lastIdx = idx + raw.length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out.length > 0 ? out : [text];
}

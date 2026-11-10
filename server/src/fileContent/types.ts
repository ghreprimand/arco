import type { FileContentOptions, FileContentResult, FileContentBlock } from '../fileContent.js';
export type { FileContentOptions, FileContentResult, FileContentBlock };
export function positive(value: number | undefined, fallback: number, max: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.min(max, Math.floor(value!)) : fallback;
}
export function selection(range: string | undefined, count: number, cap = 100): number[] {
  if (!range) return Array.from({ length: Math.min(count, cap) }, (_, i) => i);
  const indices = new Set<number>();
  for (const part of range.split(',')) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!match) throw new Error('Use a one-based range such as pages="1-3,5".');
    const first = Number(match[1]), last = Number(match[2] ?? first);
    if (first < 1 || last < first || last > count || last - first >= cap) throw new Error(`Range must fit within 1-${count}, at most ${cap} units per read.`);
    for (let i = first - 1; i < last; i++) { indices.add(i); if (indices.size > cap) throw new Error(`Select at most ${cap} units per read.`); }
  }
  return [...indices].sort((a, b) => a - b);
}
export function textResult(kind: string, text: string, options: FileContentOptions, blocks?: FileContentBlock[], truncated = false): FileContentResult {
  const lines = text.split('\n');
  const offset = positive(options.offset, 1, Number.MAX_SAFE_INTEGER) - 1;
  const limit = options.limit === undefined ? lines.length : positive(options.limit, lines.length, Number.MAX_SAFE_INTEGER);
  const ranged = lines.slice(offset, offset + limit).join('\n');
  const cap = positive(options.limits?.maxTextBytes, 256 * 1024, 1024 * 1024);
  const data = Buffer.from(ranged);
  truncated ||= data.length > cap || offset + limit < lines.length;
  const bounded = new TextDecoder().decode(data.subarray(0, cap)) + (truncated ? '\n[Output truncated; use pages, offset or limit for another range.]' : '');
  return { text: bounded, blocks: blocks ?? [{ type: 'text', text: bounded }], kind, truncated, isError: false };
}

/** Binary receipts describe the file, not a requested range of text lines. */
export function binaryResult(name: string, size: number, kind: string, options: FileContentOptions): FileContentResult {
  return textResult('binary', `file: ${name}, ${kind === 'invalid-utf8' ? 'invalid UTF-8' : kind + ' binary'}, ${size} bytes; not sent as text.`, { limits: options.limits });
}

export function legacyTextResult(text: string, options: FileContentOptions, truncated = false): FileContentResult {
  const result = textResult('text', text, options, undefined, truncated);
  const marked = '[decoded as Windows-1252]\n' + result.text;
  return { ...result, text: marked, blocks: [{ type: 'text', text: marked }] };
}

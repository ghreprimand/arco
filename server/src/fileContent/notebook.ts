import { imageResult } from './images.js';
import { positive, selection, textResult, type FileContentOptions, type FileContentResult, type FileContentBlock } from './types.js';
const string = (v: unknown): string => typeof v === 'string' ? v : Array.isArray(v) ? v.filter(x => typeof x === 'string').join('') : '';
export async function notebookResult(value: Record<string, unknown>, name: string, options: FileContentOptions): Promise<FileContentResult> {
  const cells = value.cells as Array<Record<string, unknown>>, chosen = selection(options.pages, cells.length, 100);
  const lines = [`document: ${name}, notebook, cells ${chosen.map(i => i + 1).join(', ')} of ${cells.length}`];
  const images: FileContentBlock[] = [];
  const cap = positive(options.limits?.maxImages, 20, 100); let count = 0;
  for (const index of chosen) {
    const cell = cells[index]; lines.push(`\nCell ${index + 1} (${String(cell.cell_type ?? 'unknown')})`, string(cell.source));
    for (const output of Array.isArray(cell.outputs) ? cell.outputs : []) {
      if (!output || typeof output !== 'object') continue;
      const o = output as Record<string, unknown>; const data = (o.data ?? {}) as Record<string, unknown>;
      const text = string(o.text) || string(data['text/plain']) || string(o.evalue);
      if (text) lines.push(`Output: ${text}`);
      for (const media of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']) {
        const encoded = string(data[media]); if (!encoded) continue;
        if (media === 'image/svg+xml') { lines.push(`SVG output (text only):\n${encoded}`); continue; }
        if (count++ >= cap) { lines.push('[More image outputs omitted; select fewer cells with pages.]'); continue; }
        if (encoded.length > 32 * 1024 * 1024) { lines.push('[Image output exceeds the decoding limit.]'); continue; }
        try { images.push(...(await imageResult(Buffer.from(encoded, 'base64'), `${name} cell ${index + 1}`, options)).blocks); }
        catch { lines.push(`[Cell ${index + 1} image output could not be decoded.]`); }
      }
    }
  }
  const result = textResult('notebook', lines.join('\n'), options, undefined, chosen.length < cells.length);
  return { ...result, blocks: [...result.blocks, ...images] };
}

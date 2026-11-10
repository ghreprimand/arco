import { svgResult } from './svg.js';
import { fileHeaderKind } from './detect.js';
import { officeResult, rtfResult } from './office.js';
import { notebookResult } from './notebook.js';
import { parentPort } from 'node:worker_threads';
import { isUtf8 } from 'node:buffer';
import { imageType, imageResult } from './images.js';
import { pdfResult } from './pdf.js';
import { textResult, type FileContentOptions } from './types.js';

parentPort!.once('message', async ({ data, name, options }: { data: Uint8Array; name: string; options: FileContentOptions }) => {
  const bytes = Buffer.from(data);
  try {
    const image = imageType(bytes);
    if (image) { parentPort!.postMessage(await imageResult(bytes, name, options)); return; }
    if (bytes.subarray(0, 5).toString() === '%PDF-') { parentPort!.postMessage(await pdfResult(bytes, name, options)); return; }
    if (fileHeaderKind(bytes) === 'application/zip' || bytes.subarray(0, 8).equals(Buffer.from([208,207,17,224,161,177,26,225]))) { parentPort!.postMessage(await officeResult(bytes, name, options)); return; }
    if (bytes.subarray(0, 5).toString() === '{\\rtf') { parentPort!.postMessage(await rtfResult(bytes, name, options)); return; }
    const kind = fileHeaderKind(bytes);
    if (kind === 'text/utf-16le' || kind === 'text/utf-16be') {
      const text = new TextDecoder(kind.slice(5), { fatal: true }).decode(bytes.subarray(2));
      parentPort!.postMessage(textResult('text', text, options)); return;
    }
    if (!isUtf8(bytes) || bytes.includes(0) || (kind !== 'text/plain' && kind !== 'invalid-utf8')) {
      parentPort!.postMessage(textResult('binary', `file: ${name}, ${kind === 'invalid-utf8' ? 'invalid UTF-8' : kind + ' binary'}, ${bytes.length} bytes; not sent as text.`, options)); return;
    }
    const text = bytes.toString('utf8');
    if (text.trimStart().startsWith('{')) {
      let value: unknown; try { value = JSON.parse(text); } catch { /* ordinary text */ }
      if (value && typeof value === 'object' && 'nbformat' in value && 'cells' in value && Array.isArray(value.cells)) { parentPort!.postMessage(await notebookResult(value as Record<string, unknown>, name, options)); return; }
    }
    parentPort!.postMessage(/<svg[\s>]/i.test(text) ? await svgResult(text,name,options) : textResult('text',text,options));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Decoding failed';
    const text = `file: ${name}, ${bytes.length} bytes; unable to decode binary or text content: ${reason.slice(0, 300)}`;
    parentPort!.postMessage({ text, blocks: [{ type: 'text', text }], kind: 'binary', truncated: false, isError: true });
  }
});

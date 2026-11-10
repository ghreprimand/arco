import { PDFiumLibrary } from '@hyzyla/pdfium';
import { PDFDocument } from 'pdf-lib';
import { fittedImage } from './images.js';
import { positive, selection, textResult, type FileContentOptions, type FileContentResult, type FileContentBlock } from './types.js';

export async function pdfResult(bytes: Buffer, name: string, options: FileContentOptions): Promise<FileContentResult> {
  const library = await PDFiumLibrary.init();
  try {
    const document = await library.loadDocument(bytes);
    try {
      const count = document.getPageCount();
      if (options.pdfMode && !options.pages) throw new Error('Select PDF pages with pages when requesting visual mode.');
      const selected = selection(options.pages, count, positive(options.limits?.maxDocumentPages, 100, 100));
      const bodies: string[] = [];
      const scanned = new Set<number>();
      for (const index of selected) {
        const page = document.getPage(index);
        try {
          const text = page.getText().slice(0, 256 * 1024);
          bodies.push(`Page ${index + 1}\n${text || '[No extractable text on this page.]'}`);
          if (!text.trim() || options.pdfMode === 'images') scanned.add(index);
        } finally { page.close(); }
      }
      const truncated = selected.length < count;
      const receipt = `document: ${name}, application/pdf, ${bytes.length} bytes, pages ${selected.map(i => i + 1).join(', ')} of ${count}`;
      let reason = '';
      if (options.limits?.documents !== false && (options.pdfMode === 'visual' || scanned.size !== selected.length)) {
        const original = await PDFDocument.load(bytes);
        const subset = await PDFDocument.create();
        for (const page of await subset.copyPages(original, selected)) subset.addPage(page);
        const data = Buffer.from(await subset.save()).toString('base64');
        if (data.length <= positive(options.limits?.maxDocumentBase64Bytes, 20 * 1024 * 1024, 20 * 1024 * 1024)) {
          const text = receipt + (truncated ? '\n[Other pages omitted; use pages to select another range.]' : '');
          return textResult('pdf', receipt + '\n' + bodies.join('\n\n'), options,
            [{ type: 'text', text }, { type: 'document', mediaType: 'application/pdf', data, name, pages: selected.length }], truncated);
        }
        reason = '\n[Selected PDF exceeds the document byte limit; extracted text is shown instead.]';
      }
      const text = receipt + reason + '\n\n' + bodies.join('\n\n');
      const result = textResult('pdf', text, options, undefined, truncated);
      const blocks: FileContentBlock[] = [...result.blocks];
      if (scanned.size && options.limits?.images !== false) {
        const cap = positive(options.limits?.maxImages, 20, 100);
        for (const index of [...scanned].slice(0, cap)) {
          const page = document.getPage(index);
          try {
            const { originalWidth, originalHeight } = page.getOriginalSize();
            const edge = positive(options.limits?.maxImageEdge, 2000, 2000);
            const rendered = await page.render({ scale: Math.min(2, edge / Math.max(originalWidth, originalHeight)), render: 'bitmap', colorSpace: 'RGBA' });
            const image = fittedImage(rendered, `${name} page ${index + 1}`, options);
            blocks.push({ type: 'text', text: `${options.pdfMode === 'images' ? 'PDF page' : 'Scanned page'} ${index + 1}:` }, image);
          } finally { page.close(); }
        }
        if (scanned.size > cap) blocks.push({ type: 'text', text: options.pdfMode === 'images' ? '[More PDF pages remain; use pages to read another range.]' : '[More scanned pages remain; use pages to read another range.]' });
      } else if (scanned.size) blocks.push({ type: 'text', text: '[Scanned pages have no extractable text and this model does not accept images.]' });
      return { ...result, blocks };
    } finally { document.destroy(); }
  } finally { library.destroy(); }
}

import dns from 'node:dns/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
Object.assign(dns, { lookup: async () => [{ address: '203.0.113.1', family: 4 }] });
globalThis.fetch = async (input) => {
  const url = String(input);
  if (!url.startsWith('https://example.com/')) throw new Error('Fixture URL only.');
  if (url.endsWith('.pdf')) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (const label of ['First URL page', 'Second URL page']) {
      const page = document.addPage([200, 200]);
      if (!url.endsWith('/scan.pdf')) page.drawText(label, { x: 10, y: 100, size: 10, font });
    }
    return new Response(Uint8Array.from(await document.save()), { headers: { 'content-type': 'application/pdf' } });
  }
  return new Response(Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')), { headers: { 'content-type': 'image/png' } });
};

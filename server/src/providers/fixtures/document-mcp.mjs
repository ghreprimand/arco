import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
const server = new McpServer({ name: 'fixture-documents', version: '1.0.0' });
server.registerTool('read_document', { annotations: { readOnlyHint: true }, inputSchema: {} }, async () => {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([200, 200]).drawText('MCP document retained', { x: 10, y: 100, size: 10, font });
  return { content: [{ type: 'resource', resource: { uri: 'file:///fixture/paper.pdf', mimeType: 'application/pdf', blob: Buffer.from(await doc.save()).toString('base64') } }] };
});
await server.connect(new StdioServerTransport());

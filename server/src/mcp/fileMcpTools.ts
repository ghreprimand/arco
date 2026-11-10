import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveToolPath } from '../toolPath.js';
import { readFileContent } from '../fileContent.js';

export function registerFileTools(server: McpServer, cwd: string): void {
  server.registerTool('read_file', {
    title: 'Read an image or document',
    description: 'Read a workflow file. Images are fitted and returned as images; PDFs, Word, Excel, PowerPoint, OpenDocument, RTF and notebooks become text. Other binaries return a note. No extra software is required. Use pages to select PDF pages, spreadsheet sheets, presentation slides or notebook cells.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      file_path: z.string().min(1),
      pages: z.string().optional().describe('1-based unit range, for example 1-3,5.'),
      offset: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
    },
  }, async ({ file_path, pages, offset, limit }) => {
    try {
      const result = await readFileContent(resolveToolPath(cwd, file_path), { pages, offset, limit, limits: { images: true, documents: false, maxTextBytes: 32 * 1024, maxImages: 8, maxImageBase64Bytes: 2 * 1024 * 1024 } });
      const content: Array<{type:'text';text:string}|{type:'image';data:string;mimeType:string}> = [];
      for (const block of result.blocks) {
        if (block.type === 'image') content.push({type:'image',data:block.data,mimeType:block.mediaType});
        else if (block.type === 'text') content.push({type:'text',text:block.text});
      }
      return {isError:result.isError,content};
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: `[error] ${error instanceof Error ? error.message : String(error)}` }] };
    }
  });
}

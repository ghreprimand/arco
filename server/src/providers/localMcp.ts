import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkerConfig } from '@arco/shared';
import { connectServer, isMcpToolReadOnly, type McpSession } from '../mcp/client.js';
import { isRegistryToolAllowed, parseRegistryToolName, registryNamespace } from './claude-native/registryTools.js';
import type { OllamaToolDefinition } from './ollamaTools.js';
import { fileContentFromBytes, type FileContentBlock } from '../fileContent.js';
import type { ProviderImage } from './providerFileContent.js';
import type { SavedToolText } from './localFileMedia.js';

// One short-lived set per local turn. The configured server list is the
// operator's allowlist, and disabled/dangerous/plan-mode checks apply at both
// advertisement and dispatch. Close on success, failure and cancellation.
export class LocalMcp {
  private closed = false;
  private sessions = new Map<string, McpSession>();
  constructor(private config: WorkerConfig) {}
  async open(): Promise<OllamaToolDefinition[]> {
    if (this.config.interactionMode === 'chat') return [];
    const definitions: OllamaToolDefinition[] = [];
    for (const server of this.config.mcpRegistryServers ?? []) {
      const session = await connectServer({ id:server.key,name:server.key,command:server.command,args:server.args,env:server.env ?? {},enabled:true,createdAt:0 });
      if (this.closed) { session.close(); break; }
      this.sessions.set(server.key, session);
      for (const tool of session.listTools()) {
        const name = registryNamespace(server.key) + tool.name;
        if (!this.allowed(name)) continue;
        definitions.push({type:'function',function:{name,description:tool.description ?? tool.name,parameters:{...tool.inputSchema,type:'object',properties:tool.inputSchema?.properties as Record<string,unknown> ?? {}}}});
      }
    }
    return definitions;
  }
  has(name:string):boolean { return parseRegistryToolName(name) !== null; }
  private allowed(name:string):boolean {
    const parsed = parseRegistryToolName(name);
    if (!parsed || !isRegistryToolAllowed(this.config.mcpRegistryServers ?? [], parsed.key,parsed.tool)) return false;
    const tool = this.sessions.get(parsed.key)?.listTools().find(t=>t.name===parsed.tool);
    return !!tool && (this.config.sandbox !== 'read-only' || isMcpToolReadOnly(tool)) && (!this.config.tools || this.config.tools.includes(name));
  }
  async call(name:string,args:Record<string,unknown>,images:ProviderImage[], documents?:SavedToolText[]):Promise<string> {
    const parsed = parseRegistryToolName(name);
    if (!parsed || !this.allowed(name)) return '[error] MCP tool is not enabled for this turn.';
    const result = await this.sessions.get(parsed.key)!.callTool(parsed.tool,args) as {text:string;isError:boolean;blocks?:FileContentBlock[]};
    const texts = [result.text];
    let decodedDocuments = 0;
    for (const block of result.blocks ?? []) {
      if (block.type === 'image') images.push(block);
      if (block.type === 'document') {
        const decoded = await fileContentFromBytes(Buffer.from(block.data, 'base64'), block.name, {
          limits: { documents: false, images: true, maxImages: 8, maxImageBase64Bytes: 2 * 1024 * 1024, maxTextBytes: 32 * 1024 },
        });
        texts.push(decoded.text);
        documents?.push({ name: block.name, text: decoded.text }); decodedDocuments++;
        images.push(...decoded.blocks.filter((part): part is ProviderImage => part.type === 'image'));
      }
    }
    if (!decodedDocuments && !result.isError && result.text.trim()) documents?.push({ name: parsed.tool + ' result', text: result.text });
    const text = texts.filter(Boolean).join('\n');
    return result.isError ? `[error] ${text}` : text;
  }
  close():void { this.closed = true; for (const session of this.sessions.values()) session.close(); this.sessions.clear(); }
}

export async function registerLocalMcpTools(server:McpServer, bridge:LocalMcp, definitions:OllamaToolDefinition[]):Promise<void> {
  for (const definition of definitions) {
    const tool = definition.function;
    try {
      const inputSchema = z.fromJSONSchema(tool.parameters as Parameters<typeof z.fromJSONSchema>[0]);
      server.registerTool(tool.name, {description:tool.description,inputSchema}, async (args) => {
        const images:ProviderImage[] = [];
        const text = await bridge.call(tool.name,args as Record<string,unknown>,images);
        return {isError:text.startsWith('[error]'),content:[{type:'text' as const,text},...images.map(image=>({type:'image' as const,mimeType:image.mediaType,data:image.data}))]};
      });
    } catch { /* Unsupported schemas are omitted, never relaxed. */ }
  }
}

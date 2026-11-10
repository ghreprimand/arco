import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cursor's documented --plugin-dir avoids editing the project's or operator's
// MCP configuration. This plugin exposes one read-only, cwd-confined tool.
export async function createFilePlugin(cwd:string):Promise<{path:string;close:()=>Promise<void>}> {
  const path = await mkdtemp(join(tmpdir(),'arco-files-'));
  try {
    await mkdir(join(path,'.cursor-plugin'));
    await writeFile(join(path,'.cursor-plugin','plugin.json'),JSON.stringify({name:'arco-files',version:'1.0.0',description:'Read images and documents in the workflow folder.',mcpServers:'./mcp.json'}));
    const entry = resolve(dirname(fileURLToPath(import.meta.url)),'../../mcp/fileMcpServer.' + (process.env.NODE_ENV === 'production'?'js':'ts'));
    const args = process.env.NODE_ENV === 'production' ? [entry,cwd] : ['--import',import.meta.resolve('tsx'),entry,cwd];
    await writeFile(join(path,'mcp.json'),JSON.stringify({mcpServers:{'arco-files':{command:process.execPath,args}}}));
    return {path,close:()=>rm(path,{recursive:true,force:true})};
  } catch (error) { await rm(path,{recursive:true,force:true}); throw error; }
}

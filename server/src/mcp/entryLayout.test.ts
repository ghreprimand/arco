import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

for (const layout of ['src', 'dist'] as const) {
  for (const nodeEnv of [undefined, 'development', 'production']) {
    test(`${layout} MCP entries follow running module with NODE_ENV ${nodeEnv ?? 'unset'}`, () => {
      const ext = layout === 'src' ? 'ts' : 'js';
      const script = `
        import { resolveMcpServerEntry, resolveArcoMcpServerEntry, resolveVoiceMcpServerEntry } from './server/${layout}/mcp/mcpConfigWriter.${ext}';
        import { createFilePlugin } from './server/${layout}/providers/cursor/filePlugin.${ext}';
        import { readFile } from 'node:fs/promises';
        import { join } from 'node:path';
        const plugin = await createFilePlugin(process.cwd(), 'fixture');
        try {
          const config = JSON.parse(await readFile(join(plugin.path, 'mcp.json'), 'utf8'));
          console.log(JSON.stringify([resolveMcpServerEntry(), resolveArcoMcpServerEntry(), resolveVoiceMcpServerEntry(), config.mcpServers['arco-files'], config.mcpServers.arco]));
        } finally { await plugin.close(); }
      `;
      const env = { ...process.env };
      if (nodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = nodeEnv;
      const args = layout === 'src' ? ['--conditions', 'development', '--import', 'tsx', '--input-type=module', '-e', script] : ['--input-type=module', '-e', script];
      const result = JSON.parse(execFileSync(process.execPath, args, { cwd: resolve('.'), env, encoding: 'utf8' }));
      for (const entry of result) {
        const paths = entry.args.filter((arg: string) => /(?:clusterMcpServer|arcoMcpServer|voiceMcpServer|fileMcpServer|planReadMcpServer)\.[jt]s$/.test(arg));
        assert.equal(paths.length, 1);
        assert.ok(paths[0].endsWith(`.${ext}`), JSON.stringify(entry));
        assert.equal(entry.args.includes('tsx') || entry.args.includes('--import'), layout === 'src');
      }
    });
  }
}

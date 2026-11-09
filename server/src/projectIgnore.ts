// Ask Git in one batch per directory so nested .gitignore rules and negations
// keep Git's semantics. Missing Git and non-repositories degrade to no filter.
import { spawn } from 'node:child_process';
export function ignoredProjectPaths(root: string, paths: string[], milliseconds: number): Promise<Set<string>> {
  if (!paths.length || milliseconds <= 0) return Promise.resolve(new Set());
  return new Promise(resolve => {
    const child = spawn('git', ['check-ignore', '--no-index', '-z', '--stdin'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'], timeout: Math.max(1, Math.min(100, milliseconds)) });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) child.kill(); else chunks.push(chunk);
    });
    child.once('error', () => resolve(new Set()));
    child.once('close', code => resolve(code === 0 ? new Set(Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean)) : new Set()));
    child.stdin.on('error', () => { /* Git may exit before reading input */ });
    child.stdin.end(paths.join('\0') + '\0');
  });
}

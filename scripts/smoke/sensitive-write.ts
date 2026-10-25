// H47 — sensitive-path write floor smoke.
//
// Writes to credential/secret/VCS paths (.env, .ssh/*, id_rsa, *.pem, .git/*)
// must get an explicit operator OK via the existing AskUserQuestion machinery
// before the write lands, even outside plan mode. Normal writes are untouched.
// This drives the pure path classifier + the WriteTool/EditTool gate end-to-end
// through executeNativeTool with a fake ctx (no Native turn / no API needed).
//
// Run: npm run smoke:sensitive-write   (no :3001 needed)

import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'archon-sensitive-write-smoke-'));

  const { isSensitiveWritePath } = await import('../../server/src/providers/claude-native/tools.js');
  const { executeNativeTool } = await import('../../server/src/providers/claude-native/tools.js');

  await step('isSensitiveWritePath: flags secret/VCS/key paths', () => {
    for (const p of [
      '/proj/.env', '/proj/.env.local', '/proj/.env.production',
      '/proj/.ssh/config', '/proj/secrets/id_rsa', '/proj/keys/id_ed25519',
      '/proj/cert.pem', '/proj/sub/server.pem', '/proj/.git/config',
    ]) {
      assert(isSensitiveWritePath(p), `expected sensitive: ${p}`);
    }
  });

  await step('isSensitiveWritePath: leaves normal paths alone', () => {
    for (const p of [
      '/proj/src/index.ts', '/proj/.gitignore', '/proj/README.md',
      '/proj/environment.ts', '/proj/env.example', '/proj/notes/id_rsa.txt',
    ]) {
      assert(!isSensitiveWritePath(p), `expected normal: ${p}`);
    }
  });

  // Build a minimal NativeToolContext. `askUserQuestion` is the operator
  // approval channel; the smoke swaps its verdict per step.
  let verdict = 'Block';
  const askCalls: string[] = [];
  const makeCtx = (cwd: string) => ({
    cwd,
    abortSignal: new AbortController().signal,
    shells: { byId: new Map(), mintId: () => 'sh-1' },
    readSet: new Set<string>(),
    planMode: false,
    onTodos: () => { /* noop */ },
    askUserQuestion: async (q: string) => { askCalls.push(q); return verdict; },
  });

  await step('Write to a normal path: no prompt, file written', async () => {
    const cwd = join(root, 'p1');
    await mkdir(cwd, { recursive: true });
    askCalls.length = 0;
    verdict = 'Block'; // would block IF asked — proves the gate is not triggered
    const out = await executeNativeTool('Write', { file_path: 'src/app.ts', content: 'ok' }, makeCtx(cwd) as never);
    assert(!out.startsWith('[error]'), `normal write should succeed (got ${out})`);
    assertEq(askCalls.length, 0, 'normal write did not prompt');
    assertEq(await readFile(join(cwd, 'src/app.ts'), 'utf8'), 'ok', 'file content written');
  });

  await step('Write to .env BLOCKED: prompts, write refused, file absent', async () => {
    const cwd = join(root, 'p2');
    await mkdir(cwd, { recursive: true });
    askCalls.length = 0;
    verdict = 'Block';
    const out = await executeNativeTool('Write', { file_path: '.env', content: 'SECRET=1' }, makeCtx(cwd) as never);
    assert(out.startsWith('[error]'), 'blocked write returns error');
    assert(/blocked by the operator/i.test(out), `error mentions the block (got ${out})`);
    assertEq(askCalls.length, 1, 'prompted exactly once');
    let exists = true;
    try { await readFile(join(cwd, '.env'), 'utf8'); } catch { exists = false; }
    assert(!exists, '.env must NOT have been written');
  });

  await step('Write to .env ALLOWED: prompts, then write lands', async () => {
    const cwd = join(root, 'p3');
    await mkdir(cwd, { recursive: true });
    askCalls.length = 0;
    verdict = 'Allow this write';
    const out = await executeNativeTool('Write', { file_path: '.env', content: 'SECRET=1' }, makeCtx(cwd) as never);
    assert(!out.startsWith('[error]'), `allowed write should succeed (got ${out})`);
    assertEq(askCalls.length, 1, 'prompted exactly once');
    assertEq(await readFile(join(cwd, '.env'), 'utf8'), 'SECRET=1', '.env written after approval');
  });

  await step('Edit to id_rsa BLOCKED: prompts, original unchanged', async () => {
    const cwd = join(root, 'p4');
    await mkdir(join(cwd, 'keys'), { recursive: true });
    const keyPath = join(cwd, 'keys', 'id_rsa');
    await writeFile(keyPath, 'ORIGINAL', 'utf8');
    askCalls.length = 0;
    verdict = 'Block';
    const ctx = makeCtx(cwd);
    ctx.readSet.add(keyPath); // satisfy Edit's read-before-write rule
    const out = await executeNativeTool('Edit', { file_path: 'keys/id_rsa', old_string: 'ORIGINAL', new_string: 'HACKED' }, ctx as never);
    assert(out.startsWith('[error]'), 'blocked edit returns error');
    assertEq(askCalls.length, 1, 'prompted once');
    assertEq(await readFile(keyPath, 'utf8'), 'ORIGINAL', 'key file unchanged');
  });

  await step('Sensitive write with NO approval channel fails closed', async () => {
    const cwd = join(root, 'p5');
    await mkdir(cwd, { recursive: true });
    const ctx = makeCtx(cwd) as { askUserQuestion?: unknown };
    delete ctx.askUserQuestion; // no channel wired
    const out = await executeNativeTool('Write', { file_path: '.env', content: 'X=1' }, ctx as never);
    assert(out.startsWith('[error]'), 'no-channel sensitive write refused');
    assert(/unavailable in this context/i.test(out), `fail-closed message (got ${out})`);
  });

  await rm(root, { recursive: true, force: true });
  summary('sensitive-write');
}

main().catch((err) => {
  console.error('sensitive-write smoke crashed:', err);
  process.exit(1);
});

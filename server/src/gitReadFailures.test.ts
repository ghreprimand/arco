import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';

let response: (args: string[]) => { stdout: string; code?: string | number; killed?: boolean } = () => ({ stdout: '' });
const original = childProcess.execFile;
childProcess.execFile = ((_file: string, args: string[], _opts: unknown, callback: Function) => {
  const result = response(args);
  queueMicrotask(() => callback(result.code === undefined ? null : Object.assign(new Error('Fixture Git failed.'), result), result.stdout, ''));
  return {};
}) as typeof original;
Object.defineProperty(childProcess.execFile, promisify.custom, { value: async (_file: string, args: string[]) => {
  const result = response(args);
  if (result.code !== undefined) throw Object.assign(new Error('Fixture Git failed.'), { ...result, stderr: '' });
  return { stdout: result.stdout, stderr: '' };
} });
syncBuiltinESMExports();
const { getWorkingChanges, getFileDiff } = await import('./gitWorking.js');
const { computeDiff } = await import('./gitDiff.js');
childProcess.execFile = original;
syncBuiltinESMExports();

test('B18: ordinary, rename and conflict status records preserve complete paths', async () => {
  response = (args) => ({ stdout: args[0] === 'rev-parse' ? 'true\n' : [
    '1 MM N... 100644 100644 100644 a b report draft.txt',
    '2 R. N... 100644 100644 100644 a b R100 new report draft.txt', 'old report draft.txt',
    'u UU N... 100644 100644 100644 100644 a b c conflict report.txt', '? untracked report.txt', '',
  ].join('\0') });
  const changed = await getWorkingChanges('/fixture/project');
  assert.deepEqual(changed.staged.map((f) => f.path), ['report draft.txt', 'new report draft.txt']);
  assert.equal(changed.staged[1].origPath, 'old report draft.txt');
  assert.deepEqual(changed.unstaged.map((f) => f.path), ['report draft.txt', 'conflict report.txt']);
  assert.equal(changed.untracked[0].path, 'untracked report.txt');
});

for (const failure of [{ code: 2 }, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, { code: 'ETIMEDOUT', killed: true }]) {
  for (const kind of ['working', 'refs', 'tracked-file', 'untracked-file'] as const) {
    test(`B19: ${kind} rejects incomplete diff (${failure.code})`, async () => {
      response = (args) => {
        if (args[0] === 'rev-parse') return { stdout: args.includes('--is-inside-work-tree') ? 'true\n' : 'commit\n' };
        if (args[0] === 'ls-files') return { stdout: '', ...(kind === 'untracked-file' ? { code: 1 } : {}) };
        return { stdout: 'partial patch', ...failure };
      };
      const run = kind.endsWith('-file') ? getFileDiff('/fixture/project', { path: 'report draft.txt', staged: false })
        : computeDiff({ cwd: '/fixture/project', from: 'HEAD', to: kind === 'refs' ? 'HEAD~1' : 'WORKTREE' });
      await assert.rejects(run, /diff|Git/i);
    });
  }
}

test('B19: a normal no-index exit 1 still returns a complete added-file diff', async () => {
  response = (args) => {
    if (args[0] === 'rev-parse') return { stdout: 'true\n' };
    if (args[0] === 'ls-files') return { stdout: '', code: 1 };
    return { stdout: 'complete patch', code: 1 };
  };
  assert.equal((await getFileDiff('/fixture/project', { path: 'new.txt', staged: false })).patch, 'complete patch');
});

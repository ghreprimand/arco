import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import dns from 'node:dns/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandContextRefs } from './contextRefs.js';
import { FileScanDeadlineExceeded, regularFileLines } from './boundedRead.js';
import { executeOllamaTool } from './providers/ollamaTools.js';
import { executeNativeTool } from './providers/claude-native/tools.js';

const native = (cwd: string) => ({ cwd, abortSignal: new AbortController().signal, shells: { byId: new Map(), mintId: () => 'fixture' }, readSet: new Set<string>(), partialReadSet: new Set<string>(), planMode: false, onTodos: () => {} });
for (const kind of ['context', 'local', 'native'] as const) test(`${kind} reads do not allocate a complete large file`, async t => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'arco-bounded-'));
  const file = join(cwd, 'large.txt');
  await fs.writeFile(file, 'first\n' + 'x'.repeat(300000) + '\nlast');
  const open = fs.open.bind(fs);
  let bytesRead = 0;
  t.mock.method(fs, 'open', async (...args: any[]) => {
    const handle = await (open as any)(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...params: any[]) => {
      const result = await read(...params);
      if (String(args[0]) === file) bytesRead += result.bytesRead;
      return result;
    };
    return handle;
  });
  const original = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', (...args: any[]) => {
    if (String(args[0]) === file) throw new Error('unbounded file allocation');
    return (original as any)(...args);
  });
  try {
    const result = kind === 'context' ? (await expandContextRefs(cwd, '@file:large.txt')).notices.join('\n')
      : kind === 'local' ? await executeOllamaTool('Read', {file_path: file}, {cwd})
      : await executeNativeTool('Read', {file_path: file}, native(cwd));
    assert.doesNotMatch(result, /unbounded file allocation/);
    assert.match(result, /truncated/);
    const cap = kind === 'context' ? 65536 : kind === 'local' ? 32768 : 262144;
    assert.ok(bytesRead <= cap + 16384, `read ${bytesRead} bytes for a ${cap}-byte result`);
    if (kind !== 'context') {
      const tail = kind === 'local' ? await executeOllamaTool('Read', {file_path: file, offset: 3}, {cwd})
        : await executeNativeTool('Read', {file_path: file, offset: 3}, native(cwd));
      assert.equal(tail, 'last');
    }
  } finally { t.mock.restoreAll(); await fs.rm(cwd, {recursive:true, force:true}); }
});

test('local Grep scans beyond large lines without whole-file allocation', async t => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'arco-grep-bounded-'));
  const file = join(cwd, 'large.txt');
  await fs.writeFile(file, 'x'.repeat(300000) + '\nneedle');
  const original = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', (...args: any[]) => {
    if (String(args[0]) === file) throw new Error('unbounded file allocation');
    return (original as any)(...args);
  });
  try { assert.match(await executeOllamaTool('Grep', {pattern:'needle'}, {cwd}), /large.txt:2: needle/); }
  finally { t.mock.restoreAll(); await fs.rm(cwd, {recursive:true, force:true}); }
});

test('WebFetch stops reading and cancels at its byte budget', async t => {
  let cancelled = false;
  let pulls = 0;
  t.mock.method(dns, 'lookup', async () => [{address:'203.0.113.1',family:4}] as any);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) { if (pulls >= 20) { controller.close(); return; } pulls++; controller.enqueue(new Uint8Array(16384).fill(65)); },
    cancel() { cancelled = true; },
  }), {headers:{'content-type':'text/plain'}}));
  // A synthetic public URL bypasses DNS without contacting a service.
  const result = await executeOllamaTool('WebFetch', {url:'https://example.com', mode:'fast'}, {cwd:tmpdir()});
  assert.ok(cancelled);
  assert.ok(pulls <= 10);
  assert.match(result, /truncated/);
});

for (const kind of ['context', 'local', 'native'] as const) test(`${kind} rejects special files without waiting for a writer`, {skip: process.platform === 'win32'}, async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'arco-special-'));
  try {
    const pipe = join(cwd, 'pipe');
    assert.equal(spawnSync('mkfifo', [pipe]).status, 0);
    const script = `import {expandContextRefs} from './server/src/contextRefs.ts';
      import {executeOllamaTool} from './server/src/providers/ollamaTools.ts';
      import {executeNativeTool} from './server/src/providers/claude-native/tools.ts';
      const cwd=process.argv[1],kind=process.argv[2];
      const ctx={cwd,abortSignal:new AbortController().signal,shells:{byId:new Map(),mintId:()=> 'fixture'},readSet:new Set(),planMode:false,onTodos:()=>{}};
      const r=kind==='context'?(await expandContextRefs(cwd,'@file:pipe')).notices.join(' '):kind==='local'?await executeOllamaTool('Read',{file_path:'pipe'},ctx):await executeNativeTool('Read',{file_path:'pipe'},ctx);
      console.log(r);`;
    const result = spawnSync(process.execPath, ['--conditions','development','--import','tsx','--input-type','module','-e',script,cwd,kind], {timeout:4000,encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not a regular file/);
  } finally { await fs.rm(cwd,{recursive:true,force:true}); }
});

test('Native Grep fallback streams files and finds hits after a large line', async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'arco-native-grep-'));
  try {
    await fs.writeFile(join(cwd, 'large.txt'), 'x'.repeat(300000)+'\nneedle');
    const script = `import {promises as fs} from 'node:fs';
      import {executeNativeTool} from './server/src/providers/claude-native/tools.ts';
      fs.readFile=async()=>{throw new Error('unbounded file allocation')};
      console.log(await executeNativeTool('Grep',{pattern:'needle'},{cwd:process.argv[1],abortSignal:new AbortController().signal,shells:{byId:new Map(),mintId:()=> 'fixture'},readSet:new Set(),planMode:false,onTodos:()=>{}}));`;
    const result = spawnSync(process.execPath, ['--conditions','development','--import','tsx','--input-type','module','-e',script,cwd], {env:{...process.env,PATH:''},timeout:4000,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/large.txt:2: needle/);
  } finally { await fs.rm(cwd,{recursive:true,force:true}); }
});

for (const kind of ['local', 'native', 'native-rg'] as const) test(`${kind} Grep searches legacy text and omits binary`, async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'arco-grep-encoding-'));
  try {
    await fs.writeFile(join(cwd, 'good.txt'), 'needle in text\n');
    await fs.writeFile(join(cwd, 'control-heavy.bin'), Buffer.concat([Buffer.from('needle binary\n'), Buffer.from([0x81, 1, 2, 3, 4, 5, 6, 7])]));
    await fs.writeFile(join(cwd, 'binary.pdf'), '%PDF-1.7\nneedle printable binary\n');
    await fs.writeFile(join(cwd, 'legacy.txt'), Buffer.concat([Buffer.from('first\nsecond\nneedle caf'), Buffer.from([0xe9]), Buffer.from('\n')]));
    await fs.writeFile(join(cwd, 'utf16le.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('first\nsecond\nneedle café\n', 'utf16le')]));
    const be = Buffer.from('first\nsecond\nneedle café\n', 'utf16le').swap16();
    await fs.writeFile(join(cwd, 'utf16be.txt'), Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    await fs.writeFile(join(cwd, 'image.png'), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from('needle')]));
    await fs.writeFile(join(cwd, 'archive.zip'), Buffer.concat([Buffer.from([80,75,3,4]), Buffer.from('needle')]));
    await fs.writeFile(join(cwd, 'nul.dat'), Buffer.from('needle before\n' + 'normal text '.repeat(12000) + '\0 hidden\n'));
    await fs.writeFile(join(cwd, 'unicode.txt'), 'needle café\n');
    const script = `import {executeOllamaTool} from './server/src/providers/ollamaTools.ts';
      import {executeNativeTool} from './server/src/providers/claude-native/tools.ts';
      const cwd=process.argv[1], kind=process.argv[2];
      const ctx={cwd,abortSignal:new AbortController().signal,shells:{byId:new Map(),mintId:()=> 'fixture'},readSet:new Set(),partialReadSet:new Set(),planMode:false,onTodos:()=>{}};
      console.log(kind==='local'?await executeOllamaTool('Grep',{pattern:'needle'},ctx):await executeNativeTool('Grep',{pattern:'needle'},ctx));`;
    // Put nul.dat's binary warning before unicode.txt deterministically. rg's
    // normal parallel traversal can emit these files in either order.
    const rgConfig = join(cwd, '.ripgreprc');
    await fs.writeFile(rgConfig, '--sort=path\n');
    const grepEnv = {...process.env, PATH:kind === 'native-rg' ? process.env.PATH : '', RIPGREP_CONFIG_PATH:rgConfig};
    const result = spawnSync(process.execPath, ['--conditions','development','--import','tsx','--input-type','module','-e',script,cwd,kind], {env:grepEnv,timeout:4000,encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /good.txt:1: ?needle in text/);
    assert.match(result.stdout, /unicode.txt:1: ?needle café/);
    for (const name of ['legacy.txt', 'utf16le.txt', 'utf16be.txt']) assert.match(result.stdout, new RegExp(`${name.replace('.', '\\.')} :3: ?needle café`.replace(' :', ':')));
    assert.doesNotMatch(result.stdout, /binary.pdf|image.png|archive.zip|nul.dat|control-heavy.bin|\uFFFD/);
    const accentedScript = script.replaceAll("pattern:'needle'", "pattern:'café'");
    const accented = spawnSync(process.execPath, ['--conditions','development','--import','tsx','--input-type','module','-e',accentedScript,cwd,kind], {env:grepEnv,timeout:4000,encoding:'utf8'});
    assert.equal(accented.status, 0, accented.stderr);
    assert.match(accented.stdout, /legacy\.txt:3: ?needle café/);
  } finally { await fs.rm(cwd,{recursive:true,force:true}); }
});

test('text search respects the existing scan deadline', async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'arco-grep-deadline-'));
  try {
    const file = join(cwd, 'fixture.txt');
    await fs.writeFile(file, 'needle\n');
    await assert.rejects(async () => {
      for await (const _ of regularFileLines(await fs.realpath(file), 1024, undefined, true, performance.now() - 1)) {}
    }, FileScanDeadlineExceeded);
  } finally { await fs.rm(cwd, {recursive:true, force:true}); }
});

test('Native ripgrep preserves filename-only results for binary matches', async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'arco-grep-names-'));
  try {
    await fs.writeFile(join(cwd, 'binary.pdf'), '%PDF-1.7\nneedle printable binary\n');
    const script = `import {executeNativeTool} from './server/src/providers/claude-native/tools.ts';
      const cwd=process.argv[1],ctx={cwd,abortSignal:new AbortController().signal,shells:{byId:new Map(),mintId:()=> 'fixture'},readSet:new Set(),partialReadSet:new Set(),planMode:false,onTodos:()=>{}};
      console.log(await executeNativeTool('Grep',{pattern:'needle',files_only:true},ctx));`;
    const result = spawnSync(process.execPath, ['--conditions','development','--import','tsx','--input-type','module','-e',script,cwd], {timeout:4000,encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    // When ripgrep is not installed the bounded fallback skips binary content.
    if (spawnSync('rg',['--version'],{stdio:'ignore'}).status === 0) assert.match(result.stdout, /binary.pdf/);
  } finally { await fs.rm(cwd,{recursive:true,force:true}); }
});

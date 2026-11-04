import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UPLOAD_PATH, formatUploadFailure, uploadAttachment } from './uploadAttachment.js';

function fakeFile(name = 'shot.png', type = 'image/png'): File {
  return new File([Uint8Array.from([1, 2, 3, 4])], name, { type });
}

test('UPLOAD_PATH is same-origin relative and never pins a port', () => {
  assert.equal(UPLOAD_PATH, '/upload');
  assert.equal(UPLOAD_PATH.includes(':'), false);
  assert.equal(UPLOAD_PATH.startsWith('http'), false);
});

test('uploadAttachment POSTs only to /upload with credentials', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ fileId: 'ab12', filename: 'shot.png', path: '/tmp/ab12-shot.png' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const result = await uploadAttachment(fakeFile(), fetchImpl);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('expected ok');
  assert.equal(result.fileId, 'ab12');
  assert.equal(result.path, '/tmp/ab12-shot.png');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/upload');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.credentials, 'include');
  assert.equal((calls[0].init?.headers as Record<string, string>)['X-Filename'], 'shot.png');
});

test('uploadAttachment never retries a hard-coded :3001 URL', async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ error: 'Session required' }), { status: 401 });
  };
  const result = await uploadAttachment(fakeFile(), fetchImpl);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected failure');
  assert.match(result.error, /shot\.png/);
  assert.match(result.error, /Session required/);
  assert.deepEqual(urls, ['/upload']);
  assert.equal(urls.some((u) => u.includes(':3001')), false);
});

test('HTTP failure surfaces the server error and the file name', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ error: 'Empty upload body' }), { status: 400 });
  const result = await uploadAttachment(fakeFile('clip.png'), fetchImpl);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected failure');
  assert.equal(result.error, 'Upload failed for clip.png: empty file');
});

test('size-limit status maps to a clear reason', async () => {
  const fetchImpl: typeof fetch = async () => new Response('too big', { status: 413 });
  const result = await uploadAttachment(fakeFile('huge.bin'), fetchImpl);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected failure');
  assert.equal(result.error, 'Upload failed for huge.bin: file is too large');
});

test('network failure names the file', async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  const result = await uploadAttachment(fakeFile(), fetchImpl);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected failure');
  assert.equal(result.error, formatUploadFailure(fakeFile(), 'network error'));
});

test('malformed success body is reported', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 });
  const result = await uploadAttachment(new File([], ''), fetchImpl);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected failure');
  assert.match(result.error, /pasted file/);
  assert.match(result.error, /unexpected server response/);
});

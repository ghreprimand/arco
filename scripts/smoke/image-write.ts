// Workbench Expansion H2 part 1 — guarded image-write endpoint smoke.
//
// Drives the route handler from ../http/imageWriteRoutes.ts DIRECTLY against a
// temp cwd (no server, no WS) so a tsx-watch restart can't race it. The handler
// only reads `req.url` / `req.method` / streams the JSON body and writes a JSON
// response — so we feed it a minimal mock IncomingMessage (an async-iterable that
// yields the body) + a mock ServerResponse that captures the status + body.
//
// Asserts the load-bearing fences:
//   (a) a small valid PNG data URL → ok:true, file on disk with the decoded bytes.
//   (b) a '../escape.png' path → ok:false code:'path-escape', NO file outside cwd.
//   (c) writing an existing file WITHOUT overwrite → ok:false code:'exists',
//       original bytes unchanged.
//   (d) the same file WITH overwrite:true → ok:true, bytes replaced.
//   (e) a malformed (non-image) data URL → ok:false code:'bad-image'.
//   (f) an oversize payload → ok:false code:'too-large'.
//
// Run: npm run smoke:image-write   (no dev server / network needed)

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { step, assert, assertEq, summary } from './lib.js';
import { tryHandleImageWriteRoutes } from '../../server/src/http/imageWriteRoutes.js';
import type { ImageWriteResult } from '@arco/shared';
import { workflowCwds } from '../../server/src/server/state.js';

// 1×1 transparent PNG (known-good 68-byte raster). Used as the valid fixture.
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_1x1_DATAURL = `data:image/png;base64,${PNG_1x1_B64}`;

// Invoke the route with a JSON body, returning the captured { status, body }.
async function call(body: unknown): Promise<{ status: number; result: ImageWriteResult }> {
  const raw = JSON.stringify(body);
  // Mock IncomingMessage: async-iterable yielding the body + url/method.
  const req = Readable.from([raw]) as unknown as import('http').IncomingMessage;
  (req as { url?: string }).url = '/api/image/write';
  (req as { method?: string }).method = 'POST';

  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(chunk?: string) { if (chunk) payload += chunk; },
  } as unknown as import('http').ServerResponse;

  const handled = await tryHandleImageWriteRoutes(req, res);
  assert(handled, 'route handled /api/image/write');
  return { status, result: JSON.parse(payload) as ImageWriteResult };
}

async function main() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-image-write-'));
  // A sibling dir OUTSIDE cwd to prove the escape never lands a file.
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-image-outside-'));
  // A caller-supplied cwd must be a root the server knows (writeConfinement.ts);
  // register the temp cwd as a live workflow's so the no-workflowId calls bind.
  workflowCwds.set('smoke-image-write', cwd);
  try {
    await step('an unknown cwd ("/") is rejected → no-cwd, nothing written', async () => {
      const { result } = await call({ cwd: '/', path: path.join(outside, 'rooted.png'), dataUrl: PNG_1x1_DATAURL });
      assert(result.ok === false, 'ok:false');
      assertEq(result.code, 'no-cwd', 'code no-cwd');
      let landed = true;
      try { await fs.access(path.join(outside, 'rooted.png')); } catch { landed = false; }
      assert(!landed, 'no file was created');
    });

    await step('a symlink inside cwd pointing outside → path-escape, nothing written', async () => {
      await fs.symlink(outside, path.join(cwd, 'link-out'));
      const { result } = await call({ cwd, path: 'link-out/via-link.png', dataUrl: PNG_1x1_DATAURL });
      assert(result.ok === false, 'ok:false');
      assertEq(result.code, 'path-escape', 'code path-escape');
      let landed = true;
      try { await fs.access(path.join(outside, 'via-link.png')); } catch { landed = false; }
      assert(!landed, 'no file was created through the symlink');
    });

    await step('write a valid PNG data URL to a NEW path → ok, file on disk', async () => {
      const { status, result } = await call({ cwd, path: 'sub/edited.png', dataUrl: PNG_1x1_DATAURL });
      assertEq(status, 200, 'HTTP 200');
      assert(result.ok === true, `ok:true (got ${JSON.stringify(result)})`);
      assertEq(result.relPath, path.join('sub', 'edited.png'), 'relPath is cwd-relative');
      const onDisk = await fs.readFile(path.join(cwd, 'sub', 'edited.png'));
      const expected = Buffer.from(PNG_1x1_B64, 'base64');
      assert(onDisk.equals(expected), 'on-disk bytes equal the decoded PNG');
      assertEq(result.bytes, expected.length, 'reported bytes match');
    });

    await step("a '../escape.png' path → path-escape, NO file outside cwd", async () => {
      // Aim the traversal at the sibling outside dir.
      const escapeRel = path.join('..', path.basename(outside), 'escape.png');
      const { result } = await call({ cwd, path: escapeRel, dataUrl: PNG_1x1_DATAURL });
      assert(result.ok === false, 'ok:false');
      assertEq(result.code, 'path-escape', 'code path-escape');
      let landed = true;
      try { await fs.access(path.join(outside, 'escape.png')); } catch { landed = false; }
      assert(!landed, 'no file was created outside cwd');
    });

    await step('write an EXISTING file WITHOUT overwrite → exists, original unchanged', async () => {
      const target = path.join(cwd, 'sub', 'edited.png');
      const before = await fs.readFile(target);
      // A *different* tiny payload would change bytes if it wrote — but it must NOT.
      const { result } = await call({ cwd, path: 'sub/edited.png', dataUrl: 'data:image/png;base64,QUJD' });
      assert(result.ok === false, 'ok:false');
      assertEq(result.code, 'exists', 'code exists');
      const after = await fs.readFile(target);
      assert(before.equals(after), 'original bytes unchanged (no write happened)');
    });

    await step('write the EXISTING file WITH overwrite:true → ok, bytes replaced', async () => {
      const target = path.join(cwd, 'sub', 'edited.png');
      // A distinct (still valid PNG-mime) payload so we can prove replacement.
      const newDataUrl = 'data:image/png;base64,QUJDREVG'; // "ABCDEF"
      const { result } = await call({ cwd, path: 'sub/edited.png', dataUrl: newDataUrl, overwrite: true });
      assert(result.ok === true, `ok:true (got ${JSON.stringify(result)})`);
      const after = await fs.readFile(target);
      assert(after.equals(Buffer.from('ABCDEF')), 'bytes were replaced with the new payload');
    });

    await step('a malformed (non-image) data URL → bad-image', async () => {
      const { result } = await call({ cwd, path: 'note.png', dataUrl: 'data:text/plain;base64,aGk=' });
      assert(result.ok === false, 'ok:false');
      assertEq(result.code, 'bad-image', 'code bad-image');
      // And a totally non-data-URL string.
      const { result: r2 } = await call({ cwd, path: 'note.png', dataUrl: 'not-a-data-url' });
      assertEq(r2.code, 'bad-image', 'plain string also bad-image');
    });

    await step('an oversize payload → too-large (no OOM, no write)', async () => {
      // base64 of > 64 MiB decoded. 90 MiB of base64 'A's decodes well past the cap;
      // the cheap pre-check rejects on length before any large Buffer is allocated.
      const huge = 'A'.repeat(90 * 1024 * 1024);
      const { result } = await call({ cwd, path: 'big.png', dataUrl: `data:image/png;base64,${huge}` });
      assert(result.ok === false, 'ok:false');
      assertEq(result.code, 'too-large', 'code too-large');
      let landed = true;
      try { await fs.access(path.join(cwd, 'big.png')); } catch { landed = false; }
      assert(!landed, 'no oversize file was written');
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }

  summary('image-write');
}

main();
